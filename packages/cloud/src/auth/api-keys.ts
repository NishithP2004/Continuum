import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const keyPattern = /^ctm_([A-Za-z0-9_-]{12})_([A-Za-z0-9_-]{32,64})$/;

export interface GeneratedApiKey {
  id: string;
  token: string;
  digest: Buffer;
}

export function digestApiKey(token: string, pepper: string): Buffer {
  if (pepper.length < 32) throw new Error("API key pepper must be at least 32 characters");
  return createHmac("sha256", pepper).update(token, "utf8").digest();
}

export function generateApiKey(pepper: string): GeneratedApiKey {
  const id = randomBytes(9).toString("base64url");
  const secret = randomBytes(32).toString("base64url");
  const token = `ctm_${id}_${secret}`;
  return { id, token, digest: digestApiKey(token, pepper) };
}

export function apiKeyId(token: string): string | null {
  return keyPattern.exec(token)?.[1] ?? null;
}

export function verifyApiKeyDigest(token: string, expected: Uint8Array, pepper: string): boolean {
  const actual = digestApiKey(token, pepper);
  const target = Buffer.from(expected);
  return actual.length === target.length && timingSafeEqual(actual, target);
}
