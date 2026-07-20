import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appleBridgeClient } from "../src/providers/apple.js";

const cleanup: string[] = [];
let activeClient: ReturnType<typeof appleBridgeClient> | undefined;

afterEach(async () => {
  await activeClient?.close();
  activeClient = undefined;
  await Promise.all(cleanup.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

async function stubBridge(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "continuum-apple-bridge-"));
  cleanup.push(directory);
  const executable = path.join(directory, "bridge.mjs");
  await writeFile(executable, `#!${process.execPath}
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  const request = JSON.parse(line);
  if (request.op === "chat") {
    process.stdout.write(JSON.stringify({ id: request.id, type: "delta", text: "started" }) + "\\n");
    await new Promise(() => {});
  }
  process.stdout.write(JSON.stringify({ id: request.id, type: "result", payload: { available: true } }) + "\\n");
}
`, { mode: 0o700 });
  await chmod(executable, 0o700);
  return executable;
}

function within<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`operation exceeded ${milliseconds}ms`)), milliseconds);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

describe("Apple Foundation Models bridge cancellation", () => {
  it("terminates a cancelled helper and serves the next request from a clean process", async () => {
    const executable = await stubBridge();
    const client = appleBridgeClient(executable);
    activeClient = client;
    const controller = new AbortController();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const running = client.request("chat", { input: "wait" }, controller.signal, (delta) => {
      if (delta === "started") markStarted();
    });
    const outcome = running.then(
      () => undefined,
      (error: unknown) => error
    );

    await within(started, 1_500);
    const cancellationStarted = Date.now();
    controller.abort();
    const error = await within(outcome, 1_500);
    expect(error).toMatchObject({ name: "AbortError" });
    expect(Date.now() - cancellationStarted).toBeLessThan(1_500);

    const health = await within(
      client.request("health", {}, AbortSignal.timeout(1_500)) as Promise<{ available?: boolean }>,
      1_750
    );
    expect(health).toEqual({ available: true });
    await client.close();
    activeClient = undefined;
  });
});
