import client from "prom-client";
import { PrometheusMetrics } from "./PrometheusMetrics.js";

/**
 * MCP Bridge Metrics Class
 */
export class BridgeMetrics extends PrometheusMetrics {
  constructor(serviceName = process.env.BRIDGE_SERVICE_NAME || "mcp-bridge") {
    super(serviceName);
    this.initBridgeMetrics();
  }

  initBridgeMetrics() {
    this.bridgeRequests = new client.Counter({
      name: `${this.serviceName}_requests_total`,
      help: `Total requests received by ${this.serviceName}`,
    });

    this.bridgeErrors = new client.Counter({
      name: `${this.serviceName}_errors_total`,
      help: `Total errors occurred in ${this.serviceName}`,
    });

    this.bridgeLatency = new client.Histogram({
      name: `${this.serviceName}_request_latency_seconds`,
      help: `${this.serviceName} response time`,
      buckets: [0.5, 1, 2, 5, 10, 30, 60, 120, 180, 300, 600],
    });

    this.bridgeHealth = new client.Gauge({
      name: `${this.serviceName}_health_status`,
      help: `${this.serviceName} health status (1 = healthy, 0 = failed last check)`,
    });

    this.mcpRequests = new client.Counter({
      name: `${this.serviceName}_mcp_requests_total`,
      help: "Total calls made to the MCP Server",
    });

    this.mcpLatency = new client.Histogram({
      name: `${this.serviceName}_mcp_latency_seconds`,
      help: "MCP Server Response Time",
    });

    this.mcpErrors = new client.Counter({
      name: `${this.serviceName}_mcp_errors_total`,
      help: "Total errors occurred when calling the MCP Server",
    });

    this.ollamaRequests = new client.Counter({
      name: `${this.serviceName}_ollama_requests_total`,
      help: "Total calls made to Ollama",
    });

    this.ollamaLatency = new client.Histogram({
      name: `${this.serviceName}_ollama_latency_seconds`,
      help: "Ollama response time",
      buckets: [0.5, 1, 2, 5, 10, 30, 60, 120, 180, 300, 600],
    });

    this.ollamaErrors = new client.Counter({
      name: `${this.serviceName}_ollama_errors_total`,
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
