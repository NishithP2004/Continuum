import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";

const migrationDirectory = fileURLToPath(new URL("../../migrations/", import.meta.url));

export async function runMigrations(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('continuum-cloud-migrations'))");
    await client.query(`
      CREATE TABLE IF NOT EXISTS continuum_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const appliedRows = await client.query<{ name: string }>("SELECT name FROM continuum_migrations");
    const applied = new Set(appliedRows.rows.map((row) => row.name));
    const names = (await readdir(migrationDirectory)).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
    for (const name of names) {
      if (applied.has(name)) continue;
      const sql = await readFile(new URL(`../../migrations/${name}`, import.meta.url), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO continuum_migrations(name) VALUES ($1)", [name]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('continuum-cloud-migrations'))").catch(() => undefined);
    client.release();
  }
}
