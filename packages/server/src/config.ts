import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const config = {
  databaseUrl: process.env.DATABASE_URL ?? "postgres://fpl:fpl_dev_password@localhost:5432/fpl",
  port: Number(process.env.PORT ?? 8080),
  host: process.env.HOST ?? "0.0.0.0",
  logLevel: process.env.LOG_LEVEL ?? "info",
  bodyLimit: Number(process.env.BODY_LIMIT ?? 50 * 1024 * 1024),
  /** Built web app (packages/web/dist). Served at / when present. */
  webDist: process.env.WEB_DIST ?? path.resolve(here, "../../web/dist"),
  /** Run migrations on startup (disable when a separate Job runs them). */
  migrateOnStart: (process.env.MIGRATE_ON_START ?? "true") !== "false",
  /**
   * Parts → 🗃️ document folder scan reads folders on the server's machine. On by default except in
   * production (DOC_SCAN=on|off overrides). DOC_SCAN_ROOTS (separated by ";", or also ":" outside Windows) limits the folders that may be scanned.
   */
  docScan: (process.env.DOC_SCAN ?? (process.env.NODE_ENV === "production" ? "off" : "on")).toLowerCase() !== "off",
  docScanRoots: (process.env.DOC_SCAN_ROOTS ?? "").split(process.platform === "win32" ? /;/ : /[;:]/).map((s) => s.trim()).filter(Boolean),
};
