import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import { SessionProvider } from "./lib/auth";
import { ApiProvider } from "./lib/api-context";
import { App } from "./App";
import { initializePwaInstall } from "./lib/pwa-install";
import "./styles.css";

initializePwaInstall();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: true, staleTime: 4_000 },
    mutations: { retry: 0 }
  }
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <SessionProvider>
      <ApiProvider>
        <QueryClientProvider client={queryClient}>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </QueryClientProvider>
      </ApiProvider>
    </SessionProvider>
  </StrictMode>
);

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js"));
}
