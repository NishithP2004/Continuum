import { useQuery } from "@tanstack/react-query";
import { Check, Filter, Focus, GitFork, Search } from "lucide-react";
import { useCallback, useDeferredValue, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AgentPanel } from "../components/AgentPanel";
import { GraphCanvas } from "../components/GraphCanvas";
import { NodeInspector } from "../components/NodeInspector";
import { EmptyState, ErrorState, IconButton, PageLoading } from "../components/ui";
import { useApi } from "../lib/api-context";
import type { GraphNode } from "../lib/types";

export function GraphPage() {
  const api = useApi();
  const navigate = useNavigate();
  const state = useQuery({ queryKey: ["engine-state", api.baseUrl], queryFn: () => api.state() });
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [hops, setHops] = useState<0 | 1 | 2>(1);
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const [fitSignal, setFitSignal] = useState(0);
  const [chatOpen, setChatOpen] = useState(true);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [nodeKinds, setNodeKinds] = useState<string[]>([]);
  const [relations, setRelations] = useState<string[]>([]);
  const [facets, setFacets] = useState<{ kinds: string[]; relations: string[] }>({ kinds: [], relations: [] });
  const filterWrap = useRef<HTMLDivElement>(null);
  const graph = useQuery({
    queryKey: ["graph", api.baseUrl, state.data?.activeProject?.id, deferredSearch, hops, selected?.id, nodeKinds.join(","), relations.join(",")],
    queryFn: () => api.graph({ projectId: state.data?.activeProject?.id, query: deferredSearch || undefined, nodeKinds: nodeKinds.length ? nodeKinds : undefined, relations: relations.length ? relations : undefined, aroundNodeId: selected?.id, hops, limit: 500 }),
    enabled: state.isSuccess
  });
  useEffect(() => {
    if (!graph.data) return;
    setFacets((current) => ({
      kinds: [...new Set([...current.kinds, ...graph.data!.nodes.map((node) => node.kind)])].sort(),
      relations: [...new Set([...current.relations, ...graph.data!.edges.map((edge) => edge.relation)])].sort()
    }));
  }, [graph.data]);
  useEffect(() => {
    if (!filtersOpen) return;
    const dismiss = (event: KeyboardEvent | PointerEvent) => {
      if (event.type === "keydown" && (event as KeyboardEvent).key === "Escape") setFiltersOpen(false);
      if (event.type === "pointerdown" && !filterWrap.current?.contains(event.target as Node)) setFiltersOpen(false);
    };
    window.addEventListener("keydown", dismiss);
    window.addEventListener("pointerdown", dismiss);
    return () => {
      window.removeEventListener("keydown", dismiss);
      window.removeEventListener("pointerdown", dismiss);
    };
  }, [filtersOpen]);
  const selectNode = useCallback((node: GraphNode | null) => setSelected(node), []);
  const snapshot = graph.data;
  const projectionWarning = snapshot?.projection && snapshot.projection.status !== "ready" && snapshot.projection.status !== "available";

  return (
    <div className="graph-workspace" data-chat-open={chatOpen}>
      <section className="graph-main">
        <div className="graph-toolbar">
          <label className="graph-search"><Search size={17} /><span className="sr-only">Search graph</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search graph" /></label>
          <div className="graph-filter-wrap" ref={filterWrap}><button className="toolbar-button" type="button" aria-expanded={filtersOpen} aria-controls="graph-filters" onClick={() => setFiltersOpen((value) => !value)}><Filter size={16} /> Filters{nodeKinds.length + relations.length > 0 && <span className="filter-count">{nodeKinds.length + relations.length}</span>}</button>{filtersOpen && <div className="graph-filter-popover" id="graph-filters" aria-label="Graph filters"><header><strong>Graph filters</strong>{(nodeKinds.length > 0 || relations.length > 0) && <button type="button" onClick={() => { setNodeKinds([]); setRelations([]); }}>Clear</button>}</header><fieldset><legend>Node types</legend>{facets.kinds.length ? facets.kinds.map((kind) => <label key={kind}><input type="checkbox" checked={nodeKinds.includes(kind)} onChange={() => setNodeKinds((current) => current.includes(kind) ? current.filter((item) => item !== kind) : [...current, kind])} /><span>{kind}</span>{nodeKinds.includes(kind) && <Check size={13} />}</label>) : <p>No node types available.</p>}</fieldset><fieldset><legend>Relationships</legend>{facets.relations.length ? facets.relations.map((relation) => <label key={relation}><input type="checkbox" checked={relations.includes(relation)} onChange={() => setRelations((current) => current.includes(relation) ? current.filter((item) => item !== relation) : [...current, relation])} /><span>{relation}</span>{relations.includes(relation) && <Check size={13} />}</label>) : <p>No relationships available.</p>}</fieldset></div>}</div>
          <label className="hops-select"><span className="sr-only">Expansion depth</span><select value={hops} onChange={(event) => setHops(Number(event.target.value) as 0 | 1 | 2)}><option value={0}>Selected only</option><option value={1}>1 hop</option><option value={2}>2 hops</option></select></label>
          <button className="toolbar-button" type="button" onClick={() => setFitSignal((value) => value + 1)}><Focus size={16} /> Fit</button>
          <IconButton className="graph-chat-toggle desktop-only" label={chatOpen ? "Hide agent" : "Show agent"} onClick={() => setChatOpen((value) => !value)}><span className="agent-toggle-mark">C</span></IconButton>
        </div>
        <div className="graph-stage">
          {state.isPending || graph.isPending ? <PageLoading label="Loading graph…" /> : state.isError ? <ErrorState error={state.error} retry={() => void state.refetch()} /> : graph.isError ? <ErrorState error={graph.error} retry={() => void graph.refetch()} /> : !snapshot?.nodes.length ? <EmptyState icon={<GitFork />} title="Your live graph is empty" detail="Continuum will add projects, tasks, checkpoints, files, commits, blockers, and decisions as live activity becomes evidence-backed context." /> : <GraphCanvas snapshot={snapshot} selectedId={selected?.id} onSelect={selectNode} fitSignal={fitSignal} />}
          {snapshot?.truncated && <div className="graph-notice">Showing the first {snapshot.nodes.length} nodes. Narrow the graph with search or filters.</div>}
          {projectionWarning && <div className="graph-notice graph-notice--warning">Graph projection is {snapshot.projection?.status}. {snapshot.projection?.message}</div>}
          {selected && <NodeInspector node={selected} onClose={() => setSelected(null)} onEvidence={() => navigate("/timeline")} onChat={() => { if (window.matchMedia("(max-width: 860px)").matches) navigate(`/chat?context=${encodeURIComponent(selected.label)}`); else setChatOpen(true); }} />}
        </div>
      </section>
      {chatOpen && <aside className="graph-agent desktop-only"><AgentPanel compact contextNode={selected} /></aside>}
    </div>
  );
}
