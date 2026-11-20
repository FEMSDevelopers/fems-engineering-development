import { AsyncLocalStorage } from "node:async_hooks";
import pg from "pg";
import { MIGRATIONS } from "./migrations.js";

export type Db = pg.Pool;

/**
 * Current project of the request being served (set by the onRequest hook in app.ts). Every pooled connection gets it as
 * the session setting fpl.project before it is used, so the per-project views (migration 026) show that project only.
 * Outside a request (migrations, startup) no project is set and the per-project views are empty.
 */
export const projectCtx = new AsyncLocalStorage<{ project: string }>();
export const currentProject = () => projectCtx.getStore()?.project ?? "";

type Tagged = pg.PoolClient & { __fplProject?: string };
export function createPool(url: string): Db {
  const pool = new pg.Pool({ connectionString: url, max: Number(process.env.PG_POOL_MAX ?? 10) });
  // pool.query() and transactions both go through connect(): set the project on the connection when it differs.
  const connect = pool.connect.bind(pool) as () => Promise<pg.PoolClient>;
  const tagged = async (): Promise<pg.PoolClient> => {
    const want = currentProject();
    const c = (await connect()) as Tagged;
    if (c.__fplProject !== want) {
      try {
        await c.query("SELECT set_config('fpl.project', $1, false)", [want]);
        c.__fplProject = want;
      } catch (e) {
        c.release(e as Error);
        throw e;
      }
    }
    return c;
  };
  (pool as unknown as { connect: unknown }).connect = (cb?: (err: Error | undefined, client?: pg.PoolClient, done?: (e?: Error) => void) => void) => {
    const p = tagged();
    if (!cb) return p;
    p.then((c) => cb(undefined, c, (e?: Error) => c.release(e)), (e) => cb(e as Error));
    return undefined;
  };
  return pool;
}

/** Apply pending migrations. Uses an advisory lock so concurrent replicas don't race. */
export async function migrate(db: Db, log: (m: string) => void = console.log): Promise<string[]> {
  const client = await db.connect();
  const applied: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock(727001)");
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Set((await client.query<{ id: string }>("SELECT id FROM schema_migrations")).rows.map((r) => r.id));
    for (const m of MIGRATIONS) {
      if (done.has(m.id)) continue;
      log(`Applying migration ${m.id}`);
      await client.query("BEGIN");
      try {
        await client.query(m.sql);
        await client.query("INSERT INTO schema_migrations(id) VALUES ($1)", [m.id]);
        await client.query("COMMIT");
        applied.push(m.id);
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(727001)").catch(() => {});
    client.release();
  }
  return applied;
}
