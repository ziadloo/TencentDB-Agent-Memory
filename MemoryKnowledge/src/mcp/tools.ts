/**
 * MCP tool definitions for agent workspace access.
 *
 * Existing Wiki and CodeGraph query tools are retained. MemoryCore workspace
 * tools use an explicit `payload` object so upstream v3 schemas remain the
 * source of truth; destructive operations are separately named and guarded.
 *
 * Code-Graph (8): code_search, code_explore, code_callers, code_callees,
 *                  code_impact, code_node, code_status, code_files
 * Wiki (4):        wiki_search, wiki_read, wiki_list, wiki_graph
 */

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
  /** HTTP endpoint to forward to (without /v3 prefix). */
  endpoint: string;
  /** Backend API to call. Existing tools default to the Knowledge Service. */
  backend?: "knowledge" | "core";
  /** Destructive tools require an explicit confirmation field. */
  destructive?: boolean;
}

export const MCP_TOOLS: McpToolDef[] = [
  // ── Code-Graph (8) ──

  {
    name: "code_search",
    description: "Quick symbol search by name in a code graph. Returns locations only (no code); use code_explore to get source.",
    inputSchema: {
      type: "object",
      properties: {
        code_graph_id: { type: "string", description: "The code graph ID (cg-...)" },
        query: { type: "string", description: "Symbol name or partial name (e.g. \"auth\", \"signIn\", \"UserService\")" },
        kind: {
          type: "string",
          enum: ["function", "method", "class", "interface", "type", "variable", "route", "component"],
          description: "Optional node-kind filter. Omit to search all kinds (do NOT pass \"any\"/\"symbol\"/\"file\" — not valid, yields zero results).",
        },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Max results (default: 10)" },
      },
      required: ["code_graph_id", "query"],
    },
    endpoint: "/code-graph/search",
  },
  {
    name: "code_explore",
    description: "Explore files in a code graph matching a query.",
    inputSchema: {
      type: "object",
      properties: {
        code_graph_id: { type: "string", description: "The code graph ID (cg-...)" },
        query: { type: "string", description: "Search query" },
        maxFiles: { type: "integer", minimum: 1, maximum: 200, description: "Max files to return (default: 12)" },
      },
      required: ["code_graph_id", "query"],
    },
    endpoint: "/code-graph/explore",
  },
  {
    name: "code_callers",
    description: "Find all callers of a symbol in a code graph.",
    inputSchema: {
      type: "object",
      properties: {
        code_graph_id: { type: "string", description: "The code graph ID (cg-...)" },
        symbol: { type: "string", description: "Symbol name to find callers for" },
        limit: { type: "integer", minimum: 1, maximum: 200, description: "Max results (default: 20)" },
      },
      required: ["code_graph_id", "symbol"],
    },
    endpoint: "/code-graph/callers",
  },
  {
    name: "code_callees",
    description: "Find all callees (functions called by) a symbol in a code graph.",
    inputSchema: {
      type: "object",
      properties: {
        code_graph_id: { type: "string", description: "The code graph ID (cg-...)" },
        symbol: { type: "string", description: "Symbol name to find callees for" },
        limit: { type: "integer", minimum: 1, maximum: 200, description: "Max results (default: 20)" },
      },
      required: ["code_graph_id", "symbol"],
    },
    endpoint: "/code-graph/callees",
  },
  {
    name: "code_impact",
    description: "Analyze the impact of changing a symbol (dependency chain).",
    inputSchema: {
      type: "object",
      properties: {
        code_graph_id: { type: "string", description: "The code graph ID (cg-...)" },
        symbol: { type: "string", description: "Symbol name to analyze impact for" },
        depth: { type: "integer", minimum: 1, maximum: 10, description: "Analysis depth (default: 2)" },
      },
      required: ["code_graph_id", "symbol"],
    },
    endpoint: "/code-graph/impact",
  },
  {
    name: "code_node",
    description: "Get detailed information about a specific symbol node in a code graph.",
    inputSchema: {
      type: "object",
      properties: {
        code_graph_id: { type: "string", description: "The code graph ID (cg-...)" },
        symbol: { type: "string", description: "Symbol name" },
        includeCode: { type: "boolean", description: "Include source code (default: false)" },
        file: { type: "string", description: "File path to disambiguate" },
        line: { type: "integer", minimum: 1, description: "Line number to disambiguate" },
      },
      required: ["code_graph_id", "symbol"],
    },
    endpoint: "/code-graph/node",
  },
  {
    name: "code_status",
    description: "Get the indexing status of a code graph.",
    inputSchema: {
      type: "object",
      properties: {
        code_graph_id: { type: "string", description: "The code graph ID (cg-...)" },
      },
      required: ["code_graph_id"],
    },
    endpoint: "/code-graph/status",
  },
  {
    name: "code_files",
    description: "List files in a code graph, optionally filtered by path or pattern.",
    inputSchema: {
      type: "object",
      properties: {
        code_graph_id: { type: "string", description: "The code graph ID (cg-...)" },
        path: { type: "string", description: "Path prefix filter" },
        pattern: { type: "string", description: "Glob pattern filter" },
        format: { type: "string", enum: ["tree", "flat"], description: "Output format (default: tree)" },
        includeMetadata: { type: "boolean", description: "Include file metadata (default: true)" },
        maxDepth: { type: "integer", minimum: 1, description: "Max tree depth" },
      },
      required: ["code_graph_id"],
    },
    endpoint: "/code-graph/files",
  },

  // ── Wiki (4) ──

  {
    name: "wiki_search",
    description: "Search wiki pages by keyword (BM25 full-text search). Optional graph multi-hop expansion (PRD: hop, decay, minScore) walks [[wikilink]] edges from BM25 seeds to surface graph-related pages whose body doesn't match the query directly. Each result also carries `related` (neighbour pages) and the response includes `links` (edges between results) for relationship visualisation.",
    inputSchema: {
      type: "object",
      properties: {
        wiki_id: { type: "string", description: "The wiki ID (wiki-...)" },
        query: { type: "string", description: "Search query" },
        limit: { type: "integer", description: "Max results (default: 20)" },
        hop: {
          type: "integer",
          minimum: 0,
          maximum: 5,
          description: "Graph expansion depth. 0 = pure BM25 (default), >0 = walk wikilink edges from seeds.",
        },
        decay: {
          type: "number",
          minimum: 0,
          maximum: 1,
          description: "Per-hop score decay factor when hop>0 (default 0.5).",
        },
        minScore: {
          type: "number",
          minimum: 0,
          description: "Minimum score threshold; nodes below this are dropped (default 0.1).",
        },
      },
      required: ["wiki_id", "query"],
    },
    endpoint: "/wiki/search",
  },
  {
    name: "wiki_read",
    description: "Read wiki page content by reference (page id or path).",
    inputSchema: {
      type: "object",
      properties: {
        wiki_id: { type: "string", description: "The wiki ID (wiki-...)" },
        refs: {
          type: "array",
          items: { type: "string" },
          description: "Page references (ids or relative paths, without .md)",
        },
      },
      required: ["wiki_id", "refs"],
    },
    endpoint: "/wiki/page/read",
  },
  {
    name: "wiki_list",
    description: "List all wiki pages with metadata (title, type, path).",
    inputSchema: {
      type: "object",
      properties: {
        wiki_id: { type: "string", description: "The wiki ID (wiki-...)" },
      },
      required: ["wiki_id"],
    },
    endpoint: "/wiki/page/ls",
  },
  {
    name: "wiki_graph",
    description: "Get the wiki knowledge graph (nodes, edges, communities).",
    inputSchema: {
      type: "object",
      properties: {
        wiki_id: { type: "string", description: "The wiki ID (wiki-...)" },
      },
      required: ["wiki_id"],
    },
    endpoint: "/wiki/graph",
  },

  // ── Memory (Core data plane) ──
  ...memoryTools(),

  // ── Skills ──
  ...skillTools(),

  // ── Workspace discovery ──
  ...workspaceTools(),
];

function payloadSchema() {
  return {
    type: "object" as const,
    description: "Request body forwarded to the corresponding MemoryCore v3 endpoint.",
    additionalProperties: true,
  };
}

function coreTool(
  name: string,
  description: string,
  endpoint: string,
  destructive = false,
): McpToolDef {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties: { payload: payloadSchema() },
      required: ["payload"],
    },
    endpoint,
    backend: "core",
    destructive,
  };
}

function memoryTools(): McpToolDef[] {
  return [
    coreTool("memory_conversation_add", "Append conversation messages to the explicitly identified memory context.", "/v3/conversation/add"),
    coreTool("memory_conversation_query", "Read conversation memory for the explicitly identified context.", "/v3/conversation/query"),
    coreTool("memory_conversation_search", "Search conversation memory for the explicitly identified context.", "/v3/conversation/search"),
    coreTool("memory_conversation_count", "Count conversation memory for the explicitly identified context.", "/v3/conversation/count"),
    coreTool("memory_conversation_delete", "Delete conversation messages. This is destructive and requires payload.confirm=true.", "/v3/conversation/delete", true),
    coreTool("memory_atomic_update", "Create or update an atomic memory record.", "/v3/atomic/update"),
    coreTool("memory_atomic_query", "Read atomic memories for the explicitly identified context.", "/v3/atomic/query"),
    coreTool("memory_atomic_search", "Search atomic memories for the explicitly identified context.", "/v3/atomic/search"),
    coreTool("memory_atomic_count", "Count atomic memories for the explicitly identified context.", "/v3/atomic/count"),
    coreTool("memory_atomic_delete", "Delete atomic memories. This is destructive and requires payload.confirm=true.", "/v3/atomic/delete", true),
    coreTool("memory_scenario_list", "List memory scenarios visible to the authenticated user.", "/v3/scenario/ls"),
    coreTool("memory_scenario_read", "Read a memory scenario visible to the authenticated user.", "/v3/scenario/read"),
    coreTool("memory_scenario_write", "Write a memory scenario explicitly owned by the authenticated workspace.", "/v3/scenario/write"),
    coreTool("memory_scenario_count", "Count memory scenarios visible to the authenticated user.", "/v3/scenario/count"),
    coreTool("memory_scenario_delete", "Delete a memory scenario. This is destructive and requires payload.confirm=true.", "/v3/scenario/rm", true),
    coreTool("memory_core_read", "Read core memory data for the explicitly identified context.", "/v3/core/read"),
    coreTool("memory_core_write", "Write core memory data for the explicitly identified context.", "/v3/core/write"),
    coreTool("memory_core_count", "Count core memory data for the explicitly identified context.", "/v3/core/count"),
  ];
}

function skillTools(): McpToolDef[] {
  return [
    coreTool("skill_create", "Create a versioned skill in the explicitly identified workspace.", "/v3/skill/create"),
    coreTool("skill_get", "Read a skill or a historical skill version.", "/v3/skill/get"),
    coreTool("skill_list", "List skills visible in the explicitly identified team or workspace.", "/v3/skill/list"),
    coreTool("skill_search", "Search skills visible to the authenticated user.", "/v3/skill/search"),
    coreTool("skill_versions", "List versions of a skill.", "/v3/skill/versions"),
    coreTool("skill_update", "Replace a skill body using optimistic version checking.", "/v3/skill/update"),
    coreTool("skill_patch", "Apply an explicit string patch to a skill using optimistic version checking.", "/v3/skill/patch"),
    coreTool("skill_files_read", "Read a skill resource file.", "/v3/skill/files/read"),
    coreTool("skill_files_write", "Write skill resource files using optimistic version checking.", "/v3/skill/files/write"),
    coreTool("skill_files_remove", "Remove skill resource files. This is destructive and requires payload.confirm=true.", "/v3/skill/files/remove", true),
    coreTool("skill_listing", "Render the available-skills listing for the explicitly identified workspace.", "/v3/skill/listing"),
    coreTool("skill_conversation_add", "Append an agent turn to the skill-learning conversation buffer.", "/v3/skill/conversation/add"),
    coreTool("skill_extract", "Trigger skill extraction for an explicitly identified conversation.", "/v3/skill/extract"),
    coreTool("skill_force_archive", "Archive a skill-learning conversation. This is destructive and requires payload.confirm=true.", "/v3/skill/conversation/force-archive", true),
    coreTool("skill_delete", "Archive a skill. This is destructive and requires payload.confirm=true.", "/v3/skill/delete", true),
    coreTool("knowledge_list", "List knowledge entities visible to the authenticated workspace.", "/v3/knowledge/list"),
    coreTool("knowledge_get", "Read a knowledge entity visible to the authenticated workspace.", "/v3/knowledge/get"),
  ];
}

function workspaceTools(): McpToolDef[] {
  return [
    coreTool("workspace_current_user", "Resolve the authenticated user and permitted identity context.", "/v3/meta/user/get"),
    coreTool("workspace_list_teams", "List teams visible to the authenticated user.", "/v3/meta/team/list"),
    coreTool("workspace_list_agents", "List agents visible to the authenticated user.", "/v3/meta/agent/list"),
    coreTool("workspace_list_tasks", "List tasks visible to the authenticated user.", "/v3/meta/task/list"),
    coreTool("workspace_list_assets", "List assets accessible to the authenticated user.", "/v3/meta/asset/list-accessible"),
    coreTool("workspace_list_agent_assets", "List fixed assets assigned to an explicitly identified agent.", "/v3/meta/agent-fixed-asset/list-with-detail"),
  ];
}
