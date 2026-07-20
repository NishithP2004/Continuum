#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  isCommitId,
  sanitizeChangedPath,
  sanitizeRef,
  sanitizeSubject,
} from "./privacy.mjs";
import { MAX_QUEUE_EVENTS, pruneQueue } from "./queue-policy.mjs";
import { applyGitPolicy, currentPrivacyPolicy } from "./policy.mjs";
import {
  hybridLogicalClock,
  resolveDeviceId,
  resolveProjectIdentity,
} from "./project-identity.mjs";

const EVENT_TYPES = {
  "post-commit": "commit.created",
  "post-checkout": "branch.checked-out",
  "post-merge": "merge.completed",
  "post-rewrite": "history.rewritten",
};

function git(args, cwd) {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 2_000,
    maxBuffer: 1_048_576,
  });
  return result.status === 0 ? result.stdout.trim() : "";
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function validateEndpoint(input) {
  const url = new URL(input);
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

function argumentsFor(argv) {
  const output = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith("--")) continue;
    output.set(argv[index].slice(2), argv[index + 1] ?? "");
  }
  return output;
}

async function atomicJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await rename(temporary, file);
}

function makeEvent({ eventType, identity, deviceId, title, attributes, privacyRules, confidence = 1 }) {
  const occurredAt = new Date().toISOString();
  return {
    version: "2",
    id: randomUUID(),
    deviceId,
    occurredAt,
    hlc: hybridLogicalClock(deviceId),
    source: "git",
    eventType,
    ...(identity.projectId ? { projectId: identity.projectId } : {}),
    projectLocator: {
      localAlias: identity.localAlias,
      ...(identity.repositoryFingerprint ? { repositoryFingerprint: identity.repositoryFingerprint } : {}),
    },
    title,
    attributes: { ...attributes, projectName: identity.normalizedName },
    privacy: {
      classification: eventType === "privacy.drop.aggregate" ? "public" : "personal",
      rules: privacyRules,
    },
    relevance: {
      decision: "keep",
      reason: eventType === "privacy.drop.aggregate"
        ? "privacy-audit-counter"
        : "repository-hook-metadata",
    },
    confidence,
    dedupeKey: digest(`git\0${eventType}\0${identity.localAlias}\0${JSON.stringify(attributes)}\0${occurredAt}`),
  };
}

async function bearerToken() {
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

async function queueEvent(queueDir, event, policy) {
  const sanitized = applyGitPolicy(event, policy);
  if (!sanitized) return;
  await pruneQueue(queueDir, { maxEntries: MAX_QUEUE_EVENTS - 1, retentionHours: policy.retentionHours });
  await atomicJson(path.join(queueDir, `${sanitized.id}.json`), sanitized);
  await pruneQueue(queueDir, { retentionHours: policy.retentionHours });
}

async function reconcileQueue(queueDir, policy) {
  let names;
  try {
    names = (await readdir(queueDir)).filter((name) => /^[0-9a-f-]+\.json$/i.test(name));
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  for (const name of names) {
    const file = path.join(queueDir, name);
    try {
      const event = JSON.parse(await readFile(file, "utf8"));
      const sanitized = applyGitPolicy(event, policy);
      if (sanitized) await atomicJson(file, sanitized);
      else await unlink(file).catch(() => undefined);
    } catch {
      await unlink(file).catch(() => undefined);
    }
  }
}

async function flush(queueDir, current) {
  const token = current?.token ?? await bearerToken();
  const endpoint = validateEndpoint(process.env.CONTINUUM_ENDPOINT ?? "http://127.0.0.1:43117");
  const cacheFile = process.env.CONTINUUM_PRIVACY_POLICY_FILE
    ? path.resolve(process.env.CONTINUUM_PRIVACY_POLICY_FILE)
    : path.join(path.dirname(queueDir), "privacy-policy-v1.json");
  const policy = current?.policy ?? await currentPrivacyPolicy({ endpoint, token, cacheFile });
  await pruneQueue(queueDir, { retentionHours: policy.retentionHours });
  await reconcileQueue(queueDir, policy);
  if (!token) return;
  let names;
  try {
    names = (await readdir(queueDir)).filter((name) => /^[0-9a-f-]+\.json$/i.test(name)).slice(0, 100);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  const pending = [];
  for (const name of names) {
    try {
      pending.push({ name, event: JSON.parse(await readFile(path.join(queueDir, name), "utf8")) });
    } catch {
      // Invalid local files are never transmitted.
    }
  }
  if (pending.length === 0) return;
  const response = await fetch(`${endpoint}/v1/events/batch`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ events: pending.map(({ event }) => event) }),
    signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok) throw new Error(`Continuum rejected Git events (${response.status})`);
  await Promise.all(pending.map(({ name }) => unlink(path.join(queueDir, name)).catch(() => undefined)));
}

function changedPaths(hook, args, cwd) {
  let output = "";
  if (hook === "post-checkout" && isCommitId(args.get("old")) && isCommitId(args.get("new"))) {
    output = git(["-c", "core.quotePath=false", "diff", "--name-only", "-z", args.get("old"), args.get("new"), "--"], cwd);
  } else {
    output = git(["-c", "core.quotePath=false", "diff-tree", "--root", "--no-commit-id", "--name-only", "-z", "-r", "-m", "HEAD", "--"], cwd);
  }
  const kept = [];
  const dropped = new Map();
  for (const rawPath of output.split("\0").filter(Boolean).slice(0, 500)) {
    const result = sanitizeChangedPath(rawPath);
    if (result.keep) {
      if (!kept.includes(result.value)) kept.push(result.value);
    } else {
      dropped.set(result.reason, (dropped.get(result.reason) ?? 0) + 1);
    }
    if (kept.length >= 50) break;
  }
  return { kept, dropped };
}

async function main() {
  const [hook, ...argv] = process.argv.slice(2);
  if (!Object.hasOwn(EVENT_TYPES, hook)) throw new Error("unknown Continuum Git hook");
  const args = argumentsFor(argv);
  const cwd = process.cwd();
  const repoRoot = git(["rev-parse", "--show-toplevel"], cwd);
  const gitDir = git(["rev-parse", "--absolute-git-dir"], cwd);
  if (!repoRoot || !gitDir) return;
  const queueDir = path.join(gitDir, "continuum", "queue");
  const endpoint = validateEndpoint(process.env.CONTINUUM_ENDPOINT ?? "http://127.0.0.1:43117");
  const token = await bearerToken();
  const cacheFile = process.env.CONTINUUM_PRIVACY_POLICY_FILE
    ? path.resolve(process.env.CONTINUUM_PRIVACY_POLICY_FILE)
    : path.join(gitDir, "continuum", "privacy-policy-v1.json");
  const policy = await currentPrivacyPolicy({ endpoint, token, cacheFile });
  const current = { token, policy };
  if (!policy.sources.git) {
    await flush(queueDir, current);
    return;
  }
  const identity = resolveProjectIdentity(
    repoRoot,
    process.env.CONTINUUM_PROJECT_ID,
    git(["config", "--local", "--get", "continuum.projectId"], repoRoot),
  );
  const deviceId = resolveDeviceId();
  const commit = git(["rev-parse", "HEAD"], repoRoot);
  if (!isCommitId(commit)) return;
  const branch = sanitizeRef(git(["symbolic-ref", "--short", "-q", "HEAD"], repoRoot));
  const subject = sanitizeSubject(git(["log", "-1", "--format=%s", "HEAD"], repoRoot));
  const paths = changedPaths(hook, args, repoRoot);
  const hookDetail = hook === "post-rewrite"
    ? sanitizeRef(args.get("rewrite-type"), "unknown")
    : hook === "post-checkout"
      ? (args.get("branch-checkout") === "1" ? "branch" : "file")
      : hook === "post-merge"
        ? (args.get("squash") === "1" ? "squash" : "merge")
        : "commit";

  const privacyRules = ["no-patches-or-blobs", "repository-relative-paths", "no-remotes"];
  const attributes = {
    sha: commit,
    branch,
    operation: hookDetail,
    files: paths.kept,
  };
  if (subject.keep) {
    attributes.subject = subject.value;
    privacyRules.push(subject.reason);
  } else if (subject.reason === "secret-subject") {
    paths.dropped.set(subject.reason, (paths.dropped.get(subject.reason) ?? 0) + 1);
  }
  await queueEvent(queueDir, makeEvent({
    eventType: EVENT_TYPES[hook],
    identity,
    deviceId,
    title: `${EVENT_TYPES[hook]} ${commit.slice(0, 8)}`,
    attributes,
    privacyRules,
  }), policy);

  for (const [rule, count] of paths.dropped) {
    await queueEvent(queueDir, makeEvent({
      eventType: "privacy.drop.aggregate",
      identity,
      deviceId,
      title: "Sensitive Git metadata dropped",
      attributes: { rule, count },
      privacyRules: ["aggregate-only", rule],
    }), policy);
  }
  await flush(queueDir, current);
}

await main();
