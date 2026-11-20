import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import fs from "node:fs";
import { ZodError } from "zod";
import { config } from "./config.js";
import type { Db } from "./db.js";
import { fileRoutes } from "./routes/files.js";
import { networkRoutes } from "./routes/network.js";
import { outputRoutes } from "./routes/outputs.js";
import { sourceRoutes } from "./routes/sources.js";
import { versionedRoutes } from "./routes/versioned.js";
import { folderRoutes } from "./routes/folders.js";
import { bomRoutes } from "./routes/bom.js";
import { scrapeRoutes } from "./routes/scrape.js";
import { docScanRoutes } from "./routes/docscan.js";
import { viewRoutes } from "./routes/views.js";
import { projectRoutes } from "./routes/projects.js";

export async function buildApp(db: Db, opts: { logger?: boolean | object } = {}) {
  const app = Fastify({ logger: opts.logger ?? { level: config.logLevel }, bodyLimit: config.bodyLimit });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: "Invalid request", issues: err.issues });
    // A row of another project (per-project views, migration 026: WITH CHECK OPTION).
    if ((err as { code?: string }).code === "44000") return reply.code(409).send({ error: "This item belongs to another project" });
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) req.log.error(err);
    return reply.code(status).send({ error: status >= 500 ? "Internal error" : (err as Error).message });
  });

  await app.register(multipart, { limits: { fileSize: config.bodyLimit, files: 1 } });

  app.get("/healthz", async () => ({ ok: true }));
  app.get("/readyz", async (_req, reply) => {
    try {
      await db.query("SELECT 1");
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });

  // First: resolves the current project of every /api request (per-project views, migration 026).
  projectRoutes(app, db);
  sourceRoutes(app, db);
  versionedRoutes(app, db, {
    base: "/api/profiles",
    parent: "profiles",
    child: "profile_versions",
    fk: "profile_id",
    extra: [
      { api: "sourceId", col: "source_id" },
      { api: "sourceName", col: "source_name" },
      { api: "sourceCols", col: "source_cols", json: true },
    ],
  });
  versionedRoutes(app, db, { base: "/api/rulesets", parent: "rule_sets", child: "rule_set_versions", fk: "rule_set_id" });
  versionedRoutes(app, db, { base: "/api/diagrams", parent: "diagrams", child: "diagram_versions", fk: "diagram_id" });
  versionedRoutes(app, db, { base: "/api/dataflow-snapshots", parent: "dataflow_snapshots", child: "dataflow_snapshot_versions", fk: "snapshot_id" });
  versionedRoutes(app, db, { base: "/api/network-snapshots", parent: "network_snapshots", child: "network_snapshot_versions", fk: "snapshot_id" });
  versionedRoutes(app, db, { base: "/api/pl-inputs", parent: "pl_inputs", child: "pl_input_versions", fk: "input_id" });
  versionedRoutes(app, db, { base: "/api/pl-builds", parent: "pl_builds", child: "pl_build_versions", fk: "build_id" });
  versionedRoutes(app, db, { base: "/api/unit-sets", parent: "unit_sets", child: "unit_set_versions", fk: "set_id" });
  versionedRoutes(app, db, { base: "/api/datatype-sets", parent: "datatype_sets", child: "datatype_set_versions", fk: "set_id" });
  versionedRoutes(app, db, { base: "/api/json-sources", parent: "json_sources", child: "json_source_versions", fk: "source_id" });
  versionedRoutes(app, db, { base: "/api/json-selections", parent: "json_selections", child: "json_selection_versions", fk: "selection_id" });
  versionedRoutes(app, db, {
    base: "/api/json-conds", parent: "json_conds", child: "json_cond_versions", fk: "cond_id",
    extra: [{ api: "instanceId", col: "instance_id" }],
  });
  versionedRoutes(app, db, { base: "/api/py-libs", parent: "py_libs", child: "py_lib_versions", fk: "lib_id" });
  versionedRoutes(app, db, {
    base: "/api/json-instances", parent: "json_instances", child: "json_instance_versions", fk: "instance_id",
    extra: [{ api: "folderId", col: "folder_id" }],
  });
  folderRoutes(app, db);
  // Parts & BOM: assembly templates and project BOMs are saved as major.minor versions.
  versionedRoutes(app, db, {
    base: "/api/bom-assemblies", parent: "bom_assemblies", child: "bom_assembly_versions", fk: "assembly_id",
    extra: [{ api: "kind", col: "kind", def: "OTHER" }, { api: "code", col: "code", def: "" }, { api: "folder", col: "folder", def: "" }],
  });
  versionedRoutes(app, db, { base: "/api/bom-projects", parent: "bom_projects", child: "bom_project_versions", fk: "project_id" });
  versionedRoutes(app, db, { base: "/api/pn-formats", parent: "pn_formats", child: "pn_format_versions", fk: "format_id" });
  versionedRoutes(app, db, { base: "/api/sort-formats", parent: "sort_formats", child: "sort_format_versions", fk: "format_id" });
  versionedRoutes(app, db, { base: "/api/asm-descs", parent: "asm_desc_formats", child: "asm_desc_format_versions", fk: "format_id" });
  versionedRoutes(app, db, { base: "/api/doc-namings", parent: "doc_namings", child: "doc_naming_versions", fk: "naming_id" });
  versionedRoutes(app, db, { base: "/api/mech-racks", parent: "mech_racks", child: "mech_rack_versions", fk: "layout_id" });
  versionedRoutes(app, db, { base: "/api/mech-fnes", parent: "mech_fnes", child: "mech_fne_versions", fk: "layout_id" });
  bomRoutes(app, db);
  scrapeRoutes(app);
  docScanRoutes(app, db);
  viewRoutes(app, db);
  networkRoutes(app, db);
  outputRoutes(app, db);
  fileRoutes(app);

  // Web app (production build). In development Vite serves it and proxies /api.
  if (fs.existsSync(config.webDist)) {
    await app.register(fastifyStatic, { root: config.webDist });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === "GET" && !req.url.startsWith("/api/")) return reply.sendFile("index.html");
      return reply.code(404).send({ error: "Not found" });
    });
  }
  return app;
}
