#!/usr/bin/env node
/**
 * Adeptos Content MCP — Streamable HTTP (Express) + stdio.
 *
 *   npm run start:http   # default PORT=3848
 *   npm run start:stdio
 */

import express from "express";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./server.js";
import { startScheduleWorker } from "./worker.js";

function parseArgs(argv: string[]) {
  const http = argv.includes("--http") || process.env.MCP_TRANSPORT === "http";
  const stdio = argv.includes("--stdio") || (!http && process.env.MCP_TRANSPORT !== "http");
  const portIdx = argv.indexOf("--port");
  const port =
    (portIdx >= 0 && argv[portIdx + 1] ? Number(argv[portIdx + 1]) : undefined) || Number(process.env.PORT || 3848);
  const host = process.env.HOST || "127.0.0.1";
  return { http: http || !stdio, stdio: !http && stdio, port, host };
}

async function startStdio() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  startScheduleWorker();
  console.error(`[${SERVER_NAME}] stdio transport ready v${SERVER_VERSION}`);
}

function createHttpApp() {
  const app = express();
  app.disable("x-powered-by");

  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "content-type, mcp-session-id, last-event-id");
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  app.get(["/health", "/"], (_req, res) => {
    res.json({
      name: SERVER_NAME,
      version: SERVER_VERSION,
      transport: "streamable-http",
      mcp: "/mcp",
      lane: "canva_posts",
    });
  });

  app.all("/mcp", async (req, res) => {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      console.error("[http] handleRequest error", err instanceof Error ? err.message : err);
      if (!res.headersSent) {
        res.status(500).json({ error: "Internal server error" });
      }
    }
  });

  return app;
}

async function startHttp(host: string, port: number) {
  const app = createHttpApp();
  await new Promise<void>((resolve, reject) => {
    const srv = app.listen(port, host, () => resolve());
    srv.on("error", reject);
  });
  startScheduleWorker();
  console.error(`[${SERVER_NAME}] Streamable HTTP listening on http://${host}:${port}/mcp (v${SERVER_VERSION})`);
}

async function main() {
  const { http, port, host } = parseArgs(process.argv.slice(2));
  if (http) await startHttp(host, port);
  else await startStdio();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
