import type { Project } from "./project";
import type { NamingStandard, Part, PartDoc, PartView, Subcategory, ViewName } from "@fpl/core";
import type { Connection, Device, DeviceCategory, Firewall, Grid, Issue, ProtocolDef, ProtocolMap, RowIssues, Service, Vlan } from "@fpl/core";

export interface SourceMeta {
  id: string;
  name: string;
  kind: string;
  headers: string[];
  rowCount: number;
  protocolMap: ProtocolMap;
  createdAt: string;
  updatedAt: string;
}
export interface SourceFull extends SourceMeta {
  rows: string[][];
}

export interface VersionSummary {
  major: number;
  minor: number;
  stamp: string;
  savedAt: string;
  notes: string;
  updateNotes: string;
  meta: Record<string, unknown>;
}
export interface Versioned {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  versions: VersionSummary[];
}
export interface Profile extends Versioned {
  sourceId: string | null;
  sourceName: string | null;
  sourceCols: string[] | null;
}
export type RuleSet = Versioned;
export interface VersionFull<T> extends VersionSummary {
  data: T;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const send = () =>
    fetch(url, {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  let r = await send();
  // 502/503/504 while the API is starting or restarting: reads retry for up to ~15 s (writes are never repeated).
  for (let i = 0; method === "GET" && [502, 503, 504].includes(r.status) && i < 15; i++) {
    await sleep(1000);
    r = await send();
  }
  if (r.status === 204) return undefined as T;
  const text = await r.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!r.ok) throw new ApiError(r.status, data?.error ?? r.statusText);
  return data as T;
}

export type VersionedStore = ReturnType<typeof versioned<Versioned, unknown>>;

function versioned<P extends Versioned, D>(base: string) {
  return {
    list: () => req<P[]>("GET", base),
    get: (id: string) => req<P>("GET", `${base}/${id}`),
    create: (body: Partial<P> & { name: string }) => req<P>("POST", base, body),
    rename: (id: string, name: string) => req("PATCH", `${base}/${id}`, { name }),
    remove: (id: string) => req("DELETE", `${base}/${id}`),
    getVersion: (id: string, major: number, minor: number) => req<VersionFull<D>>("GET", `${base}/${id}/versions/${major}/${minor}`),
    saveVersion: (id: string, major: number, minor: number, body: { stamp: string; data: D; meta?: Record<string, unknown> }) =>
      req<{ created: boolean; savedAt: string }>("PUT", `${base}/${id}/versions/${major}/${minor}`, body),
    notes: (id: string, major: number, minor: number, body: { notes?: string; updateNotes?: string; meta?: Record<string, unknown>; dataSet?: Record<string, unknown> }) =>
      req("PATCH", `${base}/${id}/versions/${major}/${minor}`, body),
    removeVersion: (id: string, major: number, minor: number) => req("DELETE", `${base}/${id}/versions/${major}/${minor}`),
  };
}

function crud<T extends { id: string }>(base: string) {
  return {
    list: () => req<T[]>("GET", base),
    create: (body: Partial<T> = {}) => req<T>("POST", base, body),
    update: (id: string, body: Partial<T>) => req<T>("PATCH", `${base}/${id}`, body),
    remove: (id: string) => req("DELETE", `${base}/${id}`),
    import: (rows: Partial<T>[]) => req<T[]>("POST", `${base}/import`, { rows }),
    /** Sets sort = position for these rows (siblings). */
    reorder: (ids: string[]) => req("POST", `${base}/reorder`, { ids }),
  };
}

export interface Preset<D = unknown> {
  id: string;
  name: string;
  data: D;
  updatedAt: string;
}

/** Department (parentId null) or folder; shared by the whole app. */
export interface AppFolder {
  id: string;
  parentId: string | null;
  name: string;
  sort: number;
  options: { color?: string; description?: string; code?: string };
  /** Instances directly in this folder. */
  instances: number;
  createdAt: string;
  updatedAt: string;
}
export interface InstanceItem extends Versioned {
  folderId: string | null;
}
/** Saved conditioning set; instanceId = the JSON editor instance it belongs to (null = library template). */
export interface CondItem extends Versioned {
  instanceId: string | null;
}

/** Assembly template variant (kind and code are columns of the variant). */
export interface AsmItem extends Versioned {
  kind: string;
  code: string;
  /** Template library folder ("A/B"; "" = root). */
  folder: string;
}
export interface XlsxSheet {
  name: string;
  title?: string;
  grid: string[][];
  groupRows?: number[];
}

/** POST that returns a file: downloads it in the browser. */
async function download(url: string, body: unknown, fallback: string) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) {
    const t = await r.text();
    let msg = r.statusText;
    try {
      msg = JSON.parse(t).error ?? msg;
    } catch {
      /* not JSON */
    }
    throw new ApiError(r.status, msg);
  }
  const cd = r.headers.get("content-disposition") ?? "";
  const m = cd.match(/filename\*=UTF-8''([^;]+)/) ?? cd.match(/filename="([^"]+)"/);
  const name = m ? decodeURIComponent(m[1]) : fallback;
  const blob = await r.blob();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

export interface DocScanReq {
  dirs: string[];
  exts: string[];
  prefixes: { prefix: string; contains?: string; kind: string }[];
  words: { word: string; kind: string }[];
  partIds?: string[];
  mode: "add" | "overwrite";
  useSku: boolean;
}
export interface DocScanItem {
  path: string; dir: string; rel: string; name: string; size: number; mtime: string;
  partId: string; manufacturer: string; partNumber: string; codes: string[]; prefix: string; kind: string;
  /** How the kind was found: "prefix", "word" or "" (Other). */
  by: "prefix" | "contains" | "word" | "";
  /** add = new file; replace = same file name, overwritten; exists = same file name, kept; identical = same content already stored; dup = another (newer) copy in the folders is listed. */
  action: "add" | "replace" | "exists" | "identical" | "dup" | "too-big";
  docId: string | null; docKind: string | null;
}
export interface DocScanRes {
  scanned: number; matched: number; unmatched: number; truncated: boolean;
  /** Files of the chosen types whose name holds no part number of the chosen parts (first 1000). */
  unmatchedFiles: string[];
  dirs: { dir: string; ok: boolean; files: number; error?: string }[];
  items: DocScanItem[];
}

/** STEP model the 2D views were drawn from: STEP name, the file uploaded (.stp or .zip), its .txt, orientation. */
export interface CadInfo {
  fileName: string;
  sourceName: string;
  txtName: string | null;
  txt: string | null;
  up: string;
  front: string;
  stored: boolean;
}

export const api = {
  /** Projects (shared): every other /api route works on the current project (x-fpl-project header, see project.ts). */
  projects: {
    list: () => req<Project[]>("GET", "/api/projects"),
    create: (b: Partial<Project> & { name: string }) => req<Project>("POST", "/api/projects", b),
    update: (id: string, b: Partial<Project>) => req<Project>("PATCH", `/api/projects/${id}`, b),
    remove: (id: string, confirmName: string) => req("DELETE", `/api/projects/${id}`, { confirmName }),
    counts: (id: string) => req<Record<string, number>>("GET", `/api/projects/${id}/counts`),
  },
  parts: {
    list: () => req<Part[]>("GET", "/api/parts"),
    create: (body: Partial<Part>) => req<Part>("POST", "/api/parts", body),
    update: (id: string, body: Partial<Part>) => req<Part>("PATCH", `/api/parts/${id}`, body),
    remove: (id: string) => req("DELETE", `/api/parts/${id}`),
    removeMany: (ids: string[]) => req<{ deleted: number }>("POST", "/api/parts/delete", { ids }),
    /** Partial updates of several parts in one transaction; returns the updated parts. */
    bulkUpdate: (items: { id: string; patch: Partial<Part> }[]) => req<{ updated: number; parts: Part[] }>("POST", "/api/parts/bulk-update", { items }),
    import: (rows: Partial<Part>[], mode: "skip" | "update") => req<{ created: number; updated: number; skipped: number }>("POST", "/api/parts/import", { rows, mode }),
    docs: (id: string) => req<PartDoc[]>("GET", `/api/parts/${id}/docs`),
    /** Document kinds per part (no file data). */
    docKinds: (ids?: string[]) => req<{ id: string; partId: string; kind: string; active: boolean; title: string; fileName: string; mime: string; url: string }[]>("GET", `/api/part-docs/kinds${ids ? `?ids=${ids.join(",")}` : ""}`),
    /** Parts → 🗃️ folder scan (server side; folders on the server's machine). */
    docScanStatus: () => req<{ enabled: boolean; roots: string[]; platform: string }>("GET", "/api/parts/doc-scan"),
    docScan: (body: DocScanReq) => req<DocScanRes>("POST", "/api/parts/doc-scan", body),
    docScanApply: (body: { dirs: string[]; exts: string[]; items: { path: string; partId: string; kind: string; title?: string; replaceDocId?: string | null }[] }) =>
      req<{ added: number; replaced: number; errors: { path: string; error: string }[] }>("POST", "/api/parts/doc-scan/apply", body),
    /** Read an OEM page or datasheet link (server side): page text, or the PDF bytes (base64) to read in the browser. */
    scrape: (url: string) => req<{ kind: "html"; url: string; title: string; text: string; product: Record<string, string>; pdfLinks: string[] } | { kind: "pdf"; url: string; pdf: string }>("POST", "/api/parts/scrape", { url }),
    addLink: (id: string, body: { kind: string; title: string; url: string; ref?: string; certName?: string; approvalId?: string }) => req<PartDoc>("POST", `/api/parts/${id}/docs`, body),
    async upload(id: string, file: File, kind: string, title: string, ref = ""): Promise<PartDoc> {
      const fd = new FormData();
      fd.append("kind", kind);
      fd.append("title", title);
      fd.append("ref", ref);
      fd.append("file", file);
      const r = await fetch(`/api/parts/${id}/docs`, { method: "POST", body: fd });
      const data = await r.json();
      if (!r.ok) throw new ApiError(r.status, data?.error ?? "Upload failed");
      return data;
    },
    /** Move a document to the part's manufacturer + product series. */
    docToSeries: (docId: string) => req<PartDoc>("POST", `/api/part-docs/${docId}/to-series`),
    seriesDocs: (mfr: string, series: string) => req<PartDoc[]>("GET", `/api/series-docs?mfr=${encodeURIComponent(mfr)}&series=${encodeURIComponent(series)}`),
    seriesAddLink: (mfr: string, series: string, body: { kind: string; title: string; url: string; ref?: string; certName?: string; approvalId?: string }) => req<PartDoc>("POST", "/api/series-docs", { mfr, series, ...body }),
    async seriesUpload(mfr: string, series: string, file: File, kind: string, title: string, ref = ""): Promise<PartDoc> {
      const fd = new FormData();
      fd.append("mfr", mfr);
      fd.append("series", series);
      fd.append("kind", kind);
      fd.append("title", title);
      fd.append("ref", ref);
      fd.append("file", file);
      const r = await fetch("/api/series-docs", { method: "POST", body: fd });
      const data = await r.json();
      if (!r.ok) throw new ApiError(r.status, data?.error ?? "Upload failed");
      return data;
    },
    /** Rename a manufacturer's product series: its parts, product-series documents and STEP orientations follow. */
    seriesRename: (mfr: string, from: string, to: string) => req<{ parts: Part[]; docs: number; orients: number }>("POST", "/api/series/rename", { mfr, from, to }),
    certTypeRename: (from: string, to: string) => req<{ updated: number }>("POST", "/api/part-docs/cert-type-rename", { from, to }),
    certTypeCounts: () => req<Record<string, number>>("GET", "/api/part-docs/cert-type-counts"),
    updateDoc: (docId: string, body: { kind?: string; title?: string; url?: string; ref?: string; prefix?: string; suffix?: string; fileName?: string; active?: boolean; year?: number | null; approvalId?: string; certName?: string }) => req("PATCH", `/api/part-docs/${docId}`, body),
    /** Zip of documents of a part / product series under the names given (folders allowed; links as .url files), with an index (INDEX.html, INDEX.xlsx). */
    docsZipOf: (name: string, entries: { id: string; path: string }[], title?: string) => download("/api/part-docs/zip", { name, entries, title, index: true }, `${name}.zip`),
    removeDoc: (docId: string) => req("DELETE", `/api/part-docs/${docId}`),
    docUrl: (docId: string, inline = false) => `/api/part-docs/${docId}/file${inline ? "?inline=1" : ""}`,
  },
  views: {
    list: (partIds: string[]) => (partIds.length ? req<PartView[]>("GET", `/api/part-views?ids=${partIds.join(",")}`) : Promise.resolve([] as PartView[])),
    put: (partId: string, view: ViewName, body: { kind: "svg" | "image"; content: string; wMm: number | null; hMm: number | null; source: string }) => req("PUT", `/api/parts/${partId}/views/${view}`, body),
    remove: (partId: string, view: ViewName) => req("DELETE", `/api/parts/${partId}/views/${view}`),
    /** STEP model the views were drawn from (name, orientation), or null. */
    cad: (partId: string) => req<CadInfo | null>("GET", `/api/parts/${partId}/views/cad`),
    /** Rotate 90° as seen from the front view (z± about the viewing axis, x± about the horizontal axis) and re-draw all views. */
    rotate: (partId: string, body: { rot?: "z+" | "z-" | "x+" | "x-" | "y+" | "y-"; reset?: boolean; orient?: { up: string; front: string }; times?: 1 | 2; dims: boolean }) =>
      req<{ up: string; front: string; dims: { x: number; y: number; z: number }; notes: string[] }>("POST", `/api/parts/${partId}/views/rotate`, body),
    /** STEP (all views, optional x/y/z), DXF or SVG (one view). */
    async import(partId: string, file: File, f: { view?: ViewName; up?: string; front?: string; dims?: boolean; keep?: boolean }): Promise<{ views: ViewName[]; dims: { x: number; y: number; z: number } | null; notes: string[] }> {
      const fd = new FormData();
      if (f.view) fd.append("view", f.view);
      if (f.up) fd.append("up", f.up);
      if (f.front) fd.append("front", f.front);
      fd.append("dims", f.dims ? "1" : "0");
      fd.append("keep", f.keep ? "1" : "0");
      fd.append("file", file);
      const r = await fetch(`/api/parts/${partId}/views/import`, { method: "POST", body: fd });
      const data = await r.json();
      if (!r.ok) throw new ApiError(r.status, data?.error ?? "Import failed");
      return data;
    },
  },
  subcats: {
    list: () => req<Subcategory[]>("GET", "/api/part-subcats"),
    create: (body: Partial<Subcategory>) => req<Subcategory>("POST", "/api/part-subcats", body),
    update: (id: string, body: Partial<Subcategory>) => req<Subcategory>("PATCH", `/api/part-subcats/${id}`, body),
    remove: (id: string) => req("DELETE", `/api/part-subcats/${id}`),
    reorder: (ids: string[]) => req("POST", "/api/part-subcats/reorder", { ids }),
  },
  bomAssemblies: {
    ...versioned<AsmItem, unknown>("/api/bom-assemblies"),
    setMeta: (id: string, body: { kind?: string; code?: string; name?: string; folder?: string }) => req("PATCH", `/api/bom-assemblies/${id}`, body),
  },
  asmFolders: {
    list: () => req<string[]>("GET", "/api/asm-folders"),
    create: (path: string) => req("POST", "/api/asm-folders", { path }),
    move: (from: string, to: string) => req("PATCH", "/api/asm-folders", { from, to }),
    remove: (path: string) => req("DELETE", "/api/asm-folders", { path }),
  },
  bomProjects: versioned<Versioned, unknown>("/api/bom-projects"),
  docNamings: versioned<Versioned, unknown>("/api/doc-namings"),
  pnFormats: versioned<Versioned, unknown>("/api/pn-formats"),
  asmDescs: versioned<Versioned, unknown>("/api/asm-descs"),
  sortFormats: versioned<Versioned, unknown>("/api/sort-formats"),
  mechRacks: versioned<Versioned, unknown>("/api/mech-racks"),
  mechFnes: versioned<Versioned, unknown>("/api/mech-fnes"),
  bomFiles: {
    xlsx: (fileName: string, sheets: XlsxSheet[]) => download("/api/bom/xlsx", { fileName, sheets }, `${fileName}.xlsx`),
    docsZip: (partIds: string[], name: string, kinds?: string[], naming?: NamingStandard | null, subs?: Record<string, string>, aliases?: Record<string, string>,
      more: {
        wrap?: Record<string, { before?: string; after?: string }>; lines?: Record<string, string>; units?: { name: string; partIds: string[]; lines?: Record<string, string> }[];
        byLine?: { item: string; unit: string; partId: string; before?: string; after?: string }[]; docOrder?: string;
      } = {}) =>
      download("/api/bom/docs-zip", { partIds, name, kinds, naming, subs, aliases, ...more }, `${name}.zip`),
  },
  folders: {
    list: () => req<AppFolder[]>("GET", "/api/folders"),
    create: (body: { name: string; parentId?: string | null; options?: AppFolder["options"] }) => req<AppFolder>("POST", "/api/folders", body),
    update: (id: string, body: { name?: string; parentId?: string | null; options?: AppFolder["options"] }) => req<AppFolder>("PATCH", `/api/folders/${id}`, body),
    reorder: (ids: string[]) => req("POST", "/api/folders/reorder", { ids }),
    /** Refused (409) when the subtree holds instances, unless they are moved to the parent or deleted. */
    remove: (id: string, instances?: "move" | "delete") => req("DELETE", `/api/folders/${id}${instances ? `?instances=${instances}` : ""}`),
  },
  jsonInstances: {
    ...versioned<InstanceItem, unknown>("/api/json-instances"),
    move: (id: string, folderId: string | null) => req("PATCH", `/api/json-instances/${id}`, { folderId }),
  },
  sources: {
    list: () => req<SourceMeta[]>("GET", "/api/sources"),
    get: (id: string) => req<SourceFull>("GET", `/api/sources/${id}`),
    create: (body: { name: string; kind: string; grid: Grid }) => req<SourceMeta>("POST", "/api/sources", body),
    update: (id: string, body: { name?: string; kind?: string; protocolMap?: ProtocolMap; grid?: Grid }) => req<SourceMeta>("PATCH", `/api/sources/${id}`, body),
    remove: (id: string) => req("DELETE", `/api/sources/${id}`),
    validation: (id: string) => req<Issue[]>("GET", `/api/sources/${id}/validation`),
  },
  profiles: versioned<Profile, unknown>("/api/profiles"),
  rulesets: versioned<RuleSet, unknown>("/api/rulesets"),
  diagrams: versioned<Versioned, unknown>("/api/diagrams"),
  dataflowSnapshots: versioned<Versioned, unknown>("/api/dataflow-snapshots"),
  networkSnapshots: versioned<Versioned, unknown>("/api/network-snapshots"),
  plInputs: versioned<Versioned, unknown>("/api/pl-inputs"),
  plBuilds: versioned<Versioned, unknown>("/api/pl-builds"),
  unitSets: versioned<Versioned, unknown>("/api/unit-sets"),
  dtypeSets: versioned<Versioned, unknown>("/api/datatype-sets"),
  jsonSources: versioned<Versioned, unknown>("/api/json-sources"),
  jsonSelections: versioned<Versioned, unknown>("/api/json-selections"),
  jsonConds: {
    ...versioned<CondItem, unknown>("/api/json-conds"),
    /** Attach to an instance (or null: library template). */
    setInstance: (id: string, instanceId: string | null) => req("PATCH", `/api/json-conds/${id}`, { instanceId }),
  },
  pyLibs: versioned<Versioned, unknown>("/api/py-libs"),
  restoreNetwork: (data: { services: Service[]; firewalls: Firewall[]; vlans: Vlan[]; devices: Device[]; categories?: DeviceCategory[] }) =>
    req<{ ok: true; removed: Record<string, number> }>("POST", "/api/network/restore", data),
  restoreConnections: (connections: Connection[]) =>
    req<{ ok: true; restored: number; removed: number; cleared: number }>("POST", "/api/connections/restore", { connections }),
  connections: crud<Connection>("/api/connections"),
  protocols: {
    list: () => req<ProtocolDef[]>("GET", "/api/protocols"),
    create: (body: Partial<ProtocolDef> & { name: string }) => req<ProtocolDef>("POST", "/api/protocols", body),
    update: (id: string, body: Partial<ProtocolDef>) => req<ProtocolDef>("PATCH", `/api/protocols/${id}`, body),
    remove: (id: string) => req("DELETE", `/api/protocols/${id}`),
  },
  services: crud<Service>("/api/services"),
  firewalls: crud<Firewall>("/api/firewalls"),
  vlans: crud<Vlan>("/api/vlans"),
  devices: crud<Device>("/api/devices"),
  categories: crud<DeviceCategory>("/api/categories"),
  presets: {
    list: <D>(scope: string) => req<Preset<D>[]>("GET", `/api/presets?scope=${encodeURIComponent(scope)}`),
    save: <D>(scope: string, name: string, data: D) => req<{ id: string }>("PUT", "/api/presets", { scope, name, data }),
    remove: (id: string) => req("DELETE", `/api/presets/${id}`),
  },
  netValidation: () => req<{ vlans: RowIssues; devices: RowIssues; connections: RowIssues }>("GET", "/api/network/validation"),
  outputs: {
    pointlist: () => req<{ grid: Grid; notes: string[] }>("GET", "/api/outputs/pointlist"),
    configs: (connectionId?: string) => req<{ text: string; notes: string[] }>("GET", `/api/outputs/configs${connectionId ? `?connectionId=${connectionId}` : ""}`),
    ipschema: () => req<{ sections: { service: Service | null; firewall: Firewall | null; vlan: Vlan | null; mask: string; devices: (Device & { protocols: string })[] }[]; grid: Grid; markdown: string }>("GET", "/api/outputs/ipschema"),
  },
  async parseFile(file: File): Promise<{ name: string; grid: Grid }[]> {
    const fd = new FormData();
    fd.append("file", file);
    const r = await fetch("/api/parse-file", { method: "POST", body: fd });
    const data = await r.json();
    if (!r.ok) throw new ApiError(r.status, data?.error ?? "Upload failed");
    return data.sheets;
  },
};

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
