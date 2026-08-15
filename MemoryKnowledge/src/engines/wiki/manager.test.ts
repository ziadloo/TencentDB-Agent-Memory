import Graph from "graphology";
import { describe, expect, it } from "vitest";

import { boundedGraphView, type PageGraph } from "./manager.js";

function fixture(): PageGraph {
  const nodes = ["a", "b", "c", "d"].map((id, index) => ({
    id,
    label: id,
    type: "concept",
    path: `wiki/${id}.md`,
    linkCount: index === 0 ? 3 : 1,
    community: 0,
  }));
  const edges = [
    { source: "a", target: "b", weight: 1 },
    { source: "a", target: "c", weight: 1 },
    { source: "a", target: "d", weight: 1 },
  ];
  const graph = new Graph({ type: "undirected" });
  for (const node of nodes) graph.addNode(node.id);
  for (const edge of edges) graph.addEdge(edge.source, edge.target);
  return {
    view: { nodes, edges, communities: [{ id: 0, nodeCount: 4, cohesion: 0.5, topNodes: ["a"] }] },
    graph,
    outAdj: new Map([["a", new Set(["b", "c", "d"])]]),
    inAdj: new Map([["b", new Set(["a"])], ["c", new Set(["a"])], ["d", new Set(["a"])]]),
    degree: new Map([["a", 3], ["b", 1], ["c", 1], ["d", 1]]),
  };
}

describe("boundedGraphView", () => {
  it("returns capped summaries with complete graph statistics", () => {
    const result = boundedGraphView(fixture(), { mode: "summary", maxNodes: 2, maxEdges: 1 });
    expect(result.mode).toBe("summary");
    expect(result.nodes.map((node) => node.id)).toEqual(["a", "b"]);
    expect(result.stats).toEqual({ nodeCount: 4, edgeCount: 3, communityCount: 1 });
    expect(result.truncated).toBe(true);
  });

  it("returns a bounded neighborhood around the requested center", () => {
    const result = boundedGraphView(fixture(), { mode: "neighborhood", center: "a", depth: 1, maxNodes: 3 });
    expect(result.nodes.map((node) => node.id)).toEqual(["a", "b", "c"]);
    expect(result.edges).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it("preserves the complete graph only for explicit full mode", () => {
    const result = boundedGraphView(fixture(), { mode: "full" });
    expect(result.nodes).toHaveLength(4);
    expect(result.edges).toHaveLength(3);
    expect(result.truncated).toBe(false);
  });
});
