import {
  autoTags, cloneNode, partColLabel, DOC_CODES, findNode, fullTagsOf, groupNode, insertNode, itemNumbers, moveNode, nodeIdentity, nodeRole, parseTag, partNode, partWatts,
  removeNode, shiftNode, signed, tagIssues, tagPrefixOf, tagsIn, updateNode, walk,
  type AsmTemplate, type DeviceEntry, type BomNode, type OutCol, type Part, type TagRole, type TagScheme,
} from "@fpl/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, type AsmItem } from "../api";
import { HoldButton, Modal, useLocal, useUi } from "../ui";
import { useColResize } from "../colResize";
import { ColumnsEditor, copyText } from "./OutColumns";
import { DocHoverPreview } from "./DocPreview";
import { useEditPartStandard } from "./Naming";
import { PartEditor } from "./PartEditor";
import { FilterPopover, allSpecDefs, colFilterOn, filterSummary, matchFilter, partsCellText, useHold as useHeaderHold, type ColFilter } from "./partsCols";
import { NumIn, TextIn, fmtN, partLabel, type Catalog } from "./shared";

/** Columns of the BOM builder after No. and Item (always shown): built-ins, master-part fields (part:…) and specifications (spec:…). */
const TREE_BUILTIN: { key: string; label: string; title?: string }[] = [
  { key: "mfr", label: "Manufacturer" },
  { key: "pn", label: "Part number" },
  { key: "desc", label: "Description" },
  { key: "qty", label: "Qty" },
  { key: "mech", label: "Mech", title: "Placed in Mechanical Design layouts that reference this project BOM / needed per unit" },
  { key: "prefix", label: "Prefix", title: "Role sign + the line's PREFIX column (device tags come from Mechanical Design)" },
  { key: "w", label: "W", title: "Input power × quantity" },
  { key: "tags", label: "Device tags", title: "Full device tags of the line (from the unit down)" },
  { key: "sub", label: "Subcategory" },
  { key: "doctype", label: "DocType", title: "Codes of the part's active documents (naming standard codes: DS, IG, QSG…). Click to open Edit part → Documents" },
];

/** Document-type code of a kind: the Edit-part naming standard's code, else the built-in code, else the initials. */
function docCode(kind: string, rules: { kind: string; code: string }[]): string {
  const r = rules.find((x) => x.kind.toLowerCase() === kind.toLowerCase());
  if (r?.code) return r.code;
  if (DOC_CODES[kind]) return DOC_CODES[kind];
  const w = kind.split(/[\s/_-]+/).filter(Boolean);
  return (w.length > 1 ? w.map((x) => x[0]).join("") : kind.slice(0, 3)).toUpperCase();
}
type KindDoc = { id: string; kind: string; active: boolean; title: string; fileName: string; mime: string; url: string };

/** Part number in the tree: click and hold 0.4 s copies it to the clipboard. */
function HoldCopy({ text }: { text: string }) {
  const ui = useUi();
  const t = useRef(0);
  const [holding, setHolding] = useState(false);
  const [done, setDone] = useState(false);
  const stop = () => (window.clearTimeout(t.current), setHolding(false));
  return (
    <span className={`holdcopy${holding ? " holding" : ""}${done ? " copied" : ""}`} title="Click and hold to copy the part number"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        setHolding(true);
        t.current = window.setTimeout(async () => {
          setHolding(false);
          try {
            await copyText(text);
            setDone(true);
            window.setTimeout(() => setDone(false), 900);
            ui.toast(`Copied ${text}`);
          } catch {
            ui.toast("Couldn’t copy to the clipboard");
          }
        }, 400);
      }}
      onPointerUp={stop} onPointerLeave={stop} onPointerCancel={stop}>
      {text}
    </span>
  );
}

const TREE_DEFAULT_COLS: OutCol[] = ["mfr", "pn", "desc", "qty", "mech", "prefix", "w"].map((key) => ({ key }));

function TreeColsModal({ cols, mode, ctx, onApply, onClose }: { cols: OutCol[]; mode: "project" | "template"; ctx: Catalog["ctx"]; onApply: (c: OutCol[]) => void; onClose: () => void }) {
  const [d, setD] = useState<OutCol[]>(cols);
  const builtin = mode === "project" ? TREE_BUILTIN : TREE_BUILTIN.filter((b) => b.key !== "mech");
  return (
    <Modal onClose={onClose} label="BOM builder columns">
      <div className="mh"><h3>{mode === "project" ? "Project BOM" : "Template"} builder columns</h3><span className="muted" style={{ fontSize: 12.5 }}>No. and Item are always shown first. Remembered in this browser; outputs keep their own columns.</span></div>
      <div className="mb">
        <ColumnsEditor cols={d} setCols={setD} builtin={builtin} ctx={ctx} />
        <p className="muted" style={{ margin: 0, fontSize: 12 }}>Master-part and specification columns are filled on part lines only.</p>
      </div>
      <div className="mf">
        <button type="button" onClick={() => setD(TREE_DEFAULT_COLS)}>Reset to default</button>
        <span className="grow" />
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" onClick={() => onApply(d)}>Apply</button>
      </div>
    </Modal>
  );
}

const DT = "application/x-fpl-bom";
type DragData = { t: "node"; id: string } | { t: "part"; id: string } | { t: "tpl"; id: string };

export interface TreeEditorProps {
  nodes: BomNode[];
  onChange: (n: BomNode[]) => void;
  cat: Catalog;
  shortlist: string[];
  setShortlist?: (ids: string[]) => void;
  /** project: top level = units (+RACK.01, FNE…); template: a single root group. */
  mode: "project" | "template";
  templates: AsmItem[];
  loadTemplate: (id: string, ver?: { major: number; minor: number }) => Promise<{ data: AsmTemplate; major: number; minor: number; name: string } | null>;
  onSaveAsTemplate?: (n: BomNode) => void;
  /** Template being edited (not offered for insertion into itself). */
  selfTemplateId?: string | null;
  onTemplateRename?: (id: string, name: string) => void;
  onTemplateDelete?: (id: string) => void;
  /** Units placed in Mechanical Design layouts per BOM line (project mode). */
  mech?: Map<string, { placed: number; need: number }>;
  /** Layout lines linked to each BOM line in Mechanical Design (groups / sub-assemblies, project mode). */
  mechLinks?: Map<string, number>;
  /** Device IDs defined in Mechanical Design (project mode). */
  devs?: { entries: DeviceEntry[]; tags: Map<string, string[]>; dupes: Set<string> };
  /** Show only this top-level unit (project mode; null = all units). */
  onlyUnit?: string | null;
  /** Element the declared sort / filter row is rendered into (e.g. the row under the project bar); inline when absent. */
  rulesSlot?: HTMLElement | null;
}

/** Sort levels and column filters of the BOM builder table (click and hold a header 0.4 s). */
interface TreeView { sort: { key: string; dir: "asc" | "desc" }[]; filters: Record<string, ColFilter> }
const NO_VIEW: TreeView = { sort: [], filters: {} };
/** Natural order (A2 before A10, numbers as numbers), empty values last whatever the direction. */
const cmpText = (a: string, b: string, dir: "asc" | "desc") => {
  if (!a !== !b) return a ? -1 : 1;
  const r = a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
  return dir === "asc" ? r : -r;
};

/** Nested BOM editor: tree with item numbers and device tags, inspector, and an insert panel (short-list, catalog, templates). */
export function TreeEditor(p: TreeEditorProps) {
  const ui = useUi();
  const { nodes, onChange, cat, mode } = p;
  const [selId, setSelId] = useState<string | null>(null);
  const [closed, setClosed] = useLocal<string[]>(`fpl.bom.closed.${mode}`, []);
  const [panel, setPanel] = useLocal<"short" | "catalog" | "templates">(`fpl.bom.panel.${mode}`, "short");
  const [dropOn, setDropOn] = useState<string | null>(null);
  const [tplVer, setTplVer] = useState<Record<string, string>>({});
  const [cols, setCols] = useLocal<OutCol[]>(`fpl.bom.treeCols.${mode}`, TREE_DEFAULT_COLS);
  const [colsDlg, setColsDlg] = useState(false);
  const colRef = useColResize(`bom.tree.${mode}`);
  const shown = cols.filter((c) => c.key !== "mech" || p.mech);
  const specDefs = useMemo(() => allSpecDefs(cat.subcats), [cat.subcats]);
  // DocType column: active documents per part (kinds only), re-read after Edit part closes.
  const [editPart, setEditPart] = useState<Part | null>(null);
  const [docNonce, setDocNonce] = useState(0);
  const [docKinds, setDocKinds] = useState<Map<string, KindDoc[]>>(new Map());
  const editStd = useEditPartStandard();
  const wantDocs = shown.some((c) => c.key === "doctype");
  const partIds = useMemo(() => {
    const ids = new Set<string>();
    walk(nodes, (n) => {
      if (n.kind === "part" && n.partId && cat.pmap.has(n.partId)) ids.add(n.partId);
    });
    return [...ids].sort();
  }, [nodes, cat.pmap]);
  const idKey = partIds.join(",");
  useEffect(() => {
    if (!wantDocs || !partIds.length) return;
    let live = true;
    api.parts.docKinds(partIds).then((l) => {
      if (!live) return;
      const m = new Map<string, KindDoc[]>();
      for (const x of l) m.set(x.partId, [...(m.get(x.partId) ?? []), x]);
      setDocKinds(m);
    }).catch(() => undefined);
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantDocs, idKey, docNonce]);
  const docCell = (part: Part) => {
    const all = docKinds.get(part.id) ?? [];
    const act = all.filter((x) => x.active);
    const order = editStd.std.rules.map((r) => r.kind.toLowerCase());
    const kinds = [...new Set(act.map((x) => x.kind))].sort((a, b) => {
      const ia = order.indexOf(a.toLowerCase()), ib = order.indexOf(b.toLowerCase());
      return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib) || a.localeCompare(b);
    });
    const codes = [...new Set(kinds.map((k) => docCode(k, editStd.std.rules)))];
    // Per code: the document to preview on hover (the first active stored file of that type, else its first link).
    const docOf = (code: string) => {
      const l = act.filter((x) => docCode(x.kind, editStd.std.rules) === code);
      return l.find((x) => x.fileName) ?? l[0];
    };
    const off = all.length - act.length;
    const tip = [
      ...kinds.map((k) => `${docCode(k, editStd.std.rules)} — ${k} (${act.filter((x) => x.kind === k).length})`),
      off ? `${off} inactive document${off === 1 ? "" : "s"} not listed` : "",
      "Click to open Edit part → Documents",
    ].filter(Boolean).join("\n");
    return { codes, tip, docOf };
  };
  const colHead = (c: OutCol) => {
    if (c.label) return c.label;
    const b = TREE_BUILTIN.find((x) => x.key === c.key);
    if (b) return b.label;
    if (c.key.startsWith("spec:")) {
      const f = specDefs.get(c.key.slice(5));
      if (f) return `${f.label}${f.unit ? ` (${f.unit})` : ""}`;
    }
    const l = partColLabel(c.key, cat.ctx);
    return l.charAt(0) + l.slice(1).toLowerCase();
  };
  const nos = useMemo(() => itemNumbers(nodes), [nodes]);
  const issues = useMemo(() => tagIssues(nodes), [nodes]);
  const sel = selId ? findNode(nodes, selId) : null;

  // Sort / filter rules (click and hold a column header 0.4 s; ↩️ clears them all).
  const [view, setView] = useLocal<TreeView>(`fpl.bom.treeView.${mode}`, NO_VIEW);
  const activeF = Object.entries(view.filters ?? {}).filter(([, f]) => colFilterOn(f));
  const ruled = activeF.length > 0 || view.sort.length > 0;
  const [filterAt, setFilterAt] = useState<{ key: string; rect: DOMRect } | null>(null);
  const hdrHold = useHeaderHold((el) => {
    const key = el.dataset.col;
    if (key) setFilterAt({ key, rect: el.getBoundingClientRect() });
  }, 400);
  const colLabel = (key: string) => (key === "no" ? "No." : key === "item" ? "Item" : colHead(shown.find((c) => c.key === key) ?? { key }));
  /** Text of a cell as shown (filters and sorting use it). */
  const textOf = (key: string, n: BomNode, parents: BomNode[], depth: number): string => {
    const id = nodeIdentity(n, cat.ctx);
    const isUnit = depth === 0 && mode === "project";
    switch (key) {
      case "no": return nos.get(n.id) ?? "";
      case "item": return n.kind === "group" ? (isUnit ? `${n.tags[0] ? `+${n.tags[0]} ` : ""}${n.name}` : n.line ? n.alias || n.name : n.name) : "";
      case "mfr": return id.manufacturer ?? "";
      case "pn": return id.partNumber ?? "";
      case "desc": return n.kind === "part" ? id.description ?? "" : "";
      case "qty": return n.line || (n.kind === "group" && !isUnit && n.qty === 1) ? "" : String(n.qty);
      case "mech": {
        if (n.kind === "group" && !isUnit) return String(p.mechLinks?.get(n.id) || "");
        const m = p.mech?.get(n.id);
        return m ? `${m.placed}/${m.need}` : "";
      }
      case "prefix": {
        const sub = id.part?.subcategoryId ? cat.smap.get(id.part.subcategoryId) : undefined;
        const pfx = n.kind === "part" ? tagPrefixOf(n, id.part, sub) : n.noPrefix ? "" : n.prefix ?? "";
        return n.kind === "group" && n.tags.length ? n.tags.map((t) => signed(t, nodeRole(n, depth))).join(", ") : pfx ? signed(pfx, nodeRole(n, depth)) : "";
      }
      case "w": {
        const w = n.kind === "part" ? partWatts(id.part) : null;
        return w != null ? fmtN(w * n.qty) : "";
      }
      case "tags": return n.tags.length ? fullTagsOf(n, parents).join(", ") : "";
      case "sub": return n.kind === "part" ? (id.part?.subcategoryId ? cat.smap.get(id.part.subcategoryId)?.name : undefined) ?? id.part?.category ?? "" : "";
      case "doctype": return n.kind === "part" && id.part ? docCell(id.part).codes.join(" ") : "";
      default: return n.kind === "part" && id.part ? partsCellText(key, id.part, cat.ctx, specDefs) : "";
    }
  };

  // Visible rows (depth-first, collapsed groups hidden). Filters: matching rows with their parents (a matching group
  // with all of its content; collapsed groups open); sorting: within each group (units keep their order).
  const rows = useMemo(() => {
    const out: { n: BomNode; parents: BomNode[]; depth: number }[] = [];
    const filtering = activeF.length > 0;
    const closedSet = new Set(filtering ? [] : closed);
    const only = p.onlyUnit && nodes.some((n) => n.id === p.onlyUnit) ? nodes.filter((n) => n.id === p.onlyUnit) : nodes;
    const keep = new Set<string>();
    if (filtering) {
      const all = (n: BomNode) => walk([n], (x) => void keep.add(x.id));
      const rec = (l: BomNode[], parents: BomNode[]): boolean => {
        let any = false;
        for (const n of l) {
          // A group / unit counts as a match (with all of its content) only on columns where it shows a value itself
          // (e.g. No., Item, Prefix); otherwise it is listed as the parent of matching lines.
          const hit = activeF.every(([k, f]) => {
            const t = textOf(k, n, parents, parents.length);
            return (n.kind === "part" || t !== "") && matchFilter(f, t);
          });
          if (hit) all(n);
          const sub = n.children.length ? rec(n.children, [...parents, n]) : false;
          if (hit || sub) (keep.add(n.id), (any = true));
        }
        return any;
      };
      rec(only, []);
    }
    const order = (l: BomNode[], parents: BomNode[]) => {
      if (!view.sort.length || (mode === "project" && !parents.length)) return l;
      const d = parents.length;
      const keys = new Map(l.map((n) => [n.id, view.sort.map((s) => textOf(s.key, n, parents, d))]));
      return [...l].sort((a, b) => {
        const ka = keys.get(a.id)!, kb = keys.get(b.id)!;
        for (let i = 0; i < view.sort.length; i++) {
          const r = cmpText(ka[i], kb[i], view.sort[i].dir);
          if (r) return r;
        }
        return 0;
      });
    };
    const rec = (l: BomNode[], parents: BomNode[]) => {
      for (const n of order(l, parents)) {
        if (filtering && !keep.has(n.id)) continue;
        out.push({ n, parents, depth: parents.length });
        if (n.children.length && !closedSet.has(n.id)) rec(n.children, [...parents, n]);
      }
    };
    rec(only, []);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, closed, p.onlyUnit, view, docKinds, p.mech, p.mechLinks, cat.ctx, specDefs, editStd.std, nos]);
  // The unit and group rows above the selected line stick under the header (top of each measured after rendering).
  const tableRef = useRef<HTMLTableElement | null>(null);
  const stickIds = useMemo(() => {
    const r = rows.find((x) => x.n.id === selId);
    return r ? r.parents.map((x) => x.id).filter((id) => rows.some((x) => x.n.id === id)) : [];
  }, [rows, selId]);
  const [stickTop, setStickTop] = useState<Record<string, number>>({});
  useEffect(() => {
    const t = tableRef.current;
    if (!t || !stickIds.length) return void setStickTop((m) => (Object.keys(m).length ? {} : m));
    let top = t.tHead?.getBoundingClientRect().height ?? 29;
    const next: Record<string, number> = {};
    for (const id of stickIds) {
      const tr = t.querySelector<HTMLTableRowElement>(`tbody tr[data-id="${id}"]`);
      if (!tr) continue;
      next[id] = Math.round(top);
      top += tr.getBoundingClientRect().height;
    }
    setStickTop((m) => (JSON.stringify(m) === JSON.stringify(next) ? m : next));
  });
  /** Values of a column for its filter (narrowed by the other filters), with counts. */
  const valuesOf = (key: string): [string, number][] => {
    const others = activeF.filter(([k]) => k !== key);
    const m = new Map<string, number>();
    walk(nodes, (n, ps) => {
      if (!others.every(([k, f]) => matchFilter(f, textOf(k, n, ps, ps.length)))) return;
      const t = textOf(key, n, ps, ps.length);
      if (!t && n.kind !== "part") return;
      m.set(t, (m.get(t) ?? 0) + 1);
    });
    return [...m].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));
  };
  const setSort = (key: string, dir: "asc" | "desc" | null) => {
    const i = view.sort.findIndex((s) => s.key === key);
    const sort = dir == null ? view.sort.filter((s) => s.key !== key) : i >= 0 ? view.sort.map((s) => (s.key === key ? { key, dir } : s)) : [...view.sort, { key, dir }];
    setView({ ...view, sort });
  };
  const setFilter = (key: string, f: ColFilter | null) => {
    const filters = { ...(view.filters ?? {}) };
    if (f && colFilterOn(f)) filters[key] = f;
    else delete filters[key];
    setView({ ...view, filters });
  };
  const head = (key: string, label: React.ReactNode, title?: string) => {
    const s = view.sort.findIndex((x) => x.key === key);
    const on = colFilterOn(view.filters?.[key]);
    return (
      <th key={key} data-col={key} {...hdrHold.bind(key)} className={`hcol${hdrHold.holding === key ? " holding" : ""}${on ? " filtered" : ""}`}
        title={`${title ? `${title}\n` : ""}Click and hold 0.4 s: filter and sort this column`}>
        {label}
        {s >= 0 && <span className="sortmark">{view.sort[s].dir === "asc" ? "▲" : "▼"}{view.sort.length > 1 ? s + 1 : ""}</span>}
        {on && <span className="fmark" aria-label="Filtered">⏷</span>}
      </th>
    );
  };
  const rulesRow = ruled ? (
    <div className="toolbar sub fbar bomrules">
      <button type="button" className="btn-ghost" onClick={() => setView(NO_VIEW)} title="Remove every sort and filter: back to the original order">↩️ Original order</button>
      {view.sort.length > 0 && <span className="muted" style={{ fontSize: 12.5 }}>Sorted by:</span>}
      {view.sort.map((s, i) => (
        <span key={`s${s.key}`} className="chip info fchip">
          <button type="button" className="btn-ghost" onClick={(e) => setFilterAt({ key: s.key, rect: e.currentTarget.getBoundingClientRect() })}>{view.sort.length > 1 ? `${i + 1}. ` : ""}{colLabel(s.key)} {s.dir === "asc" ? "▲" : "▼"}</button>
          <button type="button" className="btn-ghost chipx" aria-label={`Clear sort ${colLabel(s.key)}`} onClick={() => setSort(s.key, null)}>✕</button>
        </span>
      ))}
      {activeF.length > 0 && <span className="muted" style={{ fontSize: 12.5 }}>Filters ({rows.filter((r) => r.n.kind === "part").length} part lines shown):</span>}
      {activeF.map(([k, f]) => (
        <span key={`f${k}`} className="chip info fchip">
          <button type="button" className="btn-ghost" onClick={(e) => setFilterAt({ key: k, rect: e.currentTarget.getBoundingClientRect() })}>{colLabel(k)}: {filterSummary(f)}</button>
          <button type="button" className="btn-ghost chipx" aria-label={`Clear filter ${colLabel(k)}`} onClick={() => setFilter(k, null)}>✕</button>
        </span>
      ))}
    </div>
  ) : null;

  /** Where new items go: the selected group, or the selected part's parent (after it). */
  const target = (): { parentId: string | null; index?: number } | null => {
    if (!sel) return mode === "template" && nodes[0] ? { parentId: nodes[0].id } : null;
    if (sel.node.kind === "group") return { parentId: sel.node.id };
    const parent = sel.parents[sel.parents.length - 1];
    if (!parent) return null;
    return { parentId: parent.id, index: parent.children.findIndex((c) => c.id === sel.node.id) + 1 };
  };
  const insert = (node: BomNode, t = target()) => {
    if (!t) {
      if (mode === "project" && node.kind === "group") {
        onChange(insertNode(nodes, null, { ...node, role: node.role ?? "loc" }));
        setSelId(node.id);
        return;
      }
      ui.toast(mode === "project" ? "Select a unit or group first (or add a unit)" : "Select a group first");
      return;
    }
    onChange(insertNode(nodes, t.parentId, node, t.index));
    if (t.parentId) setClosed(closed.filter((x) => x !== t.parentId));
    setSelId(node.id);
  };
  const addPart = (part: Part, t?: ReturnType<typeof target>) => insert(partNode(part, 1), t === undefined ? target() : t);
  const addTemplate = async (id: string, t?: ReturnType<typeof target>, ver?: { major: number; minor: number }) => {
    const tpl = await p.loadTemplate(id, ver);
    if (!tpl) return ui.toast("Template has no saved version yet");
    const root = cloneNode(tpl.data.root);
    root.from = { assemblyId: id, name: tpl.name, major: tpl.major, minor: tpl.minor };
    const unitKind = tpl.data.kind === "RACK" || tpl.data.kind === "FNE" || tpl.data.kind === "PANEL";
    if (mode === "project" && (unitKind || (!sel && t === undefined))) {
      // Racks / FNEs / wall-mount panels become top-level units.
      root.role = "loc";
      onChange([...nodes, root]);
      setSelId(root.id);
      ui.toast(`Added ${tpl.name} as a unit`);
      return;
    }
    if (root.role === "loc") root.role = undefined;
    insert(root, t === undefined ? target() : t);
  };

  // Drag and drop: rows move; catalog / short-list parts and templates insert.
  const dropTarget = (row: BomNode, parents: BomNode[]): { parentId: string | null; index?: number } => {
    if (row.kind === "group") return { parentId: row.id };
    const parent = parents[parents.length - 1];
    return { parentId: parent?.id ?? null, index: parent ? parent.children.findIndex((c) => c.id === row.id) + 1 : undefined };
  };
  const onDrop = (e: React.DragEvent, row: BomNode, parents: BomNode[]) => {
    e.preventDefault();
    setDropOn(null);
    let d: DragData;
    try {
      d = JSON.parse(e.dataTransfer.getData(DT));
    } catch {
      return;
    }
    const t = dropTarget(row, parents);
    if (d.t === "node") {
      if (d.id === row.id) return;
      const next = moveNode(nodes, d.id, t.parentId, t.index != null ? adjust(nodes, d.id, t) : undefined);
      if (next === nodes) ui.toast("Can’t move a group into itself");
      onChange(next);
    } else if (d.t === "part") {
      const part = cat.pmap.get(d.id);
      if (part) addPart(part, t);
    } else void addTemplate(d.id, t);
  };
  const drag = (d: DragData) => (e: React.DragEvent) => {
    e.dataTransfer.setData(DT, JSON.stringify(d));
    e.dataTransfer.effectAllowed = d.t === "node" ? "move" : "copy";
  };

  const del = async () => {
    if (!sel) return;
    if (mode === "template" && !sel.parents.length) return ui.toast("The template root can’t be deleted");
    const n = sel.node;
    let count = 0;
    walk([n], () => count++);
    if (count > 1 && !(await ui.confirm(`Delete “${label(n)}” and ${count - 1} item(s) under it?`, "Delete"))) return;
    onChange(removeNode(nodes, n.id));
    setSelId(sel.parents[sel.parents.length - 1]?.id ?? null);
  };
  const dup = () => {
    if (!sel || !sel.parents.length) {
      if (sel && mode === "project") {
        const c = cloneNode(sel.node);
        c.tags = [];
        onChange([...nodes, c]);
        setSelId(c.id);
      }
      return;
    }
    const parent = sel.parents[sel.parents.length - 1];
    const c = cloneNode(sel.node);
    c.tags = [];
    onChange(insertNode(nodes, parent.id, c, parent.children.findIndex((x) => x.id === sel.node.id) + 1));
    setSelId(c.id);
  };
  const label = (n: BomNode) => {
    const id = nodeIdentity(n, cat.ctx);
    return n.kind === "group" ? n.name || n.tags[0] || (n.line ? n.alias || "(sub-assembly)" : "(group)") : `${id.manufacturer} ${id.partNumber}`.trim() || id.description;
  };

  const shortParts = p.shortlist.map((id) => cat.pmap.get(id)).filter((x): x is Part => !!x);

  return (
    <div className="bomed">
      <section className="pane">
        <div className="toolbar sub">
          {mode === "project" && <button type="button" className="btn-primary" onClick={() => insert(groupNode("", { tags: [nextUnitTag(nodes)], role: "loc" }), null)}>+ Unit</button>}
          <button type="button" onClick={() => insert(groupNode(mode === "project" && !sel ? "" : "NEW GROUP"))} title="Section / group / sub-assembly under the selected group">+ Group</button>
          <button type="button" onClick={() => insert(groupNode("", { line: true }))} title="Sub-assembly under the selected group (or sub-assembly): its items are lettered a, b, c (A1.1a, A1.1b); sub-assemblies can nest">+ Sub-assembly</button>
          <span className="sep" />
          <button type="button" disabled={!sel} aria-label="Move up" title="Move up" onClick={() => sel && onChange(shiftNode(nodes, sel.node.id, -1))}>↑</button>
          <button type="button" disabled={!sel} aria-label="Move down" title="Move down" onClick={() => sel && onChange(shiftNode(nodes, sel.node.id, 1))}>↓</button>
          <button type="button" disabled={!sel || sel.parents.length < 2} title="Move out of its group" onClick={() => {
            if (!sel || sel.parents.length < 2) return;
            const parent = sel.parents[sel.parents.length - 1];
            const gp = sel.parents[sel.parents.length - 2];
            onChange(moveNode(nodes, sel.node.id, gp.id, gp.children.findIndex((c) => c.id === parent.id) + 1));
          }}>⇤ Outdent</button>
          <button type="button" disabled={!sel} onClick={dup} title="Copy with new ids (tags cleared)">Duplicate</button>
          <button type="button" disabled={!sel} className="btn-danger" onClick={del}>Delete</button>
          <span className="sep" />
          {p.onSaveAsTemplate && <button type="button" disabled={!sel || sel.node.kind !== "group"} onClick={() => sel && p.onSaveAsTemplate!(sel.node)} title="Save the selected group as a reusable assembly template">Save as template…</button>}
          <span className="grow" />
          <button type="button" className="btn-ghost" disabled={!ruled} onClick={() => setView(NO_VIEW)} aria-label="Original order"
            title={ruled ? "↩️ Remove every sort and filter declared: back to the original order" : "No sort or filter declared (click and hold a column header 0.4 s to add one)"}>↩️</button>
          <button type="button" onClick={() => setColsDlg(true)} title="Choose, order and rename the columns of the BOM builder">Columns…</button>
          <button type="button" className="btn-ghost" onClick={() => setClosed([])}>Expand all</button>
          <button type="button" className="btn-ghost" onClick={() => {
            const ids: string[] = [];
            walk(nodes, (n, ps) => n.children.length && ps.length >= 1 && ids.push(n.id));
            setClosed(ids);
          }}>Collapse</button>
        </div>
        {rulesRow && (p.rulesSlot ? createPortal(rulesRow, p.rulesSlot) : rulesRow)}
        <div className="scroll">
          {!nodes.length ? (
            <div className="empty-state">
              <h3>{mode === "project" ? "No units yet" : "Empty template"}</h3>
              <p>{mode === "project" ? "Add a unit (RACK.01, FNE, RTAC panel…), insert a saved rack / FNE template, or import an equipment list from a drawing set." : "Add groups and parts."}</p>
            </div>
          ) : (
            <table className="net bomtree" ref={(el) => ((tableRef.current = el), colRef(el))}>
              <thead>
                <tr>{head("no", "No.")}{head("item", "Item")}{shown.map((c) => head(c.key, colHead(c), TREE_BUILTIN.find((b) => b.key === c.key)?.title))}</tr>
              </thead>
              <tbody>
                {rows.map(({ n, parents, depth }) => {
                  const id = nodeIdentity(n, cat.ctx);
                  const iss = [...(issues[n.id] ?? []), ...(n.kind === "part" && (!n.partId || !cat.pmap.has(n.partId)) ? ["Not linked to a master part"] : [])];
                  const isUnit = depth === 0 && mode === "project";
                  const w = n.kind === "part" ? partWatts(id.part) : null;
                  const sub = id.part?.subcategoryId ? cat.smap.get(id.part.subcategoryId) : undefined;
                  const pfx = n.kind === "part" ? tagPrefixOf(n, id.part, sub) : n.noPrefix ? "" : n.prefix ?? "";
                  // Parts: the prefix (with the tag role sign); groups and units keep showing their own tags (+RACK.01, -PDU.01).
                  const pre = n.kind === "group" && n.tags.length ? n.tags.map((t) => signed(t, nodeRole(n, depth))).join(", ") : pfx ? signed(pfx, nodeRole(n, depth)) : "";
                  return (
                    <tr
                      key={n.id}
                      data-id={n.id}
                      className={[n.kind, isUnit && "unit", n.line && "line", selId === n.id && "sel", dropOn === n.id && "drop", iss.length && "warnrow", stickTop[n.id] != null && "stick"].filter(Boolean).join(" ")}
                      style={stickTop[n.id] != null ? ({ ["--st" as string]: `${stickTop[n.id]}px` } as React.CSSProperties) : undefined}
                      draggable={!(mode === "template" && depth === 0)}
                      onDragStart={drag({ t: "node", id: n.id })}
                      onDragOver={(e) => (e.preventDefault(), setDropOn(n.id))}
                      onDragLeave={() => setDropOn((x) => (x === n.id ? null : x))}
                      onDrop={(e) => onDrop(e, n, parents)}
                      onClick={() => setSelId(n.id)}
                      title={iss.join("\n") || undefined}
                    >
                      <td className="mono no">{nos.get(n.id)}</td>
                      <td className="item" style={{ paddingLeft: 6 + depth * 16 }}>
                        {n.children.length ? (
                          <button type="button" className="gcaret" aria-label={closed.includes(n.id) ? "Expand" : "Collapse"} onClick={(e) => (e.stopPropagation(), setClosed(closed.includes(n.id) ? closed.filter((x) => x !== n.id) : [...closed, n.id]))}>
                            {closed.includes(n.id) ? "▸" : "▾"}
                          </button>
                        ) : <span className="gcaret" />}
                        {n.kind === "group" ? <b>{isUnit ? <>{`${n.tags.length > 1 ? `${n.tags.length} × ` : ""}${n.tags[0] ? `+${n.tags[0]}` : ""} ${n.name}`}{n.mechUndef && <span className="chip info" style={{ marginLeft: 6 }} title="Generated from Mechanical Design: parts placed in layouts / assembly groups that are not on the BOM. Rebuilt automatically; add the parts to the BOM unit to clear it.">auto · Mechanical Design</span>}</> : n.line ? <span className="subasm">{n.alias || n.name || <span className="muted">sub-assembly</span>} <span className="chip">sub-asm</span></span> : n.name || <span className="muted">(group)</span>}</b> : null}
                        {n.from && <span className="chip info" title={`From template ${n.from.name} v${n.from.major}.${String(n.from.minor).padStart(3, "0")}`}>tpl</span>}
                        {iss.length > 0 && <span className="chip" title={iss.join("\n")}>!</span>}
                      </td>
                      {shown.map((c) => {
                        switch (c.key) {
                          case "mfr": return <td key={c.key}>{id.manufacturer}</td>;
                          case "pn": return <td key={c.key} className="mono">{id.partNumber ? <HoldCopy text={id.partNumber} /> : null}</td>;
                          case "desc": return <td key={c.key} className="desc" title={id.description}>{n.kind === "part" ? id.description : ""}</td>;
                          case "qty": return <td key={c.key} className="num">{n.line || (n.kind === "group" && !isUnit && n.qty === 1) ? "" : n.qty}</td>;
                          case "mech": {
                            const m = p.mech?.get(n.id);
                            if (n.kind === "group" && !isUnit) {
                              const l = p.mechLinks?.get(n.id) ?? 0;
                              return <td key={c.key} className={`num mechq${l ? " ok" : ""}`} title={`${l} layout line${l === 1 ? "" : "s"} linked to this ${n.line ? "sub-assembly" : "group"} in Mechanical Design`}>{l ? `${l} link${l === 1 ? "" : "s"}` : ""}</td>;
                            }
                            return <td key={c.key} className={`num mechq${m ? (m.placed >= m.need ? " ok" : " short") : ""}`} title={m ? `${m.placed} of ${m.need} placed in the mechanical layouts of this unit` : undefined}>{m ? `${m.placed}/${m.need}` : ""}</td>;
                          }
                          case "prefix": return <td key={c.key} className="mono tagcell" title={n.tags.length ? `Device tags:\n${fullTagsOf(n, parents).join("\n")}` : undefined}>{pre}</td>;
                          case "w": return <td key={c.key} className="num">{w != null ? fmtN(w * n.qty) : ""}</td>;
                          case "tags": {
                            const t = n.tags.length ? fullTagsOf(n, parents) : [];
                            return <td key={c.key} className="mono tagcell" title={t.join("\n") || undefined}>{t.join(", ")}</td>;
                          }
                          case "sub": return <td key={c.key}>{n.kind === "part" ? sub?.name ?? id.part?.category ?? "" : ""}</td>;
                          case "doctype": {
                            if (n.kind !== "part" || !id.part) return <td key={c.key} />;
                            const part = id.part;
                            const { codes, tip, docOf } = docCell(part);
                            return (
                              <td key={c.key} className="doctype">
                                <button type="button" className="btn-ghost dtbtn" title={tip} aria-label={`Documents of ${part.partNumber}: ${codes.join(", ") || "none"}`} onClick={(e) => (e.stopPropagation(), setEditPart(part))}>
                                  {codes.length
                                    ? codes.map((x) => {
                                      const doc = docOf(x);
                                      const chip = <span className="dtcode" title={doc ? `${doc.title || doc.fileName || doc.url}${doc.fileName ? "" : " (link)"}` : undefined}>{x}</span>;
                                      // Hover a code: preview of that type's document (PDF pages / image).
                                      return doc?.fileName ? <DocHoverPreview key={x} doc={doc}>{chip}</DocHoverPreview> : <span key={x}>{chip}</span>;
                                    })
                                    : <span className="muted">+ docs</span>}
                                </button>
                              </td>
                            );
                          }
                          default: {
                            const v = n.kind === "part" && id.part ? partsCellText(c.key, id.part, cat.ctx, specDefs) : "";
                            return <td key={c.key} title={v.length > 40 ? v : undefined}>{v}</td>;
                          }
                        }
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </section>
      {editPart && <PartEditor part={editPart} focus="docs" subcats={cat.subcats} parts={cat.parts} onPartSaved={(x) => cat.putPart(x)} onSaved={(x) => cat.putPart(x)} onClose={() => (setEditPart(null), setDocNonce((k) => k + 1))} />}
      {filterAt && (
        <FilterPopover title={colLabel(filterAt.key)} rect={filterAt.rect} values={valuesOf(filterAt.key)} f={view.filters?.[filterAt.key] ?? { vals: [], q: "" }}
          onChange={(f) => setFilter(filterAt.key, f)} onClose={() => setFilterAt(null)}
          sort={{ dir: view.sort.find((s) => s.key === filterAt.key)?.dir ?? null, level: view.sort.findIndex((s) => s.key === filterAt.key) + 1 || view.sort.length + 1, levels: view.sort.length, onSort: (d) => setSort(filterAt.key, d) }} />
      )}
      {colsDlg && <TreeColsModal cols={cols} mode={mode} ctx={cat.ctx} onApply={(c) => (setCols(c), setColsDlg(false))} onClose={() => setColsDlg(false)} />}
      <aside className="bomside">
        <section className="pane insp">
          {sel ? (
            <Inspector key={sel.node.id} n={sel.node} parents={sel.parents} nodes={nodes} cat={cat} mode={mode} itemNo={nos.get(sel.node.id) ?? ""} devs={p.devs} onChange={(f) => onChange(updateNode(nodes, sel.node.id, f))} />
          ) : (
            <div className="empty-state" style={{ padding: 16 }}><p>Select a line to edit quantity, device tags, item number and notes. Drag lines to reorder or nest them.</p></div>
          )}
        </section>
        <section className="pane ins">
          <div className="tabs" role="tablist">
            {([["short", `Short-list (${shortParts.length})`], ["catalog", "Catalog"], ["templates", `Templates (${p.templates.length})`]] as const).map(([k, l]) => (
              <button key={k} type="button" role="tab" className="tab" aria-selected={panel === k} onClick={() => setPanel(k)}>{l}</button>
            ))}
          </div>
          <div className="scroll">
            {panel === "templates" ? (
              <ul className="srclist">
                {!p.templates.length && <li className="muted" style={{ padding: 10 }}>No assembly templates yet. Build one in the Assemblies tab or use “Save as template…”.</li>}
                {p.templates.filter((t) => t.id !== p.selfTemplateId).map((t) => {
                  const vs = t.versions.slice().sort((a, b) => b.major - a.major || b.minor - a.minor);
                  const vsel = tplVer[t.id] ?? (vs[0] ? `${vs[0].major}.${vs[0].minor}` : "");
                  const [ma, mi] = vsel.split(".").map(Number);
                  return (
                    <li key={t.id} draggable onDragStart={drag({ t: "tpl", id: t.id })} className="tplrow">
                      <button type="button" onClick={() => addTemplate(t.id, undefined, vsel ? { major: ma, minor: mi } : undefined)} title="Click to insert this version (into the selected group), or drag onto a group (latest version)">
                        <span className="nm">{t.code ? <span className="mono">{t.code} · </span> : null}{t.name}</span>
                        <span className="meta"><span>{t.kind}</span></span>
                      </button>
                      <select aria-label={`Version of ${t.name}`} value={vsel} onChange={(e) => setTplVer({ ...tplVer, [t.id]: e.target.value })} onClick={(e) => e.stopPropagation()}>
                        {vs.length ? vs.map((v) => <option key={`${v.major}.${v.minor}`} value={`${v.major}.${v.minor}`}>v{v.major}.{String(v.minor).padStart(3, "0")}</option>) : <option value="">—</option>}
                      </select>
                      {p.onTemplateRename && <button type="button" className="btn-ghost" aria-label={`Rename ${t.name}`} title="Rename" onClick={async () => {
                        const n = await ui.prompt("Template name", t.name, "Rename");
                        if (n && n !== t.name) p.onTemplateRename!(t.id, n);
                      }}>✎</button>}
                      {p.onTemplateDelete && <HoldButton label={`Delete template ${t.name}`} onHold={() => p.onTemplateDelete!(t.id)}>✕</HoldButton>}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <PartPicker
                parts={panel === "short" ? shortParts : cat.parts}
                cat={cat}
                empty={panel === "short" ? "Short-list parts with ☆ in the Parts tab (or here in Catalog) to keep this project's palette at hand." : "No parts match."}
                drag={(id) => drag({ t: "part", id })}
                onPick={(part) => addPart(part)}
                star={p.setShortlist ? { ids: p.shortlist, set: p.setShortlist } : undefined}
              />
            )}
          </div>
        </section>
      </aside>
    </div>
  );
}

/** Index in the destination list after removing the dragged node (when moving down within the same parent). */
function adjust(nodes: BomNode[], id: string, t: { parentId: string | null; index?: number }): number | undefined {
  if (t.index == null) return undefined;
  const list = t.parentId ? findNode(nodes, t.parentId)?.node.children ?? [] : nodes;
  const from = list.findIndex((c) => c.id === id);
  return from >= 0 && from < t.index ? t.index - 1 : t.index;
}
function nextUnitTag(nodes: BomNode[]): string {
  const used = new Set(nodes.flatMap((n) => n.tags.map((t) => t.toUpperCase())));
  return autoTags("RACK", 1, "seq", used)[0];
}

/** Searchable part list; click inserts, drag drops onto a group. */
export function PartPicker({ parts, cat, empty, drag, onPick, star }: { parts: Part[]; cat: Catalog; empty: string; drag?: (id: string) => (e: React.DragEvent) => void; onPick: (p: Part) => void; star?: { ids: string[]; set: (ids: string[]) => void } }) {
  const [q, setQ] = useState("");
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const list = parts.filter((p) => {
    if (!words.length) return true;
    const hay = [p.manufacturer, p.partNumber, p.description, p.series, cat.smap.get(p.subcategoryId ?? "")?.name ?? ""].join(" ").toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  const on = new Set(star?.ids ?? []);
  return (
    <div className="picker">
      <input type="search" placeholder="Filter…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter parts" />
      {!list.length && <p className="muted" style={{ padding: "6px 10px", margin: 0, fontSize: 12.5 }}>{empty}</p>}
      <ul className="srclist">
        {list.slice(0, 400).map((p) => (
          <li key={p.id} draggable={!!drag} onDragStart={drag?.(p.id)}>
            <button type="button" onClick={() => onPick(p)} title={`${p.description}\nClick to insert, or drag onto a group`}>
              <span className="nm"><span className="mono">{p.partNumber}</span> <span className="muted">· {p.manufacturer}</span></span>
              <span className="meta"><span className="clip">{p.description}</span></span>
            </button>
            {star && (
              <button type="button" className={`star${on.has(p.id) ? " on" : ""}`} aria-pressed={on.has(p.id)} aria-label="Short-list" onClick={() => star.set(on.has(p.id) ? star.ids.filter((x) => x !== p.id) : [...star.ids, p.id])}>
                {on.has(p.id) ? "★" : "☆"}
              </button>
            )}
          </li>
        ))}
        {list.length > 400 && <li className="muted" style={{ padding: 8, fontSize: 12 }}>{list.length - 400} more — refine the filter</li>}
      </ul>
    </div>
  );
}

const ROLES: [TagRole, string][] = [["loc", "+ location"], ["prod", "- product"], ["func", "= function"]];

function Inspector({ n, parents, nodes, cat, mode, itemNo, onChange, devs }: { n: BomNode; parents: BomNode[]; nodes: BomNode[]; cat: Catalog; mode: "project" | "template"; itemNo: string; onChange: (f: (n: BomNode) => BomNode) => void; devs?: TreeEditorProps["devs"] }) {
  const id = nodeIdentity(n, cat.ctx);
  const depth = parents.length;
  const isUnit = depth === 0 && mode === "project";
  const sub = id.part?.subcategoryId ? cat.smap.get(id.part.subcategoryId) : undefined;
  const [scheme, setScheme] = useState<TagScheme>("seq");
  const [prefix, setPrefix] = useState(isUnit ? n.tags[0]?.replace(/[.\d]+$/, "") || "RACK" : tagPrefixOf(n, id.part, sub));
  const [relink, setRelink] = useState(false);
  const set = (patch: Partial<BomNode>) => onChange((x) => ({ ...x, ...patch }));
  /** Tags already used in the scope of the nearest tagged ancestor (or the whole tree). */
  const scopeUsed = () => {
    const anc = [...parents].reverse().find((x) => x.tags.length);
    const used = tagsIn(anc ? anc.children : nodes);
    n.tags.forEach((t) => used.delete(t.toUpperCase()));
    return used;
  };
  const full = n.tags.length ? fullTagsOf(n, parents) : [];

  return (
    <div className="inspb">
      <div className="pane-head">
        <h3>{n.kind === "group" ? (isUnit ? "Unit" : n.line ? "Sub-assembly" : "Group") : "Part line"}</h3>
        <span className="mono muted">{itemNo}</span>
        {n.from && <span className="chip info">from {n.from.name} v{n.from.major}.{String(n.from.minor).padStart(3, "0")}</span>}
      </div>
      <div className="inspf">
        {n.kind === "part" ? (
          <>
            <div className="linked">
              {id.part ? <><b className="mono">{id.part.partNumber}</b> · {id.part.manufacturer}<br /><span className="muted">{id.part.description}</span></> : <><span className="chip">Not linked</span> <span className="mono">{n.snap?.manufacturer} {n.snap?.partNumber}</span><br /><span className="muted">{n.snap?.description}</span></>}
              <div><button type="button" className="btn-ghost" onClick={() => setRelink(!relink)}>{relink ? "Cancel" : id.part ? "Change part…" : "Link to a master part…"}</button></div>
              {relink && (
                <div className="relink">
                  <PartPicker parts={cat.parts} cat={cat} empty="No parts match" onPick={(p) => (set({ partId: p.id, snap: { manufacturer: p.manufacturer, partNumber: p.partNumber, description: p.description } }), setRelink(false))} />
                </div>
              )}
            </div>
            <label className="f">Description override<TextIn label="Description override" value={n.name} placeholder={id.part?.description ?? n.snap?.description ?? ""} onChange={(v) => set({ name: v })} /></label>
          </>
        ) : (
          <>
            {n.line && <label className="f" title="Sub-category alias of this sub-assembly; printed as its line in the equipment list">Sub-category alias<TextIn label="Sub-category alias" value={n.alias ?? ""} placeholder="e.g. TB-A TERMINALS, 24VDC DISTRIBUTION" onChange={(v) => set({ alias: v || undefined })} /></label>}
            <label className="f">{isUnit ? "Unit name (optional)" : "Title"}<TextIn label="Title" value={n.name} placeholder={isUnit ? "EMS ENCLOSURE" : n.line ? "(optional)" : "SERVER RACK"} onChange={(v) => set({ name: v })} /></label>
            {!isUnit && !n.line && <label className="f">Manufacturer on the line<TextIn label="Maker" value={n.maker ?? ""} placeholder="FRACTAL" onChange={(v) => set({ maker: v || undefined })} /></label>}
          </>
        )}
        <div className="frow tight">
          <label className="f">{isUnit ? "Instances" : "Quantity"}<NumIn label="Quantity" value={n.qty} width={70} onChange={(v) => set({ qty: Math.max(0, v ?? 1) })} /></label>
          <label className="f">Item no. (override)<TextIn label="Item number" value={n.itemNo ?? ""} placeholder={itemNo || "auto"} mono width={90} onChange={(v) => set({ itemNo: v.trim() || undefined })} /></label>
          {isUnit && <label className="f">First section letter<TextIn label="First section letter" value={n.sectionStart ?? ""} placeholder="auto" mono width={60} onChange={(v) => set({ sectionStart: v.trim().toUpperCase() || undefined })} /></label>}
        </div>
        {n.kind === "part" && mode === "project" ? (
          <DeviceTagsRO n={n} parents={parents} devs={devs} />
        ) : (
          <>
        <label className="f">Device tags ({n.tags.length} for qty {n.qty})
            <textarea
              rows={Math.min(5, Math.max(1, n.tags.length))}
              className="mono"
              defaultValue={n.tags.join("\n")}
              key={n.tags.join("|")}
              placeholder={isUnit ? "RACK.01" : "MCB.01A"}
              onBlur={(e) => {
                const parsed = e.target.value.split(/[\n,;]+/).map((x) => parseTag(x)).filter((x) => x.tag);
                const tags = parsed.map((x) => x.tag);
                const role = parsed.find((x) => x.role)?.role;
                if (tags.join("|") !== n.tags.join("|") || (role && role !== n.role)) set({ tags, ...(role ? { role } : {}) });
              }}
            />
          </label>
          <div className="frow tight autotag">
            <label className="f">Prefix<input type="text" className="mono" value={prefix} onChange={(e) => setPrefix(e.target.value)} style={{ width: 90 }} /></label>
            <label className="f">Scheme
              <select value={scheme} onChange={(e) => setScheme(e.target.value as TagScheme)}>
                <option value="seq">.01, .02, .03</option>
                <option value="letters">.01A, .01B (redundant)</option>
                <option value="seqLetters">.01A/B, .02A/B (pairs)</option>
              </select>
            </label>
            <button type="button" style={{ alignSelf: "flex-end" }} disabled={!prefix.trim() || !n.qty} onClick={() => set({ tags: autoTags(prefix.trim(), n.qty, scheme, scopeUsed()) })}>Auto-tag</button>
            {n.tags.length > 0 && <button type="button" className="btn-ghost" style={{ alignSelf: "flex-end" }} onClick={() => set({ tags: [] })}>Clear</button>}
          </div>
          </>
        )}
        <div className="frow tight">
          <label className="f">Tag role
            <select value={nodeRole(n, depth)} onChange={(e) => set({ role: e.target.value as TagRole })}>{ROLES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          </label>
          <label className="f" title="Prefix of the line's device tags (tag = prefix + the number defined in Mechanical Design)">PREFIX column
            <TextIn label="Prefix column" value={n.noPrefix ? "" : n.prefix ?? ""} mono placeholder={n.noPrefix ? "(no prefix)" : n.kind === "part" ? tagPrefixOf({ ...n, prefix: "" }, id.part, sub) || "none" : ""} width={90} onChange={(v) => set({ prefix: parseTag(v).tag || undefined, noPrefix: undefined })} />
          </label>
          <button type="button" className={`btn-ghost${n.noPrefix ? " on" : ""}`} style={{ alignSelf: "flex-end" }} aria-pressed={!!n.noPrefix}
            title={n.noPrefix ? "This line has no prefix; click to use the PREFIX column / part / subcategory prefix again" : "Remove the prefix of this line (also the part / subcategory default)"}
            onClick={() => set({ noPrefix: n.noPrefix ? undefined : true })}>{n.noPrefix ? "No prefix ✓" : "No prefix"}</button>
          {n.kind === "group" && !isUnit && <label className="chk-l" style={{ alignSelf: "flex-end" }}><input type="checkbox" checked={!!n.line} onChange={(e) => set({ line: e.target.checked || undefined })} /> Sub-assembly (items lettered a, b, c)</label>}
        </div>
        {full.length > 0 && (
          <div className="fulltags">
            <span className="muted">Full tag{full.length > 1 ? "s" : ""}{parents[0]?.tags.length > 1 ? ` (first of ${parents[0].tags.length} ${parents[0].tags[0]}… instances)` : ""}:</span>
            {full.slice(0, 8).map((t) => <code key={t}>{t}</code>)}
            {full.length > 8 && <span className="muted">… {full.length - 8} more</span>}
          </div>
        )}
        <label className="f">Notes<TextIn label="Notes" value={n.notes ?? ""} onChange={(v) => set({ notes: v || undefined })} /></label>
        {id.part && (
          <p className="muted partinfo">
            {[id.part.powerIn && `Feed: ${id.part.powerIn.kind} ${fmtN(id.part.powerIn.voltage)} V · ${fmtN(partWatts(id.part))} W${id.part.powerIn.terminals.length ? ` · ${id.part.powerIn.terminals.join("/")}` : ""}`,
              id.part.powerOut && `Out: ${fmtN(id.part.powerOut.voltage)} V · ${fmtN(id.part.powerOut.watts)} W${id.part.powerOut.efficiency ? ` · η ${id.part.powerOut.efficiency}` : ""}`,
              id.part.mech.rackUnits && `${id.part.mech.rackUnits}U`, id.part.mech.dinWidthMm && `DIN ${id.part.mech.dinWidthMm} mm`].filter(Boolean).join(" · ")}
            {id.part ? "" : partLabel(undefined)}
          </p>
        )}
      </div>
    </div>
  );
}

/** Device tags of a part line: defined in Mechanical Design (read only here), validated against the quantity. */
function DeviceTagsRO({ n, parents, devs }: { n: BomNode; parents: BomNode[]; devs?: TreeEditorProps["devs"] }) {
  const mine = devs?.entries.filter((e) => e.bomId === n.id) ?? [];
  const tags = n.tags;
  const role = nodeRole(n, parents.length);
  const dup = tags.filter((t) => devs?.dupes.has(t.toUpperCase()));
  const ok = tags.length === Math.round(n.qty || 0) && !dup.length;
  return (
    <div className="f devro">
      <span>Device tags ({tags.length} for qty {n.qty}) <span className="muted">— defined in Mechanical Design</span></span>
      <div className={`devro-box${tags.length ? (ok ? " ok" : " warn") : ""}`} aria-readonly="true">
        {tags.length ? tags.map((t) => (
          <code key={t} className={devs?.dupes.has(t.toUpperCase()) ? "dup" : undefined} title={mine.filter((e) => e.tag.toUpperCase() === t.toUpperCase()).map((e) => e.layout).join(", ") || (n.mechTags ? "" : "Not from Mechanical Design (imported or set earlier)")}>{signed(t, role)}</code>
        )) : <span className="muted">None yet: number the placed devices of this line in Mechanical Design (rack / FNE right panel).</span>}
      </div>
      {tags.length > 0 && !ok && (
        <span className="errtxt">{dup.length ? `Duplicate device tag${dup.length > 1 ? "s" : ""}: ${dup.join(", ")}. ` : ""}{tags.length !== Math.round(n.qty || 0) ? `${tags.length} defined for a quantity of ${n.qty}.` : ""}</span>
      )}
      {tags.length > 0 && !n.mechTags && <span className="muted" style={{ fontSize: 12 }}>These tags were not defined in Mechanical Design (e.g. imported); they are replaced as soon as devices of this line are numbered there.</span>}
    </div>
  );
}
