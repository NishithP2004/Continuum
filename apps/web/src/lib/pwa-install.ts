import { useSyncExternalStore } from "react";

export interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

type InstallState = {
  installed: boolean;
  prompt?: InstallPromptEvent;
};

const listeners = new Set<() => void>();
let initialized = false;
let state: InstallState = { installed: false };

function detectInstalled(): boolean {
  const navigatorWithStandalone = navigator as Navigator & { standalone?: boolean };
  return window.matchMedia("(display-mode: standalone)").matches || navigatorWithStandalone.standalone === true;
}

function publish(nextState: InstallState): void {
  state = nextState;
  listeners.forEach((listener) => listener());
}

export function initializePwaInstall(): void {
  if (initialized) return;
  initialized = true;
  state = { installed: detectInstalled() };
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    publish({ installed: false, prompt: event as InstallPromptEvent });
  });
  window.addEventListener("appinstalled", () => publish({ installed: true }));
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): InstallState {
  return state;
}

export function usePwaInstall(): InstallState & { install(): Promise<"accepted" | "dismissed" | "unavailable"> } {
  const value = useSyncExternalStore(subscribe, snapshot, snapshot);
  return {
    ...value,
    async install() {
      if (!state.prompt) return "unavailable";
      const prompt = state.prompt;
      await prompt.prompt();
      const { outcome } = await prompt.userChoice;
      publish({ installed: outcome === "accepted" || detectInstalled() });
      return outcome;
    }
  };
}
