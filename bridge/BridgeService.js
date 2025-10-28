import fs from "fs";
import { TempoTracer } from "./helpers/TempoTracer.js";
import { LokiLogger } from "./helpers/LokiLogger.js";
import { PyroscopeProfiler } from "./helpers/PyroscopeProfiler.js";
import { BridgeMetrics } from "./BridgeMetrics.js";
import { OllamaHelper } from "./helpers/OllamaHelper.js";
import { GrafanaMcp } from "./helpers/GrafanaMcp.js";

/**
 * Bridge Service
 * Grafana OSS and Ollama LLM integration specialized class
 */
export class BridgeService {
  /**
   * @param {object} options
   * @param {string} [options.serviceName] - service name
   * @param {string} [options.mode] - operation mode ("LLM" or "TEST")
   * @param {string} [options.systemPromptPath] - system prompt path (.mdc)
   * @param {string} [options.apiKey] - system prompt path (.mdc)
   */
  constructor(options = {}) {
    this.config = {
      mode: options.mode || process.env.BRIDGE_MODE || "LLM",
      serviceName:
        options.serviceName || process.env.BRIDGE_SERVICE_NAME || "llm-bridge",
      systemPromptPath:
        options.systemPromptPath ||
        process.env.BRIDGE_SYSTEM_PROMPT_PATH ||
        "./resources",
      apiKey: options.apiKey || process.env.BRIDGE_API_KEY,
    };

    this.logger = new LokiLogger(this.config.serviceName, {
      level: process.env.BRIDGE_LOG_LEVEL,
    });
    this.metrics = new BridgeMetrics();
    this.profiler = new PyroscopeProfiler({ appName: this.config.serviceName });
    this.tempo = null; // see init()
    this.systemPrompt = null; // see init()

    this.ollama = new OllamaHelper({
      logLevel: process.env.BRIDGE_LOG_LEVEL,
    });

    this.mcp = new GrafanaMcp();
  }

  /***
   * service initializer
   */
  async init() {
    try {
      this.tempo = new TempoTracer(this.config.serviceName);
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
    try {
      const fileName = `${this.config.systemPromptPath}/system-prompt.mdc`;
      this.logger.debug("[bridge] loading MCP system prompt", {
        file: fileName,
      });
      return fs.readFileSync(fileName, "utf-8");
    } catch (err) {
      this.logger.error("[bridge] failed to load MCP system prompt", {
        message: err.message,
      });
      return "";
    }
  }

  /**
   * OpenAI compatible chat completions router helper
   */
  async handleChat(req, res) {
    return await this.tempo.withSpan("handleChat", {}, async () => {
      const bridgeTimerEnd = this.metrics.bridgeLatency.startTimer();
      this.metrics.bridgeRequests.inc();

      try {
        let helper = this.ollama.getHelperFromRequest(req, res);

        // force to use bridge default model
        helper.answer.model = helper.answer.defaultModel;

        // check if test mode
        if (this.config.mode === "TEST") {
          this.logger.warn("[bridge] test mode active");
          helper.answer.content = "Lorem ipsum dolor sit amet";
        } else {
          await this.checkMCP(helper);
        }

        const ollamaTimerEnd = this.metrics.ollamaLatency.startTimer();
        this.metrics.ollamaRequests.inc();
        try {
          await this.ollama.answerChat(helper);
        } catch (err) {
          this.metrics.ollamaErrors.inc();
          this.logger.error("[bridge] LLM call for an answer failed", {
            error: err.message,
          });
          throw err;
        } finally {
          ollamaTimerEnd();
        }
      } catch (err) {
        this.metrics.bridgeErrors.inc();
        this.logger.error("[bridge] internal error", {
          error: err.message,
          stack: err.stack,
        });
        if (!res.headersSent) {
          res.status(500).json({ error: err.message });
        } else {
          res.end();
        }
      } finally {
        bridgeTimerEnd();
      }
    });
  }

  /**
   * MCP processor helper
   * check if it's an MCP request
   */
  async checkMCP(helper) {
    return await this.tempo.withSpan(
      "checkMCP",
      { prompt: helper.prompt },
      async () => {
        if (helper?.prompt?.messages.length) {
          const lines =
            helper.prompt.messages[
              helper.prompt.messages.length - 1
            ].content.split("\n");
          const lastLine = lines[lines.length - 1];
          if (lastLine.startsWith("#mcp:grafana")) {
            this.logger.debug("[bridge] MCP call to grafana requested", {
              message: lastLine,
              tools: this.mcp.tools,
            });
            helper.prompt.tools = this.mcp.tools;

            // ask LLM opinion
            const ollamaTimerEnd = this.metrics.ollamaLatency.startTimer();
            this.metrics.ollamaRequests.inc();
            try {
              await this.ollama.callLLM(helper);
              this.logger.debug(
                "[bridge] LLM opinion related to the MCP call",
                {
                  prompt: helper.prompt,
                  answer: helper.answer,
                }
              );
            } catch (err) {
              this.metrics.ollamaErrors.inc();
              this.logger.error("[bridge] LLM call for MCP opinion failed", {
                error: err.message,
              });
              throw err;
            } finally {
              ollamaTimerEnd();
            }

            // execute MCP call
            if (helper.answer.tool_calls.length) {
              const mcpTimerEnd = this.metrics.mcpLatency.startTimer();
              this.metrics.mcpRequests.inc();
              try {
                const results = await this.mcp.executeTools(
                  helper.answer.tool_calls
                );
                /*
                helper.prompt.messages.push({
                  role: "assistant",
                  content: "",
                  tool_calls: helper.answer.tool_calls,
                });
                */
                for (const result of results) {
                  helper.prompt.messages.push(result);
                }
                helper.answer.content = "";
                helper.prompt.tools = null;

                this.logger.debug("[bridge] MCP call executed", {
                  new_prompt: helper.prompt,
                });
              } catch (err) {
                this.metrics.mcpErrors.inc();
                this.logger.error("[bridge] MCP call failed", {
                  error: err.message,
                });
                throw err;
              } finally {
                mcpTimerEnd();
              }
            }
          }
        }
      }
    );
  }
}

// bridge service router instance
export const bridge = await new BridgeService().init();
