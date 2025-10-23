import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { trace } from "@opentelemetry/api";
import { LokiLogger } from "./LokiLogger.js";

/**
 * OpenTelemetry Tempo Tracer class
 */
export class TempoTracer {
  /**
   * @param {string} serviceName - service name
   * @param {object} [options] - additional options, ex: { tempoUrl: "http://.../v1/traces", env: "staging" }.
   * @param {string} [options.env] - environment (dev, staging, prod)
   * @param {string} [options.tempoUrl] - Tempo URL
   * @param {LokiLogger} [options.logger] - LokiLogger object
   */
  constructor(serviceName = "app", options = {}) {
    if (!serviceName) {
      throw new Error("[tempo] serviceName is missing.");
    }

    this.serviceName = serviceName;
    this.options = options;
    this.sdk = null;
    this.tracer = null;
    this.provider = null;
    this.exporter = null;
    this.resource = null;

    this.tempoUrl = options.tempoUrl || `${process.env.TEMPO_URL}/v1/traces`;
    this.env = options.env || process.env.NODE_ENV || "dev";
    this.logger = options.logger || new LokiLogger(serviceName);
  }

  /**
   * Tracer initialization
   */
  async init() {
    const ATTR_DEPLOYMENT_ENVIRONMENT = "deployment.environment.name";

    // ----- OpenTelemetry / Tempo -----
    this.exporter = new OTLPTraceExporter({ url: this.tempoUrl });

    this.resource = resourceFromAttributes({
      [ATTR_SERVICE_NAME]: this.serviceName,
      [ATTR_DEPLOYMENT_ENVIRONMENT]: this.env,
    });

    this.sdk = new NodeSDK({
      traceExporter: this.exporter,
      resource: this.resource,
      instrumentations: [
        new HttpInstrumentation(),
        getNodeAutoInstrumentations({
          "@opentelemetry/instrumentation-fs": { enabled: false },
        }),
      ],
    });

    await this.sdk.start();
    this.tracer = trace.getTracer(this.serviceName);

    this.logger.info(
      `[tempo] tracing initialized for ${this.serviceName} (${this.env})`
    );

    process.on("SIGTERM", async () => {
      await this.shutdown();
    });
  }

  /**
   * Method manual span helper
   * @param {string} name span name
   * @param {object} attributes additional attributes
   * @param {Function} fn function to be executed.
   * @example
   *   my_method( params ) {
   *     return await this.tempo.withSpan("my_method", { params }, async () => {
   *        ....
   *     });
   *   }
   */
  async withSpan(name, attributes = {}, fn) {
    if (!this.tracer) {
      console.warn("[tempo] tracer not initialized. Call init() first.");
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
            this.logger.debug(`[tempo] event: ${eventName}`, data);
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
        this.logger.error(`[tempo] error in span ${name}: ${err.message}`, {
          stack: err.stack,
        });
        throw err;
      } finally {
        span.addEvent("span.end", { name });
        span.end();
      }
    });
  }

  /**
   * tracer shutdown
   */
  async shutdown() {
    if (this.sdk) {
      await this.sdk.shutdown();
      console.log(`[tempo] tracing terminated for ${this.serviceName}`);
    }
  }
}

/* -------------------------------------------------------------------------- */
/*                        DECORATORS UTILS (for TypeScript)                   */
/* -------------------------------------------------------------------------- */

function wrapWithSpan(target, methodName, originalMethod) {
  return function (...args) {
    const tempo = this.tempo;
    const logger = this.logger;

    if (!tempo || typeof tempo.withSpan !== "function") {
      logger?.warn?.(
        `[traceable] TempoTracer not initialized for ${methodName}`
      );
      return originalMethod.apply(this, args);
    }

    return tempo.withSpan(methodName, {}, () => {
      try {
        const result = originalMethod.apply(this, args);
        // Retorna direto se for sync, await se for Promise
        return result instanceof Promise ? result : result;
      } catch (err) {
        logger?.error?.(`[traceable] Error in ${methodName}`, {
          error: err.message,
        });
        throw err;
      }
    });
  };
}

/**
 * @traceable — method's auto span decorator
 * @example
 *   @traceable
 *   async myMethod() { ... }
 */
export function traceable(target, propertyKey, descriptor) {
  descriptor.value = wrapWithSpan(target, propertyKey, descriptor.value);
  return descriptor;
}

/**
 * @autoTraceable — class all public methods auto span decorator
 * @example
 *   @autoTraceable
 *   export class MyClass { ... }
 */
export function autoTraceable(targetClass) {
  const methodNames = Object.getOwnPropertyNames(targetClass.prototype).filter(
    (name) =>
      name !== "constructor" &&
      typeof targetClass.prototype[name] === "function"
  );

  for (const methodName of methodNames) {
    const originalMethod = targetClass.prototype[methodName];
    targetClass.prototype[methodName] = wrapWithSpan(
      targetClass.prototype,
      methodName,
      originalMethod
    );
  }

  return targetClass;
}
