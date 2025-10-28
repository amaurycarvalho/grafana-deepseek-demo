import { McpHelper } from "./McpHelper.js";

/**
 * Grafana MCP helper class
 */
export class GrafanaMcp extends McpHelper {
  constructor() {
    super(process.env.MCP_URL || "http://mcp-grafana:8000");

    this.tools.push({
      type: "function",
      function: {
        name: "getGrafanaVersion",
        description: "Return Grafana's current version",
        parameters: {},
      },
    });
    this.tools.push({
      type: "function",
      function: {
        name: "getDashboards",
        description: "List all dashboards (id, name, title, description...)",
        parameters: {},
      },
    });
    this.tools.push({
      type: "function",
      function: {
        name: "getMetricsNames",
        description: "List all metrics (only names)",
        parameters: {},
      },
    });
    this.tools.push({
      type: "function",
      function: {
        name: "getMetrics",
        description: "List all metrics (id, name, title, description...)",
        parameters: {},
      },
    });
    this.tools.push({
      type: "function",
      function: {
        name: "getDatasources",
        description: "List all datasources (id, name, title, description...)",
        parameters: {},
      },
    });
    this.tools.push({
      type: "function",
      function: {
        name: "getDashboard",
        description: "List strictly a specific given dashboard from its id",
        parameters: {
          type: "object",
          required: ["uid"],
          properties: {
            uid: { type: "string", description: "Unique ID" },
          },
        },
      },
    });
    this.tools.push({
      type: "function",
      function: {
        name: "getMetric",
        description: "List strictly a specific given metric from its id",
        parameters: {
          type: "object",
          required: ["uid"],
          properties: {
            uid: { type: "string", description: "Unique ID" },
          },
        },
      },
    });
  }

  /**
   * Get grafana version (test)
   * @returns list (JSON)
   */
  async getGrafanaVersion() {
    return { version: "latest" };
  }

  /**
   * Dashboard list (id, name, title, description...)
   * @returns list (JSON)
   */
  async getDashboards() {
    return await this.toolCall({
      name: "search_dashboards",
      arguments: { search: "*" },
    });
  }

  /**
   * Metrics names
   * @returns list (JSON)
   */
  async getMetricsNames() {
    return await this.toolCall({
      name: "list_prometheus_metric_names",
      arguments: { datasourceUid: "Prometheus" },
    });
  }

  /**
   * Metrics list (id, name, title, description...)
   * @returns list (JSON)
   */
  async getMetrics() {
    return await this.getMetric("*");
  }

  /**
   * Datasource list (id, name, title, description...)
   * @returns list (JSON)
   */
  async getDatasources() {
    return await this.toolCall({ name: "list_datasources", arguments: {} });
  }

  /**
   * Get a dashboard from id
   * @param uid Dashboard unique id
   * @returns list (JSON)
   */
  async getDashboard(uid) {
    return await this.toolCall({
      name: "get_dashboard_summary",
      arguments: { uid },
    });
  }

  /**
   * Get a metric from id
   * @param uid Metric unique id
   * @returns list (JSON)
   */
  async getMetric(uid) {
    return await this.toolCall({
      name: "list_prometheus_metric_metadata",
      arguments: { datasourceUid: "Prometheus", metric: uid },
    });
  }

  /***
   * Execute a tool (overload)
   * @param {json} toolCall
   */
  async executeTool(toolCall) {
    if (toolCall.function.name === "getDashboards") {
      return await this.getDashboards();
    } else if (toolCall.function.name === "getMetricsNames") {
      return await this.getMetricsNames();
    } else if (toolCall.function.name === "getMetrics") {
      return await this.getMetrics();
    } else if (toolCall.function.name === "getDatasources") {
      return await this.getDatasources();
    } else if (toolCall.function.name === "getDashboard") {
      return await this.getDashboard(toolCall.function.arguments.uid);
    } else if (toolCall.function.name === "getMetric") {
      return await this.getMetric(toolCall.function.arguments.uid);
    } else if (toolCall.function.name === "getGrafanaVersion") {
      return await this.getGrafanaVersion();
    }

    return await super.executeTool(toolCall);
  }
}
