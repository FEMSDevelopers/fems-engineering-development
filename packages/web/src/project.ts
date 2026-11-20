/**
 * Current project of this browser (all tabs follow it). Every /api request names it (x-fpl-project header, added by a
 * fetch hook; a cookie covers direct links), so the server shows that project's content only.
 *
 * Browser storage: settings of shared tools (master parts list views and sorting, naming / PN / assembly-description /
 * sort formats, assembly templates, function libraries, table formatting, UI preferences) are shared by every project;
 * everything else under "fpl." (drafts, open documents, selections, version pointers…) belongs to the project. Switching
 * project packs the current project's keys into "fpl.project.bundle.<id>", unpacks the next project's and reloads.
 */
export interface Project {
  id: string;
  name: string;
  alias: string;
  country: string;
  state: string;
  contractor: string;
  endUser: string;
  iso: string;
  dispatcher: string;
  qse: string;
  kw: number | null;
  kwh: number | null;
  pcsOem: string;
  bessOem: string;
  stage: string;
  activeState: string;
  notes: string;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
export const PROJECT_STAGES = ["Proposal", "30%", "60%", "90%", "IFC", "As-built", "Commissioned"];
export const PROJECT_STATES = ["Active", "On hold", "Closed"];

const CUR_KEY = "fpl.project.current";
const BUNDLE = "fpl.project.bundle.";
/** Keys (prefixes) shared by every project. */
const SHARED = [
  "fpl.project.", "fpl.nav", "fpl.colw.", "fpl.docprev.",
  // master parts list: views, columns, sort, filters, categories
  "fpl.bom.parts", "fpl.bom.catsopen", "fpl.bom.tplcatsopen", "fpl.bom.tempF",
  // naming standards, project PN, assembly descriptions, sort orders (Python syntax) and assembly templates
  "fpl.snap.docnaming", "fpl.bom.namingdraft", "fpl.bom.namingpick", "fpl.snap.pnformat", "fpl.bom.pndraft",
  "fpl.snap.asmdesc", "fpl.bom.descdraft", "fpl.snap.sortformat", "fpl.bom.sortdraft",
  "fpl.snap.bomasm", "fpl.bom.asmdraft", "fpl.bom.tplopen", "fpl.bom.tplview", "fpl.mech.tpl",
  // table formatting and UI preferences
  "fpl.bom.treeCols.", "fpl.bom.compareSpec", "fpl.dataflow.cols", "fpl.diagram.summaryWidth",
  "fpl.mech.zoom.", "fpl.mech.split.", "fpl.mech.unit", "fpl.mech.settings",
  "fpl.bom.units", "fpl.bom.rotStep", "fpl.bom.peTab",
  // data types, function libraries, JSON editor library templates
  "fpl.plb.dtypes", "fpl.json.lib.py", "fpl.json.libdraft", "fpl.json.lib.src", "fpl.json.srcPanel", "fpl.json.condScope", "fpl.json.fbView",
];
export const isSharedKey = (k: string) => !k.startsWith("fpl.") || SHARED.some((p) => k === p || k.startsWith(p));

const read = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
/** Project this page was loaded for (writes of project keys are dropped once another tab switched project). */
export const LOADED_PROJECT = read(CUR_KEY) ?? "";
export const currentProjectId = () => read(CUR_KEY) ?? "";
/** False when another tab has switched project since this page loaded: project keys must not be written any more. */
export const storageWritable = (key: string) => isSharedKey(key) || currentProjectId() === LOADED_PROJECT;

function setCookie(id: string) {
  document.cookie = `fpl_project=${encodeURIComponent(id)}; path=/; SameSite=Lax; max-age=31536000`;
}

/** Adds the project to every same-origin /api request; reloads when another tab switches project. Call once before rendering. */
export async function initProject(): Promise<void> {
  const orig = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const p = currentProjectId();
    if (p && /^(\/api\/|https?:\/\/[^/]+\/api\/)/.test(url) && (url.startsWith("/") || url.startsWith(location.origin))) {
      const h = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      if (!h.has("x-fpl-project")) h.set("x-fpl-project", p);
      return orig(input, { ...init, headers: h });
    }
    return orig(input, init);
  };
  window.addEventListener("storage", (e) => {
    if (e.key === CUR_KEY && (e.newValue ?? "") !== LOADED_PROJECT) location.reload();
  });
  // First start (or after the project was deleted elsewhere): ask the server which project it uses.
  let id = currentProjectId();
  try {
    const r = await orig("/api/projects/current", { headers: id ? { "x-fpl-project": id } : undefined });
    const cur = r.ok ? ((await r.json()) as Project | null) : null;
    if (cur && cur.id !== id) {
      id = cur.id;
      try {
        localStorage.setItem(CUR_KEY, id);
      } catch {
        /* storage blocked: the cookie and header still name the project for this page */
      }
      // Reload once so this page is loaded for that project (only when the choice was stored, so never in a loop).
      if (LOADED_PROJECT !== id && currentProjectId() === id) {
        setCookie(id);
        location.reload();
        return new Promise(() => undefined);
      }
    }
  } catch {
    /* API not reachable yet: keep the stored project */
  }
  if (id) setCookie(id);
}

/** Pack this project's browser keys, unpack the next project's, make it current everywhere and reload. */
export async function switchProject(next: string): Promise<void> {
  const cur = currentProjectId();
  if (next === cur) return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && !isSharedKey(k)) keys.push(k);
    }
    const pack: Record<string, string> = {};
    for (const k of keys) pack[k] = localStorage.getItem(k) ?? "";
    if (cur) localStorage.setItem(BUNDLE + cur, JSON.stringify(pack));
    for (const k of keys) localStorage.removeItem(k);
    const restore = JSON.parse(localStorage.getItem(BUNDLE + next) ?? "{}") as Record<string, string>;
    for (const [k, v] of Object.entries(restore)) localStorage.setItem(k, v);
    localStorage.removeItem(BUNDLE + next);
    localStorage.setItem(CUR_KEY, next);
  } catch {
    localStorage.setItem(CUR_KEY, next);
  }
  setCookie(next);
  await fetch(`/api/projects/${next}/use`, { method: "POST", headers: { "x-fpl-project": next } }).catch(() => undefined);
  location.reload();
}

/** Drop the packed browser keys of a deleted project. */
export function forgetProject(id: string) {
  try {
    localStorage.removeItem(BUNDLE + id);
  } catch {
    /* ignore */
  }
}

/** Short label of a project for the rail: alias, else the name. */
export const projectLabel = (p: Pick<Project, "alias" | "name">) => (p.alias || p.name).trim();
