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
    this.tempo = await new TempoTracer(this.config.serviceName, {
      logger: this.logger,
    }).init();

    this.systemPrompt = this.loadSystemPrompt();
    this.logger.info(`[bridge] ${this.config.serviceName} initialized`);
    return this;
  }

  /***
   * system prompt loader
   */
  loadSystemPrompt() {
    this.logger.info("Loading system prompt", {
      file: this.config.systemPromptPath,
    });
    return fs.readFileSync(this.config.systemPromptPath, "utf-8");
  }

  /**
   * MCP server caller (JSON-RPC helper)
   */
  async callMCP(method, params) {
    return await this.tempo.withSpan("call_mcp", { method }, async () => {
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
        this.logger.error("MCP call failed", { error: err.message });
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
    return await this.tempo.withSpan("call_llm", { messages }, async () => {
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
        this.logger.error("LLM call failed", { error: err.message });
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

      if (stream) {
        this.setupStream(res, respId, respCreated);
      }

      this.logger.info("Prompt received", { prompt });
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
      this.logger.error("Bridge error", { error: err.message });
      if (!res.headersSent) {
        res.status(500).json({ error: err.message });
      } else {
        res.end();
      }
    } finally {
      endTimer();
    }
  }

  /**
   * prompt processor helper
   */
  async processPrompt(prompt, body, stream, respId, res) {
    let finalResponse = "";
    let askLLM = true;
    let parsed;

    if (this.config.mode === "TEST") {
      this.logger.warn("Test mode active");
      return this.createResponse(respId, "Lorem ipsum dolor sit amet");
    }

    // check if it's an MCP request
    if (prompt.includes("#mcp:grafana")) {
      if (prompt.endsWith("#mcp:grafana:tools")) {
        parsed = { action: "mcp", method: "tools/list" };
      } else {
        const analysisResponse = await this.callLLM([
          { role: "system", content: this.systemPrompt },
          { role: "user", content: prompt },
        ]);
        try {
          parsed = JSON.parse(analysisResponse);
        } catch {
          parsed = { action: "respond", text: prompt };
        }
      }

      // execute MCP call if needed
      if (parsed.action === "mcp" && parsed.method) {
        const mcpResponse = await this.callMCP(
          parsed.method,
          parsed.params || {}
        );
        const mcpResult = JSON.stringify(mcpResponse?.result);

        if (prompt.endsWith("#mcp:grafana:tools")) {
          finalResponse = mcpResult;
        } else {
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

        askLLM = false;
      }
    }

    // final response
    if (stream) {
      if (askLLM) {
        await this.streamLLMResponse(prompt, res, respId);
      } else {
        this.writeStreamChunk(res, respId, finalResponse);
      }
      this.endStream(res, respId);
    } else {
      if (askLLM) {
        finalResponse = await this.callLLM([{ role: "user", content: prompt }]);
      }
      return this.createResponse(respId, finalResponse);
    }
  }

  /***
   * Non streaming chat completion response helper
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
    const timerEnd = this.metrics.ollamaLatency.startTimer();
    this.metrics.ollamaRequests.inc();

    try {
      for await (const chunk of await this.ollama.chat({
        model: this.config.llmModel,
        messages: [{ role: "user", content: prompt }],
        stream: true,
      })) {
        if (chunk.message?.content) {
          this.writeStreamChunk(res, respId, chunk.message.content);
        }
        if (chunk.done) break;
      }
    } catch (err) {
      this.metrics.ollamaErrors.inc();
      this.logger.error("Stream error", { error: err.message });
      this.writeStreamChunk(res, respId, "Error in streaming");
    } finally {
      timerEnd();
    }
  }
}

// bridge service router instance
export const bridge = await new BridgeService().init();
