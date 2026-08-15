import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkbenchRuntime } from "./workbench.js";

describe("WorkbenchRuntime", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("describes the harness-facing model without requiring a backend call", () => {
    const runtime = new WorkbenchRuntime({ baseUrl: "http://knowledge", coreBaseUrl: "http://core" });
    const result = runtime.capabilities();
    expect(result.data).toMatchObject({
      model: "agent-workbench",
      persistence: expect.arrayContaining(["durable agent memory", "staged reusable assets"]),
      resource_types: expect.not.arrayContaining(["skill"]),
      optional_resource_types: ["skill"],
    });
  });

  it("rejects durable operations without an explicit workbench context", async () => {
    const runtime = new WorkbenchRuntime({ baseUrl: "http://knowledge", coreBaseUrl: "http://core" });
    await expect(runtime.invoke("record_decision", { decision: "use the new API" }))
      .rejects.toThrow("No active workbench context");
    await expect(runtime.invoke("asset_list", {}))
      .rejects.toThrow("No active workbench context");
  });

  it("allows team context for shared reads but rejects agent-only workflows", async () => {
    const runtime = new WorkbenchRuntime({ baseUrl: "http://knowledge", coreBaseUrl: "http://core" });
    (runtime as unknown as { context: unknown }).context = {
      scope: "team",
      user_id: "usr-test",
      team_id: "team-test",
    };

    await expect(runtime.contextGet()).resolves.toMatchObject({
      data: { scope: "team", team_id: "team-test" },
    });
    await expect(runtime.invoke("record_decision", { decision: "not allowed here" }))
      .rejects.toThrow("Agent context is required");
    await expect(runtime.invoke("asset_stage", { type: "llm_wiki", name: "Wiki" }))
      .rejects.toThrow("Agent context is required");
  });

  it("sets team context after authenticating team membership without creating Chat Memory", async () => {
    const requests: Array<{ endpoint: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
      const endpoint = new URL(String(input)).pathname;
      requests.push({ endpoint, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      const data = endpoint.endsWith("/user/get")
        ? { user_id: "usr-test" }
        : { items: [{ team_id: "team-test" }], total: 1 };
      return new Response(JSON.stringify({ code: 0, message: "ok", data }), { status: 200 });
    }));

    const runtime = new WorkbenchRuntime({ baseUrl: "http://knowledge", coreBaseUrl: "http://core", userKey: "user-key" });
    await expect(runtime.invoke("team_context_set", { team_id: "team-test" })).resolves.toMatchObject({
      data: { scope: "team", user_id: "usr-test", team_id: "team-test" },
    });
    expect(requests.map((request) => request.endpoint)).toEqual([
      "/v3/meta/user/get",
      "/v3/meta/team/list",
    ]);
    expect(requests[1]?.body).toMatchObject({ limit: 100, offset: 0 });
  });

  it("requires a repository when staging a CodeGraph", async () => {
    const runtime = new WorkbenchRuntime({ baseUrl: "http://knowledge", coreBaseUrl: "http://core" });
    // Set the private context through the public workflow; the first backend call
    // is intentionally not needed for this validation path.
    (runtime as unknown as { context: unknown }).context = {
      scope: "agent",
      user_id: "usr-test",
      team_id: "team-test",
      agent_id: "agt-test",
      owner_user_id: "usr-test",
      chat_memory_asset_id: "chat_memory-team-test-agt-test",
    };
    await expect(runtime.invoke("asset_stage", { type: "code_graph", name: "Repo" }))
      .rejects.toThrow("repo_url is required");
  });

  it("paginates agent fixed-asset reads at the metadata API limit", async () => {
    const requests: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
      const endpoint = new URL(String(input)).pathname;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ endpoint, ...body });
      const page = body.offset === 0
        ? Array.from({ length: 100 }, (_, index) => ({
          asset_id: `asset-${index}`,
          asset_type: "llm_wiki",
        }))
        : [];
      return new Response(JSON.stringify({ code: 0, message: "ok", data: { items: page, total: 100 } }), { status: 200 });
    }));

    const runtime = new WorkbenchRuntime({ baseUrl: "http://knowledge", coreBaseUrl: "http://core" });
    (runtime as unknown as { context: unknown }).context = {
      scope: "agent",
      user_id: "usr-test",
      team_id: "team-test",
      agent_id: "agt-test",
      owner_user_id: "usr-test",
      chat_memory_asset_id: "chat_memory-team-test-agt-test",
    };

    await expect(runtime.invoke("asset_unbind", { asset_id: "missing", confirm: true }))
      .resolves.toMatchObject({ data: { unbound: false, reason: "not_bound" } });
    expect(requests).toEqual([
      expect.objectContaining({ endpoint: "/v3/meta/agent-fixed-asset/list", limit: 100, offset: 0 }),
      expect.objectContaining({ endpoint: "/v3/meta/agent-fixed-asset/list", limit: 100, offset: 100 }),
    ]);
  });

  it("updates an existing binding when its injection settings change", async () => {
    const requests: Array<{ endpoint: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
      const endpoint = new URL(String(input)).pathname;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ endpoint, body });
      let data: unknown = {};
      if (endpoint.endsWith("/asset/get")) data = { asset_id: "wiki-test", asset_type: "llm_wiki", owner_user_id: "usr-test" };
      if (endpoint.endsWith("/agent-fixed-asset/list")) data = {
        items: [{ asset_id: "wiki-test", asset_type: "llm_wiki", injection_mode: "summary", priority: 50 }],
      };
      return new Response(JSON.stringify({ code: 0, message: "ok", data }), { status: 200 });
    }));

    const runtime = new WorkbenchRuntime({ baseUrl: "http://knowledge", coreBaseUrl: "http://core" });
    (runtime as unknown as { context: unknown }).context = {
      scope: "agent",
      user_id: "usr-test",
      team_id: "team-test",
      agent_id: "agt-test",
      owner_user_id: "usr-test",
      chat_memory_asset_id: "chat_memory-team-test-agt-test",
    };

    await expect(runtime.invoke("asset_bind", { asset_id: "wiki-test", injection_mode: "tool", priority: 7 }))
      .resolves.toMatchObject({ data: { bound: true } });
    const setRequest = requests.find((request) => request.endpoint.endsWith("/agent-fixed-asset/set"));
    expect(setRequest?.body.bindings).toEqual([
      expect.objectContaining({ asset_id: "wiki-test", injection_mode: "tool", priority: 7 }),
    ]);
  });

  it("rejects publishing a Wiki whose ingestion failed", async () => {
    const endpoints: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      const endpoint = new URL(String(input)).pathname;
      endpoints.push(endpoint);
      const data = endpoint.endsWith("/asset/get")
        ? { asset_id: "wiki-failed", asset_type: "llm_wiki", owner_user_id: "usr-test" }
        : { wiki_id: "wiki-failed", status: "failed" };
      return new Response(JSON.stringify({ code: 0, message: "ok", data }), { status: 200 });
    }));

    const runtime = new WorkbenchRuntime({ baseUrl: "http://knowledge", coreBaseUrl: "http://core" });
    (runtime as unknown as { context: unknown }).context = {
      scope: "agent",
      user_id: "usr-test",
      team_id: "team-test",
      agent_id: "agt-test",
      owner_user_id: "usr-test",
      chat_memory_asset_id: "chat_memory-team-test-agt-test",
    };

    await expect(runtime.invoke("asset_publish", { asset_id: "wiki-failed", confirm: true }))
      .rejects.toThrow("not ready for publishing");
    expect(endpoints).not.toContain("/v3/meta/asset/update");
  });

  it("includes accessible Wiki results in recall_context", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      const endpoint = new URL(String(input)).pathname;
      let data: unknown;
      if (endpoint.endsWith("/conversation/search")) data = { messages: [] };
      else if (endpoint.endsWith("/atomic/search")) data = { items: [] };
      else if (endpoint.endsWith("/core/read")) data = { content: null };
      else if (endpoint.endsWith("/asset/list-accessible")) data = {
        items: [{ asset_id: "wiki-test", asset_type: "llm_wiki", name: "Test Wiki", status: "ready" }],
        total: 1,
      };
      else data = { results: [{ title: "Test", path: "wiki/test.md" }], count: 1 };
      return new Response(JSON.stringify({ code: 0, message: "ok", data }), { status: 200 });
    }));

    const runtime = new WorkbenchRuntime({ baseUrl: "http://knowledge", coreBaseUrl: "http://core" });
    (runtime as unknown as { context: unknown }).context = {
      scope: "agent",
      user_id: "usr-test",
      team_id: "team-test",
      agent_id: "agt-test",
      owner_user_id: "usr-test",
      chat_memory_asset_id: "chat_memory-team-test-agt-test",
    };

    const result = await runtime.invoke("recall_context", { query: "test", limit: 2 });
    expect(result).toMatchObject({ data: { packet: { knowledge: [{ asset_id: "wiki-test", type: "llm_wiki" }] } } });
  });

  it("filters asset status in the MCP when the metadata endpoint cannot", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      code: 0,
      message: "ok",
      data: {
        items: [
          { asset_id: "draft", asset_type: "llm_wiki", status: "draft" },
          { asset_id: "approved", asset_type: "llm_wiki", status: "approved" },
        ],
        total: 2,
      },
    }), { status: 200 })));

    const runtime = new WorkbenchRuntime({ baseUrl: "http://knowledge", coreBaseUrl: "http://core" });
    (runtime as unknown as { context: unknown }).context = {
      scope: "team",
      user_id: "usr-test",
      team_id: "team-test",
    };

    await expect(runtime.invoke("asset_list", { status: "approved", limit: 20, offset: 0 }))
      .resolves.toMatchObject({ data: { total: 1, items: [{ asset_id: "approved" }] } });
  });
});
