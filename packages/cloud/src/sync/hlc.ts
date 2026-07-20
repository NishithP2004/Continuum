import { HlcSchema } from "../contracts.js";

export interface HlcParts {
  physical: bigint;
  logical: bigint;
  node: string;
}

export function parseHlc(value: string): HlcParts {
  HlcSchema.parse(value);
  const [physical, logical, ...nodeParts] = value.split(":");
  const node = nodeParts.join(":");
  return { physical: BigInt(physical!), logical: BigInt(logical!), node: node! };
}

export function compareHlc(left: string, right: string): number {
  const a = parseHlc(left);
  const b = parseHlc(right);
  if (a.physical !== b.physical) return a.physical < b.physical ? -1 : 1;
  if (a.logical !== b.logical) return a.logical < b.logical ? -1 : 1;
  return a.node.localeCompare(b.node);
}

export function nextHlc(node: string, previous?: string, now = Date.now()): string {
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(node)) throw new Error("HLC node must be 6-64 URL-safe characters");
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("HLC wall time must be a non-negative safe integer");
  const prior = previous ? parseHlc(previous) : undefined;
  const wallTime = BigInt(now);
  const physical = prior && prior.physical > wallTime ? prior.physical : wallTime;
  const logical = prior && physical === prior.physical ? prior.logical + 1n : 0n;
  if (logical > 999_999n) throw new Error("HLC logical counter exhausted");
  return `${physical}:${logical}:${node}`;
}
