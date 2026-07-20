import { useQuery } from "@tanstack/react-query";
import { Activity, AlertTriangle, ArrowRight, CheckCircle2, Clock3, FolderGit2, RadioTower, ShieldCheck } from "lucide-react";
import { Link } from "react-router-dom";
import { useApi } from "../lib/api-context";
import { EmptyState, ErrorState, formatDateTime, formatRelativeTime, PageLoading, StatusDot } from "../components/ui";

export function NowPage() {
  const api = useApi();
  const query = useQuery({ queryKey: ["engine-state", api.baseUrl], queryFn: () => api.state(), refetchInterval: 8_000 });
  const lease = useQuery({ queryKey: ["active-project", api.baseUrl], queryFn: () => api.activeProject(), refetchInterval: 8_000 });

  if (query.isPending) return <PageLoading />;
  if (query.isError) return <ErrorState error={query.error} retry={() => void query.refetch()} />;
  const state = query.data;
  const checkpoint = state.currentCheckpoint;

  return (
    <div className="page now-page">
      <header className="page-header">
        <div><h1>Now</h1><p>Your live, evidence-backed working state.</p></div>
        <div className="now-health" data-state={state.capturePaused ? "paused" : "active"}>
          <StatusDot status={state.capturePaused ? "degraded" : "ready"} />
          <span>{state.capturePaused ? "Collection paused" : "Collection active"}</span>
        </div>
      </header>

      {!state.activeProject ? (
        <EmptyState
          icon={<RadioTower />}
          title="Waiting for live project activity"
          detail="Open a trusted project in VS Code or run a command from its terminal. Continuum will establish an active-project lease without requiring a project ID."
          action={<Link className="button button--secondary" to="/devices">Check collectors <ArrowRight size={16} /></Link>}
        />
      ) : (
        <>
          <section className="now-project" aria-labelledby="active-project-title">
            <div className="now-project__icon"><FolderGit2 aria-hidden="true" /></div>
            <div><span className="eyeline" id="active-project-title">Active project</span><h2>{state.activeProject.name}</h2>{state.activeProject.path && <p>{state.activeProject.path}</p>}</div>
            <div className="now-project__lease">
              {lease.data?.lease ? <><strong>{lease.data.lease.source}</strong><span>Lease expires {formatRelativeTime(lease.data.lease.expiresAt)}</span></> : <><strong>No current lease</strong><span>{lease.data?.reason ?? "Waiting for authoritative activity"}</span></>}
            </div>
          </section>

          {checkpoint ? (
            <section className="current-state" aria-labelledby="current-state-title">
              <div className="current-state__heading"><div><span className="eyeline">Current state</span><h2 id="current-state-title">{checkpoint.focus}</h2></div><time dateTime={checkpoint.createdAt}>{formatRelativeTime(checkpoint.createdAt)}</time></div>
              <p className="current-state__summary">{checkpoint.summary}</p>
              <div className="state-columns">
                <div><h3><CheckCircle2 size={16} /> Progress</h3>{checkpoint.progress.length ? <ul>{checkpoint.progress.map((item) => <li key={`${item.text}-${item.eventIds[0]}`}>{item.text}</li>)}</ul> : <p className="muted-copy">No progress evidence in this checkpoint.</p>}</div>
                <div><h3><AlertTriangle size={16} /> Open blockers</h3>{checkpoint.blockers.filter((item) => item.status === "open").length ? <ul>{checkpoint.blockers.filter((item) => item.status === "open").map((item) => <li key={`${item.text}-${item.eventIds[0]}`}>{item.text}</li>)}</ul> : <p className="muted-copy">No open blockers.</p>}</div>
              </div>
              <footer><span>{Math.round(checkpoint.confidence * 100)}% confidence</span><span>{checkpoint.provider} · {checkpoint.model}</span><Link to="/chat">Ask Continuum Agent <ArrowRight size={14} /></Link></footer>
            </section>
          ) : (
            <EmptyState icon={<Clock3 />} title="No checkpoint yet" detail="Live events are arriving, but no evidence-backed checkpoint has been created for this project." />
          )}

          <section aria-labelledby="recent-activity-title">
            <div className="section-heading"><h2 id="recent-activity-title">Recent activity</h2><Link to="/timeline">View timeline</Link></div>
            {state.recentActivity.length ? (
              <div className="activity-list panel">
                {state.recentActivity.slice(0, 8).map((item) => (
                  <div className="activity-row" key={item.id}>
                    <Activity size={17} aria-hidden="true" /><div><strong>{item.title}</strong><span>{item.source} · {item.eventType}</span></div><time dateTime={item.occurredAt ?? item.timestamp}>{formatRelativeTime(item.occurredAt ?? item.timestamp)}</time>
                  </div>
                ))}
              </div>
            ) : <div className="compact-empty panel"><ShieldCheck size={20} /><span>No retained activity for this project.</span></div>}
          </section>
        </>
      )}
    </div>
  );
}
