import { readFile, stat } from "node:fs/promises";
import { EventsBatchSchema, type CheckpointV1, type NormalizedEventV1 } from "@continuum/contracts";
import type { Engine } from "../server/engine.js";

export interface ReplayResult {
  events: NormalizedEventV1[];
  accepted: number;
  dropped: number;
  secret: number;
  checkpoints: CheckpointV1[];
  projectId?: string;
}

export interface ReplayOptions {
  phase?: "all" | "friday" | "monday";
  autoAcknowledgeBaseline?: boolean;
}

export async function replayFixture(engine: Engine, fixturePath: string, options: ReplayOptions = {}): Promise<ReplayResult> {
  const fixtureStat = await stat(fixturePath);
  if (!fixtureStat.isFile() || fixtureStat.size > 5 * 1024 * 1024) throw new Error("fixture_unavailable");
  const content = await readFile(fixturePath, "utf8");
  const allEvents = content.split(/\r?\n/).filter((line) => line.trim() && !line.trimStart().startsWith("#"))
    .map((line) => JSON.parse(line) as NormalizedEventV1);
  const phase = options.phase ?? "all";
  const events = allEvents.filter((event) => {
    if (phase === "all") return true;
    const windowId = typeof event.attributes.windowId === "string" ? event.attributes.windowId : "";
    return windowId.startsWith(phase);
  });
  if (events.length === 0) throw new Error("fixture_phase_empty");
  EventsBatchSchema.parse({ events });
  const groups = new Map<string, NormalizedEventV1[]>();
  for (const event of events) {
    const windowId = typeof event.attributes.windowId === "string" ? event.attributes.windowId : "default";
    const group = groups.get(windowId) ?? [];
    group.push(event);
    groups.set(windowId, group);
  }

  let accepted = 0;
  let dropped = 0;
  let secret = 0;
  const checkpoints: CheckpointV1[] = [];
  let projectId: string | undefined;
  for (const group of groups.values()) {
    const ingestion = await engine.pipeline.ingest({ events: group });
    accepted += ingestion.accepted;
    dropped += ingestion.dropped;
    secret += ingestion.secret;
    projectId ??= group.find((event) => event.privacy.classification !== "secret")?.projectId;
    if (!projectId) continue;
    const created = await engine.pipeline.flush(projectId, "deterministic");
    checkpoints.push(...created);
    if ((options.autoAcknowledgeBaseline ?? true) && group.some((event) => event.eventType === "demo.baseline") && created.at(-1)) {
      engine.database.acknowledge(projectId, created.at(-1)!.id);
    }
  }
  return { events, accepted, dropped, secret, checkpoints, ...(projectId ? { projectId } : {}) };
}
