import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import type { CheckpointV1, NormalizedEventV2, SyncOperationV1 } from "@continuum/contracts";
import { ContinuumDatabase } from "../src/db/database.js";
import { repositoryIdentity, repositoryRoot } from "../src/project-identity.js";
import { createEngine } from "../src/server/engine.js";
import { testConfig } from "./helpers.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

describe("global clone identity", () => {
  it("maps clones at different device paths to one global project UUID", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "continuum-clone-id-"));
    cleanup.push(parent);
    const seed = path.join(parent, "seed", "continuum-project");
    const cloneA = path.join(parent, "device-a", "continuum-project");
    const cloneB = path.join(parent, "device-b", "continuum-project");
    await mkdir(seed, { recursive: true });
    execFileSync("git", ["init", "-q", seed]);
    execFileSync("git", ["-C", seed, "config", "user.email", "continuum@example.invalid"]);
    execFileSync("git", ["-C", seed, "config", "user.name", "Continuum Test"]);
    await writeFile(path.join(seed, "README.md"), "live context\n");
    execFileSync("git", ["-C", seed, "add", "README.md"]);
    execFileSync("git", ["-C", seed, "commit", "-q", "-m", "Initial"]);
    await mkdir(path.dirname(cloneA), { recursive: true });
    await mkdir(path.dirname(cloneB), { recursive: true });
    execFileSync("git", ["clone", "-q", seed, cloneA]);
    execFileSync("git", ["clone", "-q", seed, cloneB]);

    const left = repositoryIdentity(cloneA);
    const right = repositoryIdentity(cloneB);
    expect(left.repositoryFingerprint).toBe(right.repositoryFingerprint);
    expect(left.localAlias).not.toBe(right.localAlias);
    expect(left.normalizedName).toBe("continuum-project");

    const config = await testConfig();
    cleanup.push(config.dataDir);
    const database = new ContinuumDatabase(config.databasePath);
    try {
      const first = database.resolveProjectIdentity(
        left.localAlias,
        left.normalizedName,
        left.repositoryFingerprint,
        "device-a"
      );
      const second = database.resolveProjectIdentity(
        right.localAlias,
        right.normalizedName.toUpperCase(),
        right.repositoryFingerprint,
        "device-b"
      );
      expect(first.status).toBe("created");
      expect(second.status).toBe("resolved");
      expect(second.matchedBy).toBe("repository_fingerprint");
      expect(second.projectId).toBe(first.projectId);
      expect(first.projectId).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      database.close();
    }
  });

  it("reports conflicting explicit mappings and creates a separate project instead of auto-merging", async () => {
    process.env.CONTINUUM_DISABLE_EMBEDDINGS = "1";
    const config = await testConfig();
    cleanup.push(config.dataDir);
    const engine = await createEngine(config);
    const database = engine.database;
    const fingerprint = "a".repeat(64);
    const firstGlobalId = "584ef784-24cf-46db-aa48-3ff513998dc8";
    const secondGlobalId = "e690636a-5007-46ab-a094-34f106f1185b";
    try {
      database.resolveProjectIdentity(firstGlobalId, "Continuum Project", fingerprint, "device-a");
      database.resolveProjectIdentity(secondGlobalId, "continuum-project", fingerprint, "device-b");

      const match = database.inspectProjectIdentityMatch(
        "c".repeat(64),
        "CONTINUUM PROJECT",
        fingerprint,
        "device-c"
      );
      expect(match.status).toBe("ambiguous");
      if (match.status !== "ambiguous") throw new Error("expected ambiguous identity match");
      expect(match.candidateProjectIds).toEqual([firstGlobalId, secondGlobalId].sort());

      const eventId = crypto.randomUUID();
      const ingest = await engine.pipeline.ingest({ events: [{
        version: "2",
        id: eventId,
        deviceId: "device-c",
        occurredAt: new Date().toISOString(),
        hlc: `${Date.now()}:0:device-c`,
        source: "git",
        eventType: "commit.created",
        projectLocator: { localAlias: "c".repeat(64), repositoryFingerprint: fingerprint },
        title: "Created commit",
        attributes: { projectName: "CONTINUUM PROJECT", sha: "d".repeat(40), branch: "main", files: [] },
        privacy: { classification: "public", rules: ["repository-hook-metadata"] },
        relevance: { decision: "keep", reason: "repository-hook-metadata" },
        confidence: 1,
        policyVersion: 1,
        syncEligibility: "cloud_eligible"
      }] });
      expect(ingest.identityConflicts).toHaveLength(1);
      const resolution = ingest.identityConflicts[0]!;
      expect(resolution.conflictId).toMatch(/^[0-9a-f-]{36}$/i);
      expect(resolution.eventId).toBe(eventId);
      expect(resolution.assignedProjectId).not.toBe(firstGlobalId);
      expect(resolution.assignedProjectId).not.toBe(secondGlobalId);
      expect(resolution.candidateProjectIds).toEqual([firstGlobalId, secondGlobalId].sort());
      expect(database.raw.prepare("SELECT sync_eligibility FROM events WHERE id = ?").get(eventId))
        .toMatchObject({ sync_eligibility: "local_only" });
      expect(database.pendingSyncOperations().some((operation) => operation.entityType === "event" && operation.entityId === eventId)).toBe(false);

      const pending = database.listProjectIdentityConflicts();
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({
        id: resolution.conflictId,
        status: "pending",
        assignedProjectId: resolution.assignedProjectId,
        candidates: [
          { projectId: firstGlobalId, label: "continuum-project" },
          { projectId: secondGlobalId, label: "continuum-project" }
        ]
      });

      const confirmation = database.confirmProjectIdentityConflict(resolution.conflictId!, firstGlobalId);
      expect(confirmation.status).toBe("confirmed");
      expect(database.listProjectIdentityConflicts()).toEqual([]);
      expect(database.listProjectIdentityConflicts("confirmed")[0]).toMatchObject({
        id: resolution.conflictId,
        status: "confirmed",
        confirmedProjectId: firstGlobalId
      });
      expect(database.inspectProjectIdentityMatch("c".repeat(64), "Continuum Project", fingerprint, "device-c"))
        .toMatchObject({ status: "resolved", projectId: firstGlobalId, matchedBy: "local_alias" });

      // Immutable history retains its original project provenance. Reads
      // resolve the mutable redirect to the user-confirmed target.
      const stored = database.raw.prepare("SELECT project_id FROM events WHERE id = ?").get(eventId) as { project_id: string };
      expect(stored.project_id).toBe(resolution.assignedProjectId);
      expect(database.raw.prepare("SELECT redirect_to_project_id FROM projects WHERE id = ?").get(resolution.assignedProjectId))
        .toMatchObject({ redirect_to_project_id: firstGlobalId });
      expect(database.recentEvents(firstGlobalId).map((item) => item.id)).toContain(eventId);
      const redirect = database.pendingSyncOperations().find((operation) => operation.entityType === "project"
        && (operation.payload as { redirectFrom?: string }).redirectFrom === resolution.assignedProjectId);
      expect(redirect).toMatchObject({ entityId: resolution.assignedProjectId, tombstone: false });
      expect(database.pendingSyncOperations().some((operation) => operation.tombstone
        && JSON.stringify(operation).includes(resolution.assignedProjectId))).toBe(false);
    } finally {
      engine.close();
      delete process.env.CONTINUUM_DISABLE_EMBEDDINGS;
    }
  });

  it("synchronizes repository identity so a clone on another device converges on the global UUID", async () => {
    const firstConfig = await testConfig();
    const secondConfig = await testConfig();
    cleanup.push(firstConfig.dataDir, secondConfig.dataDir);
    const first = new ContinuumDatabase(firstConfig.databasePath);
    const second = new ContinuumDatabase(secondConfig.databasePath);
    const fingerprint = "9".repeat(64);
    try {
      const created = first.resolveProjectIdentity("a".repeat(64), "Continuum", fingerprint, "device-first");
      const projectOperation = first.pendingSyncOperations().find((operation) => operation.entityType === "project");
      expect(projectOperation).toBeTruthy();
      second.applySyncOperations([projectOperation!]);

      const clone = second.resolveProjectIdentity("b".repeat(64), "CONTINUUM", fingerprint, "device-second");
      expect(clone).toMatchObject({ status: "resolved", matchedBy: "repository_fingerprint", projectId: created.projectId });
    } finally {
      first.close();
      second.close();
    }
  });

  it("converges two devices through a project redirect without rewriting immutable history", async () => {
    const firstConfig = await testConfig();
    const secondConfig = await testConfig();
    cleanup.push(firstConfig.dataDir, secondConfig.dataDir);
    const first = new ContinuumDatabase(firstConfig.databasePath);
    const second = new ContinuumDatabase(secondConfig.databasePath);
    const fingerprint = "7".repeat(64);
    const targetProjectId = crypto.randomUUID();
    const alternateProjectId = crypto.randomUUID();
    try {
      first.resolveProjectIdentity(targetProjectId, "Continuum", fingerprint, "device-target-a");
      first.resolveProjectIdentity(alternateProjectId, "Continuum", fingerprint, "device-target-b");
      const ambiguous = first.resolveProjectIdentity("f".repeat(64), "Continuum", fingerprint, "device-provisional");
      expect(ambiguous.status).toBe("ambiguous");

      const occurredAt = new Date().toISOString();
      const sourceEvent: NormalizedEventV2 = {
        version: "2",
        id: crypto.randomUUID(),
        deviceId: first.deviceId(),
        occurredAt,
        hlc: `${Date.now()}:0:${first.deviceId()}`,
        source: "git",
        eventType: "commit.created",
        projectId: ambiguous.projectId,
        title: "Committed canonical redirect support",
        attributes: { sha: "a".repeat(40), branch: "main", files: ["src/identity.ts"] },
        privacy: { classification: "public", rules: ["test-live-sync"] },
        relevance: { decision: "keep", reason: "test-live-sync" },
        confidence: 1,
        policyVersion: 1,
        syncEligibility: "cloud_eligible"
      };
      expect(first.insertEvent(sourceEvent)).toBe(true);
      const windowId = first.createWindow(ambiguous.projectId, [sourceEvent], "ollama", "test-model", true);
      const sourceCheckpoint: CheckpointV1 = {
        version: "1",
        id: crypto.randomUUID(),
        projectId: ambiguous.projectId,
        deviceId: first.deviceId(),
        windowId,
        eventIds: [sourceEvent.id],
        goal: "Converge project identity",
        focus: "Canonical redirects",
        summary: "Preserved provisional context",
        progress: [{ text: "Implemented redirects", eventIds: [sourceEvent.id] }],
        blockers: [], hypotheses: [], decisions: [], questions: [], entities: [],
        importance: 0.8,
        confidence: 1,
        provider: "ollama",
        model: "test-model",
        createdAt: occurredAt
      };
      first.insertCheckpoint(sourceCheckpoint);

      const beforeConfirmation = first.pendingSyncOperations().filter((operation) =>
        operation.entityType === "project" || operation.entityType === "event" || operation.entityType === "checkpoint");
      second.applySyncOperations(beforeConfirmation);

      const confirmed = first.confirmProjectIdentityConflict(ambiguous.conflictId!, targetProjectId);
      expect(confirmed.status).toBe("confirmed");
      const redirect = first.pendingSyncOperations().find((operation) => operation.entityType === "project"
        && (operation.payload as { redirectFrom?: string }).redirectFrom === ambiguous.projectId)!;
      second.applySyncOperations([redirect]);

      expect(second.raw.prepare("SELECT project_id FROM events WHERE id = ?").get(sourceEvent.id))
        .toMatchObject({ project_id: ambiguous.projectId });
      expect(second.raw.prepare("SELECT project_id FROM checkpoints WHERE id = ?").get(sourceCheckpoint.id))
        .toMatchObject({ project_id: ambiguous.projectId });
      expect(second.listCheckpoints(targetProjectId).map((checkpoint) => checkpoint.id)).toContain(sourceCheckpoint.id);
      expect(second.listCheckpoints(targetProjectId)[0]?.projectId).toBe(targetProjectId);
      expect(second.recentEvents(targetProjectId).map((item) => item.id)).toContain(sourceEvent.id);

      const replay = (operation: SyncOperationV1, sequence: number): SyncOperationV1 => ({
        ...operation,
        id: crypto.randomUUID(),
        sequence,
        hlc: `${Date.now()}:${sequence}:${operation.deviceId}`
      });
      const immutable = beforeConfirmation.filter((operation) => operation.entityType === "event" || operation.entityType === "checkpoint");
      expect(() => second.applySyncOperations(immutable.map((operation, index) => replay(operation, 10_000 + index)))).not.toThrow();
      expect(second.listCheckpoints(targetProjectId).filter((checkpoint) => checkpoint.id === sourceCheckpoint.id)).toHaveLength(1);
    } finally {
      first.close();
      second.close();
    }
  });

  it("resolves V2 events from separate clone aliases to the same project through ingestion", async () => {
    process.env.CONTINUUM_DISABLE_EMBEDDINGS = "1";
    const config = await testConfig();
    cleanup.push(config.dataDir);
    const engine = await createEngine(config);
    const fingerprint = "b".repeat(64);
    const makeEvent = (deviceId: string, localAlias: string) => ({
      version: "2" as const,
      id: crypto.randomUUID(),
      deviceId,
      occurredAt: new Date().toISOString(),
      hlc: `${Date.now()}:0:${deviceId}`,
      source: "git" as const,
      eventType: "commit.created",
      projectLocator: { localAlias, repositoryFingerprint: fingerprint },
      title: "Created commit",
      attributes: {
        projectName: "Continuum Project",
        sha: "c".repeat(40),
        branch: "main",
        files: ["src/identity.ts"],
        operation: "commit"
      },
      privacy: { classification: "public" as const, rules: ["repository-hook-metadata"] },
      relevance: { decision: "keep" as const, reason: "repository-hook-metadata" },
      confidence: 1,
      dedupeKey: crypto.randomUUID(),
      policyVersion: 1,
      syncEligibility: "local_only" as const
    });
    try {
      const first = await engine.pipeline.ingest({ events: [makeEvent("device-clone-a", "d".repeat(64))] });
      const second = await engine.pipeline.ingest({ events: [makeEvent("device-clone-b", "e".repeat(64))] });
      expect(first.projectIds).toHaveLength(1);
      expect(second.projectIds).toEqual(first.projectIds);
      const rows = engine.database.raw.prepare("SELECT DISTINCT project_id FROM events").all() as Array<{ project_id: string }>;
      expect(rows.map((row) => row.project_id)).toEqual(first.projectIds);
    } finally {
      engine.close();
      delete process.env.CONTINUUM_DISABLE_EMBEDDINGS;
    }
  });
});

describe("device-local project aliases", () => {
  it("uses one local alias for nested and symlinked paths without exposing it as a global project ID", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "continuum-project-id-"));
    cleanup.push(parent);
    const repo = path.join(parent, "repo");
    const nested = path.join(repo, "packages", "core");
    const alias = path.join(parent, "repo-alias");
    await mkdir(nested, { recursive: true });
    execFileSync("git", ["init", "-q", repo]);
    await symlink(repo, alias);

    const canonical = await realpath(repo);
    expect(repositoryRoot(nested)).toBe(canonical);
    const nestedIdentity = repositoryIdentity(nested);
    const aliasIdentity = repositoryIdentity(alias);
    expect(nestedIdentity.localAlias).toBe(aliasIdentity.localAlias);
    expect(nestedIdentity.localAlias).toMatch(/^[a-f0-9]{64}$/);
  });
});
