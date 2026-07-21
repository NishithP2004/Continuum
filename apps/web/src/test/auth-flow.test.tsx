import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PropsWithChildren } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiProvider } from "../lib/api-context";
import { CONTINUUM_AUTH0_SCOPES, SessionProvider, useSession } from "../lib/auth";

const auth0 = vi.hoisted(() => ({
  isAuthenticated: false,
  isLoading: true,
  user: undefined as { name?: string } | undefined,
  loginWithRedirect: vi.fn(),
  logout: vi.fn(),
  getAccessTokenSilently: vi.fn()
}));

vi.mock("@auth0/auth0-react", () => ({
  Auth0Provider: ({ children }: PropsWithChildren) => children,
  useAuth0: () => auth0
}));

function TokenProbe() {
  const session = useSession();
  return <button onClick={() => void session.token()}>Get token</button>;
}

beforeEach(() => {
  vi.stubEnv("VITE_AUTH0_DOMAIN", "tenant.example.auth0.com");
  vi.stubEnv("VITE_AUTH0_CLIENT_ID", "public-spa-client-id");
  vi.stubEnv("VITE_AUTH0_AUDIENCE", "https://continuum.example");
  auth0.isAuthenticated = false;
  auth0.isLoading = true;
  auth0.user = undefined;
  auth0.loginWithRedirect.mockReset();
  auth0.logout.mockReset();
  auth0.getAccessTokenSilently.mockReset();
});

describe("authenticated API initialization", () => {
  it("does not mount protected API consumers until Auth0 restores the session", () => {
    const view = render(
      <SessionProvider><ApiProvider><div>Protected content</div></ApiProvider></SessionProvider>
    );

    expect(screen.getAllByText("Finishing sign-in…")).not.toHaveLength(0);
    expect(screen.queryByText("Protected content")).not.toBeInTheDocument();

    auth0.isLoading = false;
    auth0.isAuthenticated = true;
    view.rerender(
      <SessionProvider><ApiProvider><div>Protected content</div></ApiProvider></SessionProvider>
    );

    expect(screen.getByText("Protected content")).toBeInTheDocument();
  });

  it("requests the configured API audience and scopes when obtaining a token", async () => {
    auth0.isLoading = false;
    auth0.isAuthenticated = true;
    auth0.getAccessTokenSilently.mockResolvedValue("access-token");
    render(<SessionProvider><TokenProbe /></SessionProvider>);

    await userEvent.click(screen.getByRole("button", { name: "Get token" }));

    expect(auth0.getAccessTokenSilently).toHaveBeenCalledWith({
      authorizationParams: {
        audience: "https://continuum.example",
        scope: CONTINUUM_AUTH0_SCOPES
      }
    });
  });
});
