import express from "express";
import { bridge } from "./BridgeService.js";

const app = express();
app.use(express.json());

app.post(
  "/v1/chat/completions",
  bridge.tracer.middleware("chatCompletionsEndpoint"),
  bridge.authMiddleware,
  function chatCompletionsEndpoint(req, res) {
    bridge.handleChat(req, res);
  }
);

app.get(
  "/health",
  //bridge.tracer.middleware("healthEndpoint"),
  function healthEndpoint(req, res) {
    bridge.metrics.health(req, res);
  }
);

app.get(
  "/metrics",
  //bridge.tracer.middleware("metricsEndpoint"),
  function metricsEndpoint(req, res) {
    bridge.metrics.metrics(req, res);
  }
);

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  bridge.logger.info(`[bridge] listening on ${PORT}`);
});
