import otel from "./OtelHelper.js";
import { LokiLogger } from "./LokiLogger.js";

/**
 * OpenTelemetry Tempo Tracer class
 */
export class TempoTracer {
  /**
   * @param {string} serviceName - service name
   * @param {object} [options] - additional options, ex: { apiUrl: "http://.../v1/traces", env: "staging" }.
   * @param {string} [options.env] - environment (dev, staging, prod)
   * @param {string} [options.apiUrl] - Tempo URL
   * @param {string} [options.apiKey] - Tempo API key
   */
  constructor(serviceName = "app", options = {}) {
    if (!serviceName) {
      throw new Error("[tempo] serviceName is missing.");
    }

    this.serviceName = otel.normalizeIdentifier(serviceName);
    this.env = options.env || process.env.NODE_ENV || "dev";
    this.region =
      process.env.AWS_REGION ||
      process.env.AZURE_LOCATION ||
      process.env.NODE_REGION ||
      "local";
    this.options = options;
    this.tracer = null;
    this.provider = null;
    this.exporter = null;
    this.resource = null;

    this.apiUrl = `${options.apiUrl || process.env.TEMPO_API_URL}/v1/traces`;
    this.apiKey = options.apiKey || process.env.TEMPO_API_KEY || "";
    this.logger = new LokiLogger(`tempo-${serviceName}`);
  }

  /**
   * Tracer initialization
   */
  async init() {
    otel.diag.setLogger(
      {
        debug: (msg, ...args) =>
          this.logger.debug(`[tempo.otel] ${msg}`, ...args),
        info: (msg, ...args) =>
          this.logger.info(`[tempo.otel] ${msg}`, ...args),
        warn: (msg, ...args) =>
          this.logger.warn(`[tempo.otel] ${msg}`, ...args),
        error: (msg, ...args) =>
          this.logger.error(`[tempo.otel] ${msg}`, ...args),
      },
      otel.DiagLogLevel.INFO // DEBUG, INFO, WARN, ERROR
    );

    // ----- OpenTelemetry / Tempo -----
    try {
      this.exporter = new otel.OTLPTraceExporter({
        url: this.apiUrl,
        headers: {
          "x-api-key": this.apiKey,
        },
      });
      this.logger.info(`[tempo] OTLP exporter created for ${this.apiUrl}`);
    } catch (err) {
      this.logger.error(
        `[tempo] failed to create OTLP exporter: ${err.message}`
      );
      return;
    }

    this.resource = otel.resourceFromAttributes({
      [otel.ATTR_SERVICE_NAME]: this.serviceName,
      [otel.ATTR_DEPLOYMENT_ENVIRONMENT]: this.env,
      [otel.ATTR_REGION]: this.region,
    });

    this.provider = new otel.NodeTracerProvider({
      resource: this.resource,
      spanProcessors: [new otel.SimpleSpanProcessor(this.exporter)],
    });
    this.provider.register();

    otel.registerInstrumentations({
      instrumentations: [
        otel.getNodeAutoInstrumentations({
          "@opentelemetry/instrumentation-http": {
            applyCustomAttributesOnSpan: (span) => {
              span.setAttribute("otel.instrumented", true);
            },
          },
          "@opentelemetry/instrumentation-fs": { enabled: false },
        }),
        new otel.WinstonInstrumentation(),
      ],
    });

    this.tracer = otel.trace.getTracer(this.serviceName);

    this.logger.info(
      `[tempo] tracing initialized for ${this.serviceName} (${this.env})`
    );

    process.on("SIGTERM", async () => {
      await this.shutdown();
    });
  }

  /**
   * tracer shutdown
   */
  async shutdown() {
    if (this.provider) {
      await this.provider.shutdown();
      console.log(`[tempo] tracing terminated for ${this.serviceName}`);
    }
  }

  /***
   * Tempo's express middleware
   * @param {string} name span name
   * @example
   *   app.get("/endpoint", tracer.middleware( "/endpoint" ), (req, res, next) => { ... });
   */
  middleware(name) {
    return (req, res, next) => {
      this.withSpan(name, {}, async () => {
        next();
      });
    };
  }

  /**
   * Tempo's span helper
   * @param {string} name span name
   * @param {object} attributes additional attributes
   * @param {Function} fn function to be executed.
   * @example
   *   my_function( params ) {
   *     return await tempo.withSpan("my_function", { params }, async () => {
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
          let safeValue = value;
          if (typeof value === "object" && value !== null) {
            safeValue = JSON.stringify(value);
          }
          span.setAttribute(key, safeValue);
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
