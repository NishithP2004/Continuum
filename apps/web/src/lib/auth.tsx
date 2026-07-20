import { Auth0Provider, useAuth0 } from "@auth0/auth0-react";
import { createContext, type PropsWithChildren, useCallback, useContext, useMemo } from "react";
import { auth0Configuration } from "./config";

export const CONTINUUM_AUTH0_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "context:read",
  "sync:read",
  "sync:write",
  "devices:write",
  "keys:write"
].join(" ");

interface SessionUser {
  name?: string;
  email?: string;
  picture?: string;
}

interface SessionValue {
  configured: boolean;
  authenticated: boolean;
  loading: boolean;
  user?: SessionUser;
  login(): Promise<void>;
  logout(): void;
  token(): Promise<string | undefined>;
}

const SessionContext = createContext<SessionValue | null>(null);

const unavailableSession: SessionValue = {
  configured: false,
  authenticated: false,
  loading: false,
  async login() {},
  logout() {},
  async token() {
    return undefined;
  }
};

function Auth0Session({ children }: PropsWithChildren) {
  const { isAuthenticated, isLoading, user, loginWithRedirect, logout, getAccessTokenSilently } = useAuth0();
  const login = useCallback(async () => loginWithRedirect({ appState: { returnTo: window.location.pathname } }), [loginWithRedirect]);
  const signOut = useCallback(() => logout({ logoutParams: { returnTo: window.location.origin } }), [logout]);
  const token = useCallback(async () => {
    if (!isAuthenticated) return undefined;
    return getAccessTokenSilently();
  }, [getAccessTokenSilently, isAuthenticated]);
  const value = useMemo<SessionValue>(() => ({
    configured: true,
    authenticated: isAuthenticated,
    loading: isLoading,
    user,
    login,
    logout: signOut,
    token
  }), [isAuthenticated, isLoading, login, signOut, token, user]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function SessionProvider({ children }: PropsWithChildren) {
  const configuration = auth0Configuration();
  if (!configuration) {
    return <SessionContext.Provider value={unavailableSession}>{children}</SessionContext.Provider>;
  }
  return (
    <Auth0Provider
      domain={configuration.domain}
      clientId={configuration.clientId}
      authorizationParams={{
        redirect_uri: window.location.origin,
        scope: CONTINUUM_AUTH0_SCOPES,
        ...(configuration.audience ? { audience: configuration.audience } : {})
      }}
      cacheLocation="memory"
      useRefreshTokens
    >
      <Auth0Session>{children}</Auth0Session>
    </Auth0Provider>
  );
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession must be used within SessionProvider");
  return value;
}
