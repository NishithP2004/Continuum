import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatMcpConfig } from "../src/cli/mcp-config.js";
import { loadRuntimeConfig, resolveDatabasePath, resolveToken } from "../src/runtime.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "continuum-runtime-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("runtime credentials", () => {
  it("replaces a weak stored token and hardens its permissions", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "auth.token");
    await writeFile(path, "weak\n", { mode: 0o644 });

    const token = await resolveToken(path);

    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect((await readFile(path, "utf8")).trim()).toBe(token);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("preserves a valid stored token while correcting its permissions", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "auth.token");
    const expected = "a".repeat(64);
    await writeFile(path, `${expected}\n`, { mode: 0o644 });

    expect(await resolveToken(path)).toBe(expected);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("uses the same explicit token file as the native credential loader", async () => {
    const directory = await temporaryDirectory();
    const tokenPath = join(directory, "shared.token");
    const expected = "b".repeat(64);
    await writeFile(tokenPath, `${expected}\n`, { mode: 0o600 });

    const config = await loadRuntimeConfig(
      { dataDir: join(directory, "data") },
      { CONTINUUM_TOKEN_FILE: tokenPath }
    );

    expect(config.tokenPath).toBe(tokenPath);
    expect(config.token).toBe(expected);
  });

  it("rejects a weak environment override instead of running with it", async () => {
    const directory = await temporaryDirectory();
    await expect(loadRuntimeConfig(
      { dataDir: directory },
      { CONTINUUM_AUTH_TOKEN: "short", CONTINUUM_TOKEN: "c".repeat(64) }
    )).rejects.toThrow(/32 to 4,096/);
  });

  it("rejects a split-brain port that the native app and Chrome cannot use", async () => {
    const directory = await temporaryDirectory();
    await expect(loadRuntimeConfig(
      { dataDir: directory },
      { CONTINUUM_PORT: "43118" }
    )).rejects.toThrow(/fixed port 43117/);
  });
});

describe("local database resolution", () => {
  it("uses CONTINUUM_DB before CONTINUUM_DATA_DIR and otherwise uses the data directory", async () => {
    const directory = await temporaryDirectory();
    const explicit = join(directory, "explicit.sqlite");
    const dataDirectory = join(directory, "data");

    expect(resolveDatabasePath({ CONTINUUM_DB: explicit, CONTINUUM_DATA_DIR: dataDirectory })).toBe(explicit);
    expect(resolveDatabasePath({ CONTINUUM_DATA_DIR: dataDirectory })).toBe(join(dataDirectory, "continuum.sqlite"));

    const config = await loadRuntimeConfig({ dataDir: dataDirectory }, { CONTINUUM_DB: explicit });
    expect(config.databasePath).toBe(explicit);
  });

  it("prints a project-scoped MCP config pinned to the resolved read-only database", async () => {
    const directory = await temporaryDirectory();
    const databasePath = join(directory, "Continuum Data", "continuum.sqlite");
    const config = formatMcpConfig(directory, databasePath);

    expect(config).toContain(`command = ${JSON.stringify(join(directory, "script/run_mcp.sh"))}`);
    expect(config).toContain(`cwd = ${JSON.stringify(directory)}`);
    expect(config).toContain(`env = { CONTINUUM_DB = ${JSON.stringify(databasePath)} }`);
  });
});
