// tempo.js
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { Resource } from "@opentelemetry/resources";
import { SemanticResourceAttributes } from "@opentelemetry/semantic-conventions";
import { trace, context } from "@opentelemetry/api";
import winston from "winston";
import LokiTransport from "winston-loki";

export const tempo = {
  sdk: null,
  tracer: null,
  logger: null,

  async init(options = {}) {
    const serviceName =
      options.serviceName || process.env.SERVICE_NAME || "mcp-bridge";
    const tempoUrl =
      options.tempoUrl ||
      process.env.OTLP_ENDPOINT ||
      "http://tempo:4318/v1/traces";
    const lokiUrl =
      options.lokiUrl ||
      process.env.LOKI_URL ||
      "http://loki:3100/loki/api/v1/push";
    const env = options.env || process.env.NODE_ENV || "dev";

    // ----- OpenTelemetry / Tempo -----
    const traceExporter = new OTLPTraceExporter({ url: tempoUrl });

    this.sdk = new NodeSDK({
      traceExporter,
      resource: new Resource({
        [SemanticResourceAttributes.SERVICE_NAME]: serviceName,
        [SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT]: env,
      }),
      instrumentations: [new HttpInstrumentation()],
    });

    await this.sdk.start();
    this.tracer = trace.getTracer(serviceName);

    // ----- Winston / Loki -----
    this.logger = winston.createLogger({
      level: "info",
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({ level, message, timestamp, ...meta }) => {
          const span = trace.getSpan(context.active());
          const traceId = span?.spanContext()?.traceId || "none";
          const spanId = span?.spanContext()?.spanId || "none";
          return `${timestamp} [${level}] [trace:${traceId}] [span:${spanId}] ${message} ${
            Object.keys(meta).length ? JSON.stringify(meta) : ""
          }`;
        })
      ),
      transports: [
        new winston.transports.Console(),
        new LokiTransport({
          host: lokiUrl,
          labels: { service: serviceName, env },
          json: true,
        }),
      ],
    });

    console.log(
      `[tempo] tracing+logging initialized for ${serviceName} (${env})`
    );

    process.on("SIGTERM", async () => {
      await this.sdk.shutdown();
      console.log("[tempo] tracing terminated");
    });
  },

  async withSpan(name, attributes = {}, fn) {
    if (!this.tracer) {
      console.warn("[tempo] tracer not initialized. Call tempo.init() first.");
      return await fn({ log: this.logger });
    }

    return await this.tracer.startActiveSpan(name, async (span) => {
      try {
        for (const [key, value] of Object.entries(attributes)) {
          span.setAttribute(key, value);
        }

        const ctx = {
          addEvent: (eventName, data = {}) => {
            span.addEvent(eventName, data);
            this.logger.debug(`event: ${eventName}`, data);
          },
          span,
          log: this.logger,
        };

        ctx.addEvent("span.start", { name });

        const result = await fn(ctx);

        ctx.addEvent("span.success", { resultType: typeof result });
        span.setStatus({ code: 1 });
        return result;
      } catch (err) {
        span.addEvent("span.error", { message: err.message });
        span.recordException(err);
        span.setStatus({ code: 2, message: err.message });
        this.logger.error(`Error in span ${name}: ${err.message}`, {
          stack: err.stack,
        });
        throw err;
      } finally {
        span.addEvent("span.end", { name });
        span.end();
      }
    });
  },
};
