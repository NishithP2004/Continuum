import Graph from "graphology";
import Sigma from "sigma";
import { AlertTriangle, Bookmark, CheckSquare2, FileCode2, FolderGit2, GitCommitHorizontal, Lightbulb, Scale, XCircle } from "lucide-react";
import { type PointerEvent as ReactPointerEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import type { GraphNode, GraphSnapshot } from "../lib/types";

const kindColors: Record<string, string> = {
  project: "#0866eb", task: "#0866eb", checkpoint: "#2f9c53", file: "#5d6672", commit: "#7756d8",
  blocker: "#e42a2a", decision: "#e88a00", concept: "#777f89", error: "#e42a2a", url: "#1689a6"
};
const kindIcons: Record<string, typeof Bookmark> = {
  project: FolderGit2, task: CheckSquare2, checkpoint: Bookmark, file: FileCode2, commit: GitCommitHorizontal,
  blocker: XCircle, decision: Scale, concept: Lightbulb, error: AlertTriangle
};

function supportsWebGl(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") || canvas.getContext("webgl"));
  } catch { return false; }
}

function position(index: number, total: number, kind: string): { x: number; y: number } {
  if (total === 1) return { x: 0, y: 0 };
  const layer = ["project", "task", "checkpoint", "blocker", "decision", "file", "commit", "concept"].indexOf(kind);
  const radius = 4 + Math.max(0, layer) * .45 + Math.floor(index / 10) * 1.1;
  const angle = (index / total) * Math.PI * 2 - Math.PI / 2;
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}

function compactSnapshot(snapshot: GraphSnapshot, selectedId?: string): GraphSnapshot {
  if (snapshot.nodes.length <= 7) return snapshot;
  const degree = new Map(snapshot.nodes.map((node) => [node.id, 0]));
  snapshot.edges.forEach((edge) => {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  });
  const center = snapshot.nodes.find((node) => node.id === selectedId)
    ?? [...snapshot.nodes].sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0))[0];
  if (!center) return snapshot;
  const neighborIds = snapshot.edges.flatMap((edge) => edge.source === center.id ? [edge.target] : edge.target === center.id ? [edge.source] : []);
  const ranked = [...new Set(neighborIds)].sort((a, b) => (degree.get(b) ?? 0) - (degree.get(a) ?? 0));
  const selected = new Set([center.id, ...ranked.slice(0, 6)]);
  if (selected.size < 7) {
    [...snapshot.nodes].sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0)).forEach((node) => {
      if (selected.size < 7) selected.add(node.id);
    });
  }
  return {
    ...snapshot,
    nodes: snapshot.nodes.filter((node) => selected.has(node.id)),
    edges: snapshot.edges.filter((edge) => selected.has(edge.source) && selected.has(edge.target)),
    truncated: true
  };
}

export function GraphCanvas({ snapshot, selectedId, onSelect, fitSignal }: { snapshot: GraphSnapshot; selectedId?: string; onSelect(node: GraphNode | null): void; fitSignal?: number }) {
  const container = useRef<HTMLDivElement>(null);
  const renderer = useRef<Sigma | null>(null);
  const [webgl] = useState(supportsWebGl);
  const [compactLayout, setCompactLayout] = useState(() => window.matchMedia("(max-width: 860px)").matches);
  const nodeMap = useMemo(() => new Map(snapshot.nodes.map((node) => [node.id, node])), [snapshot.nodes]);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 860px)");
    const update = () => setCompactLayout(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (!webgl || !container.current) return;
    const graph = new Graph();
    snapshot.nodes.forEach((node, index) => {
      const point = position(index, snapshot.nodes.length, node.kind);
      graph.addNode(node.id, { ...point, label: node.label, size: 8 + Math.min(9, (node.importance ?? .5) * 8), color: kindColors[node.kind] ?? "#67707d" });
    });
    snapshot.edges.forEach((edge) => {
      if (graph.hasNode(edge.source) && graph.hasNode(edge.target) && !graph.hasEdge(edge.id)) graph.addEdgeWithKey(edge.id, edge.source, edge.target, { label: edge.relation, size: 1, color: "#9ba2ad", type: edge.directed === false ? "line" : "arrow" });
    });
    const sigma = new Sigma(graph, container.current, {
      renderEdgeLabels: true,
      labelFont: "-apple-system, BlinkMacSystemFont, sans-serif",
      labelSize: 12,
      labelWeight: "600",
      labelColor: { color: getComputedStyle(document.documentElement).getPropertyValue("--text").trim() || "#111318" },
      edgeLabelColor: { color: getComputedStyle(document.documentElement).getPropertyValue("--text-soft").trim() || "#5f6470" },
      edgeLabelSize: 9,
      defaultEdgeType: "arrow",
      nodeReducer: (node, data) => selectedId && node !== selectedId ? { ...data, color: "#c9cdd4", label: "", zIndex: 0 } : { ...data, highlighted: node === selectedId, zIndex: node === selectedId ? 2 : 1 },
      edgeReducer: (edge, data) => {
        if (!selectedId) return data;
        const extremities = graph.extremities(edge);
        return extremities.includes(selectedId) ? { ...data, color: "#637184", size: 1.8 } : { ...data, hidden: true };
      }
    });
    sigma.on("clickNode", ({ node }) => onSelect(nodeMap.get(node) ?? null));
    sigma.on("clickStage", () => onSelect(null));
    renderer.current = sigma;
    return () => { sigma.kill(); renderer.current = null; };
  }, [nodeMap, onSelect, selectedId, snapshot, webgl]);

  useEffect(() => {
    if (fitSignal === undefined) return;
    renderer.current?.getCamera().animatedReset({ duration: 260 });
  }, [fitSignal]);

  if (compactLayout) return <CardGraph snapshot={compactSnapshot(snapshot, selectedId)} totalNodes={snapshot.nodes.length} selectedId={selectedId} onSelect={onSelect} fitSignal={fitSignal} compact />;
  if (snapshot.nodes.length <= 40) return <CardGraph snapshot={snapshot} totalNodes={snapshot.nodes.length} selectedId={selectedId} onSelect={onSelect} fitSignal={fitSignal} compact={false} />;
  if (!webgl) return <SemanticGraph snapshot={snapshot} selectedId={selectedId} onSelect={onSelect} />;
  return <div className="sigma-graph"><div className="sigma-canvas" ref={container} role="img" aria-label={`Graph visualization with ${snapshot.nodes.length} nodes and ${snapshot.edges.length} relationships`} /><details className="graph-keyboard-browser"><summary>Browse nodes</summary><p>Choose a node to inspect it. Search or filter the graph to narrow this list.</p><div>{snapshot.nodes.slice(0, 100).map((node) => <button type="button" key={node.id} data-selected={node.id === selectedId} onClick={() => onSelect(node)}><span>{node.kind}</span><strong>{node.label}</strong></button>)}</div>{snapshot.nodes.length > 100 && <small>Showing the first 100 nodes. Narrow the graph to browse the rest.</small>}</details></div>;
}

function cardPositions(snapshot: GraphSnapshot, compact: boolean): Map<string, { x: number; y: number }> {
  const degree = new Map(snapshot.nodes.map((node) => [node.id, 0]));
  snapshot.edges.forEach((edge) => { degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1); degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1); });
  const ordered = [...snapshot.nodes].sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) || (a.kind === "task" ? -1 : 1));
  const center = ordered[0];
  const positions = new Map<string, { x: number; y: number }>();
  if (!center) return positions;
  positions.set(center.id, { x: 50, y: compact ? 48 : 50 });
  const surrounding = ordered.slice(1).sort((a, b) => {
    const rank = ["project", "checkpoint", "task", "blocker", "decision", "file", "commit", "concept", "url", "error"];
    return rank.indexOf(a.kind) - rank.indexOf(b.kind);
  });
  if (compact) {
    const mobilePoints = [{ x: 21, y: 18 }, { x: 79, y: 18 }, { x: 19, y: 50 }, { x: 81, y: 50 }, { x: 25, y: 82 }, { x: 75, y: 82 }];
    surrounding.forEach((node, index) => positions.set(node.id, mobilePoints[index] ?? { x: 18 + (index % 3) * 32, y: 12 + Math.floor(index / 3) * 24 }));
  } else {
    surrounding.forEach((node, index) => {
      const angle = -Math.PI / 2 + (index / Math.max(1, surrounding.length)) * Math.PI * 2;
      positions.set(node.id, { x: 50 + Math.cos(angle) * 35, y: 50 + Math.sin(angle) * 36 });
    });
  }
  return positions;
}

function CardGraph({ snapshot, totalNodes, selectedId, onSelect, fitSignal, compact }: { snapshot: GraphSnapshot; totalNodes: number; selectedId?: string; onSelect(node: GraphNode | null): void; fitSignal?: number; compact: boolean }) {
  const positions = useMemo(() => cardPositions(snapshot, compact), [compact, snapshot]);
  const instructionsId = useId();
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
  const drag = useRef<{ x: number; y: number; originX: number; originY: number; moved: boolean } | null>(null);
  useEffect(() => setView({ x: 0, y: 0, scale: 1 }), [fitSignal]);
  function pointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if ((event.target as HTMLElement).closest("button")) return;
    drag.current = { x: event.clientX, y: event.clientY, originX: view.x, originY: view.y, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function pointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!drag.current) return;
    const dx = event.clientX - drag.current.x; const dy = event.clientY - drag.current.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) drag.current.moved = true;
    setView((current) => ({ ...current, x: drag.current!.originX + dx, y: drag.current!.originY + dy }));
  }
  function pointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    drag.current = null;
  }
  return (
    <div className="card-graph" role="region" aria-label={`Interactive graph with ${snapshot.nodes.length} nodes and ${snapshot.edges.length} relationships`} aria-describedby={instructionsId} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onWheel={(event) => { event.preventDefault(); setView((current) => ({ ...current, scale: Math.min(1.7, Math.max(.65, current.scale - event.deltaY * .001)) })); }}>
      <p className="sr-only" id={instructionsId}>Tab through graph nodes to inspect them. Drag to pan or use a mouse wheel to zoom.</p>
      {compact && totalNodes > snapshot.nodes.length && <div className="mobile-graph-summary" role="status">Showing {snapshot.nodes.length} of {totalNodes} nodes around the current focus. Search or filter to explore others.</div>}
      <div className="card-graph__world" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}>
        <svg className="card-graph__edges" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><defs><marker id="graph-arrow" markerWidth="5" markerHeight="5" refX="4.4" refY="2.5" orient="auto"><path d="M0,0 L5,2.5 L0,5 z" /></marker></defs>{snapshot.edges.map((edge) => { const source = positions.get(edge.source); const target = positions.get(edge.target); if (!source || !target) return null; return <g key={edge.id}><line x1={source.x} y1={source.y} x2={target.x} y2={target.y} markerEnd={edge.directed === false ? undefined : "url(#graph-arrow)"} /><text x={(source.x + target.x) / 2} y={(source.y + target.y) / 2}>{edge.relation}</text></g>; })}</svg>
        {snapshot.nodes.map((node) => { const point = positions.get(node.id); const Icon = kindIcons[node.kind] ?? Lightbulb; if (!point) return null; return <button type="button" key={node.id} className="graph-card-node semantic-node" style={{ left: `${point.x}%`, top: `${point.y}%` }} data-kind={node.kind} data-selected={node.id === selectedId} onClick={() => onSelect(node)}><Icon size={18} /><span>{node.kind}</span><strong>{node.label}</strong>{node.status && <small>{node.status}</small>}</button>; })}
      </div>
    </div>
  );
}

function SemanticGraph({ snapshot, selectedId, onSelect }: { snapshot: GraphSnapshot; selectedId?: string; onSelect(node: GraphNode): void }) {
  return (
    <div className="semantic-graph" role="list" aria-label="Graph nodes">
      {snapshot.nodes.map((node) => {
        const Icon = kindIcons[node.kind] ?? Lightbulb;
        return <button type="button" role="listitem" key={node.id} className="semantic-node" data-kind={node.kind} data-selected={node.id === selectedId} onClick={() => onSelect(node)}><Icon size={19} /><span>{node.kind}</span><strong>{node.label}</strong>{node.subtitle && <small>{node.subtitle}</small>}</button>;
      })}
    </div>
  );
}
