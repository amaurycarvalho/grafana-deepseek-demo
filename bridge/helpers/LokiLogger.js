import winston from "winston";
import LokiTransport from "winston-loki";

/**
 * Loki Logger class
 */
export class LokiLogger {
  /**
   * @param {string} serviceName - service name
   * @param {object} [options] - additional options, ex: { env: "staging", lokiUrl: "http://...", console: true }
   * @param {string} [options.env] - environment (dev, staging, prod)
   * @param {string} [options.lokiUrl] - Loki URL
   * @param {boolean} [options.console] - console output flag
   */
  constructor(serviceName, options = {}) {
    if (!serviceName) {
      throw new Error("[logger] serviceName é obrigatório no construtor.");
    }

    this.serviceName = serviceName;
    this.env = options.env || process.env.NODE_ENV || "dev";
    this.lokiUrl =
      options.lokiUrl || process.env.LOKI_URL || "http://loki:3100";
    this.consoleEnabled = options.console ?? true;

    const transports = [
      new LokiTransport({
        host: this.lokiUrl,
        labels: {
          app: this.serviceName,
          env: this.env,
        },
        json: true,
        replaceTimestamp: true,
        interval: 5,
      }),
    ];

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
      level: options.level || "info",
      transports,
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
      ),
    });
  }

  info(message, meta = {}) {
    this.logger.info(message, meta);
  }

  warn(message, meta = {}) {
    this.logger.warn(message, meta);
  }

  error(message, meta = {}) {
    this.logger.error(message, meta);
  }

  debug(message, meta = {}) {
    this.logger.debug(message, meta);
  }

  getInstance() {
    return this.logger;
  }
}
