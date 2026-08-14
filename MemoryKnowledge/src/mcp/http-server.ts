/**
 * Streamable HTTP MCP server for remote Agent clients.
 *
 * This is additive to the existing stdio MCP server. It exposes Knowledge
 * Service tools and workspace tools backed by MemoryCore through one URL.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { createMcpServer } from "./server.js";
import { createLogger } from "../logger.js";

const log = createLogger("mcp-http-server");
const port = Number.parseInt(process.env.MCP_PORT || "8425", 10);
const apiUrl = process.env.KNOWLEDGE_API_URL || "http://127.0.0.1:8424";
const apiToken = process.env.KNOWLEDGE_API_TOKEN;
const coreUrl = process.env.MEMORY_CORE_API_URL || "http://memory-core:8420";
const coreToken = process.env.MEMORY_CORE_API_KEY?.trim() || "";
const serviceId = process.env.MCP_SERVICE_ID?.trim() || "default";
const requireUserAuth = process.env.MCP_REQUIRE_AUTH !== "false";
const sessions = new Map<string, { transport: StreamableHTTPServerTransport; userToken: string }>();

function addCorsHeaders(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", process.env.MCP_CORS_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Authorization, Mcp-Session-Id, Last-Event-ID");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
}

async function handleMcpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  addCorsHeaders(res);

  const authorization = req.headers.authorization;
  const userToken = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";
  if (requireUserAuth && !userToken) {
    res.writeHead(401, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }

  const header = req.headers["mcp-session-id"];
  const sessionId = typeof header === "string" ? header : undefined;
  const existing = sessionId ? sessions.get(sessionId) : undefined;
  if (existing && existing.userToken !== userToken) {
    res.writeHead(401, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Session credential mismatch" }));
    return;
  }
  let transport = existing?.transport;

  if (!transport) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { transport: transport!, userToken });
      },
    });
    transport.onclose = () => {
      if (transport?.sessionId) sessions.delete(transport.sessionId);
    };

    const mcp = createMcpServer({
      baseUrl: apiUrl,
      token: apiToken,
      userKey: userToken || undefined,
      serviceId,
      coreBaseUrl: coreUrl,
      coreToken: coreToken || undefined,
    });
    await mcp.connect(transport);
  }

  await transport.handleRequest(req, res);
}

const httpServer = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ status: "ok" }));
    return;
  }

  if (req.url !== "/mcp") {
    res.writeHead(404).end("Not found");
    return;
  }

  handleMcpRequest(req, res).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    log.error(`MCP request failed: ${message}`);
    if (!res.headersSent) res.writeHead(500);
    res.end(JSON.stringify({ error: message }));
  });
});

httpServer.listen(port, "0.0.0.0", () => {
  log.info(`Streamable HTTP MCP listening on http://0.0.0.0:${port}/mcp`);
  log.info(`MCP backend API: ${apiUrl}`);
  log.info(`MCP user authentication: ${requireUserAuth ? "enabled" : "disabled"}`);
  log.info(`MCP Core backend: ${coreUrl} (service=${serviceId}, internal-key=${coreToken ? "configured" : "missing"})`);
});
