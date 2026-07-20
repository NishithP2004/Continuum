import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Clipboard, Cloud, KeyRound, Laptop, Link2, Plus, RefreshCw, Server, ShieldCheck, Trash2, X } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Button, EmptyState, ErrorState, formatRelativeTime, IconButton, Modal, PageLoading, StatusDot } from "../components/ui";
import { useApi } from "../lib/api-context";
import type { CreatedApiKey } from "../lib/types";

export function DevicesPage() {
  const api = useApi();
  const queryClient = useQueryClient();
  const devices = useQuery({ queryKey: ["devices", api.baseUrl], queryFn: () => api.devices(), refetchInterval: 15_000 });
  const keys = useQuery({ queryKey: ["api-keys", api.baseUrl], queryFn: () => api.apiKeys() });
  const mcp = useQuery({ queryKey: ["remote-mcp", api.baseUrl], queryFn: () => api.remoteMcp() });
  const reconnect = useMutation({ mutationFn: () => api.reconnectSync(), onSuccess: () => queryClient.invalidateQueries({ queryKey: ["devices", api.baseUrl] }) });
  const revokeDevice = useMutation({ mutationFn: (id: string) => api.revokeDevice(id), onSuccess: () => queryClient.invalidateQueries({ queryKey: ["devices", api.baseUrl] }) });
  const revokeKey = useMutation({ mutationFn: (id: string) => api.revokeApiKey(id), onSuccess: () => queryClient.invalidateQueries({ queryKey: ["api-keys", api.baseUrl] }) });
  const createKey = useMutation({ mutationFn: (input: { name: string; scopes: string[]; expiresAt?: string }) => api.createApiKey(input), onSuccess: () => queryClient.invalidateQueries({ queryKey: ["api-keys", api.baseUrl] }) });
  const [newKeyOpen, setNewKeyOpen] = useState(false);
  const [createdKey, setCreatedKey] = useState<CreatedApiKey>();
  const [copied, setCopied] = useState<string>();
  const [copyError, setCopyError] = useState<string>();

  async function copy(value: string, id: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopyError(undefined); setCopied(id); window.setTimeout(() => setCopied(undefined), 1600);
    } catch {
      setCopyError("Clipboard access was denied. Select and copy the value manually.");
    }
  }

  async function submitKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get("name") ?? "").trim();
    const scopes = form.getAll("scopes").map(String);
    const expiryDays = Number(form.get("expiryDays") ?? 0);
    if (!name || !scopes.length) return;
    const expiresAt = expiryDays > 0 ? new Date(Date.now() + expiryDays * 86_400_000).toISOString() : undefined;
    const result = await createKey.mutateAsync({ name, scopes, expiresAt });
    setCreatedKey(result.key); setNewKeyOpen(false);
  }

  if (devices.isPending) return <PageLoading label="Loading devices…" />;
  if (devices.isError) return <ErrorState error={devices.error} retry={() => void devices.refetch()} title="Couldn’t load synchronized devices" />;

  return (
    <div className="page devices-page">
      <header className="page-header"><div><h1>Devices</h1><p>Synchronization, collector health, API keys, and remote MCP access.</p></div><div className="page-header__actions"><Button onClick={() => reconnect.mutate()} disabled={reconnect.isPending}><RefreshCw size={16} /> {reconnect.isPending ? "Reconnecting…" : "Reconnect"}</Button></div></header>
      {(reconnect.isError || revokeDevice.isError || revokeKey.isError || copyError) && <div className="inline-error" role="alert">{copyError ?? reconnect.error?.message ?? revokeDevice.error?.message ?? revokeKey.error?.message}</div>}

      <section className="sync-overview panel" aria-labelledby="sync-title">
        <div className="sync-overview__icon"><Cloud size={23} /></div><div><h2 id="sync-title">Synchronization</h2><p>{devices.data.sync.message ?? "Eligible, sanitized context is synchronized through your configured Continuum service."}</p></div><div className="sync-overview__status"><StatusDot status={devices.data.sync.status} /><strong>{devices.data.sync.status}</strong><span>Last sync {formatRelativeTime(devices.data.sync.lastSyncAt)}</span></div>
      </section>

      <div className="section-heading"><h2>Connected devices</h2></div>
      {!devices.data.devices.length ? <EmptyState icon={<Laptop />} title="No connected devices" detail="Sign in from a Continuum macOS app or PWA to register it with this account." /> : (
        <div className="device-list panel">{devices.data.devices.map((device) => <article className="device-row" key={device.id}><div className="device-icon"><Laptop size={20} /></div><div className="device-main"><h3>{device.name}</h3><p>{device.platform} · Seen {formatRelativeTime(device.lastSeenAt)}</p>{device.collectors?.length ? <div className="collector-list">{device.collectors.map((collector) => <span key={collector.name}><StatusDot status={collector.status} />{collector.name}</span>)}</div> : <span className="help-text">This device does not report collectors.</span>}</div><div className="device-sync"><span>Last sync</span><strong>{formatRelativeTime(device.lastSyncAt)}</strong></div><Button variant="danger" disabled={Boolean(device.revokedAt) || revokeDevice.isPending} onClick={() => { if (window.confirm(`Revoke ${device.name}? It will stop synchronizing immediately.`)) revokeDevice.mutate(device.id); }}><Trash2 size={15} /> {device.revokedAt ? "Revoked" : "Revoke"}</Button></article>)}</div>
      )}

      <div className="device-admin-grid">
        <section className="panel admin-panel" aria-labelledby="api-keys-title"><header><div><h2 id="api-keys-title">API keys</h2><p>Scoped bearer credentials for remote MCP clients.</p></div><Button onClick={() => setNewKeyOpen(true)}><Plus size={15} /> New key</Button></header>
          {keys.isPending ? <PageLoading label="Loading API keys…" /> : keys.isError ? <ErrorState error={keys.error} retry={() => void keys.refetch()} title="Couldn’t load API keys" /> : keys.data.keys.length ? <div className="api-key-list">{keys.data.keys.map((key) => <div className="api-key-row" key={key.id}><KeyRound size={18} /><div><strong>{key.name}</strong><span className="mono">{key.prefix}••••••</span><small>{key.scopes.join(" · ")} · Created {formatRelativeTime(key.createdAt)}{key.expiresAt ? ` · Expires ${formatRelativeTime(key.expiresAt)}` : ""}</small></div><Button variant="quiet" disabled={Boolean(key.revokedAt) || revokeKey.isPending} onClick={() => { if (window.confirm(`Revoke API key “${key.name}”? Existing clients will lose access immediately.`)) revokeKey.mutate(key.id); }}>{key.revokedAt ? "Revoked" : "Revoke"}</Button></div>)}</div> : <div className="small-empty"><KeyRound size={22} /><p>No API keys have been created.</p></div>}
        </section>

        <section className="panel admin-panel" aria-labelledby="mcp-title"><header><div><h2 id="mcp-title">Remote MCP</h2><p>Connect Codex or another compatible MCP client.</p></div></header>
          {mcp.isPending ? <PageLoading label="Checking remote MCP…" /> : mcp.isError ? <ErrorState error={mcp.error} retry={() => void mcp.refetch()} title="Couldn’t check remote MCP" /> : <div className="mcp-status"><div className="mcp-status__line"><Server size={20} /><div><strong>{mcp.data.status}</strong><span>{mcp.data.message ?? "Streamable HTTP endpoint"}</span></div><StatusDot status={mcp.data.status} /></div>{mcp.data.url ? <div className="copy-field"><code>{mcp.data.url}</code><button aria-label="Copy MCP URL" onClick={() => void copy(mcp.data.url!, "mcp-url")}>{copied === "mcp-url" ? <Check size={16} /> : <Clipboard size={16} />}</button></div> : <p className="help-text">The service has not advertised a remote MCP URL.</p>}{mcp.data.oauthMetadataUrl && <a className="text-link" href={mcp.data.oauthMetadataUrl} target="_blank" rel="noreferrer"><ShieldCheck size={14} /> OAuth metadata <Link2 size={13} /></a>}</div>}
        </section>
      </div>

      {newKeyOpen && <Modal labelledBy="new-key-title" onClose={() => setNewKeyOpen(false)}><header><h2 id="new-key-title">Create API key</h2><IconButton label="Close API key dialog" onClick={() => setNewKeyOpen(false)}><X size={18} /></IconButton></header><form onSubmit={submitKey}><label className="form-field"><span>Name</span><input className="text-input" name="name" required autoFocus maxLength={80} placeholder="Codex on work laptop" /></label><label className="form-field"><span>Expiration</span><select className="select-input" name="expiryDays" defaultValue="90"><option value="30">30 days</option><option value="90">90 days</option><option value="365">1 year</option><option value="0">No expiration</option></select></label><fieldset><legend>Scopes</legend><label><input type="checkbox" name="scopes" value="context:read" defaultChecked /> Read context and connect to MCP</label><label><input type="checkbox" name="scopes" value="sync:read" /> Read synchronized records</label><label><input type="checkbox" name="scopes" value="sync:write" /> Write synchronized records</label><label><input type="checkbox" name="scopes" value="devices:write" /> Revoke synchronized devices</label><label><input type="checkbox" name="scopes" value="keys:write" /> Create and revoke API keys</label></fieldset>{createKey.isError && <p className="inline-error" role="alert">{createKey.error.message}</p>}<footer><Button type="button" onClick={() => setNewKeyOpen(false)}>Cancel</Button><Button type="submit" variant="primary" disabled={createKey.isPending}>{createKey.isPending ? "Creating…" : "Create key"}</Button></footer></form></Modal>}

      {createdKey && <Modal labelledBy="key-created-title" describedBy="key-created-description" className="secret-modal"><KeyRound size={26} /><h2 id="key-created-title">Copy this key now</h2><p id="key-created-description">Continuum stores only a cryptographic digest. This secret cannot be shown again.</p><div className="copy-field"><code>{createdKey.secret}</code><button aria-label="Copy API key" onClick={() => void copy(createdKey.secret, "new-key")}>{copied === "new-key" ? <Check size={16} /> : <Clipboard size={16} />}</button></div>{copyError && <p className="inline-error" role="alert">{copyError}</p>}<Button variant="primary" onClick={() => setCreatedKey(undefined)}>I’ve saved the key</Button></Modal>}
    </div>
  );
}
