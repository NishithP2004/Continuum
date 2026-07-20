import { Bookmark, ExternalLink, MessageCircle, X } from "lucide-react";
import type { GraphNode } from "../lib/types";
import { Button, formatDateTime, IconButton } from "./ui";

export function NodeInspector({ node, onClose, onEvidence, onChat }: { node: GraphNode; onClose(): void; onEvidence(): void; onChat(): void }) {
  return (
    <section className="node-inspector" aria-label={`${node.label} details`}>
      <div className="bottom-sheet-handle" />
      <header><div><span>{node.kind}</span><h2>{node.label}</h2></div><IconButton label="Close details" onClick={onClose}><X size={18} /></IconButton></header>
      <dl><div><dt>Status</dt><dd>{node.status ?? "Not specified"}</dd></div>{node.createdAt && <div><dt>Created</dt><dd>{formatDateTime(node.createdAt)}</dd></div>}<div><dt>Provenance</dt><dd>{node.checkpointIds.length ? node.checkpointIds.map((id) => <code key={id}>{id}</code>) : "No checkpoint provenance supplied"}</dd></div></dl>
      <div className="node-inspector__actions"><Button variant="primary" onClick={onEvidence}><Bookmark size={16} /> View evidence</Button><Button onClick={onChat}><MessageCircle size={16} /> Open in chat</Button></div>
    </section>
  );
}
