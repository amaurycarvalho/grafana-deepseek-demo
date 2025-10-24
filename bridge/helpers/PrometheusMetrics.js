import client from "prom-client";

/**
 * Prometheus Metrics base class
 */
export class PrometheusMetrics {
  constructor(metricsPrefixName = "app") {
    this.metricsPrefixName = metricsPrefixName;
    this.register = new client.Registry();
    client.collectDefaultMetrics({ register: this.register });
  }

  registerMetric(metric) {
    this.register.registerMetric(metric);
  }

  async metricsEndpoint(req, res) {
    res.set("Content-Type", this.register.contentType);
    res.end(await this.register.metrics());
  }

  healthEndpoint(req, res, healthGauge) {
    try {
      if (healthGauge) healthGauge.set(1);
      res.json({ status: "ok" });
    } catch (err) {
      if (healthGauge) healthGauge.set(0);
      res.status(500).json({ status: "error", error: err.message });
    }
  }
}
