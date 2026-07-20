import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Cloud, Download, LogIn, LogOut, Server, Sparkles } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { Button, ErrorState, PageLoading, StatusDot } from "../components/ui";
import { useApi } from "../lib/api-context";
import { useSession } from "../lib/auth";
import { configuredApiUrl, saveApiUrl } from "../lib/config";
import { usePwaInstall } from "../lib/pwa-install";
import type { ModelSettings } from "../lib/types";

export function SettingsPage() {
  const api = useApi();
  const session = useSession();
  const queryClient = useQueryClient();
  const models = useQuery({ queryKey: ["model-settings", api.baseUrl], queryFn: () => api.modelSettings() });
  const [draft, setDraft] = useState<ModelSettings>();
  const [apiUrl, setApiUrl] = useState(configuredApiUrl);
  const [connectionError, setConnectionError] = useState<string>();
  const [installNotice, setInstallNotice] = useState<string>();
  const pwa = usePwaInstall();

  useEffect(() => setDraft(models.data?.settings), [models.data]);

  const saveModels = useMutation({
    mutationFn: () => api.updateModelSettings(draft!),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["model-settings", api.baseUrl] })
  });

  function saveConnection(event: FormEvent) {
    event.preventDefault();
    try {
      saveApiUrl(apiUrl);
      setConnectionError(undefined);
      queryClient.clear();
    } catch (error) {
      setConnectionError(error instanceof Error ? error.message : "The service URL is not allowed.");
    }
  }

  return (
    <div className="page settings-page">
      <header className="page-header"><div><h1>Settings</h1><p>Connection, identity, model providers, and install options.</p></div></header>
      <div className="settings-stack">
        <section className="panel settings-section">
          <header><Server size={20} /><div><h2>Continuum service</h2><p>The HTTPS endpoint used for sync, chat, graph, and remote administration.</p></div></header>
          <form className="settings-form" onSubmit={saveConnection}>
            <label className="form-field"><span>Service URL</span><input className="text-input mono" type="url" required value={apiUrl} aria-describedby="service-url-help service-url-error" onChange={(event) => { setApiUrl(event.target.value); setConnectionError(undefined); }} /><span id="service-url-help" className="help-text">Remote services require HTTPS. Loopback HTTP is supported for the local daemon.</span></label>
            {connectionError && <p className="inline-error" id="service-url-error" role="alert">{connectionError}</p>}
            <Button type="submit" variant="primary">Save and reconnect</Button>
          </form>
        </section>

        <section className="panel settings-section">
          <header><Cloud size={20} /><div><h2>Account</h2><p>Auth0 secures synchronized data and remote MCP access.</p></div></header>
          <div className="settings-row">
            <div>{session.configured ? session.authenticated ? <><strong>{session.user?.name ?? session.user?.email ?? "Signed in"}</strong><span>{session.user?.email}</span></> : <><strong>Not signed in</strong><span>Sign in to access synchronized Continuum data.</span></> : <><strong>Auth0 is not configured</strong><span>Add the Auth0 domain, client ID, and API audience at build time.</span></>}</div>
            {session.configured && (session.authenticated ? <Button onClick={session.logout}><LogOut size={16} /> Sign out</Button> : <Button variant="primary" onClick={() => void session.login()}><LogIn size={16} /> Sign in</Button>)}
          </div>
        </section>

        <section className="panel settings-section">
          <header><Sparkles size={20} /><div><h2>Model providers</h2><p>Providers never change automatically. Cloud selection is explicit consent.</p></div></header>
          {models.isPending ? <PageLoading label="Loading model settings…" /> : models.isError ? <ErrorState error={models.error} retry={() => void models.refetch()} title="Couldn’t load model settings" /> : draft && (
            <div className="settings-form">
              <label className="form-field"><span>Checkpoint provider</span><select className="select-input" value={draft.activeCheckpointProvider} onChange={(event) => setDraft({ ...draft, activeCheckpointProvider: event.target.value as ModelSettings["activeCheckpointProvider"] })}><option value="apple">Apple Foundation Models</option><option value="ollama">Ollama</option><option value="openai">OpenAI</option></select></label>
              <label className="form-field"><span>Chat provider</span><select className="select-input" value={draft.activeChatProvider ?? draft.activeCheckpointProvider} onChange={(event) => setDraft({ ...draft, activeChatProvider: event.target.value as ModelSettings["activeChatProvider"] })}><option value="apple">Apple Foundation Models</option><option value="ollama">Ollama</option><option value="openai">OpenAI</option></select></label>
              {draft.activeCheckpointProvider === "ollama" && <label className="form-field"><span>Ollama model</span><select className="select-input" value={draft.ollamaModel} onChange={(event) => setDraft({ ...draft, ollamaModel: event.target.value })}>{models.data.ollamaModels.length ? models.data.ollamaModels.map((model) => <option key={model}>{model}</option>) : <option value={draft.ollamaModel}>{draft.ollamaModel}</option>}</select></label>}
              {draft.activeCheckpointProvider === "openai" && <label className="form-field"><span>OpenAI model</span><select className="select-input" value={draft.openaiModel} onChange={(event) => setDraft({ ...draft, openaiModel: event.target.value })}>{models.data.presets.map((model) => <option key={model}>{model}</option>)}{!models.data.presets.includes(draft.openaiModel) && <option value={draft.openaiModel}>{draft.openaiModel}</option>}</select><span className="help-text">Requests use structured output with store:false. This is not a Zero Data Retention claim.</span></label>}
              <div className="provider-health-list">{Object.entries(models.data.providerHealth).map(([provider, value]) => { const status = typeof value === "string" ? value : value.status; const detail = typeof value === "string" ? undefined : value.detail; return <div key={provider}><StatusDot status={status} /><strong>{provider.replaceAll("_", " ")}</strong><span>{status}{detail ? ` · ${detail}` : ""}</span></div>; })}</div>
              {saveModels.isError && <p className="inline-error">{saveModels.error.message}</p>}
              <Button variant="primary" onClick={() => saveModels.mutate()} disabled={saveModels.isPending}>{saveModels.isPending ? "Saving…" : "Save model settings"}</Button>
            </div>
          )}
        </section>

        <section className="panel settings-section">
          <header><Download size={20} /><div><h2>Install Continuum</h2><p>Install this companion as a standalone app on supported desktop and mobile browsers.</p></div></header>
          <div className="settings-row"><div><strong>Progressive Web App</strong><span>{pwa.installed ? "Installed on this device." : pwa.prompt ? "Ready to install on this device." : "Use your browser’s Install or Add to Home Screen command."}</span>{installNotice && <span className="install-notice" role="status">{installNotice}</span>}</div>{!pwa.installed && pwa.prompt && <Button variant="primary" onClick={() => void pwa.install().then((outcome) => setInstallNotice(outcome === "accepted" ? "Installation started." : "Installation was dismissed."))}><Download size={16} /> Install</Button>}</div>
        </section>
      </div>
    </div>
  );
}
