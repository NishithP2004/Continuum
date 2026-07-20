import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { PageLoading } from "./components/ui";

const NowPage = lazy(() => import("./routes/NowPage").then((module) => ({ default: module.NowPage })));
const ChatPage = lazy(() => import("./routes/ChatPage").then((module) => ({ default: module.ChatPage })));
const GraphPage = lazy(() => import("./routes/GraphPage").then((module) => ({ default: module.GraphPage })));
const TimelinePage = lazy(() => import("./routes/TimelinePage").then((module) => ({ default: module.TimelinePage })));
const PrivacyPage = lazy(() => import("./routes/PrivacyPage").then((module) => ({ default: module.PrivacyPage })));
const DevicesPage = lazy(() => import("./routes/DevicesPage").then((module) => ({ default: module.DevicesPage })));
const SettingsPage = lazy(() => import("./routes/SettingsPage").then((module) => ({ default: module.SettingsPage })));

export function App() {
  return (
    <Suspense fallback={<PageLoading label="Opening Continuum…" />}>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/now" element={<NowPage />} />
          <Route path="/chat" element={<ChatPage />} />
          <Route path="/graph" element={<GraphPage />} />
          <Route path="/timeline" element={<TimelinePage />} />
          <Route path="/privacy" element={<PrivacyPage />} />
          <Route path="/devices" element={<DevicesPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/now" replace />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
