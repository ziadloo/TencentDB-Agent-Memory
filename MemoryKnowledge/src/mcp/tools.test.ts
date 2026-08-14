import { describe, expect, it } from "vitest";

import { MCP_TOOLS } from "./tools.js";

describe("MCP workspace tool registry", () => {
  it("contains unique names and keeps the original knowledge tools", () => {
    const names = MCP_TOOLS.map((tool) => tool.name);

    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(expect.arrayContaining([
      "code_search",
      "wiki_search",
      "memory_conversation_search",
      "skill_search",
      "workspace_list_teams",
    ]));
  });

  it("marks destructive operations separately", () => {
    const destructive = MCP_TOOLS.filter((tool) => tool.destructive).map((tool) => tool.name);

    expect(destructive).toEqual(expect.arrayContaining([
      "memory_conversation_delete",
      "skill_delete",
      "skill_files_remove",
    ]));
    expect(MCP_TOOLS.find((tool) => tool.name === "memory_conversation_search")?.destructive).toBeFalsy();
  });

  it("keeps Core request bodies behind an explicit payload", () => {
    const tool = MCP_TOOLS.find((candidate) => candidate.name === "skill_update");

    expect(tool?.backend).toBe("core");
    expect(tool?.inputSchema.required).toEqual(["payload"]);
  });
});
