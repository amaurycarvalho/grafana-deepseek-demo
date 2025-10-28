import fetch from "node-fetch";

/**
 * MCP Helper class
 */
export class McpHelper {
  /**
   * @param {string} mcpUrl - MCP server URL
   */
  constructor(mcpUrl = process.env.MCP_URL || "") {
    if (!mcpUrl) {
      throw new Error("[mcp] URL is missing.");
    }

    this.mcpUrl = mcpUrl;

    /*
      Create the tools schema list
      Tool schema example (https://ollama.com/blog/streaming-tool):
      {
        type: 'function',
        function: {
           name: 'addTwoNumbers',
           description: 'Add two numbers together',
           parameters: {
              type: 'object',
              required: ['a', 'b'],
              properties: {
                a: { type: 'number', description: 'The first number' },
                b: { type: 'number', description: 'The second number' }
              }
            }
        }
      }
    */
    this.tools = [
      {
        type: "function",
        function: {
          name: "getToolsList",
          description: "Get the MCP server tools list",
          parameters: {},
        },
      },
    ];
  }

  /**
   * MCP server method caller (JSON-RPC helper)
   * @param {string} method Method name
   * @param {JSON} params Method params (JSON)
   * @example
   *   method: "tools/list" or "tools/call"
   *   params: { "name": "toolFunction", "arguments": { "param1": "value1", "param2": "value2" } }
   */
  async methodCall(method, params) {
    const response = await fetch(`${this.mcpUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.MCP_API_KEY}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "1",
        method,
        params,
      }),
    });
    const result = await response.json();
    if (!response.ok || response.status === 401) {
      return {
        error: `MCP Server connection error: ${response.status} - ${response.statusText}`,
      };
    }
    if (result.error) {
      return { error: result.error.message };
    }
    return result;
  }

  /**
   * Tool caller
   * @param {JSON} tool Tool function with arguments
   * @returns Tool response (JSON)
   * @example
   *   tool: { "name": "toolFunction", "arguments": { "param1": "value1", "param2": "value2" } }
   */
  async toolCall(tool) {
    return await this.methodCall("tools/call", tool);
  }

  /**
   * Return MCP server tools list
   * @returns Tools list ([JSON])
   */
  async getToolsList() {
    return await this.methodCall("tools/list", {});
  }

  /***
   * Execute tools
   * @param {[json]} tool_calls tool_calls list
   * @returns results [ { name, content } ]
   */
  async executeTools(tool_calls) {
    let results = [];
    for (const toolCall of tool_calls) {
      const result = await this.executeTool(toolCall);
      results.push({
        role: "tool",
        name: toolCall.function.name,
        content: result.error ? "error" : "result",
        result,
      });
    }
    return results;
  }

  /***
   * Execute a tool
   * @param {json} toolCall
   * @returns {json} result
   * @example
   *   toolCall: { function: { name: "name", arguments: { param1: "value1", ... } } }
   */
  async executeTool(toolCall) {
    if (toolCall.function.name === "getToolsList") {
      return await this.getToolsList();
    }
    return toolCall.function;
  }
}
