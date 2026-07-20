import { useQuery } from "@tanstack/react-query";
import {
  Activity, Clock3, GitFork, Laptop, MessageCircle, MoreHorizontal,
  Settings, ShieldCheck, SlidersHorizontal, X
} from "lucide-react";
import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useApi } from "../lib/api-context";
import { useSession } from "../lib/auth";
import { useOnlineStatus } from "../lib/network";
import { Brand } from "./Brand";
import { Button, IconButton, StatusDot } from "./ui";

const navigation = [
  { to: "/now", label: "Now", icon: Clock3 },
  { to: "/chat", label: "Chat", icon: MessageCircle },
  { to: "/graph", label: "Graph", icon: GitFork },
  { to: "/timeline", label: "Timeline", icon: Activity },
  { to: "/privacy", label: "Privacy", icon: ShieldCheck },
  { to: "/devices", label: "Devices", icon: Laptop },
  { to: "/settings", label: "Settings", icon: Settings }
] as const;

const mobileNavigation = navigation.filter(({ to }) => ["/now", "/chat", "/graph", "/privacy"].includes(to));
const moreNavigation = navigation.filter(({ to }) => ["/timeline", "/devices", "/settings"].includes(to));

export function AppShell() {
  const api = useApi();
  const session = useSession();
  const location = useLocation();
  const online = useOnlineStatus();
  const [moreOpen, setMoreOpen] = useState(false);
  const state = useQuery({ queryKey: ["engine-state", api.baseUrl], queryFn: () => api.state(), refetchInterval: 10_000 });
  const title = navigation.find((item) => location.pathname.startsWith(item.to))?.label ?? "Continuum";
  const syncStatus = !online ? "offline" : state.data?.sync?.status ?? (state.data?.connected ? "ready" : "disconnected");
  const statusLabel = !online ? "Offline" : state.isPending ? "Connecting" : state.isError ? "Disconnected" : state.data?.sync?.status === "syncing" ? "Syncing" : state.data?.sync?.lastSyncAt ? "Synced" : "Connected";
  const moreActive = moreNavigation.some((item) => location.pathname.startsWith(item.to));

  useEffect(() => {
    document.title = `${title} — Continuum`;
    setMoreOpen(false);
  }, [location.pathname, title]);

  useEffect(() => {
    if (!moreOpen) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMoreOpen(false);
    };
    window.addEventListener("keydown", dismiss);
    return () => window.removeEventListener("keydown", dismiss);
  }, [moreOpen]);

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Skip to content</a>
      <aside className="sidebar">
        <Brand />
        <p className="sidebar__tagline">Privacy-first context<br />for developer agents.</p>
        <div className="project-switcher" aria-label="Active project">
          <span className="project-switcher__mark">C</span>
          <span>{state.data?.activeProject?.name ?? "No active project"}</span>
        </div>
        <nav className="sidebar__nav" aria-label="Primary navigation">
          {navigation.map(({ to, label, icon: Icon }) => (
            <NavLink key={to} to={to} className={({ isActive }) => isActive ? "nav-item nav-item--active" : "nav-item"}>
              <Icon size={20} aria-hidden="true" /><span>{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="sidebar__footer">
          <div className="local-status"><ShieldCheck size={20} aria-hidden="true" /><div><strong>Privacy guard active</strong><span>Secrets always stay blocked</span></div></div>
          <div className="connection-line"><StatusDot status={syncStatus} /><span>{statusLabel}</span></div>
        </div>
      </aside>

      <div className="app-body">
        <header className="topbar">
          <div className="mobile-brand"><Brand compact /><div className="mobile-project">{state.data?.activeProject?.name ?? "Continuum"}</div></div>
          <div className="topbar__title"><strong>{title}</strong>{state.data?.activeProject && <><span>›</span><span>{state.data.activeProject.name}</span></>}</div>
          <div className="topbar__status" aria-live="polite" aria-label={`Connection status: ${statusLabel}`}>
            <StatusDot status={syncStatus} /><span>{statusLabel}</span>
            {state.data?.sync?.lastSyncAt && <time dateTime={state.data.sync.lastSyncAt}>{new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(Math.round((new Date(state.data.sync.lastSyncAt).getTime() - Date.now()) / 60_000), "minute")}</time>}
            {!session.authenticated && session.configured && <Button variant="quiet" onClick={() => void session.login()}>Sign in</Button>}
            <NavLink className="icon-button" aria-label="Settings" title="Settings" to="/settings"><MoreHorizontal size={20} /></NavLink>
          </div>
        </header>
        <main className="main-content" id="main-content" tabIndex={-1}><Outlet /></main>
      </div>

      <nav className="mobile-tabs" aria-label="Primary navigation">
        {mobileNavigation.map(({ to, label, icon: Icon }) => (
          <NavLink key={to} to={to} className={({ isActive }) => isActive ? "mobile-tab mobile-tab--active" : "mobile-tab"}>
            <Icon size={25} aria-hidden="true" /><span>{label}</span>
          </NavLink>
        ))}
        <button type="button" className={moreActive || moreOpen ? "mobile-tab mobile-tab--active" : "mobile-tab"} aria-haspopup="dialog" aria-expanded={moreOpen} onClick={() => setMoreOpen((value) => !value)}>
          <SlidersHorizontal size={25} aria-hidden="true" /><span>More</span>
        </button>
      </nav>

      {moreOpen && <div className="mobile-more-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) setMoreOpen(false); }}><section className="mobile-more-sheet" role="dialog" aria-modal="true" aria-labelledby="mobile-more-title"><div className="bottom-sheet-handle" /><header><h2 id="mobile-more-title">More</h2><IconButton label="Close more navigation" onClick={() => setMoreOpen(false)}><X size={19} /></IconButton></header><nav aria-label="More navigation">{moreNavigation.map(({ to, label, icon: Icon }) => <NavLink key={to} to={to}><Icon size={20} aria-hidden="true" /><span>{label}</span></NavLink>)}</nav></section></div>}
    </div>
  );
}
