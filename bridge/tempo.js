import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { trace } from "@opentelemetry/api";
import logger from "./logger.js";

export const tempo = {
  sdk: null,
  tracer: null,

  async init(options = {}) {
    const serviceName =
      options.serviceName || process.env.SERVICE_NAME || "mcp-bridge";
    const tempoUrl =
      options.tempoUrl ||
      process.env.OTLP_ENDPOINT ||
      "http://tempo:4318/v1/traces";
    const env = options.env || process.env.NODE_ENV || "dev";
    const ATTR_DEPLOYMENT_ENVIRONMENT = "deployment.environment.name";

    // ----- OpenTelemetry / Tempo -----
    const traceExporter = new OTLPTraceExporter({ url: tempoUrl });

    this.sdk = new NodeSDK({
      traceExporter,
      resource: resourceFromAttributes({
        [ATTR_SERVICE_NAME]: serviceName,
        [ATTR_DEPLOYMENT_ENVIRONMENT]: env,
      }),
      instrumentations: [new HttpInstrumentation()],
    });

    await this.sdk.start();
    this.tracer = trace.getTracer(serviceName);

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
      return await fn({ log: logger });
    }

    return await this.tracer.startActiveSpan(name, async (span) => {
      try {
        for (const [key, value] of Object.entries(attributes)) {
          span.setAttribute(key, value);
        }

        const ctx = {
          addEvent: (eventName, data = {}) => {
            span.addEvent(eventName, data);
            logger.debug(`event: ${eventName}`, data);
          },
          span,
          log: logger,
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
        logger.error(`Error in span ${name}: ${err.message}`, {
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
