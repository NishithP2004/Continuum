import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalProjectId, projectIdForPath, repositoryRoot } from "../src/project-identity.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

describe("canonical project identity", () => {
  it("uses the canonical repository root from nested and symlinked paths", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "continuum-project-id-"));
    cleanup.push(parent);
    const repo = path.join(parent, "repo");
    const nested = path.join(repo, "packages", "core");
    const alias = path.join(parent, "repo-alias");
    await mkdir(nested, { recursive: true });
    execFileSync("git", ["init", "-q", repo]);
    await symlink(repo, alias);

    const canonical = await realpath(repo);
    const expected = createHash("sha256").update(canonical).digest("hex").slice(0, 24);
    expect(repositoryRoot(nested)).toBe(canonical);
    expect(projectIdForPath(nested)).toBe(expected);
    expect(projectIdForPath(alias)).toBe(expected);
    expect(canonicalProjectId(repo)).toBe(expected);
  });
});
