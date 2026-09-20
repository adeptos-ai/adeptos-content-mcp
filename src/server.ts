import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerContentTools } from "./tools.js";

export const SERVER_NAME = "adeptos-content-mcp";
export const SERVER_VERSION = "1.0.0";

export function createServer(): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });
  registerContentTools(server);
  return server;
}
