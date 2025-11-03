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
   * @param {string} [options.apiKey] - system prompt path (.mdc)
   */
  constructor(options = {}) {
    this.config = {
      serviceName:
        options.serviceName ||
        process.env.LLM_BRIDGE_SERVICE_NAME ||
        "llm-bridge",
      apiKey: options.apiKey || process.env.LLM_BRIDGE_API_KEY,
    };

    this.logger = new LokiLogger(this.config.serviceName, {
      level: process.env.LLM_BRIDGE_LOG_LEVEL,
    });
    this.metrics = new BridgeMetrics();
    this.profiler = new PyroscopeProfiler({ appName: this.config.serviceName });
    this.tracer = null; // see init()

    this.ollama = new OllamaHelper({
      logLevel: process.env.LLM_BRIDGE_LOG_LEVEL,
    });

    this.mcp = new GrafanaMcp();
  }

  /***
   * service initializer
   */
  async init() {
    try {
      this.tracer = new TempoTracer(this.config.serviceName);
      await this.tracer.init();

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
   * Authorization middleware
   */
  authMiddleware(req, res, next) {
    if (process.env.LLM_BRIDGE_API_KEY) {
      const authKey = req.headers.authorization?.replace("Bearer ", "");
      const apiKey = req?.body?.prompt?.apiKey;
      if (!authKey || authKey !== process.env.LLM_BRIDGE_API_KEY) {
        if (!apiKey || apiKey !== process.env.LLM_BRIDGE_API_KEY) {
          return res.status(401).json({ error: "Unauthorized" });
        }
      }
    }
    next();
  }

  /**
   * OpenAI compatible chat completions router helper
   */
  async handleChat(req, res) {
    return await this.tracer.withSpan("handleChat", {}, async () => {
      const bridgeTimerEnd = this.metrics.bridgeLatency.startTimer();
      this.metrics.bridgeRequests.inc();

      try {
        let helper = this.ollama.getHelperFromRequest(req, res);

        // force to use bridge default model
        helper.answer.model = helper.answer.defaultModel;

        this.profiler.withLabels({ method: "_checkOWASP" }, () => {
          if (!this._checkOWASP(helper)) {
            helper.answer.content = "Invalid prompt";
          }
        });

        await this._checkMCP(helper);

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

  /***
   * Check prompt integrity (OWASP)
   * @param helper Ollama helper object
   * @returns true/false
   * @see
   * https://owasp.org/www-project-top-10-for-large-language-model-applications/
   * https://genai.owasp.org/llm-top-10/
   */
  _checkOWASP(helper) {
    // LLM01: Prompt Injection
    // LLM02: Sensitive Information Disclosure
    // LLM03: Supply Chain
    // LLM04: Data and Model Poisoning
    // LLM05: Improper Output Handling
    // LLM06: Excessive Agency
    // LLM07: System Prompt Leakage
    // LLM08: Vector and Embedding Weaknesses
    // LLM09: Misinformation
    // LLM10: Unbounded Consumption
    return this.ollama.checkOWASP(helper);
  }

  /**
   * MCP processor helper
   * check if it's an MCP request
   */
  async _checkMCP(helper) {
    return await this.tracer.withSpan(
      "checkMCP",
      { prompt: helper.prompt },
      async () => {
        if (helper?.prompt?.messages.length) {
          const lines =
            helper.prompt.messages[
              helper.prompt.messages.length - 1
            ].content.split("\n");
          const lastLine = lines[lines.length - 1];

          if (lastLine.startsWith("#llm:test")) {
            this.logger.warn("[bridge] test mode activated");
            helper.answer.content = "Lorem ipsum dolor sit amet";
            return;
          } else if (lastLine.startsWith("#mcp:grafana")) {
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
                helper.prompt.messages.push({
                  role: "assistant",
                  content: "",
                  tool_calls: helper.answer.tool_calls,
                });
                const results = await this.mcp.executeTools(
                  helper.answer.tool_calls
                );
                for (const result of results) {
                  const message = {
                    role: "tool",
                    name: result.name,
                    content: JSON.stringify(
                      result.error
                        ? { error: result.error }
                        : result.result
                        ? { result: result.result }
                        : { result }
                    ),
                  };
                  helper.prompt.messages.push(message);
                }
                helper.prompt.messages.push({
                  role: "system",
                  content:
                    "Respond to the user's latest interaction based on the result from the previous tool.",
                });
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
