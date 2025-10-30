import { LoggerHelper } from "./LoggerHelper.js";
import otel from "./OtelHelper.js";

/**
 * Loki Logger class
 */
export class LokiLogger extends LoggerHelper {
  /**
   * @param {string} serviceName - service name
   * @param {object} [options] - additional options, ex: { env: "staging", lokiUrl: "http://...", console: true }
   * @param {string} [options.env] - environment (dev, staging, prod)
   * @param {string} [options.lokiUrl] - Loki URL
   * @param {boolean} [options.console] - console output flag
   */
  constructor(serviceName, options = {}) {
    options.lokiUrl =
      options.lokiUrl || process.env.LOKI_URL || "http://loki:3100";

    super(otel.normalizeIdentifier(serviceName), options);
  }
}
