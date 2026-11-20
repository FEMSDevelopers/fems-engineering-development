/**
 * Local PostgreSQL for development, no Docker or admin rights needed.
 * Binaries come from the `embedded-postgres` npm package; data lives in .venv/pgdata.
 *
 *   npm run db:local          start (Ctrl+C stops it)
 *   npm run db:local -- stop  stop a server left running (e.g. after a crash)
 *   npm run db:local -- reset delete all local data (asks first)
 *   npm run db:local -- check create the database if needed and verify it starts
 */
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import readline from "node:readline/promises";

const root = path.resolve(import.meta.dirname, "..");
const dataDir = path.join(root, ".venv", "pgdata");
const port = Number(process.env.LOCAL_PG_PORT ?? 54329);
const user = "fpl";
const password = "fpl_dev_password";
const database = "fpl";
const cmd = process.argv[2] ?? "start";
/** UTF-8 regardless of the Windows code page (the default would be WIN1252, which can't store e.g. "→", "≥" or "Ω"). */
const initdbFlags = ["--encoding=UTF8", "--no-locale"];
/** Written once the database is known to be UTF-8, so the check runs only once. */
const utf8Marker = path.join(dataDir, ".fpl-utf8");

const log = (m: string) => console.log(`[db] ${m}`);
/** Last Postgres log lines, printed if startup fails (the library's own error is often empty). */
const recent: string[] = [];
const keep = (m: unknown) => {
  for (const l of String(m).split(/\r?\n/)) if (l.trim()) recent.push(l.trim());
  while (recent.length > 15) recent.shift();
};

function portOpen(p: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ port: p, host: "127.0.0.1" });
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => resolve(false));
  });
}

async function pgCtl(): Promise<string> {
  const pkg = `@embedded-postgres/${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
  const mod = (await import(pkg)) as { pg_ctl: string };
  return mod.pg_ctl;
}

async function stop() {
  if (!fs.existsSync(path.join(dataDir, "postmaster.pid"))) return log("Not running.");
  execFileSync(await pgCtl(), ["stop", "-D", dataDir, "-m", "fast"], { stdio: "inherit" });
  log("Stopped.");
}

async function start() {
  if (await portOpen(port)) {
    log(`Port ${port} is already in use; assuming the local database is already running.`);
    log(`If it isn't, stop whatever uses port ${port} or set LOCAL_PG_PORT in .env.`);
    return;
  }
  // A crash can leave a stale lock file behind; Postgres refuses to start with it present.
  const pid = path.join(dataDir, "postmaster.pid");
  if (fs.existsSync(pid)) {
    log("Removing stale postmaster.pid from a previous run.");
    fs.rmSync(pid);
  }
  const fresh = !fs.existsSync(path.join(dataDir, "PG_VERSION"));
  if (!fresh && !fs.existsSync(utf8Marker)) await ensureUtf8();
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user,
    password,
    port,
    persistent: true,
    initdbFlags,
    onLog: keep,
    onError: keep,
  });
  if (fresh) {
    log(`Creating local database cluster in ${path.relative(root, dataDir)} …`);
    await pg.initialise();
  }
  await pg.start();
  if (fresh) {
    await pg.createDatabase(database);
    fs.writeFileSync(utf8Marker, "UTF8\n");
  }
  log(`Local PostgreSQL ready on localhost:${port} (database "${database}", user "${user}").`);

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    log("Stopping …");
    await pg.stop().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGHUP", shutdown);
  setInterval(() => {}, 1 << 30); // keep the process alive
}

/** Used by setup: create the cluster if needed, start it once, then stop. Proves the binaries run on this PC. */
async function check() {
  if (await portOpen(port)) return log(`Something is already listening on port ${port}; skipping the check.`);
  const fresh = !fs.existsSync(path.join(dataDir, "PG_VERSION"));
  if (!fresh && !fs.existsSync(utf8Marker)) await ensureUtf8();
  const pg = new EmbeddedPostgres({ databaseDir: dataDir, user, password, port, persistent: true, initdbFlags, onLog: keep, onError: keep });
  if (fresh) {
    log(`Creating local database cluster in ${path.relative(root, dataDir)} …`);
    await pg.initialise();
  }
  await pg.start();
  if (fresh) {
    await pg.createDatabase(database);
    fs.writeFileSync(utf8Marker, "UTF8\n");
  }
  await pg.stop();
  log("Local PostgreSQL works.");
}

const qi = (s: string) => `"${s.replace(/"/g, '""')}"`;

/**
 * Clusters created before this fix use the Windows code page (WIN1252), so text such as "→" cannot be stored.
 * Converts the "fpl" database once: renames it to fpl_<encoding> (kept as a backup), creates a UTF-8 "fpl",
 * applies the application's migrations and copies every table. Runs on a temporary port so the API can't connect meanwhile.
 */
async function ensureUtf8() {
  const tmpPort = port + 1;
  if (await portOpen(tmpPort)) throw new Error(`Port ${tmpPort} is in use; it is needed once to convert the local database to UTF-8.`);
  const pg0 = new EmbeddedPostgres({ databaseDir: dataDir, user, password, port: tmpPort, persistent: true, onLog: keep, onError: keep });
  const pid = path.join(dataDir, "postmaster.pid");
  if (fs.existsSync(pid)) fs.rmSync(pid);
  await pg0.start();
  try {
    const url = (db: string) => `postgres://${user}:${encodeURIComponent(password)}@localhost:${tmpPort}/${db}`;
    const admin = new pg.Client({ connectionString: url("postgres") });
    await admin.connect();
    const encOf = async (db: string) =>
      (await admin.query<{ e: string }>("SELECT pg_encoding_to_char(encoding) AS e FROM pg_database WHERE datname = $1", [db])).rows[0]?.e ?? null;
    const enc = await encOf(database);
    if (!enc || enc === "UTF8") {
      await admin.end();
      fs.writeFileSync(utf8Marker, "UTF8\n");
      return;
    }
    let backup = `${database}_${enc.toLowerCase()}`;
    if (await encOf(backup)) backup += `_${Date.now()}`;
    const staging = `${database}_utf8_staging`;
    log(`Database "${database}" uses ${enc}, which can't store characters such as "→". Converting it to UTF-8 once; the original is kept as "${backup}".`);
    // Build the UTF-8 copy under a staging name; the original is only renamed once the copy succeeded.
    await admin.query(`DROP DATABASE IF EXISTS ${qi(staging)}`);
    await admin.query(`CREATE DATABASE ${qi(staging)} OWNER ${qi(user)} ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0`);

    // Same schema as the API creates, then the data.
    const { createPool, migrate } = await import("../packages/server/src/db.ts");
    const dst = createPool(url(staging));
    await migrate(dst, (m: string) => log(m));
    const src = new pg.Client({ connectionString: url(database) });
    await src.connect();
    await src.query("SET client_encoding TO 'UTF8'");
    const tablesOf = async (c: { query: pg.Client["query"] }) =>
      (await c.query<{ t: string }>("SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'")).rows.map((r) => r.t);
    const have = new Set(await tablesOf(dst));
    const tables = (await tablesOf(src)).filter((t) => have.has(t));
    const c = await dst.connect();
    let total = 0;
    try {
      await c.query("BEGIN");
      // Rows are copied table by table; foreign-key triggers are off for this transaction only.
      await c.query("SET LOCAL session_replication_role = replica");
      if (tables.length) await c.query(`TRUNCATE ${tables.map(qi).join(", ")}`);
      for (const t of tables) {
        const rows = (await src.query<{ j: unknown[] }>(`SELECT coalesce(json_agg(x), '[]'::json) AS j FROM ${qi(t)} x`)).rows[0].j;
        for (let i = 0; i < rows.length; i += 200)
          await c.query(`INSERT INTO ${qi(t)} SELECT * FROM json_populate_recordset(NULL::${qi(t)}, $1::json)`, [JSON.stringify(rows.slice(i, i + 200))]);
        total += rows.length;
      }
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      c.release();
      await src.end();
      await dst.end();
    }
    await admin.query(`ALTER DATABASE ${qi(database)} RENAME TO ${qi(backup)}`);
    await admin.query(`ALTER DATABASE ${qi(staging)} RENAME TO ${qi(database)}`);
    await admin.end();
    fs.writeFileSync(utf8Marker, "UTF8\n");
    log(`Converted ${tables.length} tables (${total} rows) to UTF-8. When everything looks right you can drop the backup with: DROP DATABASE ${backup};`);
  } finally {
    await pg0.stop().catch(() => {});
  }
}

async function reset() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = await rl.question(`Delete ALL local data in ${dataDir}? Type "yes" to confirm: `);
  rl.close();
  if (a.trim() !== "yes") return log("Cancelled.");
  await stop().catch(() => {});
  fs.rmSync(dataDir, { recursive: true, force: true });
  log("Local data deleted. The next start creates a fresh database.");
}

const run = { start, stop, reset, check }[cmd as "start"];
if (!run) {
  console.error(`Unknown command "${cmd}". Use start, stop, check or reset.`);
  process.exit(1);
}
run().catch((e) => {
  console.error("[db] Failed:", e?.message ?? (e === undefined ? "PostgreSQL did not start" : e));
  if (recent.length) console.error("[db] PostgreSQL said:\n  " + recent.join("\n  "));
  if (process.platform === "win32") console.error("[db] On Windows, a missing VCRUNTIME140.dll means the Microsoft Visual C++ Redistributable (x64) must be installed.");
  process.exit(1);
});
