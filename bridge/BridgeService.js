import crypto from "crypto";
import fs from "fs";
import fetch from "node-fetch";
import { Ollama } from "ollama";
import { TempoTracer } from "./TempoTracer.js";
import { LokiLogger } from "./LokiLogger.js";
import { BridgeMetrics } from "./BridgeMetrics.js";
import { PyroscopeProfiler } from "./PyroscopeProfiler.js";

/**
 * Bridge Service
 * Grafana OSS and Ollama LLM integration specialized class
 */
export class BridgeService {
  /**
   * @param {object} options
   * @param {string} [options.serviceName] - service name
   * @param {string} [options.mode] - operation mode ("LLM" or "TEST")
   * @param {string} [options.model] - LLM model name
   * @param {string} [options.ollamaHost] - Ollama URL
   * @param {string} [options.mcpUrl] - Grafana MCP server URL
   * @param {string} [options.systemPromptPath] - system prompt path (.mdc)
   */
  constructor(options = {}) {
    this.config = {
      ollamaHost:
        options.ollamaHost || process.env.OLLAMA_HOST || "http://ollama:11434",
      llmModel: options.model || process.env.LLM_MODEL || "deepseek-r1:1.5b",
      mcpUrl:
        options.mcpUrl || process.env.MCP_URL || "http://mcp-grafana:8000",
      mode: options.mode || process.env.BRIDGE_MODE || "LLM",
      serviceName:
        options.serviceName || process.env.BRIDGE_SERVICE_NAME || "mcp-bridge",
      systemPromptPath:
        options.systemPromptPath ||
        process.env.SYSTEM_PROMPT_MDC ||
        "./system-prompt.mdc",
    };

    this.logger = new LokiLogger(this.config.serviceName);
    this.metrics = new BridgeMetrics();
    this.profiler = new PyroscopeProfiler({ appName: this.config.serviceName });
    this.ollama = new Ollama({ host: this.config.ollamaHost });
    this.tempo = null; // see init()
    this.systemPrompt = null; // see init()
  }

  /***
   * service initializer
   */
  async init() {
    try {
      this.tempo = new TempoTracer(this.config.serviceName, {
        logger: this.logger,
      });
      await this.tempo.init();

      this.systemPrompt = this.loadSystemPrompt();
      this.logger.info(
        `[bridge] ${this.config.serviceName} service initialized`
      );
    } catch (err) {
      this.metrics.bridgeErrors.inc();
      this.logger.error(
        `[bridge] ${this.config.serviceName} service initialization failed`,
        {
          error: err.message,
        }
      );
      throw err;
    }
    return this;
  }

  /***
   * system prompt loader
   */
  loadSystemPrompt() {
    this.logger.info("[bridge] loading system prompt", {
      file: this.config.systemPromptPath,
    });
    return fs.readFileSync(this.config.systemPromptPath, "utf-8");
  }

  /**
   * MCP server caller (JSON-RPC helper)
   */
  async callMCP(method, params) {
    return await this.tempo.withSpan("callMCP", { params }, async () => {
      const timerEnd = this.metrics.mcpLatency.startTimer();
      this.metrics.mcpRequests.inc();
      try {
        const res = await fetch(`${this.config.mcpUrl}/mcp`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: "1",
            method,
            params,
          }),
        });

        if (!res.ok) {
          const text = await res.text();
          throw new Error(`MCP server error: ${text}`);
        }

        return await res.json();
      } catch (err) {
        this.metrics.mcpErrors.inc();
        this.logger.error("[bridge] MCP call failed", { error: err.message });
        throw err;
      } finally {
        timerEnd();
      }
    });
  }

  /**
   * LLM caller (Ollama API helper)
   */
  async callLLM(messages) {
    return await this.tempo.withSpan("callLLM", { messages }, async () => {
      const timerEnd = this.metrics.ollamaLatency.startTimer();
      this.metrics.ollamaRequests.inc();
      try {
        const response = await this.ollama.chat({
          model: this.config.llmModel,
          messages,
          stream: false,
        });
        return response?.message?.content || JSON.stringify(response);
      } catch (err) {
        this.metrics.ollamaErrors.inc();
        this.logger.error("[bridge] LLM call failed", { error: err.message });
        throw err;
      } finally {
        timerEnd();
      }
    });
  }

  /**
   * OpenAI compatible chat completions router helper
   */
  async handleChat(req, res) {
    return await this.tempo.withSpan("handleChat", {}, async () => {
      const endTimer = this.metrics.bridgeLatency.startTimer();
      this.metrics.bridgeRequests.inc();

      try {
        const body = req.body;
        let prompt =
          body.messages?.map((m) => `${m.role}: ${m.content}`).join("\n") ||
          body.prompt ||
          body.input ||
          JSON.stringify(body);

        const respId = `chatcmpl-${crypto.randomUUID()}`;
        const respCreated = Math.floor(Date.now() / 1000);
        const stream = body.stream === true;

        this.logger.info("[bridge] prompt received", { prompt });

        if (stream) {
          this.logger.info(
            "[bridge] response as stream requested by the chat client"
          );
          this.setupStream(res, respId, respCreated);
        }

        const response = await this.processPrompt(
          prompt,
          body,
          stream,
          respId,
          res
        );

        if (!stream) {
          res.json(response);
        }
      } catch (err) {
        this.metrics.bridgeErrors.inc();
        this.logger.error("[bridge] internal error", { error: err.message });
        if (!res.headersSent) {
          res.status(500).json({ error: err.message });
        } else {
          res.end();
        }
      } finally {
        endTimer();
      }
    });
  }

  /**
   * prompt processor helper
   */
  async processPrompt(prompt, body, stream, respId, res) {
    return await this.tempo.withSpan("processPrompt", { prompt }, async () => {
      let finalResponse = "";
      let askLLM = true;
      let parsed;

      if (this.config.mode === "TEST") {
        this.logger.warn("[bridge] test mode active");
        return this.createResponse(respId, "Lorem ipsum dolor sit amet");
      }

      // check if it's an MCP request
      if (prompt.includes("#mcp:grafana")) {
        this.logger.info("[bridge] MCP call to grafana requested");
        if (prompt.endsWith("#mcp:grafana:tools")) {
          this.logger.info("[bridge] MCP server tools list requested");
          parsed = { action: "mcp", method: "tools/list" };
        } else {
          this.logger.info(
            "[bridge] asking LLM to do an MCP request analysis",
            {
              prompt: this.systemPrompt,
            }
          );
          const analysisResponse = await this.callLLM([
            { role: "system", content: this.systemPrompt },
            { role: "user", content: prompt },
          ]);

          this.logger.info("[bridge] MCP request analysis response", {
            response: analysisResponse,
          });

          try {
            parsed = JSON.parse(analysisResponse);
          } catch (err) {
            parsed = { action: "respond", text: prompt };
            this.logger.error("[bridge] MCP request analysis failed", {
              error: err.message,
            });
          }
        }

        // execute MCP call if needed
        if (parsed.action === "mcp" && parsed.method) {
          this.logger.info(
            `[bridge] executing method ${parsed.method} on the MCP Server...`
          );
          const mcpResponse = await this.callMCP(
            parsed.method,
            parsed.params || {}
          );

          if (mcpResponse.error) {
            this.logger.error("[bridge] invalid MCP Server method call", {
              error: mcpResponse?.error?.message,
            });
            finalResponse = "MCP Server internal error (see grafana logs)";
          } else {
            this.logger.info("[bridge] MCP Server response", {
              result: mcpResponse?.result,
            });

            const mcpResult = JSON.stringify(mcpResponse?.result);

            if (prompt.endsWith("#mcp:grafana:tools")) {
              finalResponse = mcpResult;
            } else {
              // ask for LLM to transform the json in a textual response
              this.logger.info("[bridge] asking for LLM final response");
              finalResponse = await this.callLLM([
                {
                  role: "system",
                  content:
                    "You received telemetry data from MCP server. Summarize naturally.",
                },
                { role: "assistant", content: mcpResult },
                {
                  role: "user",
                  content: "Summarize this result in natural language.",
                },
              ]);
            }
          }
          askLLM = false;
        } else {
          this.logger.warn(
            "[bridge] LLM has decided not to use the MCP server for data collection"
          );
        }
      }

      // final response
      if (stream) {
        if (askLLM) {
          this.logger.info("[bridge] asking LLM for a streaming response");
          finalResponse = await this.streamLLMResponse(prompt, res, respId);
        } else {
          this.writeStreamChunk(res, respId, finalResponse);
        }
        this.endStream(res, respId);
        this.logger.info("[bridge] LLM final response", {
          message: finalResponse,
        });
        return {};
      } else {
        if (askLLM) {
          this.logger.info("[bridge] asking LLM for a response");
          finalResponse = await this.callLLM([
            { role: "user", content: prompt },
          ]);
        }
        this.logger.info("[bridge] LLM final response", {
          message: finalResponse,
        });
        return this.createResponse(respId, finalResponse);
      }
    });
  }

  /***
   * Non streaming chat completion response helper
   * @param respId response ID
   * @param content final response
   */
  createResponse(respId, content) {
    return {
      id: respId,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: this.config.llmModel,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content },
          finish_reason: "stop",
        },
      ],
      usage: {},
    };
  }

  /**
   * Chat completion streaming header setup (SSE)
   */
  setupStream(res, id, created) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.write(
      `data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created,
        model: this.config.llmModel,
        choices: [{ index: 0, delta: { role: "assistant" } }],
      })}\n\n`
    );
  }

  /**
   * Chat completion streaming chunk writer (SSE)
   */
  writeStreamChunk(res, id, content) {
    res.write(
      `data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: this.config.llmModel,
        choices: [{ index: 0, delta: { content } }],
      })}\n\n`
    );
  }

  /**
   * Finalize chat completion streaming (SSE)
   */
  endStream(res, id) {
    res.write(
      `data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: this.config.llmModel,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      })}\n\n`
    );
    res.write("data: [DONE]\n\n");
    res.end();
  }

  /**
   * Chat completion streaming response
   */
  async streamLLMResponse(prompt, res, respId) {
    return await this.tempo.withSpan(
      "streamLLMResponse",
      { prompt },
      async () => {
        const timerEnd = this.metrics.ollamaLatency.startTimer();
        let finalResponse = "";
        this.metrics.ollamaRequests.inc();

        try {
          for await (const chunk of await this.ollama.chat({
            model: this.config.llmModel,
            messages: [{ role: "user", content: prompt }],
            stream: true,
          })) {
            if (chunk.message?.content) {
              this.writeStreamChunk(res, respId, chunk.message?.content);
              finalResponse += chunk.message?.content;
            }
            if (chunk.done) break;
          }
        } catch (err) {
          this.metrics.ollamaErrors.inc();
          finalResponse = "[bridge] error in streaming";
          this.logger.error(finalResponse, { error: err.message });
          this.writeStreamChunk(res, respId, finalResponse);
        } finally {
          timerEnd();
        }
        return finalResponse;
      }
    );
  }
}

// bridge service router instance
export const bridge = await new BridgeService().init();
