import { useEffect, useState, useCallback, useMemo, useRef, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import Graph from "graphology";
import { SigmaContainer, useLoadGraph, useRegisterEvents, useSigma } from "@react-sigma/core";
import "@react-sigma/core/lib/style.css";
import forceAtlas2 from "graphology-layout-forceatlas2";
import { SearchIcon, CloseIcon } from 'tea-icons-react';

// --- Types (re-exported from knowledge-api) ---
export interface GraphNode {
  id: string; label: string; type: string; path: string; linkCount: number; community: number;
  snippet?: string; inboundLinkCount?: number; outboundLinkCount?: number;
}
export interface GraphEdge { source: string; target: string; weight: number; }
export interface GraphData {
  nodes: GraphNode[]; edges: GraphEdge[];
  communities?: { id: number; nodeCount: number; topNodes: string[] }[];
}

// Sigma 的 Canvas 绘制不能直接解析 CSS var()，因此在组件渲染时读取 Tea Token 的计算值。
// 这避免模块加载早于 Tea 主题 CSS 时取得空值，并会在主题属性变更后刷新画布调色板。
interface AtlasPalette {
  bg: string;
  toolbarBg: string;
  dim: string;
  dimFaded: string;
  edgeBase: string;
  edgeHover: string;
  label: string;
  nodeColors: Record<string, string>;
  communityColors: string[];
}

function readTeaColor(token: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(token).trim();
}

function createAtlasPalette(): AtlasPalette {
  const dim = readTeaColor('--tea-color-bg-tertiary-default');
  const accents = [
    readTeaColor('--tea-color-bg-brand-default'),
    readTeaColor('--tea-color-bg-warning-default'),
    readTeaColor('--tea-color-bg-amber-default'),
    readTeaColor('--tea-color-bg-error-default'),
  ];
  const nodeColors: Record<string, string> = {
    entity: accents[0],
    concept: accents[1],
    source: accents[2],
    query: dim,
    synthesis: accents[3],
    overview: accents[2],
    comparison: dim,
    finding: accents[1],
    thesis: accents[3],
    methodology: dim,
    other: dim,
  };

  return {
    bg: readTeaColor('--tea-color-bg-primary-default'),
    toolbarBg: readTeaColor('--tea-color-bg-secondary-default'),
    dim,
    dimFaded: readTeaColor('--tea-color-bg-secondary-default'),
    edgeBase: readTeaColor('--tea-color-border-secondary-default'),
    edgeHover: readTeaColor('--tea-color-border-brand-default'),
    label: readTeaColor('--tea-color-text-primary'),
    nodeColors,
    communityColors: [
      accents[0], dim, accents[1], dim, accents[2], dim,
      accents[3], dim, accents[0], dim, accents[1], dim,
    ],
  };
}

type ColorMode = "type" | "community";

// --- Structural node filter ---
const STRUCTURAL_IDS = new Set(["index", "overview", "log", "schema", "purpose"]);
function isStructuralNode(node: GraphNode): boolean {
  const id = node.id.toLowerCase();
  if (STRUCTURAL_IDS.has(id)) return true;
  if (node.type === "overview") return true;
  const p = node.path.replace(/\\/g, "/").toLowerCase();
  return p.endsWith("/wiki/index.md") || p.endsWith("/wiki/overview.md") || p.endsWith("/wiki/log.md") || p.endsWith("/purpose.md") || p.endsWith("/schema.md");
}
function filterStructuralNodes(data: GraphData): GraphData {
  const hidden = new Set<string>();
  for (const n of data.nodes) if (isStructuralNode(n)) hidden.add(n.id);
  if (hidden.size === 0) return data;
  return { nodes: data.nodes.filter((n) => !hidden.has(n.id)), edges: data.edges.filter((e) => !hidden.has(e.source) && !hidden.has(e.target)), communities: data.communities };
}

// --- Helpers ---
const BASE_NODE_SIZE = 7;
const MAX_NODE_SIZE = 26;
function nc(type: string, palette: AtlasPalette): string { return palette.nodeColors[type] || palette.nodeColors.other; }
function ns(linkCount: number, maxLinks: number, nodeCount: number): number {
  if (maxLinks === 0) return BASE_NODE_SIZE;
  const r = linkCount / maxLinks;
  const s = nodeCount > 150 ? Math.sqrt(150 / nodeCount) : 1;
  return (BASE_NODE_SIZE + Math.pow(r, 0.6) * (MAX_NODE_SIZE - BASE_NODE_SIZE)) * s;
}
function layoutIter(n: number): number { return n > 2500 ? 28 : n > 1200 ? 40 : n > 600 ? 65 : n > 250 ? 90 : 140; }
function stableCoordinate(id: string, axis: number): number {
  let hash = axis === 0 ? 2166136261 : 16777619;
  for (let i = 0; i < id.length; i += 1) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619);
  return ((hash >>> 0) % 10000) / 100;
}

// --- Graph Loader ---
function GraphLoader({ nodes, edges, colorMode, onNodeClick, highlightNode, palette }: {
  nodes: GraphNode[]; edges: GraphEdge[]; colorMode: ColorMode;
  onNodeClick?: (n: GraphNode) => void; highlightNode?: string | null; palette: AtlasPalette;
}) {
  const loadGraph = useLoadGraph();
  const sigma = useSigma();
  const registerEvents = useRegisterEvents();
  const [hovered, setHovered] = useState<{ node: string; neighbors: Set<string> } | null>(null);
  const draggedNode = useRef<string | null>(null);
  const draggedPosition = useRef<{ x: number; y: number } | null>(null);
  const positions = useRef(new Map<string, { x: number; y: number }>());

  useEffect(() => {
    const graph = new Graph();
    const maxLinks = Math.max(...nodes.map((n) => n.linkCount), 1);
    for (const node of nodes) {
      const color = colorMode === "community"
        ? palette.communityColors[node.community % palette.communityColors.length]
        : nc(node.type, palette);
      const position = positions.current.get(node.id) || { x: stableCoordinate(node.id, 0), y: stableCoordinate(node.id, 1) };
      graph.addNode(node.id, { x: position.x, y: position.y, size: ns(node.linkCount, maxLinks, nodes.length), color, label: node.label });
    }
    const maxW = Math.max(...edges.map((e) => e.weight), 1);
    for (const edge of edges) {
      if (graph.hasNode(edge.source) && graph.hasNode(edge.target)) {
        const key = `${edge.source}->${edge.target}`;
        if (!graph.hasEdge(key) && !graph.hasEdge(`${edge.target}->${edge.source}`)) {
          const nw = edge.weight / maxW;
          // 连接线颜色走 Tea 次级边框 Token，权重仅影响线宽。
          graph.addEdgeWithKey(key, edge.source, edge.target, { size: 0.5 + nw * 1.4, color: palette.edgeBase });
        }
      }
    }
    const hasUnpositionedNode = nodes.some((node) => !positions.current.has(node.id));
    if (hasUnpositionedNode) {
      const settings = forceAtlas2.inferSettings(graph);
      forceAtlas2.assign(graph, { iterations: layoutIter(nodes.length), settings: { ...settings, gravity: 1.2, scalingRatio: nodes.length > 400 ? 3.5 : 2.5, strongGravityMode: true, barnesHutOptimize: nodes.length > 50 } });
      graph.forEachNode((id, attributes) => positions.current.set(id, { x: attributes.x, y: attributes.y }));
    }
    loadGraph(graph);
    sigma.refresh();
  }, [nodes, edges, colorMode, loadGraph, palette, sigma]);

  useEffect(() => {
    registerEvents({
      enterNode: (e) => { const g = sigma.getGraph(); setHovered({ node: e.node, neighbors: new Set(g.neighbors(e.node)) }); const c = sigma.getContainer(); if (c) c.style.cursor = "pointer"; },
      leaveNode: () => { setHovered(null); const c = sigma.getContainer(); if (c) c.style.cursor = "default"; },
      clickNode: (e) => { const n = nodes.find((n) => n.id === e.node); if (n && onNodeClick) onNodeClick(n); },
      downNode: (e) => {
        draggedNode.current = e.node;
        const attributes = sigma.getGraph().getNodeAttributes(e.node);
        draggedPosition.current = { x: attributes.x, y: attributes.y };
        e.preventSigmaDefault();
        const c = sigma.getContainer();
        if (c) c.style.cursor = "grabbing";
      },
      mousemovebody: (e) => {
        if (!draggedNode.current) return;
        const position = sigma.viewportToGraph(e);
        draggedPosition.current = position;
        sigma.getGraph().setNodeAttribute(draggedNode.current, "x", position.x);
        sigma.getGraph().setNodeAttribute(draggedNode.current, "y", position.y);
        positions.current.set(draggedNode.current, position);
        e.preventSigmaDefault();
        sigma.refresh({ partialGraph: { nodes: [draggedNode.current] } });
      },
      mouseup: () => {
        draggedNode.current = null;
        draggedPosition.current = null;
        const c = sigma.getContainer();
        if (c) c.style.cursor = "default";
      },
    });
  }, [registerEvents, sigma, nodes, onNodeClick]);

  useEffect(() => {
    const focusNode = highlightNode && sigma.getGraph().hasNode(highlightNode) ? highlightNode : null;
    const focusNeighbors = focusNode ? new Set(sigma.getGraph().neighbors(focusNode)) : null;
    const labelNodes = new Set(
      nodes
        .slice()
        .sort((a, b) => b.linkCount - a.linkCount || a.label.localeCompare(b.label))
        .slice(0, Math.min(10, nodes.length))
        .map((node) => node.id),
    );
    sigma.setSetting("nodeReducer", (node, data) => {
      const res = { ...data };
      if (!focusNode && !hovered && !labelNodes.has(node)) res.label = "";
      if (highlightNode && node === highlightNode) { res.highlighted = true; res.zIndex = 2; }
      if (focusNeighbors && node !== focusNode && !focusNeighbors.has(node)) {
        res.color = palette.dimFaded;
        res.label = "";
        res.zIndex = 0;
      }
      if (hovered) {
        if (node === hovered.node) { res.highlighted = true; res.zIndex = 2; res.size = (data.size || BASE_NODE_SIZE) * 1.3; }
        else if (hovered.neighbors.has(node)) { res.zIndex = 1; }
        else if (!focusNeighbors || !focusNeighbors.has(node)) { res.color = palette.dimFaded; res.label = ""; res.zIndex = 0; }
      }
      return res;
    });
    sigma.setSetting("edgeReducer", (edge, data) => {
      const res = { ...data };
      const g = sigma.getGraph();
      if (focusNode) {
        const source = g.source(edge);
        const target = g.target(edge);
        if (source !== focusNode && target !== focusNode) res.color = palette.edgeBase;
        if (source !== focusNode && target !== focusNode && !(focusNeighbors?.has(source) && focusNeighbors?.has(target))) res.hidden = true;
      }
      if (hovered) {
        if (g.source(edge) !== hovered.node && g.target(edge) !== hovered.node) { res.hidden = true; }
        else if (!focusNode || g.source(edge) === focusNode || g.target(edge) === focusNode) { res.color = palette.edgeHover; res.size = Math.max((data.size || 1) * 1.8, 2); }
      }
      return res;
    });
    sigma.refresh();
  }, [hovered, highlightNode, nodes, palette, sigma]);

  return null;
}

// --- Controls ---
function GraphControls() {
  const sigma = useSigma();
  const cls = "h-7 w-7 bg-card/90 hover:bg-card border border-border text-muted-foreground shadow-md rounded-md flex items-center justify-center transition-colors text-[12px] backdrop-blur";
  return (
    <div className="absolute bottom-3 right-3 flex flex-col gap-1 z-10">
      <button className={cls} onClick={() => sigma.getCamera().animatedZoom({ duration: 200 })}>+</button>
      <button className={cls} onClick={() => sigma.getCamera().animatedUnzoom({ duration: 200 })}>−</button>
      <button className={cls} onClick={() => sigma.getCamera().animatedReset({ duration: 300 })}>⊙</button>
    </div>
  );
}

// --- Main Component ---
interface Props {
  data: GraphData | null; loading?: boolean;
  onNodeClick?: (node: GraphNode) => void; highlightNode?: string | null; className?: string;
}

export default function KnowledgeGraph({ data, loading, onNodeClick, highlightNode, className }: Props) {
  const { t } = useTranslation();
  const [colorMode, setColorMode] = useState<ColorMode>("type");
  const [hideStructural, setHideStructural] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<GraphNode[]>([]);
  const [themeRevision, setThemeRevision] = useState(0);

  useEffect(() => {
    const observer = new MutationObserver(() => setThemeRevision((revision) => revision + 1));
    observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'theme-mode'] });
    return () => observer.disconnect();
  }, []);

  const palette = useMemo(() => createAtlasPalette(), [themeRevision]);
  const filteredData = useMemo(() => data ? (hideStructural ? filterStructuralNodes(data) : data) : null, [data, hideStructural]);

  const handleSearch = useCallback((q: string) => {
    setSearchQuery(q);
    if (!q.trim() || !filteredData) { setSearchResults([]); return; }
    const lower = q.toLowerCase();
    setSearchResults(filteredData.nodes.filter((n) => n.label.toLowerCase().includes(lower) || n.id.toLowerCase().includes(lower)).slice(0, 8));
  }, [filteredData]);

  if (loading) return <div className={`flex items-center justify-center ${className}`} style={{ background: palette.bg }}><span className="text-xs text-muted-foreground">{t('graph.loading')}</span></div>;
  if (!filteredData || filteredData.nodes.length === 0) return <div className={`flex items-center justify-center ${className}`} style={{ background: palette.bg }}><span className="text-[12px] text-muted-foreground/70">{t('graph.empty')}</span></div>;

  const typeSet = new Set(filteredData.nodes.map((n) => n.type));
  const types = [...typeSet].sort();

  // 极细网格背景 + 白底，营造"高科技画布"感（CSS grid pattern）
  const gridBg: CSSProperties = {
    background: palette.bg,
    backgroundImage:
      'linear-gradient(var(--tea-color-border-secondary-default) 1px, transparent 1px), linear-gradient(90deg, var(--tea-color-border-secondary-default) 1px, transparent 1px)',
    backgroundSize: '32px 32px'
  };

  return (
    <div className={`relative flex flex-col overflow-hidden ${className}`} style={{ background: palette.bg }}>
      {/* Toolbar */}
      <div className="flex items-center gap-2 border-b border-border px-3 py-2 z-10" style={{ background: palette.toolbarBg, backdropFilter: 'blur(8px)' }}>
        <div className="relative flex-1 max-w-[180px]">
          <span className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground/70 text-xs inline-flex items-center"><SearchIcon size={12} /></span>
          <input
            className="h-7 w-full pl-7 pr-6 text-xs border rounded-md bg-card/80 border-border text-foreground/70 placeholder:text-muted-foreground/70 focus:outline-none focus:ring-1 focus:ring-primary"
            placeholder={t('graph.searchPlaceholder')}
            value={searchQuery}
            onChange={(e) => handleSearch(e.target.value)}
          />
          {searchQuery && (
            <button className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground/70 hover:text-muted-foreground text-xs inline-flex items-center" onClick={() => { setSearchQuery(""); setSearchResults([]); }}><CloseIcon size={12} /></button>
          )}
        </div>
        <div className="flex gap-0.5">
          <button className={`rounded-md px-2 py-1 text-xs font-medium transition ${colorMode === "type" ? "bg-primary/5 text-primary ring-1 ring-primary/30" : "text-muted-foreground hover:text-foreground/70 hover:bg-muted"}`} onClick={() => setColorMode("type")}>{t('graph.colorMode.type')}</button>
          <button className={`rounded-md px-2 py-1 text-xs font-medium transition ${colorMode === "community" ? "bg-primary/5 text-primary ring-1 ring-primary/30" : "text-muted-foreground hover:text-foreground/70 hover:bg-muted"}`} onClick={() => setColorMode("community")}>{t('graph.colorMode.community')}</button>
        </div>
        <button className={`rounded-md px-2 py-1 text-xs font-medium transition ${hideStructural ? "bg-success/10 text-success ring-1 ring-success/30" : "text-muted-foreground hover:text-foreground/70 hover:bg-muted"}`}
          onClick={() => setHideStructural(!hideStructural)} title={t('graph.hideStructural.title')}>{t('graph.hideStructural')}</button>
        {hideStructural && data && filteredData.nodes.length !== data.nodes.length && (
          <button className="text-[11px] text-muted-foreground hover:text-foreground/80" onClick={() => setHideStructural(false)}>
            {t('graph.showStructural', 'Show structural')}
          </button>
        )}
        <span className="text-xs ml-auto font-mono text-muted-foreground">{t('graph.stats', { nodes: filteredData.nodes.length, edges: filteredData.edges.length })}</span>
      </div>

      {/* Search results dropdown */}
      {searchResults.length > 0 && searchQuery && (
        <div className="absolute top-12 left-3 z-20 w-[190px] rounded-lg border shadow-xl p-1 max-h-[200px] overflow-auto bg-card/95 border-border backdrop-blur">
          {searchResults.map((n) => (
            <div key={n.id} className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs cursor-pointer hover:bg-muted"
              onClick={() => { onNodeClick?.(n); setSearchQuery(""); setSearchResults([]); }}>
              <div className="h-2 w-2 rounded-full shrink-0" style={{ background: nc(n.type, palette) }} />
              <span className="truncate text-foreground/70">{n.label}</span>
            </div>
          ))}
        </div>
      )}

      {/* Sigma Canvas */}
      <div className="flex-1 min-h-0 relative" style={gridBg}>
        <SigmaContainer
          style={{ width: "100%", height: "100%", background: "transparent" }}
          settings={{
            allowInvalidContainer: true, renderLabels: true,
            labelFont: "system-ui, -apple-system, sans-serif", labelSize: 12, labelWeight: "500",
            labelDensity: (data?.nodes?.length || 0) > 600 ? 0.12 : 0.35, labelGridCellSize: 90,
            labelRenderedSizeThreshold: (data?.nodes?.length || 0) > 600 ? 12 : 7,
            defaultEdgeType: "line", defaultNodeColor: palette.dim,
            defaultEdgeColor: palette.edgeBase,
            labelColor: { color: palette.label }, stagePadding: 40, zIndex: true,
            minCameraRatio: 0.06, maxCameraRatio: 4,
          }}
        >
          <GraphLoader nodes={filteredData.nodes} edges={filteredData.edges} colorMode={colorMode} onNodeClick={onNodeClick} highlightNode={highlightNode} palette={palette} />
          <GraphControls />
        </SigmaContainer>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-3 border-t border-border px-3 py-1.5 z-10" style={{ background: palette.toolbarBg, backdropFilter: 'blur(8px)' }}>
        {(colorMode === "type" ? types : [...new Set(filteredData.nodes.map((n) => String(n.community)))].sort((a, b) => Number(a) - Number(b))).map((item) => {
          const c = colorMode === "type" ? nc(item, palette) : palette.communityColors[Number(item) % palette.communityColors.length];
          const isAccent = c !== palette.dim;
          return (
            <div key={item} className="flex items-center gap-1.5">
              <div className="h-2.5 w-2.5 rounded-full" style={{ background: c, boxShadow: isAccent ? 'var(--tea-shadow-xs)' : 'none' }} />
              <span className="text-xs text-muted-foreground">{colorMode === "type" ? item : `Community ${item}`}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
