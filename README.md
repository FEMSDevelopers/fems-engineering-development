# open dev.cmd and execute the batch file

# Point List Workbench (fractal-pointlist)

Engineering workbench for utility-scale BESS / renewable projects. It keeps a project database of source tables (Modbus TCP, DNP3 and IEC 60870-5-104 point lists, plus any other table), network objects (services, firewalls, VLANs, devices) and data-flow connections between devices. It also conditions table data into JSON and generates customer-facing outputs:

- **Customer point list** (CSV / XLSX)
- **Source → MQTT configs**: one JSON per point-list connection, or one bundle for all of them, with each point conditioned by that source's saved editor rules plus `mqtt_topic`
- **IP schema** (Markdown / CSV / XLSX)

Node.js + TypeScript throughout: React + Vite front end, Fastify API, PostgreSQL.

## Modules (icon rail, top to bottom)



A profile saved from a source becomes that source's conditioning rules. Outputs always apply the **most recently saved profile** for each source to the source's **current** rows, so updating a source flows through without re-saving the profile.

Every version bar has **Cancel changes** (discard unsaved edits and go back to the loaded version); dialogs use about 88 % of the window width (80–95 %).

A user manual (PDF) covering every module is in `docs/Point-List-Workbench-Manual.pdf`.

## Repository layout

```
packages/
  core/     pure TypeScript: conditioning engine, protocol + network validation, output generators (unit-tested)
  server/   Fastify API + PostgreSQL migrations; serves the built web app in production
  web/      React + Vite UI
docker/Dockerfile           multi-stage production image
docker-compose.yml          local PostgreSQL (and optional full stack)
deploy/k8s/                 Kustomize manifests (namespace, Postgres StatefulSet, app Deployment, Service, Ingress, NetworkPolicies)
```

## Run locally on Windows (VS Code)

Everything installs inside this folder. Nothing is installed system-wide, and you don't need admin rights or Docker.

| Path | What it is |
|---|---|
| `.venv\node` | Portable Node.js (version pinned in `.nvmrc`). The download is SHA-256 checked against nodejs.org. |
| `node_modules` | npm packages, installed from `package-lock.json` |
| `.venv\pgdata` | Local PostgreSQL 16 data. The binaries come from the `embedded-postgres` npm package. |

**First time:** double-click **`setup.cmd`**, or in VS Code run *Terminal → Run Task → Setup environment*. It downloads Node, installs packages, creates `.env`, creates and checks the local database, and copies the VS Code config from `tools\vscode` into `.vscode`. Re-running it is safe.

**Every time:**

- Double-click **`dev.cmd`** to start the local database, the API and the web UI with hot reload. Your browser opens at http://localhost:5173. Press Ctrl+C in that window to stop everything.
- Or in VS Code, use *Terminal → Run Build Task* (Ctrl+Shift+B) → **Dev: start all (DB + API + Web)**.

**In VS Code**

- **Terminals** open with the environment active: an `(fpl)` prompt, with the project's Node on PATH. In any other PowerShell window, run `. .\scripts\activate.ps1`; `deactivate` undoes it.
- **Run and Debug (F5) configurations:**
  - *Open UI in Edge/Chrome* starts the stack, then lets you set breakpoints in the React code.
  - *Debug API* runs the database and web UI, plus the API under the debugger, so breakpoints in `packages/server` work.
  - *Debug core unit tests* runs the tests under the debugger.
- **Hot reload:** edits in `packages/web` and `packages/core` show up in the browser immediately. Edits in `packages/server` restart the API automatically.

**Useful commands** (in an `(fpl)` terminal):

| Command | Does |
|---|---|
| `npm run dev` | DB + API + web (same as dev.cmd) |
| `npm test` | core unit tests |
| `npm run typecheck` | type-check all packages |
| `npm run db:local -- stop` | stop a database left running (e.g. after closing a window) |
| `npm run db:local -- reset` | delete all local data and start fresh (asks first) |

**Ports:** UI 5173, API 8080, database 54329. Change them in `.env` (`PORT`, `LOCAL_PG_PORT` and `DATABASE_URL` together).

**Troubleshooting**

- *`http proxy error … ECONNREFUSED` / "API not reachable yet"*: the API is still starting (or restarting after a server-code edit). The web UI waits for the API before it starts, and the browser retries reads automatically, so this clears by itself within a few seconds. If it persists, check the `[api]` lines for the real error.
- *"running scripts is disabled on this system"*: use `setup.cmd` / `dev.cmd`, which bypass the policy for that run only, or the VS Code tasks.
- *Database fails to start, mentioning VCRUNTIME140.dll*: install the Microsoft Visual C++ Redistributable (x64) from https://aka.ms/vs/17/release/vc_redist.x64.exe.
- *Setup can't download Node* (proxy or firewall): install Node 22+ yourself, then run `powershell -ExecutionPolicy Bypass -File scripts\setup.ps1 -UseSystemNode`.
- *`EBUSY` / `EPERM` during install*: this folder is inside OneDrive, which syncs `.venv` and `node_modules` (~500 MB). Pause syncing and re-run setup, or keep the working copy outside OneDrive (e.g. `C:\dev\fractal-pointlist`).
- *Prefer Docker Desktop for the database:* `npm run db:up`, set `DATABASE_URL` to port 5432 in `.env`, then `npm run dev:docker`.

## Production image

```powershell
docker build -f docker/Dockerfile -t registry.example.com/engineering/fractal-pointlist:0.1.0 .
docker push registry.example.com/engineering/fractal-pointlist:0.1.0
```

The build stage runs `npm ci`, builds all packages, and **runs the unit tests**, so a failing test fails the image build. The runtime stage is `node:22-bookworm-slim` running as the non-root `node` user. To try the full stack locally: `docker compose up -d --build`, then open http://localhost:8080.

## Kubernetes

1. Create the database secret (don't commit real values; see `deploy/k8s/secret.example.yaml`):
   ```bash
   kubectl create namespace fractal-pointlist
   kubectl -n fractal-pointlist create secret generic fpl-db \
     --from-literal=POSTGRES_PASSWORD='<strong password>' \
     --from-literal=DATABASE_URL='postgres://fpl:<strong password>@fpl-postgres:5432/fpl'
   ```
2. Set your image registry/tag in `deploy/k8s/kustomization.yaml`, and the hostname / TLS secret / ingress class in `deploy/k8s/ingress.yaml`.
3. Apply:
   ```bash
   kubectl apply -k deploy/k8s
   ```

What it deploys:

- **App:** a 2-replica Deployment with a read-only root filesystem, all capabilities dropped, and non-root user. Probes: `/healthz` (liveness) and `/readyz` (database reachability).
- **Migrations:** run on start behind a Postgres advisory lock, so rolling multiple replicas is safe.
- **PostgreSQL:** a single-instance StatefulSet with a 10 Gi PVC. To use managed or HA Postgres instead, point `DATABASE_URL` at it and remove `postgres.yaml` from the kustomization.
- **NetworkPolicies:** default-deny ingress. Only the ingress controller (namespace `ingress-nginx`; adjust to your cluster) reaches the app, and only the app reaches Postgres.

### Security notes

- **No authentication yet.** The app has no sign-in, by design for this phase. Keep the Ingress on an internal/VPN-only hostname, or add auth at the ingress (basic auth or oauth2-proxy with Entra ID) before wider exposure.
- **Possible BCSI.** Point lists, VLAN/IP schemas and device data for BES Cyber Systems may be BES Cyber System Information under NERC CIP-011. Apply your information-protection program (access control, storage location, backups, disposal) to the database, its backups, and exported files.
- **Dependencies:** `npm audit` is clean as of this version. `uuid` is pinned to ≥ 11.1.1 through `overrides`, because exceljs's own pin is affected by GHSA-w5hq-g745-h8pq.

## Configuration (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `postgres://fpl:fpl_dev_password@localhost:5432/fpl` | PostgreSQL connection |
| `PORT` / `HOST` | `8080` / `0.0.0.0` | Listen address |
| `LOG_LEVEL` | `info` | Fastify/pino log level |
| `BODY_LIMIT` | `52428800` | Max request/upload size (bytes) for large tables |
| `MIGRATE_ON_START` | `true` | Run migrations when the server starts |
| `PG_POOL_MAX` | `10` | Postgres pool size per replica |
| `WEB_DIST` | `packages/web/dist` | Built web app to serve |
| `DOC_SCAN` | `on` (`off` when `NODE_ENV=production`) | Parts → 🗃️ folder scan: reads folders on the server's machine |
| `DOC_SCAN_ROOTS` | *(none)* | Folders that may be scanned (`;`-separated; also `:` outside Windows); empty = any absolute folder |

## Projects in the database

Migration `026_projects` makes content per project without changing the routes' SQL: each per-project table `<t>` was renamed `<t>_all` with an `app_project_id` column, and a view `<t>` (`WITH CHECK OPTION`) shows and accepts the current project's rows only; version tables of per-project items are filtered through their parent view. The current project is the session setting `fpl.project`, set on every pooled connection from the request (`x-fpl-project` header sent by the web app, else the `fpl_project` cookie, else `?project=`, else the most recently used project). A write to another project's item is refused (409). **Future migrations** must alter the `<t>_all` tables (not the views) and then run `SELECT fpl_project_views();` to rebuild the views; data changes in migrations must target `<t>_all` (no project is set while migrating, so the views are empty).

## API (summary)

`/api/projects` (GET, POST, PATCH `/:id`, DELETE `/:id` `{ confirmName }`, POST `/:id/use`, GET `/:id/counts`, GET `/current`) · `/api/sources` (CRUD; `/validation`) · `/api/profiles` and `/api/rulesets` (CRUD; `/:id/versions/:major/:minor` GET/PUT/PATCH/DELETE) · `/api/services`, `/api/firewalls`, `/api/vlans`, `/api/devices`, `/api/categories`, `/api/connections` (CRUD; `/import`; `/reorder` except connections) · `/api/presets?scope=` (GET; PUT upsert by scope+name; DELETE `/:id`) · `/api/protocols` (CRUD; delete refused while in use) · `/api/diagrams`, `/api/pl-inputs`, `/api/pl-builds`, `/api/unit-sets`, `/api/datatype-sets`, `/api/json-sources`, `/api/json-selections` (no longer used by the UI), `/api/json-conds` (versioned; PATCH `{ instanceId }` attaches / detaches), `/api/py-libs`, `/api/json-instances` (versioned; PATCH also moves an instance: `{ folderId }`) · `/api/folders` (departments and folders: GET, POST, PATCH name/parentId/options, `/reorder`, DELETE `?instances=move|delete`) · `/api/parts` (CRUD; `POST /import` `{ rows, mode: skip|update }`; `POST /delete` `{ ids }`; `POST /bulk-update` `{ items: [{ id, patch }] }` (one transaction); `/:id/docs` GET, POST multipart file or JSON link) · `/api/part-docs/:id` (PATCH, DELETE; `/file[?inline=1]`) · `/api/part-subcats` (CRUD; `/reorder`) · `/api/part-views?ids=` · `/api/parts/:id/views/:view` (PUT svg / image, DELETE) · `POST /api/parts/:id/views/import` (multipart .stp/.step → six views + x/y/z, .dxf / .svg → one view; fields `view`, `up`, `front`, `dims`, `keep`) · `/api/bom-assemblies` (versioned; PATCH kind / code / folder) · `/api/asm-folders` (template library folders: GET, POST `{ path }`, PATCH `{ from, to }` renames / moves with contents, DELETE `{ path }` moves contents to the parent) · `/api/bom-projects` (versioned; PATCH version `{ meta, dataSet }` e.g. stage) · `/api/doc-namings`, `/api/pn-formats`, `/api/asm-descs`, `/api/mech-racks`, `/api/mech-fnes` (versioned) · `POST /api/parts/scrape` `{ url }` (public http(s) only → page text + schema.org Product + PDF links, or PDF bytes) · `PATCH /api/part-docs/:id` also `{ prefix, suffix, fileName }` · `POST /api/bom/xlsx` `{ fileName, sheets: [{ name, title?, grid, groupRows? }] }` · `POST /api/bom/docs-zip` `{ partIds, name, kinds?, naming?, subs?, aliases? }` · `/api/network/validation` · `/api/outputs/pointlist?format=json|csv|xlsx` · `/api/outputs/configs?connectionId=&format=json|file` · `/api/outputs/ipschema?format=json|md|csv|xlsx` · `POST /api/parse-file` (multipart .xlsx/.csv) · `/healthz` · `/readyz`
"# fems-engineering-development" 
"# fems-engineering-development" 
#   f e m s - e n g i n e e r i n g - d e v e l o p m e n t 
 
 # fems-engineering-development
