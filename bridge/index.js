import express from "express";
import crypto from "crypto";
import fs from "fs";
import fetch from "node-fetch";
import client from "prom-client";
import Pyroscope from "@pyroscope/nodejs";
import winston from "winston";
import LokiTransport from "winston-loki";
import { Ollama } from "ollama";

/***
 * Main configuration
 */
const app = express();
app.use(express.json());

const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://ollama:11434";
const LLM_MODEL = process.env.LLM_MODEL || "deepseek-r1:1.5b";
const MCP_URL = process.env.MCP_URL || "http://mcp-grafana:8000";
const LOKI_URL = process.env.LOKI_URL || "http://loki:3100";
const PYROSCOPE_URL = process.env.PYROSCOPE_URL || "http://pyroscope:4040";
const PYROSCOPE_AUTH_TOKEN = process.env.PYROSCOPE_AUTH_TOKEN || "";
const BRIDGE_MODE = process.env.BRIDGE_MODE || "LLM"; // LLM or TEST
const SYSTEM_PROMPT_MDC =
  process.env.SYSTEM_PROMPT_MDC || "./system-prompt.mdc";

const ollama = new Ollama({ host: OLLAMA_HOST });

/**
 * Prometheus metrics setup
 */
const register = new client.Registry();
client.collectDefaultMetrics({ register });

const bridgeRequests = new client.Counter({
  name: "bridge_requests_total",
  help: "Total requests received by the bridge",
});
const bridgeErrors = new client.Counter({
  name: "bridge_errors_total",
  help: "Total errors occurred in the bridge",
});
const bridgeLatency = new client.Histogram({
  name: "bridge_request_latency_seconds",
  help: "Bridge response time",
  buckets: [0.5, 1, 2, 5, 10, 30, 60, 120, 180, 300, 600],
});
const bridgeHealth = new client.Gauge({
  name: "bridge_health_status",
  help: "Bridge health status (1 = healthy, 0 = failed last check)",
});
const mcpRequests = new client.Counter({
  name: "bridge_mcp_requests_total",
  help: "Total calls made to the MCP Server",
});
const mcpLatency = new client.Histogram({
  name: "bridge_mcp_latency_seconds",
  help: "MCP Server Response Time",
});
const mcpErrors = new client.Counter({
  name: "bridge_mcp_errors_total",
  help: "Total errors occurred when calling the MCP Server",
});
const ollamaRequests = new client.Counter({
  name: "bridge_ollama_requests_total",
  help: "Total calls made to Ollama",
});
const ollamaLatency = new client.Histogram({
  name: "bridge_ollama_latency_seconds",
  help: "Ollama response time",
  buckets: [0.5, 1, 2, 5, 10, 30, 60, 120, 180, 300, 600],
});
const ollamaErrors = new client.Counter({
  name: "bridge_ollama_errors_total",
  help: "Total errors occurred in the call to Ollama",
});

register.registerMetric(bridgeRequests);
register.registerMetric(bridgeErrors);
register.registerMetric(bridgeLatency);
register.registerMetric(bridgeHealth);
register.registerMetric(mcpRequests);
register.registerMetric(mcpLatency);
register.registerMetric(mcpErrors);
register.registerMetric(ollamaRequests);
register.registerMetric(ollamaLatency);
register.registerMetric(ollamaErrors);

/***
 * Pyroscope profiler setup
 */
Pyroscope.init({
  appName: "mcp-bridge",
  serverAddress: PYROSCOPE_URL,
  authToken: PYROSCOPE_AUTH_TOKEN,
  sampleRate: 10,
  tags: {
    env: process.env.NODE_ENV || "dev",
    service: "bridge",
  },
  labels: {},
  sourceMap: true,
});
Pyroscope.start();

function pyroscopeSetLabelsMiddleware(labels) {
  return (req, res, next) => {
    Pyroscope.wrapWithLabels(labels, async () => {
      next();
    });
  };
}

/***
 * Loki setup
 */

const logger = winston.createLogger({
  transports: [
    new LokiTransport({
      host: LOKI_URL,
      labels: { app: "mcp-bridge", env: process.env.NODE_ENV || "dev" },
      json: true,
      replaceTimestamp: true,
      interval: 5, // segundos entre flushes
    }),
  ],
});

/***
 * System prompt load
 */

function loadSystemPrompt() {
  logger.info("Loading system prompt", { filename: SYSTEM_PROMPT_MDC });
  return fs.readFileSync(SYSTEM_PROMPT_MDC, "utf-8");
}

const SYSTEM_PROMPT = loadSystemPrompt();

/**
 * MCP server helper (JSON-RPC)
 * @param method MCP method name
 * @param params MCP method params object
 * @returns MCP response
 */
async function callMCP(method, params) {
  //return Pyroscope.wrapWithLabels(
  //  { function: "callMCP", app: "bridge" },
  //  async () => {
  const timerEnd = mcpLatency.startTimer();
  mcpRequests.inc();
  try {
    const url = `${MCP_URL}/mcp`;

    const payload = {
      jsonrpc: "2.0",
      id: "1",
      method,
      params,
    };

    // POST to MCP Server
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`MCP server error: ${text}`);
    }

    const data = await res.json();

    return data;
  } catch (err) {
    mcpErrors.inc();
    throw err;
  } finally {
    timerEnd();
  }
  //    }
  //  );
}

/**
 * Call LLM (DeepSeek) via Ollama
 * @param {*} messages message object
 * @returns LLM response
 */
async function callLLM(messages) {
  //return Pyroscope.wrapWithLabels(
  //  { function: "callLLM", app: "bridge" },
  //  async () => {
  const timerEnd = ollamaLatency.startTimer();
  ollamaRequests.inc();
  try {
    const response = await ollama.chat({
      model: LLM_MODEL,
      messages: messages,
      stream: false,
    });
    return response?.message?.content || JSON.stringify(response);
  } catch (err) {
    ollamaErrors.inc();
    throw err;
  } finally {
    timerEnd();
  }
  //  }
  //);
}

/***
 * Ollama Chat endpoint
 * "LLM" mode: send data direct to LLM
 * "MCP" mode: do the MCP server → LLM integration
 */
app.post(
  "/v1/chat/completions",
  pyroscopeSetLabelsMiddleware({
    endpoint: "/v1/chat/completions",
  }),
  async (req, res) => {
    const endTimer = bridgeLatency.startTimer();
    bridgeRequests.inc();

    try {
      const body = req.body;
      let prompt = "";

      if (body.messages) {
        prompt = body.messages.map((m) => `${m.role}: ${m.content}`).join("\n");
      } else if (body.prompt) {
        prompt = body.prompt;
      } else if (body.input) {
        prompt = body.input;
      } else {
        prompt = JSON.stringify(body);
      }

      const respId = `chatcmpl-${crypto.randomUUID()}`;
      //  req.headers["chatcmpl-id"] || `chatcmpl-${crypto.randomUUID()}`;
      let respCreated = Math.floor(Date.now() / 1000);

      if (body.stream) {
        logger.info("Prompt received (response as stream requested)", {
          prompt,
        });
        // --- STREAMING MODE ---
        // stream's header
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        // stream's start
        res.write(
          `data: ${JSON.stringify({
            id: respId,
            object: "chat.completion.chunk",
            created: respCreated,
            model: LLM_MODEL,
            choices: [
              {
                index: 0,
                delta: { role: "assistant" },
              },
            ],
          })}\n\n`
        );
      } else {
        logger.info("Prompt received", { prompt });
      }

      let finalResponse = "";
      let askLLM = true;
      let parsed;

      // check LLM mode (LLM or TEST)
      if (BRIDGE_MODE === "LLM") {
        // check if it's an MCP prompt request
        if (prompt.includes("#mcp:grafana")) {
          logger.info("MCP call to grafana requested");
          if (prompt.includes("#mcp:grafana:tools")) {
            logger.info("MCP server tools list requested");
            parsed = { action: "mcp", method: "tools/list" };
          } else {
            logger.info("Asking LLM to do an MCP request analysis", {
              prompt: SYSTEM_PROMPT,
            });
            const analysisResponse = await callLLM([
              { role: "system", content: SYSTEM_PROMPT },
              { role: "user", content: prompt?.user },
            ]);

            logger.info("MCP request analysis response", {
              response: analysisResponse,
            });

            try {
              parsed = JSON.parse(analysisResponse);
            } catch (err) {
              parsed = { action: "respond", text: prompt };
              logger.error("MCP request analysis failed", {
                error: err.message,
              });
            }
          }

          // check if LLM decided to do an MCP call
          if (parsed.action === "mcp" && parsed.method) {
            logger.info(
              `Executing method ${parsed.method} on the MCP Server...`
            );

            const mcpResponse = await callMCP(
              parsed.method,
              parsed.params || {}
            );

            if (mcpResponse.error) {
              logger.error("Invalid MCP Server method call", {
                error: mcpResponse?.error?.message,
              });
              finalResponse = "MCP Server internal error (see grafana logs)";
            } else {
              logger.info("MCP Server response", {
                result: mcpResponse?.result,
              });

              const mcpResult = JSON.stringify(mcpResponse?.result);

              if (prompt.includes("#mcp:grafana:tools")) {
                finalResponse = mcpResult;
              } else {
                // ask for LLM to transform the json in a textual response
                logger.info("Asking for LLM final response");
                finalResponse = await callLLM([
                  {
                    role: "system",
                    content:
                      "You received the following telemetry data from MCP server. Summarize and explain it naturally to the user:",
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
            logger.warn(
              "LLM has decided not to use the MCP server for data collection"
            );
          }
        } else {
          askLLM = true;
        }
      } else {
        logger.warn("Test mode activated");
        finalResponse =
          "Lorem ipsum dolor sit amet, consectetur adipiscing elit";
        askLLM = false;
      }

      /// Return result to Grafana LLM App in the OpenAI format
      respCreated = Math.floor(Date.now() / 1000);
      if (body.stream) {
        // --- STREAMING MODE ---
        if (askLLM) {
          const timerEnd = ollamaLatency.startTimer();
          ollamaRequests.inc();
          logger.info("Asking LLM for a streaming response");
          try {
            for await (const chunk of await ollama.chat({
              model: LLM_MODEL,
              messages: [{ role: "user", content: prompt }],
              stream: true,
            })) {
              if (chunk.message?.content) {
                respCreated = Math.floor(Date.now() / 1000);
                res.write(
                  `data: ${JSON.stringify({
                    id: respId,
                    object: "chat.completion.chunk",
                    created: respCreated,
                    model: LLM_MODEL,
                    choices: [
                      {
                        index: 0,
                        delta: { content: chunk.message.content },
                      },
                    ],
                  })}\n\n`
                );
                logger.info("Response streaming", {
                  delta: chunk.message.content,
                });
                finalResponse += chunk.message.content;
              }
              if (chunk.done) {
                logger.info("Response stream ending", {
                  delta: finalResponse,
                });
                break;
              }
            }
          } catch (err) {
            finalResponse = "Error in LLM response streaming";
            logger.error(finalResponse, { error: err.message });
            ollamaErrors.inc();
          } finally {
            timerEnd();
          }
        } else {
          res.write(
            `data: ${JSON.stringify({
              id: respId,
              object: "chat.completion.chunk",
              created: respCreated,
              model: LLM_MODEL,
              choices: [
                {
                  index: 0,
                  delta: { content: finalResponse },
                },
              ],
            })}\n\n`
          );
        }
        logger.info("LLM final response (as stream)", {
          message: finalResponse,
        });
        // stream's end
        res.write(
          `data: ${JSON.stringify({
            id: respId,
            object: "chat.completion.chunk",
            created: respCreated,
            model: LLM_MODEL,
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: "stop",
              },
            ],
          })}\n\n`
        );
        res.write("data: [DONE]\n\n");
        res.end();
      } else {
        // --- NON-STREAMING MODE ---
        if (askLLM) {
          logger.info("Asking LLM for a response");
          finalResponse = await callLLM([{ role: "user", content: prompt }]);
        }

        logger.info("LLM final response", { message: finalResponse });

        const result = {
          id: respId,
          object: "chat.completion",
          created: respCreated,
          model: LLM_MODEL,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: finalResponse,
              },
              finish_reason: "stop",
            },
          ],
          usage: {},
        };
        res.json(result);
      }
    } catch (err) {
      if (res.headersSent) {
        res.end();
      } else {
        res.status(500).json({ error: err.message });
      }
      bridgeErrors.inc();
      logger.error("Bridge error", { error: err.message });
    } finally {
      endTimer();
    }
  }
);

/***
 * Health and Metrics endpoint
 */
app.get(
  "/health",
  pyroscopeSetLabelsMiddleware({ endpoint: "/health" }),
  (req, res) => {
    try {
      bridgeHealth.set(1);
      res.json({ status: "ok" });
    } catch (err) {
      bridgeHealth.set(0);
      res.status(500).json({ status: "error", error: err.message });
    }
  }
);

app.get(
  "/metrics",
  pyroscopeSetLabelsMiddleware({ endpoint: "/metrics" }),
  async (req, res) => {
    res.set("Content-Type", register.contentType);
    res.end(await register.metrics());
  }
);

/***
 * Initialization
 */
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(
    `bridge listening on ${PORT} [mode=${BRIDGE_MODE}] (model=${LLM_MODEL}, MCP=${MCP_URL})`
  );
  logger.info(
    `bridge listening on ${PORT} [mode=${BRIDGE_MODE}] (model=${LLM_MODEL}, MCP=${MCP_URL})`
  );
});
