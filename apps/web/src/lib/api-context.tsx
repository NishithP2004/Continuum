import { createContext, type PropsWithChildren, useContext, useEffect, useMemo, useState } from "react";
import { PageLoading } from "../components/ui";
import { ContinuumApi } from "./api";
import { configuredApiUrl } from "./config";
import { useSession } from "./auth";

const ApiContext = createContext<ContinuumApi | null>(null);

export function ApiProvider({ children }: PropsWithChildren) {
  const session = useSession();
  const [baseUrl, setBaseUrl] = useState(configuredApiUrl);
  useEffect(() => {
    const update = () => setBaseUrl(configuredApiUrl());
    window.addEventListener("continuum:configuration", update);
    return () => window.removeEventListener("continuum:configuration", update);
  }, []);
  const api = useMemo(() => new ContinuumApi(baseUrl, session.token), [baseUrl, session.token]);
  if (session.loading) return <PageLoading label="Finishing sign-in…" />;
  return <ApiContext.Provider value={api}>{children}</ApiContext.Provider>;
}

export function useApi(): ContinuumApi {
  const api = useContext(ApiContext);
  if (!api) throw new Error("useApi must be used within ApiProvider");
  return api;
}
