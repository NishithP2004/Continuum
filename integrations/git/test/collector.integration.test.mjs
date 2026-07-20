import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { failClosedPrivacyPolicy } from "../policy.mjs";

const integrationDir = path.dirname(fileURLToPath(import.meta.url));
const sourceDir = path.resolve(integrationDir, "..");

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function enabledPolicy(overrides = {}) {
  const policy = failClosedPrivacyPolicy();
  return {
    ...policy,
    revision: overrides.revision ?? 11,
    updatedAt: new Date().toISOString(),
    sources: { ...policy.sources, git: true, ...(overrides.sources ?? {}) },
    metadata: {
      ...policy.metadata,
      relativeFilePaths: true,
      personalMetadata: true,
      ...(overrides.metadata ?? {}),
    },
    ignoredPathPatterns: overrides.ignoredPathPatterns ?? [],
  };
}

test("collector queues only sanitized Git metadata", async (context) => {
  const repo = await mkdtemp(path.join(os.tmpdir(), "continuum-git-test-"));
  context.after(() => rm(repo, { recursive: true, force: true }));
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "continuum@example.invalid");
  git(repo, "config", "user.name", "Continuum Test");
  git(repo, "config", "--local", "continuum.projectId", "Build Week / Demo");
  await mkdir(path.join(repo, "src"));
  await writeFile(path.join(repo, "src", "engine.ts"), "export const ready = true;\n");
  await writeFile(path.join(repo, ".env"), "OPENAI_API_KEY=never-persist-this\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "Add engine checkpoint");

  const gitDir = git(repo, "rev-parse", "--absolute-git-dir");
  const queueDir = path.join(gitDir, "continuum", "queue");
  await mkdir(queueDir, { recursive: true });
  await writeFile(path.join(gitDir, "continuum", "privacy-policy-v1.json"), JSON.stringify(enabledPolicy()));
  const expiredName = `${randomUUID()}.json`;
  await writeFile(path.join(queueDir, expiredName), JSON.stringify({
    occurredAt: new Date(Date.now() - 2 * 60 * 60 * 1_000).toISOString(),
    title: "expired-event-must-be-removed",
  }));

  const result = spawnSync(process.execPath, [path.join(sourceDir, "collector.mjs"), "post-commit"], {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      CONTINUUM_DEVICE_ID: "device-git-collector",
      CONTINUUM_TOKEN: "",
      CONTINUUM_TOKEN_FILE: path.join(repo, "missing-token"),
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const queueFiles = (await readdir(queueDir)).filter((name) => name.endsWith(".json"));
  assert.equal(queueFiles.includes(expiredName), false);
  assert.ok(queueFiles.length >= 2, "expected Git event and privacy aggregate");
  const events = await Promise.all(
    queueFiles.map(async (name) => JSON.parse(await readFile(path.join(queueDir, name), "utf8"))),
  );
  const commit = events.find((event) => event.eventType === "commit.created");
  assert.ok(commit);
  assert.equal(commit.version, "2");
  assert.equal(commit.projectId, undefined, "legacy path-like IDs must not masquerade as global UUIDs");
  assert.equal(commit.deviceId, "device-git-collector");
  assert.match(commit.hlc, /^\d{10,20}:\d+:device-git-collector$/);
  assert.match(commit.projectLocator.localAlias, /^[0-9a-f]{64}$/);
  assert.match(commit.projectLocator.repositoryFingerprint, /^[0-9a-f]{64}$/);
  assert.deepEqual(commit.attributes.files, ["src/engine.ts"]);
  assert.match(commit.attributes.sha, /^[0-9a-f]{40,64}$/);
  assert.equal(commit.attributes.subject, "Add engine checkpoint");
  assert.equal(JSON.stringify(events).includes("OPENAI_API_KEY"), false);
  assert.equal(JSON.stringify(events).includes("never-persist-this"), false);
  assert.equal(JSON.stringify(events).includes(".env"), false);
});

test("installer refuses to overwrite an existing repository hook", async (context) => {
  const repo = await mkdtemp(path.join(os.tmpdir(), "continuum-hook-test-"));
  context.after(() => rm(repo, { recursive: true, force: true }));
  git(repo, "init", "-q");
  const first = spawnSync(path.join(sourceDir, "install.sh"), [], {
    cwd: repo,
    encoding: "utf8",
  });
  assert.equal(first.status, 0, first.stderr);
  const second = spawnSync(path.join(sourceDir, "install.sh"), [], {
    cwd: repo,
    encoding: "utf8",
  });
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /Refusing to overwrite existing hook/);
});

test("fails closed when no validated Git policy is available", async (context) => {
  const repo = await mkdtemp(path.join(os.tmpdir(), "continuum-git-fail-closed-"));
  context.after(() => rm(repo, { recursive: true, force: true }));
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "continuum@example.invalid");
  git(repo, "config", "user.name", "Continuum Test");
  await writeFile(path.join(repo, "README.md"), "live\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-q", "-m", "Initial live commit");
  const result = spawnSync(process.execPath, [path.join(sourceDir, "collector.mjs"), "post-commit"], {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      CONTINUUM_TOKEN: "",
      CONTINUUM_TOKEN_FILE: path.join(repo, "missing-token"),
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const queueDir = path.join(git(repo, "rev-parse", "--absolute-git-dir"), "continuum", "queue");
  await assert.rejects(readdir(queueDir), /ENOENT/);
});

test("Git metadata toggles are applied before queue persistence", async (context) => {
  const repo = await mkdtemp(path.join(os.tmpdir(), "continuum-git-policy-"));
  context.after(() => rm(repo, { recursive: true, force: true }));
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "continuum@example.invalid");
  git(repo, "config", "user.name", "Continuum Test");
  await mkdir(path.join(repo, "private"));
  await writeFile(path.join(repo, "private", "ignored.ts"), "ignored\n");
  await writeFile(path.join(repo, "visible.ts"), "visible\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "Policy filtered commit");
  const gitDir = git(repo, "rev-parse", "--absolute-git-dir");
  await mkdir(path.join(gitDir, "continuum"), { recursive: true });
  await writeFile(
    path.join(gitDir, "continuum", "privacy-policy-v1.json"),
    JSON.stringify(enabledPolicy({
      revision: 23,
      metadata: { relativeFilePaths: false, personalCloudEligibility: true },
      ignoredPathPatterns: ["private/**"],
    })),
  );
  const result = spawnSync(process.execPath, [path.join(sourceDir, "collector.mjs"), "post-commit"], {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      CONTINUUM_DEVICE_ID: "device-git-policy",
      CONTINUUM_TOKEN: "",
      CONTINUUM_TOKEN_FILE: path.join(repo, "missing-token"),
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const queueDir = path.join(gitDir, "continuum", "queue");
  const events = await Promise.all((await readdir(queueDir)).map(async (name) => JSON.parse(await readFile(path.join(queueDir, name), "utf8"))));
  const event = events.find((candidate) => candidate.eventType === "commit.created");
  assert.ok(event);
  assert.equal(event.attributes.files, undefined);
  assert.equal(JSON.stringify(event).includes("ignored.ts"), false);
  assert.equal(event.policyVersion, 23);
  assert.equal(event.syncEligibility, "cloud_eligible");
});

test("disabled Git policy deletes queued events before transport", async (context) => {
  const repo = await mkdtemp(path.join(os.tmpdir(), "continuum-git-reconcile-"));
  context.after(() => rm(repo, { recursive: true, force: true }));
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "continuum@example.invalid");
  git(repo, "config", "user.name", "Continuum Test");
  await writeFile(path.join(repo, "README.md"), "live\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-q", "-m", "Queued commit");
  const gitDir = git(repo, "rev-parse", "--absolute-git-dir");
  const support = path.join(gitDir, "continuum");
  await mkdir(support, { recursive: true });
  const policyFile = path.join(support, "privacy-policy-v1.json");
  await writeFile(policyFile, JSON.stringify(enabledPolicy()));
  const env = {
    ...process.env,
    CONTINUUM_DEVICE_ID: "device-git-reconcile",
    CONTINUUM_TOKEN: "",
    CONTINUUM_TOKEN_FILE: path.join(repo, "missing-token"),
  };
  const queued = spawnSync(process.execPath, [path.join(sourceDir, "collector.mjs"), "post-commit"], { cwd: repo, encoding: "utf8", env });
  assert.equal(queued.status, 0, queued.stderr);
  await writeFile(policyFile, JSON.stringify(enabledPolicy({ revision: 12, sources: { git: false } })));
  const reconciled = spawnSync(process.execPath, [path.join(sourceDir, "collector.mjs"), "post-commit"], { cwd: repo, encoding: "utf8", env });
  assert.equal(reconciled.status, 0, reconciled.stderr);
  assert.deepEqual(await readdir(path.join(support, "queue")), []);
});
