import Pyroscope from "@pyroscope/nodejs";
import otel from "./OtelHelper.js";
import { LokiLogger } from "./LokiLogger.js";

export class PyroscopeProfiler {
  constructor({
    appName = "app",
    serverAddress = process.env.PYROSCOPE_URL || "http://pyroscope:4040",
    authToken = process.env.PYROSCOPE_AUTH_TOKEN || "",
  } = {}) {
    this.appName = otel.normalizeIdentifier(appName);
    this.serverAddress = serverAddress;
    this.authToken = authToken;
    this.env = process.env.NODE_ENV || "dev";
    this.region =
      process.env.AWS_REGION ||
      process.env.AZURE_LOCATION ||
      process.env.NODE_REGION ||
      "local";
    this.initialized = false;
    this.logger = new LokiLogger(`pyroscope-${this.appName}`);

    this.init();
  }

  init() {
    try {
      Pyroscope.init({
        appName: this.appName,
        serverAddress: this.serverAddress,
        authToken: this.authToken,
        sampleRate: 10,
        tags: {
          [otel.ATTR_SERVICE_NAME]: this.appName,
          [otel.ATTR_DEPLOYMENT_ENVIRONMENT]: this.env,
          [otel.ATTR_REGION]: this.region,
        },
        sourceMap: true,
      });

      Pyroscope.start();

      this.initialized = true;
      this.logger.info(`[pyroscope] profiler initialized for ${this.appName}.`);
    } catch (err) {
      this.logger.error("[pyroscope] profiler not initialized.", {
        message: err.message,
      });
    }
  }

  /***
   * Pyroscope's express middleware
   * @param {object} labels labels list { label1: value1, label2: value2 ...}
   * @example
   *   app.get("/endpoint", profiler.middleware({ endpoint: "/endpoint" }), (req, res, next) => { ... });
   */
  middleware(labels = { endpoint: "default" }) {
    return (req, res, next) => {
      Pyroscope.wrapWithLabels(labels, async () => {
        next();
      });
    };
  }

  /**
   * Pyroscope's label helper
   * @param labels labels list { label1: value1, label2: value2 ...}
   * @example
   *   my_function( params ) {
   *     return await profiler.withLabels({ function: "my_function" }), async () => {
   *        ....
   *     });
   *   }
   */
  async withLabels(labels = {}, fn) {
    if (!this.initialized) {
      this.logger.warn("[pyroscope] profiler not initialized.");
      return await fn({ log: this.logger });
    }

    return await Pyroscope.wrapWithLabels(labels, async () => {
      try {
        return await fn();
      } catch (err) {
        this.logger.error(`[pyroscope] withLabels(...) error: ${err.message}`, {
          stack: err.stack,
        });
        throw err;
      }
    });
  }
}

/* -------------------------------------------------------------------------- */
/*                        DECORATORS UTILS (for TypeScript)                   */
/* -------------------------------------------------------------------------- */

/**
 * @profiled - Pyroscope.wrapWithLabels() decorator
 * @example
 *   @profiled({ function: "doWork", module: "service" })
 *   async doWork() { ... }
 */
export function profiled(labels = {}) {
  return function (target, propertyKey, descriptor) {
    const originalMethod = descriptor.value;

    descriptor.value = async function (...args) {
      const profiler = this.profiler;
      const methodName = propertyKey;

      if (!profiler || typeof Pyroscope.wrapWithLabels !== "function") {
        this.logger?.warn?.(
          `[profiled] Pyroscope not initialized for ${methodName}`
        );
        return await originalMethod.apply(this, args);
      }

      const fullLabels = {
        function: methodName,
        service: profiler.appName,
        ...labels,
      };

      const maybeAsync = originalMethod.constructor.name === "AsyncFunction";
      return Pyroscope.wrapWithLabels(fullLabels, async () => {
        try {
          const result = maybeAsync
            ? await originalMethod.apply(this, args)
            : originalMethod.apply(this, args);
          return result;
        } catch (err) {
          this.logger?.error?.(`[profiled] Error in ${methodName}`, {
            error: err.message,
          });
          throw err;
        }
      });
    };

    return descriptor;
  };
}
