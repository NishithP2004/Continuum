#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  classifyCommand,
  sanitizeCwd,
  sanitizeExitCode,
} from "./privacy.mjs";
import { MAX_QUEUE_EVENTS, pruneQueue } from "./queue-policy.mjs";
import {
  applyTerminalPolicy,
  currentPrivacyPolicy,
  prepareTerminalSession,
} from "./policy.mjs";
import {
  hybridLogicalClock,
  repositoryRoot,
  resolveDeviceId,
  resolveProjectIdentity,
} from "./project-identity.mjs";

const ENDPOINT = process.env.CONTINUUM_ENDPOINT ?? "http://127.0.0.1:43117";
const STATE_ROOT = process.env.CONTINUUM_ZSH_STATE_DIR
  ? path.resolve(process.env.CONTINUUM_ZSH_STATE_DIR)
  : path.join(os.homedir(), ".continuum", "zsh");
const SESSION_DIR = path.join(STATE_ROOT, "sessions");
const QUEUE_DIR = path.join(STATE_ROOT, "queue");
const POLICY_FILE = process.env.CONTINUUM_PRIVACY_POLICY_FILE
  ? path.resolve(process.env.CONTINUUM_PRIVACY_POLICY_FILE)
  : path.join(STATE_ROOT, "privacy-policy-v1.json");

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function safeId(value) {
  if (!/^[A-Za-z0-9._-]{1,160}$/.test(value ?? "")) {
    throw new Error("invalid collector identifier");
  }
  return value;
}

function argumentsFor(argv) {
  const result = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith("--")) throw new Error("invalid collector arguments");
    result.set(argv[index].slice(2), argv[index + 1] ?? "");
  }
  return result;
}

async function readStdin() {
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > 65_536) throw new Error("command input exceeded safety limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function validateEndpoint(raw) {
  const url = new URL(raw);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.port !== "43117" ||
    url.username ||
    url.password
  ) {
    throw new Error("Continuum endpoint must use the fixed loopback port 43117");
  }
  return url.toString().replace(/\/$/, "");
}

async function storeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await rename(temporary, file);
}

async function queue(event, policy) {
  const sanitized = applyTerminalPolicy(event, policy);
  if (!sanitized) return;
  await pruneQueue(QUEUE_DIR, { maxEntries: MAX_QUEUE_EVENTS - 1, retentionHours: policy.retentionHours });
  await storeJson(path.join(QUEUE_DIR, `${safeId(sanitized.id)}.json`), sanitized);
  await pruneQueue(QUEUE_DIR, { retentionHours: policy.retentionHours });
}

async function token() {
  if (process.env.CONTINUUM_TOKEN?.trim()) return process.env.CONTINUUM_TOKEN.trim();
  const tokenFile = process.env.CONTINUUM_TOKEN_FILE
    ? path.resolve(process.env.CONTINUUM_TOKEN_FILE)
    : process.env.CONTINUUM_DATA_DIR
      ? path.join(path.resolve(process.env.CONTINUUM_DATA_DIR), "auth.token")
      : path.join(os.homedir(), "Library", "Application Support", "Continuum", "auth.token");
  try {
    return (await readFile(tokenFile, "utf8")).trim();
  } catch {
    return "";
  }
}

async function policyAndToken() {
  const bearer = await token();
  const policy = await currentPrivacyPolicy({
    endpoint: validateEndpoint(ENDPOINT),
    token: bearer,
    cacheFile: POLICY_FILE,
  });
  return { bearer, policy };
}

async function reconcileQueue(policy) {
  let names;
  try {
    names = (await readdir(QUEUE_DIR)).filter((name) => /^[A-Za-z0-9-]+\.json$/.test(name));
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  for (const name of names) {
    const file = path.join(QUEUE_DIR, name);
    try {
      const event = JSON.parse(await readFile(file, "utf8"));
      const sanitized = applyTerminalPolicy(event, policy);
      if (sanitized) await storeJson(file, sanitized);
      else await unlink(file).catch(() => undefined);
    } catch {
      await unlink(file).catch(() => undefined);
    }
  }
}

async function flush(current) {
  const { bearer, policy } = current ?? await policyAndToken();
  await pruneQueue(QUEUE_DIR, { retentionHours: policy.retentionHours });
  await reconcileQueue(policy);
  if (!bearer) return;
  let names;
  try {
    names = (await readdir(QUEUE_DIR)).filter((name) => /^[A-Za-z0-9-]+\.json$/.test(name)).slice(0, 100);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  const entries = [];
  for (const name of names) {
    try {
      entries.push({ name, event: JSON.parse(await readFile(path.join(QUEUE_DIR, name), "utf8")) });
    } catch {
      // A malformed local queue entry is ignored and never transmitted.
    }
  }
  if (entries.length === 0) return;
  const response = await fetch(`${validateEndpoint(ENDPOINT)}/v1/events/batch`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ events: entries.map(({ event }) => event) }),
    signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok) throw new Error(`Continuum rejected terminal events (${response.status})`);
  await Promise.all(entries.map(({ name }) => unlink(path.join(QUEUE_DIR, name)).catch(() => undefined)));
}

function baseEvent({ eventType, identity, deviceId, sessionId, title, attributes, privacy, relevance, confidence = 1 }) {
  const occurredAt = new Date().toISOString();
  const id = randomUUID();
  return {
    version: "2",
    id,
    deviceId,
    occurredAt,
    hlc: hybridLogicalClock(deviceId),
    source: "terminal",
    eventType,
    ...(identity.projectId ? { projectId: identity.projectId } : {}),
    projectLocator: {
      localAlias: identity.localAlias,
      ...(identity.repositoryFingerprint ? { repositoryFingerprint: identity.repositoryFingerprint } : {}),
    },
    sessionId,
    title,
    attributes: { ...attributes, projectName: identity.normalizedName },
    privacy,
    relevance,
    confidence,
    dedupeKey: digest(`terminal\0${eventType}\0${identity.localAlias}\0${sessionId}\0${JSON.stringify(attributes)}\0${occurredAt}`),
  };
}

async function start(args) {
  const sessionId = safeId(args.get("session"));
  const commandId = safeId(args.get("command-id"));
  const current = await policyAndToken();
  const { policy } = current;
  if (!policy.sources.terminal) {
    await flush(current);
    return;
  }
  const requestedCwd = path.resolve(args.get("cwd") || process.cwd());
  const cwd = await realpath(requestedCwd).catch(() => requestedCwd);
  const raw = await readStdin();
  const classification = classifyCommand(raw);
  const repoRoot = repositoryRoot(cwd);
  const identity = resolveProjectIdentity(repoRoot);
  const deviceId = resolveDeviceId();
  if (!classification.keep) {
    await queue(baseEvent({
      eventType: "privacy.drop.aggregate",
      identity,
      deviceId,
      sessionId,
      title: "Sensitive terminal event dropped",
      attributes: { rule: classification.reason, count: 1 },
      privacy: { classification: "public", rules: ["aggregate-only", classification.reason] },
      relevance: { decision: "keep", reason: "privacy-audit-counter" },
    }), policy);
    return;
  }
  // The persisted state is already sanitized. The raw command goes out of scope here.
  const session = prepareTerminalSession({
    version: 1,
    commandId,
    sessionId,
    startedAtMs: Date.now(),
    identity,
    deviceId,
    cwd: sanitizeCwd(repoRoot, cwd),
    shape: classification.shape,
    confidence: classification.confidence,
    reason: classification.reason,
  }, policy);
  if (session) await storeJson(path.join(SESSION_DIR, `${commandId}.json`), session);
  else await flush(current);
}

async function complete(args) {
  const commandId = safeId(args.get("command-id"));
  const sessionId = safeId(args.get("session"));
  const stateFile = path.join(SESSION_DIR, `${commandId}.json`);
  let state;
  try {
    state = JSON.parse(await readFile(stateFile, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      await flush();
      return;
    }
    throw error;
  }
  await unlink(stateFile).catch(() => undefined);
  if (state.sessionId !== sessionId || state.commandId !== commandId) return;
  const current = await policyAndToken();
  const prepared = prepareTerminalSession(state, current.policy);
  if (!prepared) {
    await flush(current);
    return;
  }
  const durationMs = Math.max(0, Math.min(86_400_000, Date.now() - Number(state.startedAtMs)));
  const exitCode = sanitizeExitCode(args.get("exit-code"));
  await queue(baseEvent({
    eventType: "command.completed",
    identity: prepared.identity,
    deviceId: prepared.deviceId,
    sessionId,
    title: prepared.shape
      ? `${prepared.shape} ${exitCode === 0 ? "succeeded" : "failed"}`
      : "Terminal command activity",
    attributes: {
      ...(prepared.shape ? { commandShape: prepared.shape } : {}),
      ...(prepared.cwd ? { cwd: prepared.cwd } : {}),
      durationMs,
      exitCode,
    },
    privacy: {
      classification: "personal",
      rules: ["command-shape-only", "no-terminal-output", "repository-relative-cwd"],
    },
    relevance: { decision: "keep", reason: prepared.reason },
    confidence: prepared.confidence,
  }), current.policy);
  await flush(current);
}

const [mode, ...rest] = process.argv.slice(2);
const args = argumentsFor(rest);
if (mode === "start") await start(args);
else if (mode === "complete") await complete(args);
else if (mode === "flush") await flush();
else throw new Error("usage: collector.mjs start|complete|flush");
