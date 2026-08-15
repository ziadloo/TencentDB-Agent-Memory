import { randomUUID } from "node:crypto";

import { callApi, type HttpClientOptions } from "./http-client.js";

export interface TeamWorkbenchContext {
  scope: "team";
  user_id: string;
  team_id: string;
}

export interface AgentWorkbenchContext {
  scope: "agent";
  user_id: string;
  team_id: string;
  agent_id: string;
  owner_user_id: string;
  task_id?: string;
  chat_memory_asset_id: string;
}

export type WorkbenchContext = TeamWorkbenchContext | AgentWorkbenchContext;

interface AssetRecord {
  asset_id: string;
  asset_type: string;
  name?: string;
  status?: string;
  visibility?: string;
  owner_user_id?: string;
  [key: string]: unknown;
}

interface WorkbenchResult {
  data: unknown;
  isError?: boolean;
}

const READABLE_ASSET_TYPES = new Set(["skill", "llm_wiki", "code_graph", "chat_memory"]);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function itemsOf(value: unknown): AssetRecord[] {
  const record = asRecord(value);
  const items = Array.isArray(record.items) ? record.items : [];
  return items.filter((item): item is AssetRecord => Boolean(item && typeof item === "object"));
}

export class WorkbenchRuntime {
  private context?: WorkbenchContext;

  constructor(private readonly opts: HttpClientOptions) {}

  private core(endpoint: string, body: Record<string, unknown>): Promise<unknown> {
    return callApi(
      {
        ...this.opts,
        baseUrl: this.opts.coreBaseUrl ?? this.opts.baseUrl,
        token: this.opts.coreToken ?? this.opts.token,
      },
      endpoint,
      body,
    );
  }

  private async currentUser(): Promise<string> {
    if (!this.opts.userKey) throw new Error("MCP authentication is required to establish a workbench context");
    const data = asRecord(await this.core("/v3/meta/user/get", { user_key: this.opts.userKey }));
    const userId = typeof data.user_id === "string" ? data.user_id : undefined;
    if (!userId) throw new Error("The authenticated MCP key did not resolve to a user");
    return userId;
  }

  private requireTeamContext(): WorkbenchContext {
    if (!this.context) {
      throw new Error("No active workbench context. Call workbench_team_context_set or workbench_context_set first.");
    }
    return this.context;
  }

  private requireAgentContext(): AgentWorkbenchContext {
    const context = this.requireTeamContext();
    if (context.scope !== "agent") {
      throw new Error("Agent context is required for this workflow. Call workbench_context_set with team_id and agent_id first.");
    }
    return context;
  }

  private async ensureChatMemoryAsset(ctx: AgentWorkbenchContext): Promise<AssetRecord> {
    const assetId = ctx.chat_memory_asset_id;
    let asset: AssetRecord | undefined;
    try {
      asset = asRecord(await this.core("/v3/meta/asset/get", { asset_id: assetId })) as AssetRecord;
    } catch (err) {
      if (!(err instanceof Error) || !/not found|404/i.test(err.message)) throw err;
    }

    if (!asset?.asset_id) {
      asset = asRecord(await this.core("/v3/meta/asset/create", {
        asset_id: assetId,
        team_id: ctx.team_id,
        asset_type: "chat_memory",
        name: `Memory of ${ctx.agent_id}`,
        owner_user_id: ctx.owner_user_id,
        source_type: "mcp",
        visibility: "private",
        status: "draft",
      })) as AssetRecord;
    }

    await this.ensureBinding(ctx, assetId, "chat_memory", "summary", 50);
    return asset;
  }

  private async ensureBinding(
    ctx: AgentWorkbenchContext,
    assetId: string,
    assetType: string,
    injectionMode = "summary",
    priority = 50,
  ): Promise<void> {
    const bindings = itemsOf(await this.core("/v3/meta/agent-fixed-asset/list", {
      agent_id: ctx.agent_id,
      limit: 1000,
      offset: 0,
    }));
    if (!bindings.some((binding) => binding.asset_id === assetId)) {
      await this.core("/v3/meta/agent-fixed-asset/set", {
        agent_id: ctx.agent_id,
        bindings: [
          ...bindings.map((binding) => ({
            asset_id: binding.asset_id,
            asset_type: binding.asset_type,
            injection_mode: typeof binding.injection_mode === "string" ? binding.injection_mode : "summary",
            priority: typeof binding.priority === "number" ? binding.priority : 50,
            created_by: ctx.owner_user_id,
          })),
          {
            asset_id: assetId,
            asset_type: assetType,
            injection_mode: injectionMode,
            priority,
            created_by: ctx.owner_user_id,
          },
        ],
      });
    }
  }

  async contextGet(): Promise<WorkbenchResult> {
    return { data: this.context ?? { active: false } };
  }

  async teamContextSet(input: Record<string, unknown>): Promise<WorkbenchResult> {
    const teamId = typeof input.team_id === "string" ? input.team_id : "";
    if (!teamId) throw new Error("team_id is required");

    const userId = await this.currentUser();
    const accessibleTeams: unknown[] = [];
    const pageSize = 100;
    let offset = 0;
    while (true) {
      const teams = asRecord(await this.core("/v3/meta/team/list", {
        user_id: userId,
        limit: pageSize,
        offset,
      }));
      const page = Array.isArray(teams.items) ? teams.items : [];
      accessibleTeams.push(...page);
      const total = typeof teams.total === "number" ? teams.total : undefined;
      if (page.length < pageSize || (total !== undefined && accessibleTeams.length >= total)) break;
      offset += pageSize;
    }
    if (!accessibleTeams.some((team) => asRecord(team).team_id === teamId)) {
      throw new Error(`Authenticated user is not a member of team ${teamId}`);
    }

    const next: TeamWorkbenchContext = { scope: "team", user_id: userId, team_id: teamId };
    this.context = next;
    return { data: next };
  }

  async contextSet(input: Record<string, unknown>): Promise<WorkbenchResult> {
    const teamId = typeof input.team_id === "string" ? input.team_id : "";
    const agentId = typeof input.agent_id === "string" ? input.agent_id : "";
    if (!teamId || !agentId) throw new Error("team_id and agent_id are required");

    const userId = await this.currentUser();
    const agent = asRecord(await this.core("/v3/meta/agent/get", { agent_id: agentId }));
    if (agent.team_id !== teamId) throw new Error(`Agent ${agentId} does not belong to team ${teamId}`);
    const ownerUserId = typeof agent.owner_user_id === "string" ? agent.owner_user_id : userId;
    const next: AgentWorkbenchContext = {
      scope: "agent",
      user_id: userId,
      team_id: teamId,
      agent_id: agentId,
      owner_user_id: ownerUserId,
      task_id: typeof input.task_id === "string" ? input.task_id : undefined,
      chat_memory_asset_id: `chat_memory-${teamId}-${agentId}`,
    };
    await this.ensureChatMemoryAsset(next);
    this.context = next;
    return { data: next };
  }

  async contextClear(): Promise<WorkbenchResult> {
    this.context = undefined;
    return { data: { active: false } };
  }

  capabilities(): WorkbenchResult {
    return {
      data: {
        model: "agent-workbench",
        context: "explicit team or team/agent context with session reuse",
        persistence: ["ephemeral session context", "durable agent memory", "staged reusable assets"],
        workflows: [
          "workbench_context_set",
          "workbench_team_context_set",
          "recall_context",
          "record_decision",
          "import_conversation",
          "asset_list",
          "asset_stage",
          "asset_publish",
          "asset_job_status",
        ],
        resource_types: ["chat_memory", "skill", "llm_wiki", "code_graph"],
        team_context: "Team context supports shared asset discovery and read/status workflows without selecting an agent.",
        agent_context: "Agent context is required for durable memory, skills, staging, publishing, and asset bindings.",
        note: "Durable resources are registered as GUI-visible assets and bound to the active agent.",
      },
    };
  }

  async importConversation(input: Record<string, unknown>): Promise<WorkbenchResult> {
    const ctx = this.requireAgentContext();
    const sessionId = typeof input.session_id === "string" ? input.session_id : "";
    const messages = Array.isArray(input.messages) ? input.messages : [];
    if (!sessionId || messages.length === 0) throw new Error("session_id and a non-empty messages array are required");
    const asset = await this.ensureChatMemoryAsset(ctx);
    const data = await this.core("/v3/conversation/add", {
      team_id: ctx.team_id,
      agent_id: ctx.agent_id,
      user_id: ctx.owner_user_id,
      ...(ctx.task_id ? { task_id: ctx.task_id } : {}),
      session_id: sessionId,
      messages,
    });
    return { data: { asset, session_id: sessionId, ingestion: data, gui_layers: ["L0", "L1", "L2", "L3"] } };
  }

  async recordDecision(input: Record<string, unknown>): Promise<WorkbenchResult> {
    this.requireAgentContext();
    const decision = typeof input.decision === "string" ? input.decision.trim() : "";
    if (!decision) throw new Error("decision is required");
    const rationale = typeof input.rationale === "string" ? input.rationale.trim() : "";
    const sourceRef = typeof input.source_ref === "string" ? input.source_ref.trim() : "";
    const sessionId = typeof input.session_id === "string" && input.session_id
      ? input.session_id
      : `mcp-${randomUUID()}`;
    return this.importConversation({
      session_id: sessionId,
      messages: [{
        role: "assistant",
        content: ["[Decision]", decision, rationale ? `[Rationale] ${rationale}` : "", sourceRef ? `[Source] ${sourceRef}` : ""]
          .filter(Boolean)
          .join("\n"),
      }],
    });
  }

  async assetList(input: Record<string, unknown>): Promise<WorkbenchResult> {
    const ctx = this.requireTeamContext();
    const data = await this.core("/v3/meta/asset/list-accessible", {
      user_id: ctx.user_id,
      team_id: ctx.team_id,
      action: "read",
      ...(ctx.scope === "agent" ? { agent_id: ctx.agent_id } : {}),
      ...(typeof input.asset_type === "string" ? { asset_type: input.asset_type } : {}),
      ...(typeof input.status === "string" ? { status: input.status } : {}),
      ...(typeof input.limit === "number" ? { limit: input.limit } : {}),
      ...(typeof input.offset === "number" ? { offset: input.offset } : {}),
    });
    return { data };
  }

  async assetGet(input: Record<string, unknown>): Promise<WorkbenchResult> {
    this.requireTeamContext();
    const assetId = typeof input.asset_id === "string" ? input.asset_id : "";
    if (!assetId) throw new Error("asset_id is required");
    return { data: await this.core("/v3/meta/asset/get", { asset_id: assetId }) };
  }

  async assetUpdate(input: Record<string, unknown>): Promise<WorkbenchResult> {
    const ctx = this.requireAgentContext();
    const assetId = typeof input.asset_id === "string" ? input.asset_id : "";
    if (!assetId) throw new Error("asset_id is required");
    const patch: Record<string, unknown> = { asset_id: assetId };
    for (const key of ["name", "description", "source_ref"]) {
      if (typeof input[key] === "string") patch[key] = input[key];
    }
    if (Object.keys(patch).length === 1) throw new Error("at least one mutable asset field is required");
    const asset = asRecord(await this.core("/v3/meta/asset/get", { asset_id: assetId }));
    if (asset.owner_user_id && asset.owner_user_id !== ctx.owner_user_id) throw new Error("Only the asset owner can update this asset");
    return { data: await this.core("/v3/meta/asset/update", patch) };
  }

  async assetBind(input: Record<string, unknown>): Promise<WorkbenchResult> {
    const ctx = this.requireAgentContext();
    const assetId = typeof input.asset_id === "string" ? input.asset_id : "";
    if (!assetId) throw new Error("asset_id is required");
    const asset = asRecord(await this.core("/v3/meta/asset/get", { asset_id: assetId }));
    const assetType = typeof asset.asset_type === "string" ? asset.asset_type : "";
    if (!assetType) throw new Error("asset metadata has no asset_type");
    await this.ensureBinding(
      ctx,
      assetId,
      assetType,
      typeof input.injection_mode === "string" ? input.injection_mode : "summary",
      typeof input.priority === "number" ? input.priority : 50,
    );
    return { data: { bound: true, agent_id: ctx.agent_id, asset_id: assetId } };
  }

  async assetUnbind(input: Record<string, unknown>): Promise<WorkbenchResult> {
    const ctx = this.requireAgentContext();
    if (input.confirm !== true) throw new Error("Unbinding requires confirm=true");
    const assetId = typeof input.asset_id === "string" ? input.asset_id : "";
    if (!assetId) throw new Error("asset_id is required");
    if (assetId === ctx.chat_memory_asset_id) throw new Error("The agent's own Chat Memory cannot be unbound");
    const bindings = itemsOf(await this.core("/v3/meta/agent-fixed-asset/list", { agent_id: ctx.agent_id, limit: 1000, offset: 0 }));
    if (!bindings.some((binding) => binding.asset_id === assetId)) return { data: { unbound: false, reason: "not_bound" } };
    await this.core("/v3/meta/agent-fixed-asset/set", {
      agent_id: ctx.agent_id,
      bindings: bindings.filter((binding) => binding.asset_id !== assetId).map((binding) => ({
        asset_id: binding.asset_id,
        asset_type: binding.asset_type,
        injection_mode: typeof binding.injection_mode === "string" ? binding.injection_mode : "summary",
        priority: typeof binding.priority === "number" ? binding.priority : 50,
        created_by: ctx.owner_user_id,
      })),
    });
    return { data: { unbound: true, agent_id: ctx.agent_id, asset_id: assetId } };
  }

  async recallContext(input: Record<string, unknown>): Promise<WorkbenchResult> {
    const ctx = this.requireAgentContext();
    const query = typeof input.query === "string" ? input.query.trim() : "";
    if (!query) throw new Error("query is required");
    const limit = typeof input.limit === "number" ? Math.min(Math.max(input.limit, 1), 50) : 5;
    const ids = { team_id: ctx.team_id, agent_id: ctx.agent_id, user_id: ctx.owner_user_id };
    const settled = await Promise.allSettled([
      this.core("/v3/conversation/search", { ...ids, query, limit }),
      this.core("/v3/atomic/search", { ...ids, query, limit }),
      this.core("/v3/core/read", ids),
      this.assetList({ limit: 1000 }),
    ]);
    const value = (index: number): unknown => settled[index]?.status === "fulfilled" ? settled[index].value : null;
    const assets = itemsOf(value(3));
    const includeAssets = input.include_assets !== false;
    const knowledge = includeAssets
      ? await Promise.all(assets.filter((asset) => READABLE_ASSET_TYPES.has(asset.asset_type) && asset.asset_id !== ctx.chat_memory_asset_id).slice(0, 12).map(async (asset) => {
      try {
        if (asset.asset_type === "llm_wiki") {
          return { asset_id: asset.asset_id, type: asset.asset_type, result: await callApi(this.opts, "/wiki/search", { wiki_id: asset.asset_id, query, limit }) };
        }
        if (asset.asset_type === "code_graph") {
          return { asset_id: asset.asset_id, type: asset.asset_type, result: await callApi(this.opts, "/code-graph/explore", { code_graph_id: asset.asset_id, query, maxFiles: limit }) };
        }
        return { asset_id: asset.asset_id, type: asset.asset_type, name: asset.name, status: asset.status };
      } catch (error) {
        return { asset_id: asset.asset_id, type: asset.asset_type, error: error instanceof Error ? error.message : String(error) };
      }
      }))
      : [];
    return {
      data: {
        query,
        context: ctx,
        packet: {
          conversation: value(0),
          atomic: value(1),
          core: value(2),
          knowledge,
        },
        degraded_sources: settled.map((result, index) => result.status === "rejected" ? index : null).filter((index): index is number => index !== null),
      },
    };
  }

  async assetStage(input: Record<string, unknown>): Promise<WorkbenchResult> {
    const ctx = this.requireAgentContext();
    const type = typeof input.type === "string" ? input.type : "";
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (!name || !["skill", "llm_wiki", "code_graph"].includes(type)) throw new Error("type and name are required");
    const description = typeof input.description === "string" ? input.description : undefined;
    const sourceRef = typeof input.source_ref === "string" ? input.source_ref : undefined;

    if (type === "skill") {
      const content = typeof input.content === "string" && input.content
        ? input.content
        : `---\nname: ${name}\ndescription: ${description ?? name}\n---\n\n# ${name}\n`;
      const skill = await this.core("/v3/skill/create", {
        user_id: ctx.user_id,
        team_id: ctx.team_id,
        agent_id: ctx.agent_id,
        name,
        content,
      });
      return { data: { kind: "skill", status: "draft", resource: skill } };
    }

    const createBody = {
      team_id: ctx.team_id,
      user_id: ctx.owner_user_id,
      agent_id: ctx.agent_id,
      name,
      ...(type === "code_graph"
        ? { repo_url: typeof input.repo_url === "string" ? input.repo_url : "", branch: typeof input.branch === "string" ? input.branch : "main" }
        : {}),
    };
    if (type === "code_graph" && !(typeof input.repo_url === "string" && input.repo_url)) {
      throw new Error("repo_url is required when staging a CodeGraph asset");
    }
    const resource = type === "llm_wiki"
      ? await callApi(this.opts, "/wiki/create", createBody)
      : await callApi(this.opts, "/code-graph/create", createBody);
    const resourceRecord = asRecord(resource);
    const resourceId = typeof resourceRecord.wiki_id === "string"
      ? resourceRecord.wiki_id
      : typeof resourceRecord.code_graph_id === "string" ? resourceRecord.code_graph_id : "";
    if (!resourceId) throw new Error(`Knowledge service did not return a ${type} resource ID`);

    const assetBody = {
      asset_id: resourceId,
      team_id: ctx.team_id,
      asset_type: type,
      name,
      owner_user_id: ctx.owner_user_id,
      source_type: "mcp",
      ...(sourceRef ? { source_ref: sourceRef } : {}),
      visibility: "private",
      status: "draft",
    };
    try {
      await this.core("/v3/meta/asset/create", assetBody);
    } catch (err) {
      if (!(err instanceof Error) || !/already|exists|duplicate|conflict/i.test(err.message)) throw err;
      await this.core("/v3/meta/asset/get", { asset_id: resourceId });
    }
    await this.ensureBinding(ctx, resourceId, type, "tool", 50);
    if (type === "llm_wiki" && typeof input.content === "string" && input.content) {
      await callApi(this.opts, "/wiki/raw/write", {
        ...createBody,
        wiki_id: resourceId,
        files: [{ filename: "source.md", content: input.content }],
      });
      const job = await callApi(this.opts, "/wiki/ingest", { wiki_id: resourceId, user_id: ctx.owner_user_id });
      return { data: { kind: type, asset_id: resourceId, status: "processing", resource, job } };
    }
    return { data: { kind: type, asset_id: resourceId, status: resourceRecord.status ?? "draft", resource } };
  }

  async assetPublish(input: Record<string, unknown>): Promise<WorkbenchResult> {
    const ctx = this.requireAgentContext();
    if (input.confirm !== true) throw new Error("Publishing requires confirm=true");
    const assetId = typeof input.asset_id === "string" ? input.asset_id : "";
    if (!assetId) throw new Error("asset_id is required");
    const asset = await this.core("/v3/meta/asset/get", { asset_id: assetId }) as AssetRecord;
    if (asset.owner_user_id && asset.owner_user_id !== ctx.owner_user_id) throw new Error("Only the asset owner can publish this asset");
    const updated = await this.core("/v3/meta/asset/update", { asset_id: assetId, status: "approved" });
    return { data: { asset: updated, published: true } };
  }

  async assetJobStatus(input: Record<string, unknown>): Promise<WorkbenchResult> {
    this.requireTeamContext();
    const assetId = typeof input.asset_id === "string" ? input.asset_id : "";
    if (!assetId) throw new Error("asset_id is required");
    if (assetId.startsWith("wiki-")) return { data: await callApi(this.opts, "/wiki/get", { wiki_id: assetId }) };
    if (assetId.startsWith("cg-")) return { data: await callApi(this.opts, "/code-graph/get", { code_graph_id: assetId }) };
    return { data: await this.core("/v3/meta/asset/get", { asset_id: assetId }) };
  }

  async invoke(workflow: string, input: Record<string, unknown>): Promise<WorkbenchResult> {
    switch (workflow) {
      case "context_get": return this.contextGet();
      case "context_set": return this.contextSet(input);
      case "team_context_set": return this.teamContextSet(input);
      case "context_clear": return this.contextClear();
      case "capabilities": return this.capabilities();
      case "recall_context": return this.recallContext(input);
      case "record_decision": return this.recordDecision(input);
      case "import_conversation": return this.importConversation(input);
      case "asset_list": return this.assetList(input);
      case "asset_get": return this.assetGet(input);
      case "asset_update": return this.assetUpdate(input);
      case "asset_bind": return this.assetBind(input);
      case "asset_unbind": return this.assetUnbind(input);
      case "asset_stage": return this.assetStage(input);
      case "asset_publish": return this.assetPublish(input);
      case "asset_job_status": return this.assetJobStatus(input);
      default: throw new Error(`Unknown workbench workflow: ${workflow}`);
    }
  }
}
