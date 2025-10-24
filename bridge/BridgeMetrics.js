import client from "prom-client";
import { PrometheusMetrics } from "./helpers/PrometheusMetrics.js";

/**
 * MCP Bridge Metrics Class
 */
export class BridgeMetrics extends PrometheusMetrics {
  constructor(
    metricsPrefixName = process.env.BRIDGE_METRICS_PREFIX_NAME || "bridge"
  ) {
    super(metricsPrefixName);
    this.initBridgeMetrics();
  }

  initBridgeMetrics() {
    this.bridgeRequests = new client.Counter({
      name: `${this.metricsPrefixName}_requests_total`,
      help: `Total requests received by ${this.metricsPrefixName}`,
    });

    this.bridgeErrors = new client.Counter({
      name: `${this.metricsPrefixName}_errors_total`,
      help: `Total errors occurred in ${this.metricsPrefixName}`,
    });

    this.bridgeLatency = new client.Histogram({
      name: `${this.metricsPrefixName}_request_latency_seconds`,
      help: `${this.metricsPrefixName} response time`,
      buckets: [0.5, 1, 2, 5, 10, 30, 60, 120, 180, 300, 600],
    });

    this.bridgeHealth = new client.Gauge({
      name: `${this.metricsPrefixName}_health_status`,
      help: `${this.metricsPrefixName} health status (1 = healthy, 0 = failed last check)`,
    });

    this.mcpRequests = new client.Counter({
      name: `${this.metricsPrefixName}_mcp_requests_total`,
      help: "Total calls made to the MCP Server",
    });

    this.mcpLatency = new client.Histogram({
      name: `${this.metricsPrefixName}_mcp_latency_seconds`,
      help: "MCP Server Response Time",
    });

    this.mcpErrors = new client.Counter({
      name: `${this.metricsPrefixName}_mcp_errors_total`,
      help: "Total errors occurred when calling the MCP Server",
    });

    this.ollamaRequests = new client.Counter({
      name: `${this.metricsPrefixName}_ollama_requests_total`,
      help: "Total calls made to Ollama",
    });

    this.ollamaLatency = new client.Histogram({
      name: `${this.metricsPrefixName}_ollama_latency_seconds`,
      help: "Ollama response time",
      buckets: [0.5, 1, 2, 5, 10, 30, 60, 120, 180, 300, 600],
    });

    this.ollamaErrors = new client.Counter({
      name: `${this.metricsPrefixName}_ollama_errors_total`,
      help: "Total errors occurred in the call to Ollama",
    });

    this.registerMetric(this.bridgeRequests);
    this.registerMetric(this.bridgeErrors);
    this.registerMetric(this.bridgeLatency);
    this.registerMetric(this.bridgeHealth);
    this.registerMetric(this.mcpRequests);
    this.registerMetric(this.mcpLatency);
    this.registerMetric(this.mcpErrors);
    this.registerMetric(this.ollamaRequests);
    this.registerMetric(this.ollamaLatency);
    this.registerMetric(this.ollamaErrors);
  }

  /**
   * Bridge /health endpoint
   */
  health(req, res) {
    super.healthEndpoint(req, res, this.bridgeHealth);
  }

  /**
   * Bridge /metrics endpoint
   */
  async metrics(req, res) {
    await super.metricsEndpoint(req, res);
  }
}
