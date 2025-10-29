import express from "express";
import { bridge } from "./BridgeService.js";

const app = express();
app.use(express.json());

app.post(
  "/v1/chat/completions",
  bridge.profiler.middleware({ endpoint: "/v1/chat/completions" }),
  bridge.authMiddleware,
  (req, res) => bridge.handleChat(req, res)
);

app.get(
  "/health",
  bridge.profiler.middleware({ endpoint: "/health" }),
  (req, res) => bridge.metrics.health(req, res)
);

app.get(
  "/metrics",
  bridge.profiler.middleware({ endpoint: "/metrics" }),
  (req, res) => bridge.metrics.metrics(req, res)
);

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  bridge.logger.info(`[bridge] listening on ${PORT})`);
});
