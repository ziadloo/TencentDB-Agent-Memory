/**
 * MCP stdio server — exposes knowledge query tools to LLM agents.
 *
 * Runs as a separate process with stdio transport. When an agent calls a tool,
 * the server forwards the request to the Hono HTTP API via callApi().
 *
 * Usage:
 *   KNOWLEDGE_API_URL=http://localhost:8421 node dist/mcp/server.js
 *
 * The agent connects via stdio; the server translates tool calls to HTTP
 * requests against the knowledge service.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { MCP_TOOLS, type McpToolDef } from "./tools.js";
import { callApi, type HttpClientOptions } from "./http-client.js";
import { createLogger } from "../logger.js";

const log = createLogger("mcp-server");

export function createMcpServer(httpOpts: HttpClientOptions): Server {
  // Keep the legacy stdio server focused on the Knowledge Service. The
  // remote HTTP bridge opts into Core tools by providing coreBaseUrl.
  const tools = httpOpts.coreBaseUrl
    ? MCP_TOOLS
    : MCP_TOOLS.filter((tool) => tool.backend !== "core");
  const toolMap = new Map<string, McpToolDef>();
  for (const tool of tools) {
    toolMap.set(tool.name, tool);
  }

  const server = new Server(
    { name: "knowledge-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  // List tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        annotations: t.destructive
          ? { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
          : { readOnlyHint: !t.backend || !t.name.includes("add") && !t.name.includes("write") && !t.name.includes("update") && !t.name.includes("patch") && !t.name.includes("create") && !t.name.includes("extract"), destructiveHint: false, openWorldHint: false },
      })),
    };
  });

  // Call tool
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = toolMap.get(name);
    if (!tool) {
      log.warn(`Unknown tool requested: "${name}"`);
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }

    const rawArgs = (args ?? {}) as Record<string, unknown>;
    const body = tool.backend === "core"
      ? (rawArgs.payload as Record<string, unknown> | undefined)
      : rawArgs;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return {
        content: [{ type: "text", text: "Error: payload must be an object" }],
        isError: true,
      };
    }
    if (tool.destructive && body.confirm !== true) {
      return {
        content: [{ type: "text", text: "Error: destructive operation requires payload.confirm=true" }],
        isError: true,
      };
    }
    try {
      const backendOpts = tool.backend === "core"
        ? { ...httpOpts, baseUrl: httpOpts.coreBaseUrl ?? httpOpts.baseUrl, token: httpOpts.coreToken ?? httpOpts.token }
        : httpOpts;
      const data = await callApi(backendOpts, tool.endpoint, body);

      // The code-graph query endpoints return {text, isError} — pass through directly
      if (data && typeof data === "object" && "text" in data && "isError" in data) {
        const result = data as { text: string; isError: boolean };
        return {
          content: [{ type: "text", text: result.text || "(empty result)" }],
          isError: result.isError,
        };
      }

      // Other endpoints return structured data — serialize as JSON
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        isError: false,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`tool ${name} failed: ${msg}`);
      return {
        content: [{ type: "text", text: `Error: ${msg}` }],
        isError: true,
      };
    }
  });

  return server;
}

// Start server when run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const baseUrl = process.env.KNOWLEDGE_API_URL || "http://localhost:8421";
  const token = process.env.KNOWLEDGE_API_TOKEN;

  log.info(`MCP server starting, API URL: ${baseUrl}`);

  const server = createMcpServer({ baseUrl, token });
  const transport = new StdioServerTransport();

  server.connect(transport).then(() => {
    log.info("MCP server connected via stdio");
  }).catch((err) => {
    log.error(`Failed to connect: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
