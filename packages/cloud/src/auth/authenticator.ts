import { createRemoteJWKSet, jwtVerify } from "jose";
import { apiKeyId, verifyApiKeyDigest } from "./api-keys.js";
import type { PostgresStore } from "../db/postgres.js";

export interface Principal {
  accountId: string;
  subject: string;
  clientId: string;
  credentialId?: string;
  deviceId?: string;
  scopes: string[];
  token: string;
  expiresAt?: number;
  method: "oauth" | "api_key";
}

export class AuthenticationError extends Error {
  constructor(message: string, readonly statusCode = 401) {
    super(message);
  }
}

export interface Authenticator {
  authenticate(authorization: string | undefined, requiredScopes?: string[]): Promise<Principal>;
}

export class ContinuumAuthenticator implements Authenticator {
  private readonly issuer: string;
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(
    private readonly store: PostgresStore,
    issuer: string,
    private readonly audience: string,
    private readonly pepper: string
  ) {
    this.issuer = issuer.endsWith("/") ? issuer : `${issuer}/`;
    this.jwks = createRemoteJWKSet(new URL(".well-known/jwks.json", this.issuer));
  }

  async authenticate(authorization: string | undefined, requiredScopes: string[] = []): Promise<Principal> {
    if (!authorization?.startsWith("Bearer ")) throw new AuthenticationError("missing bearer token");
    const token = authorization.slice(7).trim();
    const principal = token.startsWith("ctm_") ? await this.authenticateApiKey(token) : await this.authenticateJwt(token);
    const missing = requiredScopes.filter((scope) => !principal.scopes.includes(scope));
    if (missing.length > 0) throw new AuthenticationError(`missing required scope: ${missing.join(", ")}`, 403);
    return principal;
  }

  private async authenticateApiKey(token: string): Promise<Principal> {
    const id = apiKeyId(token);
    if (!id) throw new AuthenticationError("invalid API key format");
    const record = await this.store.findApiKey(id);
    if (!record || record.revokedAt || (record.expiresAt && record.expiresAt.getTime() <= Date.now())) {
      throw new AuthenticationError("API key is expired, revoked, or unknown");
    }
    if (!verifyApiKeyDigest(token, record.digest, this.pepper)) throw new AuthenticationError("invalid API key");
    void this.store.touchApiKey(record.accountId, id).catch(() => undefined);
    return {
      accountId: record.accountId,
      subject: `api-key:${id}`,
      clientId: id,
      credentialId: id,
      ...(record.deviceId ? { deviceId: record.deviceId } : {}),
      scopes: record.scopes,
      token,
      ...(record.expiresAt ? { expiresAt: Math.floor(record.expiresAt.getTime() / 1_000) } : {}),
      method: "api_key"
    };
  }

  private async authenticateJwt(token: string): Promise<Principal> {
    try {
      const verified = await jwtVerify(token, this.jwks, {
        issuer: this.issuer,
        audience: this.audience,
        algorithms: ["RS256"]
      });
      if (!verified.payload.sub) throw new AuthenticationError("access token has no subject");
      const scopeClaim = typeof verified.payload.scope === "string" ? verified.payload.scope.split(/\s+/) : [];
      const permissions = Array.isArray(verified.payload.permissions)
        ? verified.payload.permissions.filter((value): value is string => typeof value === "string")
        : [];
      const accountId = await this.store.ensureAccount(verified.payload.sub);
      return {
        accountId,
        subject: verified.payload.sub,
        clientId: typeof verified.payload.azp === "string" ? verified.payload.azp : "auth0",
        scopes: [...new Set([...scopeClaim, ...permissions])],
        token,
        ...(verified.payload.exp ? { expiresAt: verified.payload.exp } : {}),
        method: "oauth"
      };
    } catch (error) {
      if (error instanceof AuthenticationError) throw error;
      throw new AuthenticationError("invalid OAuth access token");
    }
  }
}

export class StaticAuthenticator implements Authenticator {
  constructor(private readonly resolve: (token: string) => Principal | null) {}

  async authenticate(authorization: string | undefined, requiredScopes: string[] = []): Promise<Principal> {
    if (!authorization?.startsWith("Bearer ")) throw new AuthenticationError("missing bearer token");
    const principal = this.resolve(authorization.slice(7));
    if (!principal) throw new AuthenticationError("invalid token");
    const missing = requiredScopes.filter((scope) => !principal.scopes.includes(scope));
    if (missing.length > 0) throw new AuthenticationError(`missing required scope: ${missing.join(", ")}`, 403);
    return principal;
  }
}
