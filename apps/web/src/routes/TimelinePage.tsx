import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Bookmark, CheckCircle2, Clock3 } from "lucide-react";
import { useApi } from "../lib/api-context";
import { EmptyState, ErrorState, formatDateTime, PageLoading } from "../components/ui";

export function TimelinePage() {
  const api = useApi();
  const state = useQuery({ queryKey: ["engine-state", api.baseUrl], queryFn: () => api.state() });
  const timeline = useQuery({
    queryKey: ["timeline", api.baseUrl, state.data?.activeProject?.id],
    queryFn: () => api.timeline(state.data?.activeProject?.id),
    enabled: state.isSuccess
  });

  if (state.isPending || timeline.isPending) return <PageLoading label="Loading timeline…" />;
  if (state.isError) return <ErrorState error={state.error} retry={() => void state.refetch()} />;
  if (timeline.isError) return <ErrorState error={timeline.error} retry={() => void timeline.refetch()} />;
  const checkpoints = timeline.data.checkpoints;

  return (
    <div className="page timeline-page">
      <header className="page-header"><div><h1>Timeline</h1><p>Evidence-backed checkpoints, shown in the order they were created.</p></div></header>
      {!state.data.activeProject ? <EmptyState icon={<Clock3 />} title="No active project" detail="Continuum will show a timeline after live project activity establishes a project lease." /> : !checkpoints.length ? (
        <EmptyState icon={<Bookmark />} title="No checkpoints yet" detail="Checkpoints created from live events will appear here. Continuum does not insert sample data." />
      ) : (
        <ol className="timeline-list">
          {checkpoints.map((checkpoint) => {
            const openBlockers = checkpoint.blockers.filter((item) => item.status === "open").length;
            return (
              <li className="timeline-entry" key={checkpoint.id}>
                <div className="timeline-entry__marker"><span /></div>
                <article className="panel">
                  <header><div><time dateTime={checkpoint.createdAt}>{formatDateTime(checkpoint.createdAt)}</time><h2>{checkpoint.focus}</h2></div><span className="checkpoint-id mono">{checkpoint.id}</span></header>
                  <p>{checkpoint.summary}</p>
                  <footer>
                    <span><CheckCircle2 size={14} /> {checkpoint.progress.length} progress item{checkpoint.progress.length === 1 ? "" : "s"}</span>
                    <span data-warning={openBlockers > 0}><AlertTriangle size={14} /> {openBlockers} open blocker{openBlockers === 1 ? "" : "s"}</span>
                    <span>{Math.round(checkpoint.confidence * 100)}% confidence</span>
                  </footer>
                </article>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
