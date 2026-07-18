import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const integrationDir = path.dirname(fileURLToPath(import.meta.url));
const collector = path.resolve(integrationDir, "..", "collector.mjs");
const plugin = path.resolve(integrationDir, "..", "continuum.plugin.zsh");
const repositoryRoot = path.resolve(integrationDir, "../../..");
const cliExecutable = path.join(repositoryRoot, "packages", "continuum", "dist", "cli", "main.js");

function invoke(mode, args, options) {
  return spawnSync(process.execPath, [collector, mode, ...args], {
    encoding: "utf8",
    ...options,
  });
}

test("raw commands never enter terminal state or durable queue", async (context) => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "continuum-zsh-test-"));
  context.after(() => rm(stateRoot, { recursive: true, force: true }));
  const env = {
    ...process.env,
    CONTINUUM_ZSH_STATE_DIR: stateRoot,
    CONTINUUM_TOKEN: "",
    CONTINUUM_TOKEN_FILE: path.join(stateRoot, "missing-token"),
  };
  const session = "session-1";
  const commandId = "command-1";
  const rawMarker = "never-persist-this-filename";
  const start = invoke(
    "start",
    ["--session", session, "--command-id", commandId, "--cwd", stateRoot],
    { env, input: `npm run test -- --watch ${rawMarker}` },
  );
  assert.equal(start.status, 0, start.stderr);
  const stateFile = path.join(stateRoot, "sessions", `${commandId}.json`);
  assert.equal((await readFile(stateFile, "utf8")).includes(rawMarker), false);

  const complete = invoke(
    "complete",
    ["--session", session, "--command-id", commandId, "--exit-code", "0"],
    { env },
  );
  assert.equal(complete.status, 0, complete.stderr);
  const files = await readdir(path.join(stateRoot, "queue"));
  const event = JSON.parse(await readFile(path.join(stateRoot, "queue", files[0]), "utf8"));
  assert.equal(event.attributes.commandShape, "npm run test");
  assert.equal(event.attributes.exitCode, 0);
  assert.equal(event.attributes.cwd, ".");
  assert.equal(JSON.stringify(event).includes(rawMarker), false);
});

test("secret commands produce an aggregate counter only", async (context) => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "continuum-zsh-secret-test-"));
  context.after(() => rm(stateRoot, { recursive: true, force: true }));
  const env = {
    ...process.env,
    CONTINUUM_ZSH_STATE_DIR: stateRoot,
    CONTINUUM_TOKEN: "",
    CONTINUUM_TOKEN_FILE: path.join(stateRoot, "missing-token"),
  };
  const secret = "sk-proj-never-persist-this-secret";
  const result = invoke(
    "start",
    ["--session", "session-secret", "--command-id", "command-secret", "--cwd", stateRoot],
    { env, input: `tool --api-key ${secret}` },
  );
  assert.equal(result.status, 0, result.stderr);
  const files = await readdir(path.join(stateRoot, "queue"));
  const payload = await readFile(path.join(stateRoot, "queue", files[0]), "utf8");
  const event = JSON.parse(payload);
  assert.equal(event.eventType, "privacy.drop.aggregate");
  assert.equal(event.attributes.rule, "secret-pattern");
  assert.equal(payload.includes(secret), false);
});

test("a retry attempt purges expired terminal events without a token", async (context) => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "continuum-zsh-retry-test-"));
  context.after(() => rm(stateRoot, { recursive: true, force: true }));
  const queueDir = path.join(stateRoot, "queue");
  await mkdir(queueDir);
  const expiredName = `${randomUUID()}.json`;
  await writeFile(path.join(queueDir, expiredName), JSON.stringify({
    occurredAt: new Date(Date.now() - 24 * 60 * 60 * 1_000 - 1_000).toISOString(),
  }));
  const result = invoke("flush", [], {
    env: {
      ...process.env,
      CONTINUUM_ZSH_STATE_DIR: stateRoot,
      CONTINUUM_TOKEN: "",
      CONTINUUM_TOKEN_FILE: path.join(stateRoot, "missing-token"),
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal((await readdir(queueDir)).includes(expiredName), false);
});

test("CONTINUUM_CLI executes the safe terminal start and complete protocol", async (context) => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "continuum-zsh-cli-test-"));
  context.after(() => rm(stateRoot, { recursive: true, force: true }));
  const marker = "cli-raw-command-must-not-persist";
  const result = spawnSync("/bin/zsh", ["-f", "-c", `
    source "$CONTINUUM_TEST_PLUGIN"
    print -rn -- "npm run test -- --watch ${marker}" | _continuum_zsh_invoke start --session cli-session --command-id cli-command --cwd "$CONTINUUM_ZSH_STATE_DIR"
    _continuum_zsh_invoke complete --session cli-session --command-id cli-command --exit-code 0 </dev/null
  `], {
    encoding: "utf8",
    env: {
      ...process.env,
      CONTINUUM_CLI: cliExecutable,
      CONTINUUM_PROJECT_ID: "Build Week / Demo",
      CONTINUUM_TEST_PLUGIN: plugin,
      CONTINUUM_TOKEN: "",
      CONTINUUM_TOKEN_FILE: path.join(stateRoot, "missing-token"),
      CONTINUUM_ZSH_STATE_DIR: stateRoot,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const names = await readdir(path.join(stateRoot, "queue"));
  assert.equal(names.length, 1);
  const payload = await readFile(path.join(stateRoot, "queue", names[0]), "utf8");
  const event = JSON.parse(payload);
  assert.equal(event.projectId, "Build-Week-Demo");
  assert.equal(event.attributes.commandShape, "npm run test");
  assert.equal(payload.includes(marker), false);
});
