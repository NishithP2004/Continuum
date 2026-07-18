#!/usr/bin/env node

import { closeSync, openSync } from "node:fs";
import { spawn } from "node:child_process";

const [entrypoint, logPath] = process.argv.slice(2);
if (!entrypoint || !logPath) {
  process.stderr.write("Usage: node script/launch_daemon.mjs <entrypoint> <log-path>\n");
  process.exit(2);
}

const logFd = openSync(logPath, "a", 0o600);
const child = spawn(process.execPath, [entrypoint], {
  cwd: process.cwd(),
  detached: true,
  env: process.env,
  stdio: ["ignore", logFd, logFd]
});

await new Promise((resolve, reject) => {
  child.once("spawn", resolve);
  child.once("error", reject);
});

closeSync(logFd);
child.unref();
process.stdout.write(`${child.pid}\n`);
