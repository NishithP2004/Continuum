import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, AppWindow, CheckCircle2, Chrome, Clock3, Code2, Database, FileCode2, Filter, Folder, GitBranch, LockKeyhole, ShieldCheck, Terminal, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { Button, ErrorState, formatRelativeTime, PageLoading, SavedNotice, StatusDot, Toggle } from "../components/ui";
import { useApi } from "../lib/api-context";
import type { PrivacyMetadata, PrivacyPolicy, PrivacySource } from "../lib/types";

const sources: Array<{ key: PrivacySource; label: string; description: string; icon: typeof Activity }> = [
  { key: "osApps", label: "App activity", description: "Foreground app usage and state changes.", icon: Activity },
  { key: "osWindows", label: "Window titles", description: "Opt-in focused-window titles; local only.", icon: AppWindow },
  { key: "approvedFolders", label: "Approved folders", description: "Changes inside folders you explicitly approve.", icon: Folder },
  { key: "vscode", label: "VS Code", description: "Trusted workspace focus, active file, and save events.", icon: Code2 },
  { key: "terminal", label: "Terminal command shape", description: "Safe command names, flags, cwd, duration, and exit status.", icon: Terminal },
  { key: "git", label: "Git metadata", description: "Commits, branches, subjects, and changed paths.", icon: GitBranch },
  { key: "chrome", label: "Chrome active tab", description: "Allowlisted active-tab host and sanitized path.", icon: Chrome }
];

const metadata: Array<{ localKey: PrivacyMetadata; cloudKey?: PrivacyMetadata; cloudBlocked?: boolean; label: string; description: string }> = [
  { localKey: "personalMetadata", cloudKey: "personalCloudEligibility", label: "Personal metadata", description: "Identity hints such as a user or device name." },
  { localKey: "confidentialLocalCollection", cloudBlocked: true, label: "Confidential metadata", description: "Sensitive project or business context. Always local-only." },
  { localKey: "relativeFilePaths", label: "Relative file paths", description: "Project-relative paths with home-directory names removed." },
  { localKey: "urlHosts", label: "URL hosts", description: "Allowlisted host names only." },
  { localKey: "urlPaths", label: "URL paths", description: "Paths with userinfo, query, and fragments removed." },
  { localKey: "commandNames", label: "Command names", description: "Allowlisted command shape; arguments are removed." },
  { localKey: "commandFlagNames", label: "Command flag names", description: "Allowlisted flag names only; values are never retained." }
];

function AuditIcon({ decision }: { decision: string }) {
  if (decision === "rejected") return <XCircle className="audit-icon audit-icon--rejected" size={19} />;
  if (decision === "accepted") return <CheckCircle2 className="audit-icon audit-icon--accepted" size={19} />;
  return <Filter className="audit-icon audit-icon--stripped" size={19} />;
}

export function PrivacyPage() {
  const api = useApi();
  const queryClient = useQueryClient();
  const policyQuery = useQuery({ queryKey: ["privacy-policy", api.baseUrl], queryFn: () => api.privacyPolicy() });
  const auditQuery = useQuery({ queryKey: ["privacy-audit", api.baseUrl], queryFn: () => api.privacyAudit(), refetchInterval: 8_000 });
  const [draft, setDraft] = useState<PrivacyPolicy>();
  const [saved, setSaved] = useState(false);
  useEffect(() => setDraft(policyQuery.data?.policy), [policyQuery.data]);
  const save = useMutation({
    mutationFn: () => api.updatePrivacyPolicy(draft!),
    onSuccess: ({ policy }) => {
      setDraft(policy); setSaved(true); window.setTimeout(() => setSaved(false), 2_500);
      void queryClient.invalidateQueries({ queryKey: ["privacy-policy", api.baseUrl] });
    }
  });
  const dirty = Boolean(draft && policyQuery.data && JSON.stringify(draft) !== JSON.stringify(policyQuery.data.policy));
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  if (policyQuery.isPending) return <PageLoading label="Loading privacy policy…" />;
  if (policyQuery.isError) return <ErrorState error={policyQuery.error} retry={() => void policyQuery.refetch()} title="Couldn’t load the privacy policy" />;
  if (!draft) return null;
  const updateSource = (key: PrivacySource, value: boolean) => setDraft((current) => current ? ({ ...current, sources: { ...current.sources, [key]: value } }) : current);
  const updateMetadata = (key: PrivacyMetadata, value: boolean) => setDraft((current) => {
    if (!current) return current;
    const next = { ...current.metadata, [key]: value };
    if (key === "personalMetadata" && !value) next.personalCloudEligibility = false;
    if (key === "commandNames" && !value) next.commandFlagNames = false;
    return { ...current, metadata: next };
  });

  return (
    <div className="page privacy-page">
      <header className="page-header privacy-header">
        <div><h1>Privacy controls</h1><p>Secrets are always blocked. You control everything else.</p></div>
        <div className="page-header__actions"><span className="policy-version">Policy r{draft.revision}</span><SavedNotice visible={saved} /><Button variant="primary" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>{save.isPending ? "Saving…" : "Save policy"}</Button></div>
      </header>
      {save.isError && <div className="inline-error" role="alert">{save.error.message}</div>}
      <div className="privacy-layout">
        <div className="privacy-controls">
          <section className="secret-guard"><div className="secret-guard__icon"><LockKeyhole size={21} /></div><div><strong>Credential and secret detection — Always on</strong><span>Secrets are rejected on device. This protection cannot be changed.</span></div><div className="protected-label"><ShieldCheck size={16} /> Protected</div></section>

          <section className="privacy-section panel" aria-labelledby="collection-sources-title">
            <header><h2 id="collection-sources-title">1. Collection sources</h2><p>Control what Continuum can observe on this device.</p></header>
            {sources.map(({ key, label, description, icon: Icon }) => <div className="policy-row" key={key}><Icon size={17} /><div><strong>{label}</strong><span>{description}</span></div><Toggle checked={draft.sources[key]} onChange={(value) => updateSource(key, value)} label={`${label} collection`} /></div>)}
          </section>

          <section className="privacy-section panel" aria-labelledby="metadata-filters-title">
            <header className="metadata-header"><h2 id="metadata-filters-title">2. Metadata filters</h2><p>Choose which metadata may be processed or shared.</p><span>Local</span><span>Cloud</span></header>
            {metadata.map(({ localKey, cloudKey, cloudBlocked, label, description }) => <div className="policy-row metadata-row" key={localKey}><FileCode2 size={17} /><div><strong>{label}</strong><span>{description}</span></div><Toggle checked={draft.metadata[localKey]} onChange={(value) => updateMetadata(localKey, value)} disabled={localKey === "commandFlagNames" && !draft.metadata.commandNames} label={`${label} local processing`} /><Toggle checked={cloudKey ? draft.metadata[cloudKey] : cloudBlocked ? false : draft.metadata[localKey]} onChange={(value) => cloudKey && updateMetadata(cloudKey, value)} disabled={!cloudKey || !draft.metadata[localKey]} label={`${label} cloud eligibility${cloudKey ? "" : " (derived by policy)"}`} /></div>)}
            <div className="immutable-note"><LockKeyhole size={13} /> Secrets and prohibited content are never processed or shared.</div>
          </section>

          <section className="privacy-section panel" aria-labelledby="retention-title">
            <header><h2 id="retention-title">3. Retention</h2><p>Control how long sanitized events remain available.</p></header>
            <div className="policy-row retention-row"><Clock3 size={17} /><div><strong>Sanitized events</strong><span>Automatically deleted on every device and server.</span></div><select className="select-input" aria-label="Sanitized event retention" value={draft.retentionHours} onChange={(event) => setDraft({ ...draft, retentionHours: Number(event.target.value) })}><option value={1}>1 hour</option><option value={6}>6 hours</option><option value={12}>12 hours</option><option value={24}>24 hours</option></select></div>
            <div className="policy-row"><Database size={17} /><div><strong>Checkpoints</strong><span>Minimal evidence summaries are retained until you delete them.</span></div><span className="retention-value">Indefinite</span></div>
          </section>

          <section className="privacy-section panel" aria-labelledby="rules-title">
            <header><h2 id="rules-title">4. Allow and ignore rules</h2><p>One host or project-relative path per line.</p></header>
            <div className="policy-textareas"><label className="form-field"><span>Chrome domain allowlist</span><textarea className="text-area mono" value={draft.allowedDomains.join("\n")} onChange={(event) => setDraft({ ...draft, allowedDomains: event.target.value.split("\n").map((item) => item.trim()).filter(Boolean) })} placeholder="developers.example.com" /></label><label className="form-field"><span>Ignored domains</span><textarea className="text-area mono" value={draft.ignoredDomains.join("\n")} onChange={(event) => setDraft({ ...draft, ignoredDomains: event.target.value.split("\n").map((item) => item.trim()).filter(Boolean) })} placeholder="mail.example.com" /></label><label className="form-field"><span>Ignored project paths</span><textarea className="text-area mono" value={draft.ignoredPathPatterns.join("\n")} onChange={(event) => setDraft({ ...draft, ignoredPathPatterns: event.target.value.split("\n").map((item) => item.trim()).filter(Boolean) })} placeholder="build/&#10;.cache/" /></label></div>
          </section>

          <section className="privacy-section panel cloud-section" aria-labelledby="cloud-title">
            <header><h2 id="cloud-title">5. Cloud and sync eligibility</h2><p>Manage what may be synchronized with Continuum.</p></header>
            <div className="policy-row"><ShieldCheck size={20} /><div><strong>Cloud sharing follows eligibility policy</strong><span>Only sanitized, eligible records may synchronize. Personal metadata has a separate switch above.</span></div><span className="retention-value">Enforced</span></div>
            <div className="immutable-note"><ShieldCheck size={13} /> Secret and confidential data never leaves this device.</div>
          </section>
        </div>

        <aside className="privacy-audit panel" aria-labelledby="privacy-audit-title">
          <header><div><h2 id="privacy-audit-title">Privacy audit</h2><p>Live policy decisions without rejected payloads.</p></div><div className="audit-live"><StatusDot status={auditQuery.isError ? "degraded" : "ready"} /> Live</div></header>
          {auditQuery.isPending ? <PageLoading label="Loading audit…" /> : auditQuery.isError ? <ErrorState error={auditQuery.error} retry={() => void auditQuery.refetch()} title="Couldn’t load the audit" /> : auditQuery.data.audit.length ? <div className="audit-list">{auditQuery.data.audit.slice(0, 40).map((entry) => <div className="audit-entry" key={entry.id}><time dateTime={entry.occurredAt}>{formatRelativeTime(entry.occurredAt)}</time><AuditIcon decision={entry.decision} /><div><strong>{entry.label ?? entry.rule}</strong><span>Rule: {entry.rule}</span><small>{entry.source}</small></div><b>{entry.count}</b></div>)}</div> : <div className="compact-audit-empty"><ShieldCheck size={24} /><p>No retained privacy decisions yet.</p></div>}
        </aside>
      </div>
    </div>
  );
}
