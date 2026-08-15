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
});
