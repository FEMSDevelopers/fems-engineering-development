import { ASM_KINDS, latest } from "@fpl/core";
import { useEffect, useMemo, useState } from "react";
import { api, type AsmItem } from "../api";
import { useLocal } from "../ui";

interface F {
  path: string;
  name: string;
  kids: F[];
}
/** Read-only template library directory (folders from Mechanical Design → Template library), with search and kind filter. */
export function TplTree({ tpls, cur, onPick }: { tpls: AsmItem[]; cur: string | null; onPick: (t: AsmItem) => void }) {
  const [folders, setFolders] = useState<string[]>([]);
  const [open, setOpen] = useLocal<string[]>("fpl.bom.tplopen", []);
  const [q, setQ] = useState("");
  const [kindF, setKindF] = useState("");
  useEffect(() => void api.asmFolders.list().then(setFolders).catch(() => {}), [tpls]);
  const tree = useMemo(() => {
    const root: F = { path: "", name: "", kids: [] };
    for (const p of [...new Set([...folders, ...tpls.map((t) => t.folder).filter(Boolean)])].sort()) {
      let c = root;
      const parts = p.split("/");
      parts.forEach((nm, i) => {
        const path = parts.slice(0, i + 1).join("/");
        let k = c.kids.find((x) => x.path === path);
        if (!k) c.kids.push((k = { path, name: nm, kids: [] }));
        c = k;
      });
    }
    return root.kids;
  }, [folders, tpls]);
  const ql = q.trim().toLowerCase();
  const inF = (path: string) => tpls.filter((t) => (t.folder || "") === path && (!kindF || t.kind === kindF) && (!ql || `${t.code} ${t.name}`.toLowerCase().includes(ql)));
  const count = (f: F): number => inF(f.path).length + f.kids.reduce((s, k) => s + count(k), 0);
  const Row = ({ t, depth }: { t: AsmItem; depth: number }) => {
    const v = latest(t.versions);
    return (
      <li className={`tplrow${t.id === cur ? " sel" : ""}`} style={{ paddingLeft: 8 + depth * 14 }} onClick={() => v && onPick(t)} title={ASM_KINDS.find(([k]) => k === t.kind)?.[1] ?? t.kind}>
        <span className="ico">▦</span><span className="nm">{t.code ? <span className="mono">{t.code} · </span> : null}{t.name}</span><span className="muted">{v ? `v${v.major}.${String(v.minor).padStart(3, "0")}` : "—"}</span>
      </li>
    );
  };
  const Fold = ({ f, depth }: { f: F; depth: number }) => {
    const n = count(f);
    if ((ql || kindF) && !n) return null;
    const isOpen = open.includes(f.path) || !!ql;
    return (
      <>
        <li className="fold" style={{ paddingLeft: 4 + depth * 14 }} onClick={() => setOpen((o) => (o.includes(f.path) ? o.filter((x) => x !== f.path) : [...o, f.path]))}>
          <span className="twisty">{isOpen ? "▾" : "▸"}</span><span className="ico">📁</span>{f.name}<span className="muted" style={{ marginLeft: "auto" }}>{n}</span>
        </li>
        {isOpen && (
          <>
            {f.kids.map((k) => <Fold key={k.path} f={k} depth={depth + 1} />)}
            {inF(f.path).map((t) => <Row key={t.id} t={t} depth={depth + 1} />)}
          </>
        )}
      </>
    );
  };
  return (
    <div className="tpllib tpltree">
      <div className="toolbar sub" style={{ padding: "4px 8px", gap: 6 }}>
        <input type="search" placeholder="Search templates" aria-label="Search templates" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1, minWidth: 120 }} />
        <select aria-label="Filter by kind" style={{ maxWidth: 120 }} value={kindF} onChange={(e) => setKindF(e.target.value)}>
          <option value="">All kinds</option>
          {ASM_KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </div>
      <div className="scroll">
        <ul className="tlib">
          {tree.map((f) => <Fold key={f.path} f={f} depth={0} />)}
          {inF("").map((t) => <Row key={t.id} t={t} depth={0} />)}
          {!tpls.length && <li className="muted" style={{ padding: 10, fontSize: 12.5 }}>No templates yet. Build them in Mechanical Design → Assemblies (Save to library…) or save a project group with “Save as template…”.</li>}
        </ul>
      </div>
    </div>
  );
}
