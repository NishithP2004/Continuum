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

const integrationDir = path.dirname(fileURLToPath(import.meta.url));
const sourceDir = path.resolve(integrationDir, "..");

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
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
  const expiredName = `${randomUUID()}.json`;
  await writeFile(path.join(queueDir, expiredName), JSON.stringify({
    occurredAt: new Date(Date.now() - 24 * 60 * 60 * 1_000 - 1_000).toISOString(),
    title: "expired-event-must-be-removed",
  }));

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
  const queueFiles = (await readdir(queueDir)).filter((name) => name.endsWith(".json"));
  assert.equal(queueFiles.includes(expiredName), false);
  assert.ok(queueFiles.length >= 2, "expected Git event and privacy aggregate");
  const events = await Promise.all(
    queueFiles.map(async (name) => JSON.parse(await readFile(path.join(queueDir, name), "utf8"))),
  );
  const commit = events.find((event) => event.eventType === "commit.created");
  assert.ok(commit);
  assert.equal(commit.projectId, "Build-Week-Demo");
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
