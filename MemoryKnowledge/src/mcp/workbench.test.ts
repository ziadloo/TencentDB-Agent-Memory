import { describe, expect, it } from "vitest";

import { WorkbenchRuntime } from "./workbench.js";

describe("WorkbenchRuntime", () => {
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

  it("requires a repository when staging a CodeGraph", async () => {
    const runtime = new WorkbenchRuntime({ baseUrl: "http://knowledge", coreBaseUrl: "http://core" });
    // Set the private context through the public workflow; the first backend call
    // is intentionally not needed for this validation path.
    (runtime as unknown as { context: unknown }).context = {
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
