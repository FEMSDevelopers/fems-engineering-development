import { buildApp } from "./app.js";
import { config } from "./config.js";
import { createPool, migrate } from "./db.js";

const db = createPool(config.databaseUrl);
const app = await buildApp(db);

// Wait for the database (it may still be starting locally, or in Kubernetes), then migrate.
for (let attempt = 1; ; attempt++) {
  try {
    await db.query("SELECT 1");
    break;
  } catch (e) {
    if (attempt >= 60) throw e;
    if (attempt === 1 || attempt % 10 === 0) app.log.warn(`Waiting for database at ${config.databaseUrl.replace(/:[^:@/]*@/, ":***@")} …`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}
if (config.migrateOnStart) {
  const applied = await migrate(db, (m) => app.log.info(m));
  if (applied.length) app.log.info({ applied }, "migrations applied");
}

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  await app.close();
  await db.end();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ port: config.port, host: config.host });
