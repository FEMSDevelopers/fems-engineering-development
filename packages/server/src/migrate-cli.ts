import { config } from "./config.js";
import { createPool, migrate } from "./db.js";

const db = createPool(config.databaseUrl);
migrate(db)
  .then((applied) => {
    console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Database is up to date");
    return db.end();
  })
  .catch(async (e) => {
    console.error(e);
    await db.end();
    process.exit(1);
  });
