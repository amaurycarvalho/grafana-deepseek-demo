import Pyroscope from "@pyroscope/nodejs";

export class PyroscopeProfiler {
  constructor({
    appName = "app",
    serverAddress = process.env.PYROSCOPE_URL || "http://pyroscope:4040",
    authToken = process.env.PYROSCOPE_AUTH_TOKEN || "",
  } = {}) {
    this.appName = appName;
    this.serverAddress = serverAddress;
    this.authToken = authToken;

    this.init();
  }

  init() {
    Pyroscope.init({
      appName: this.appName,
      serverAddress: this.serverAddress,
      authToken: this.authToken,
      sampleRate: 10,
      tags: {
        env: process.env.NODE_ENV || "dev",
        service: this.appName,
      },
      labels: {},
      sourceMap: true,
    });

    Pyroscope.start();
  }

  middleware(labels) {
    return (req, res, next) => {
      Pyroscope.wrapWithLabels(labels, async () => {
        next();
      });
    };
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
      const profiler = this.profiler; // espera-se que a classe tenha this.profiler = new PyroscopeProfiler(...)
      const methodName = propertyKey;

      if (!profiler || typeof Pyroscope.wrapWithLabels !== "function") {
        this.logger?.warn?.(
          `[profiled] Pyroscope not initialized for ${methodName}`
        );
        return await originalMethod.apply(this, args);
      }

      // Adiciona automaticamente o nome do método aos labels
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
