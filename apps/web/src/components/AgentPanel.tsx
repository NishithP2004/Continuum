import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Bookmark, Bot, Check, Cloud, FileCode2, GitCommitHorizontal, LoaderCircle, LockKeyhole, Plus, Search, Send, ShieldCheck, Square, X } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useApi } from "../lib/api-context";
import { ApiError, contextActionFromApiError } from "../lib/api";
import { isLocalServiceUrl } from "../lib/config";
import type { ChatMessage, ChatRunEvent, Citation, ContextAction, GraphNode } from "../lib/types";
import { Button, EmptyState, ErrorState, formatRelativeTime, IconButton, Spinner } from "./ui";
import { MarkdownContent } from "./MarkdownContent";

const citationIcons: Record<string, typeof Bookmark> = { checkpoint: Bookmark, file: FileCode2, commit: GitCommitHorizontal, blocker: AlertTriangle, entity: Search };

function CitationCard({ citation }: { citation: Citation }) {
  const Icon = citationIcons[citation.kind] ?? Bookmark;
  return <div className="citation-card"><Icon size={17} aria-hidden="true" /><div><span>{citation.kind}</span><strong>{citation.label}</strong>{citation.detail && <small>{citation.detail}</small>}</div></div>;
}

function AgentAction({ sessionId, action }: { sessionId: string; action: ContextAction }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [dismissed, setDismissed] = useState(false);
  const [resolved, setResolved] = useState<ContextAction>();
  const shown = resolved ?? action;
  const mutation = useMutation({
    mutationFn: () => api.confirmAction(action.id),
    onSuccess: ({ action: confirmed }) => { setResolved(confirmed); return queryClient.invalidateQueries({ queryKey: ["chat-messages", api.baseUrl, sessionId] }); },
    onError: (error) => {
      const failed = contextActionFromApiError(error);
      if (failed) setResolved(failed);
    }
  });
  const reject = useMutation({
    mutationFn: () => api.rejectAction(action.id),
    onSuccess: () => setDismissed(true)
  });
  if (dismissed) return null;
  return (
    <div className="agent-action" data-state={shown.state}>
      <div><strong>{shown.label}</strong><span>{shown.type.replaceAll("_", " ")}</span></div>
      {shown.requiresConfirmation && shown.state === "proposed" ? (
        <div><IconButton label={`Dismiss ${shown.label}`} onClick={() => reject.mutate()} disabled={mutation.isPending || reject.isPending}><X size={16} /></IconButton><Button variant="primary" onClick={() => mutation.mutate()} disabled={mutation.isPending || reject.isPending}>{mutation.isPending ? <Spinner /> : <Check size={15} />} Confirm</Button></div>
      ) : <span className="agent-action__state">{shown.state}</span>}
      {(shown.error || mutation.error?.message || reject.error?.message) && <p role="alert">{shown.error ?? mutation.error?.message ?? reject.error?.message}</p>}
    </div>
  );
}

function Message({ message }: { message: ChatMessage }) {
  return (
    <article className={`chat-message chat-message--${message.role}`}>
      {message.role === "assistant" && <div className="assistant-avatar"><img src="/continuum-mark.svg" alt="" /></div>}
      <div className="chat-message__body">
        <header><strong>{message.role === "assistant" ? "Continuum Agent" : "You"}</strong><time dateTime={message.createdAt}>{formatRelativeTime(message.createdAt)}</time></header>
        <MarkdownContent className="chat-message__copy" content={message.content} />
        {!!message.citations.length && <div className="citation-list" aria-label="Evidence">{message.citations.map((citation) => <CitationCard key={citation.id} citation={citation} />)}</div>}
        {!!message.hypotheses?.length && <div className="hypothesis"><AlertTriangle size={17} /><div><strong>Unverified {message.hypotheses.length === 1 ? "hypothesis" : "hypotheses"}</strong>{message.hypotheses.map((item) => <p key={item}>{item}</p>)}</div></div>}
        {message.actions?.map((action) => <AgentAction key={action.id} sessionId={message.sessionId} action={action} />)}
      </div>
    </article>
  );
}

export function AgentPanel({ compact = false, contextNode, contextLabel }: { compact?: boolean; contextNode?: GraphNode | null; contextLabel?: string | null }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const state = useQuery({ queryKey: ["engine-state", api.baseUrl], queryFn: () => api.state() });
  const projectId = state.data?.activeProject?.id;
  const sessions = useQuery({ queryKey: ["chat-sessions", api.baseUrl, projectId], queryFn: () => api.chatSessions(projectId), enabled: state.isSuccess });
  const remotePrivacy = useQuery({ queryKey: ["privacy-policy", api.baseUrl], queryFn: () => api.privacyPolicy(), enabled: state.isSuccess && !isLocalServiceUrl(api.baseUrl), staleTime: 5_000 });
  const [sessionId, setSessionId] = useState<string>();
  const [draft, setDraft] = useState("");
  const [streamText, setStreamText] = useState("");
  const [optimisticMessage, setOptimisticMessage] = useState<ChatMessage>();
  const [streamError, setStreamError] = useState<string>();
  const [latestActions, setLatestActions] = useState<ContextAction[]>([]);
  const activeRunRef = useRef<{ controller: AbortController; runId: string } | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!sessions.data) return;
    if (!sessionId || !sessions.data.sessions.some((session) => session.id === sessionId)) setSessionId(sessions.data.sessions[0]?.id);
  }, [sessionId, sessions.data]);
  const messages = useQuery({ queryKey: ["chat-messages", api.baseUrl, sessionId], queryFn: () => api.chatMessages(sessionId!), enabled: Boolean(sessionId) });
  const createSession = useMutation({
    mutationFn: () => api.createChatSession(projectId),
    onSuccess: ({ session }) => {
      queryClient.setQueryData<{ sessions: Array<typeof session> }>(["chat-sessions", api.baseUrl, projectId], (current) => ({ sessions: [session, ...(current?.sessions.filter((item) => item.id !== session.id) ?? [])] }));
      setSessionId(session.id);
    }
  });
  const [running, setRunning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const contextName = contextNode?.label ?? contextLabel;
  const activeSession = sessions.data?.sessions.find((session) => session.id === sessionId);
  const remotePersonalSyncDisabled = Boolean(remotePrivacy.data && (!remotePrivacy.data.policy.metadata.personalMetadata || !remotePrivacy.data.policy.metadata.personalCloudEligibility));
  const chatSyncBlocked = remotePersonalSyncDisabled && activeSession?.classification !== "public";
  const privacyState = chatSyncBlocked
    ? "sync_disabled"
    : !activeSession
    ? undefined
    : activeSession.syncEligibility === "local_only" || activeSession.classification === "confidential"
      ? "local_only"
      : activeSession.syncEligibility === "cloud_eligible"
        ? "sync_eligible"
        : "policy_governed";
  const displayedMessages = useMemo(() => {
    const loaded = [...(messages.data?.messages ?? [])];
    if (latestActions.length) {
      let index = -1;
      for (let cursor = loaded.length - 1; cursor >= 0; cursor -= 1) {
        if (loaded[cursor].role === "assistant") { index = cursor; break; }
      }
      if (index >= 0) loaded[index] = { ...loaded[index], actions: latestActions };
    }
    return [...loaded, ...(optimisticMessage ? [optimisticMessage] : [])];
  }, [latestActions, messages.data, optimisticMessage]);
  useEffect(() => {
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    endRef.current?.scrollIntoView({ block: "end", behavior: reduceMotion ? "auto" : "smooth" });
  }, [displayedMessages.length, streamText]);

  useEffect(() => {
    setLatestActions([]);
    setOptimisticMessage(undefined);
    setStreamError(undefined);
    setStreamText("");
  }, [sessionId]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const content = draft.trim();
    if (!content || running || chatSyncBlocked) return;
    setDraft(""); setStreamError(undefined); setStreamText(""); setLatestActions([]); setRunning(true);
    try {
      let targetSessionId = sessionId;
      if (!targetSessionId) {
        const created = await createSession.mutateAsync();
        targetSessionId = created.session.id;
        setSessionId(targetSessionId);
        await queryClient.invalidateQueries({ queryKey: ["chat-sessions", api.baseUrl, projectId] });
      }
      setOptimisticMessage({ id: `pending-${Date.now()}`, sessionId: targetSessionId, role: "user", content, createdAt: new Date().toISOString(), citations: [] });
      const controller = new AbortController();
      const runId = crypto.randomUUID();
      activeRunRef.current = { controller, runId };
      await api.streamChat(targetSessionId, content, runId, controller.signal, (runEvent: ChatRunEvent) => {
        if (runEvent.type === "delta") setStreamText((current) => current + runEvent.text);
        if (runEvent.type === "error") setStreamError(runEvent.message);
        if (runEvent.type === "cancelled") setStreamError("Response stopped.");
        if (runEvent.type === "action") setLatestActions((current) => [...current.filter((item) => item.id !== runEvent.action.id), runEvent.action]);
      });
      setOptimisticMessage(undefined); setStreamText("");
      await queryClient.invalidateQueries({ queryKey: ["chat-messages", api.baseUrl, targetSessionId] });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") setStreamError((current) => current ?? "Response stopped.");
      else setStreamError(error instanceof Error ? error.message : "The agent request failed.");
    } finally { activeRunRef.current = null; setStopping(false); setRunning(false); }
  }

  async function stopRun() {
    const activeRun = activeRunRef.current;
    if (!activeRun || stopping) return;
    setStopping(true);
    let cancellationAccepted = false;
    try {
      await api.cancelChatRun(activeRun.runId);
      cancellationAccepted = true;
      setStreamError("Response stopped.");
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) setStreamError("Response already finished.");
      else if (error instanceof ApiError && error.code === "chat_run_completing") setStreamError("Response is already finishing and could not be cancelled.");
      else setStreamError(error instanceof Error ? `Couldn’t confirm server cancellation: ${error.message}` : "Couldn’t confirm server cancellation.");
    } finally {
      if (cancellationAccepted) activeRun.controller.abort();
      else setStopping(false);
    }
  }

  const waiting = state.isPending
    || (state.isSuccess && sessions.isPending)
    || Boolean(state.isSuccess && sessions.isSuccess && sessionId && messages.isPending);
  const error = state.error || sessions.error || messages.error;
  return (
    <section className={compact ? "agent-panel agent-panel--compact" : "agent-panel"} aria-label="Continuum Agent">
      <header className="agent-panel__header"><div><h1>{compact ? "Continuum Agent" : "Chat"}</h1>{!compact && <p>Grounded in your Continuum graph and timeline.</p>}</div><div className="agent-panel__header-actions">{!compact && sessions.data && <label className="conversation-select"><span className="sr-only">Conversation</span><select aria-label="Conversation" value={sessionId ?? ""} onChange={(event) => setSessionId(event.target.value || undefined)} disabled={running || createSession.isPending}><option value="">New conversation</option>{sessions.data.sessions.map((session) => <option key={session.id} value={session.id}>{session.title}</option>)}</select></label>}{!compact && <IconButton label="New conversation" title={remotePersonalSyncDisabled ? "Enable personal cloud eligibility in Privacy before creating a synchronized chat." : "New conversation"} onClick={() => createSession.mutate()} disabled={running || createSession.isPending || remotePersonalSyncDisabled}>{createSession.isPending ? <Spinner label="Creating conversation" /> : <Plus size={18} />}</IconButton>}{privacyState ? <div className="chat-privacy-state" data-state={privacyState} title={privacyState === "sync_disabled" ? "Your privacy policy does not allow personal chat synchronization." : privacyState === "local_only" ? "This confidential conversation stays on the connected local Continuum service." : privacyState === "sync_eligible" ? "This conversation is eligible for synchronization under your privacy policy." : "The connected service did not report this conversation’s synchronization eligibility."}>{privacyState === "sync_disabled" || privacyState === "local_only" ? <LockKeyhole size={16} /> : privacyState === "sync_eligible" ? <Cloud size={16} /> : <ShieldCheck size={16} />}<span>{privacyState === "sync_disabled" ? "Sync disabled" : privacyState === "local_only" ? "Local only" : privacyState === "sync_eligible" ? "Sync eligible" : "Policy governed"}</span></div> : <ShieldCheck size={20} aria-label="Privacy policy active" />}</div></header>
      {contextName && <div className="context-strip"><span>Graph context</span><strong>{contextName}</strong></div>}
      <div className="agent-panel__messages" aria-live="polite">
        {waiting ? <div className="agent-loading"><Spinner label="Loading conversations" /></div> : error ? <ErrorState error={error} retry={() => { void state.refetch(); void sessions.refetch(); if (sessionId) void messages.refetch(); }} title="Couldn’t load conversations" /> : !displayedMessages.length && !streamText ? <EmptyState icon={<Bot />} title="Ask about your live context" detail="Continuum cites the checkpoints, files, commits, blockers, and decisions behind every grounded answer." /> : <>{displayedMessages.map((message) => <Message key={message.id} message={message} />)}{streamText && <article className="chat-message chat-message--assistant"><div className="assistant-avatar"><img src="/continuum-mark.svg" alt="" /></div><div className="chat-message__body"><header><strong>Continuum Agent</strong><LoaderCircle className="streaming-icon" size={14} /></header><MarkdownContent className="chat-message__copy" content={streamText} /></div></article>}</>}
        {streamError && <div className="chat-error" role="alert"><AlertTriangle size={17} /><span>{streamError}</span></div>}<div ref={endRef} />
      </div>
      {chatSyncBlocked && <div className="chat-consent-notice" role="status"><LockKeyhole size={18} /><div><strong>Chat sync needs your consent</strong><span>This remote service can start or continue a personal conversation only when Personal metadata is cloud eligible. Continuum will never enable that setting automatically.</span></div><Link to="/privacy">Review privacy</Link></div>}
      <form className="chat-composer" onSubmit={submit} data-blocked={chatSyncBlocked}>
        <label className="sr-only" htmlFor={compact ? "graph-agent-message" : "agent-message"}>Message Continuum Agent</label>
        <textarea id={compact ? "graph-agent-message" : "agent-message"} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} placeholder={chatSyncBlocked ? "Enable personal cloud eligibility to chat…" : contextName ? `Ask about ${contextName}…` : "Ask about your context…"} rows={compact ? 2 : 3} disabled={running || chatSyncBlocked} />
        {running ? <IconButton type="button" label={stopping ? "Stopping response" : "Stop response"} onClick={() => void stopRun()} disabled={stopping}><Square size={17} fill="currentColor" /></IconButton> : <IconButton type="submit" label="Send message" disabled={!draft.trim() || chatSyncBlocked}><Send size={19} /></IconButton>}
      </form>
    </section>
  );
}
