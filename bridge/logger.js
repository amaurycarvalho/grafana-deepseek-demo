import winston from "winston";
import LokiTransport from "winston-loki";

/***
 * Loki setup
 */

const LOKI_URL = process.env.LOKI_URL || "http://loki:3100";

const logger = winston.createLogger({
  transports: [
    new LokiTransport({
      host: LOKI_URL,
      labels: {
        app: "mcp-bridge",
        env: process.env.NODE_ENV || "dev",
      },
      json: true,
      replaceTimestamp: true,
      interval: 5,
    }),
  ],
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
});

export default logger;
