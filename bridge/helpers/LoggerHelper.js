import winston from "winston";
import LokiTransport from "winston-loki";

/**
 * Logger Helper class
 */
export class LoggerHelper {
  /**
   * @param {string} serviceName - service name
   * @param {object} [options] - additional options, ex: { env: "staging", lokiUrl: "http://...", console: true }
   * @param {string} [options.env] - environment (dev, staging, prod)
   * @param {string} [options.lokiUrl] - Loki URL
   * @param {string} [options.level] - log level, ex: "debug" or "info"
   * @param {boolean} [options.console] - console output flag
   */
  constructor(serviceName, options = {}) {
    if (!serviceName) {
      throw new Error("[logger] serviceName is missing.");
    }

    this.serviceName = serviceName;
    this.env = options.env || process.env.NODE_ENV || "dev";
    this.region =
      process.env.AWS_REGION ||
      process.env.AZURE_LOCATION ||
      process.env.NODE_REGION ||
      "local";
    this.lokiUrl = options.lokiUrl || process.env.LOKI_URL || "";
    this.level = options.level || process.env.LOG_LEVEL || "info";
    this.consoleEnabled = options.console ?? true;

    const transports = [];

    if (this.lokiUrl !== "") {
      transports.push(
        new LokiTransport({
          host: this.lokiUrl,
          labels: {
            service_name: this.serviceName,
            env: this.env,
            region: this.region,
          },
          json: true,
          replaceTimestamp: true,
          interval: 5,
        })
      );
    }

    if (this.consoleEnabled) {
      transports.push(
        new winston.transports.Console({
          format: winston.format.combine(
            winston.format.colorize(),
            winston.format.simple()
          ),
        })
      );
    }

    this.logger = winston.createLogger({
      level: this.level,
      transports,
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
      ),
    });
  }

  _getCallerMethodLabels() {
    const regex =
      /at\s+(?:(?<method>[\w.$<> ]+)\s+\((?<location1>[^)]+)\)|(?<location2>file:[^ )]+))/;
    const lines = new Error().stack?.split("\n");
    const match = lines[3]?.match(regex);
    return match
      ? {
          method: match.groups.method || "<anonymous>",
          location:
            match.groups.location2 || match.groups.location1 || "<unknown>",
        }
      : { method: "<unknown>", location: lines[3] || "<unknown>" };
  }

  info(message, meta = {}) {
    const labels = this._getCallerMethodLabels();
    this.logger.info(message, { labels, ...meta });
  }

  warn(message, meta = {}) {
    const labels = this._getCallerMethodLabels();
    this.logger.warn(message, { labels, ...meta });
  }

  error(message, meta = {}) {
    const labels = this._getCallerMethodLabels();
    this.logger.error(message, { labels, ...meta });
  }

  debug(message, meta = {}) {
    const labels = this._getCallerMethodLabels();
    this.logger.debug(message, { labels, ...meta });
  }

  getInstance() {
    return this.logger;
  }
}
