#!/usr/bin/env node
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

function canonicalPath(input) {
  const resolved = path.resolve(input);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

const input = canonicalPath(process.argv[2] ?? process.cwd());
const git = spawnSync("git", ["-C", input, "rev-parse", "--show-toplevel"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "ignore"],
  timeout: 2_000,
});
const root = canonicalPath(git.status === 0 ? git.stdout.trim() : input);
process.stdout.write(`${createHash("sha256").update(root).digest("hex").slice(0, 24)}\n`);
