import { DEFAULT_DOC_EXTS, DEFAULT_DOC_PREFIXES, DEFAULT_DOC_WORDS, normExts, wildcardToRegExp, type DocPrefix, type DocWord, type Part } from "@fpl/core";
import { KindOptions, useDocKinds } from "./Naming";
import { useEffect, useMemo, useState } from "react";
import { api, errMsg, type DocScanItem, type DocScanRes } from "../api";
import { Modal, useUi } from "../ui";

/** Shared settings (database): folders, file types, prefix → kind, options. */
export const DOC_SCAN_SCOPE = "bom.doc-scan";
interface ScanCfg {
  dirs: { path: string; on: boolean }[];
  exts: string[];
  prefixes: DocPrefix[];
  /** Words recognised in the name when the prefix is unknown (off: unknown → Other). */
  useWords: boolean;
  words: DocWord[];
  mode: "add" | "overwrite";
  useSku: boolean;
}
const DEFAULT_CFG: ScanCfg = { dirs: [], exts: DEFAULT_DOC_EXTS, prefixes: DEFAULT_DOC_PREFIXES, useWords: false, words: DEFAULT_DOC_WORDS, mode: "add", useSku: false };
const ACTION: Record<DocScanItem["action"], [string, string]> = {
  add: ["New", "info"],
  replace: ["Overwrite", "warn"],
  exists: ["Already stored (same file name)", ""],
  identical: ["Already stored (same content)", ""],
  dup: ["Copy of a newer file listed above", ""],
  "too-big": ["Over 100 MB", "err"],
};
const kb = (n: number) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} kB`);

/** Parts → 🗃️: scan folders (and every sub-folder) for documents whose file name holds a part number. */
export function DocScanModal({ listed, selected, onDone, onClose }: { listed: Part[]; selected: Part[]; onDone: () => void; onClose: () => void }) {
  const ui = useUi();
  const [cfg, setCfg] = useState<ScanCfg>(DEFAULT_CFG);
  const [saved, setSaved] = useState("");
  const [status, setStatus] = useState<{ enabled: boolean; roots: string[]; platform: string } | null>(null);
  const [newDir, setNewDir] = useState("");
  const [extText, setExtText] = useState(DEFAULT_DOC_EXTS.join(", "));
  const [scope, setScope] = useState<"all" | "listed" | "selected">(selected.length ? "selected" : "all");
  const [busy, setBusy] = useState<string>("");
  const [res, setRes] = useState<DocScanRes | null>(null);
  const [pick, setPick] = useState<Set<number>>(new Set());
  const [kinds, setKinds] = useState<Record<number, string>>({});
  const [show, setShow] = useState<"todo" | "all">("todo");
  useEffect(() => {
    api.parts.docScanStatus().then(setStatus).catch(() => setStatus({ enabled: false, roots: [], platform: "" }));
    api.presets.list<ScanCfg>(DOC_SCAN_SCOPE).then((l) => {
      const c = l.find((x) => x.name === "default")?.data;
      if (c) {
        const m = { ...DEFAULT_CFG, ...c };
        setCfg(m);
        setExtText(m.exts.join(", "));
        setSaved(JSON.stringify(m));
      }
    }).catch(() => {});
  }, []);
  const cur = { ...cfg, exts: normExts(extText) };
  const dirty = JSON.stringify(cur) !== saved;
  const persist = async (c = cur) => {
    await api.presets.save(DOC_SCAN_SCOPE, "default", c);
    setSaved(JSON.stringify(c));
  };
  const dirs = cfg.dirs.filter((d) => d.on && d.path.trim()).map((d) => d.path.trim());
  const addDir = () => {
    const p = newDir.trim().replace(/^"(.*)"$/, "$1");
    if (!p || cfg.dirs.some((d) => d.path === p)) return;
    setCfg({ ...cfg, dirs: [...cfg.dirs, { path: p, on: true }] });
    setNewDir("");
  };
  const partIds = scope === "all" ? undefined : (scope === "listed" ? listed : selected).map((p) => p.id);
  const scan = async () => {
    setBusy("Scanning folders…");
    setRes(null);
    try {
      if (dirty) await persist();
      const r = await api.parts.docScan({ dirs, exts: cur.exts, prefixes: cur.prefixes.filter((p) => p.prefix.trim() || p.contains?.trim()).map((p) => ({ prefix: p.prefix.trim(), kind: p.kind, ...(p.contains?.trim() ? { contains: p.contains.trim() } : {}) })), words: cfg.useWords ? cur.words.filter((w) => w.word.trim().length >= 3) : [], partIds, mode: cfg.mode, useSku: cfg.useSku });
      setRes(r);
      setKinds({});
      setPick(new Set(r.items.map((it, i) => (it.action === "add" || it.action === "replace" ? i : -1)).filter((i) => i >= 0)));
    } catch (e) {
      ui.toast(errMsg(e));
    } finally {
      setBusy("");
    }
  };
  const items = res?.items ?? [];
  const rows = useMemo(() => items.map((it, i) => ({ it, i })).filter(({ it }) => show === "all" || it.action === "add" || it.action === "replace"), [items, show]);
  const count = (a: DocScanItem["action"]) => items.filter((x) => x.action === a).length;
  const chosen = [...pick].filter((i) => items[i] && (items[i].action === "add" || items[i].action === "replace"));
  const apply = async () => {
    const list = chosen.map((i) => ({ path: items[i].path, partId: items[i].partId, kind: kinds[i] ?? items[i].kind, replaceDocId: items[i].action === "replace" ? items[i].docId : null }));
    let added = 0;
    let replaced = 0;
    const errors: { path: string; error: string }[] = [];
    try {
      for (let k = 0; k < list.length; k += 25) {
        setBusy(`Storing documents… ${k}/${list.length}`);
        const r = await api.parts.docScanApply({ dirs, exts: cur.exts, items: list.slice(k, k + 25) });
        added += r.added;
        replaced += r.replaced;
        errors.push(...r.errors);
      }
      ui.toast(`${added} document(s) added, ${replaced} overwritten${errors.length ? `, ${errors.length} failed: ${errors[0].error}` : ""}`);
      onDone();
      if (!errors.length) onClose();
      else await scan();
    } catch (e) {
      ui.toast(errMsg(e));
    } finally {
      setBusy("");
    }
  };
  const kindOpts = useDocKinds([...cfg.prefixes.map((p) => p.kind), ...cfg.words.map((w) => w.kind)]);
  const off = status && !status.enabled;
  return (
    <Modal onClose={onClose} label="Scan folders for documents">
      <div className="mh"><h3>🗃️ Scan folders for documents</h3><span className="muted" style={{ fontSize: 12.5 }}>Finds files whose name contains a part number, in the folders below and all their sub-folders, and stores them as part documents.</span></div>
      <div className="mb docscan">
        {off && <div className="chip err" style={{ whiteSpace: "normal" }}>Folder scanning is turned off on this server (DOC_SCAN=off). It reads folders of the machine that runs the app server; enable it with DOC_SCAN=on.</div>}
        <div className="dsgrid">
          <fieldset className="sortbox">
            <legend>Folders to search (with every sub-folder)</legend>
            <ul className="dsdirs">
              {cfg.dirs.map((d, i) => {
                const rep = res?.dirs.find((x) => x.dir === d.path);
                return (
                  <li key={i}>
                    <input type="checkbox" aria-label={`Search ${d.path}`} checked={d.on} onChange={(e) => setCfg({ ...cfg, dirs: cfg.dirs.map((x, j) => (j === i ? { ...x, on: e.target.checked } : x)) })} />
                    <input type="text" aria-label="Folder path" value={d.path} className="mono" onChange={(e) => setCfg({ ...cfg, dirs: cfg.dirs.map((x, j) => (j === i ? { ...x, path: e.target.value } : x)) })} />
                    {rep && <span className={`chip ${rep.ok ? "info" : "err"}`} title={rep.error}>{rep.ok ? `${rep.files} file(s)` : rep.error}</span>}
                    {rep?.ok && rep.error && <span className="chip" title={rep.error}>some sub-folders unreadable</span>}
                    <button type="button" className="btn-ghost btn-danger" aria-label={`Remove ${d.path}`} onClick={() => setCfg({ ...cfg, dirs: cfg.dirs.filter((_x, j) => j !== i) })}>✕</button>
                  </li>
                );
              })}
              <li>
                <input type="text" className="mono" aria-label="New folder" placeholder={status?.platform === "win32" ? "C:\\Engineering\\Datasheets  or  \\\\server\\share\\Docs" : "/srv/datasheets"} value={newDir}
                  onChange={(e) => setNewDir(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addDir()} />
                <button type="button" onClick={addDir} disabled={!newDir.trim()}>+ Add folder</button>
              </li>
            </ul>
            <span className="muted" style={{ fontSize: 12 }}>Paths on the computer that runs the app server{status?.roots.length ? ` (allowed: ${status.roots.join("; ")})` : ""}. Paste a folder path from Explorer's address bar.</span>
          </fieldset>
          <fieldset className="sortbox">
            <legend>Document type by file-name prefix</legend>
            <table className="net dspfx">
              <thead><tr><th>Prefix</th><th title="Wildcard text the file name must contain (glob): * any characters, ? one character, [abc] / [a-z] one of, [!abc] none of, \ escapes. Case-insensitive. With a prefix too, both must match.">Contains (wildcard)</th><th>Files under</th><th /></tr></thead>
              <tbody>
                {cfg.prefixes.map((p, i) => (
                  <tr key={i}>
                    <td><input type="text" aria-label={`Prefix ${i + 1}`} value={p.prefix} className="mono" style={{ width: 70 }} placeholder="any" onChange={(e) => setCfg({ ...cfg, prefixes: cfg.prefixes.map((x, j) => (j === i ? { ...x, prefix: e.target.value.toUpperCase() } : x)) })} /></td>
                    <td>
                      <input type="text" aria-label={`Contains ${i + 1}`} value={p.contains ?? ""} className={`mono${p.contains?.trim() && !wildcardToRegExp(p.contains) ? " bad" : ""}`} style={{ width: 150 }} placeholder="(none)"
                        title="* any characters · ? one character · [abc] [a-z] one of · [!abc] none of · \ escapes" onChange={(e) => setCfg({ ...cfg, prefixes: cfg.prefixes.map((x, j) => (j === i ? { ...x, contains: e.target.value } : x)) })} />
                    </td>
                    <td>
                      <select aria-label={`Kind of prefix ${p.prefix}`} value={p.kind} onChange={(e) => setCfg({ ...cfg, prefixes: cfg.prefixes.map((x, j) => (j === i ? { ...x, kind: e.target.value } : x)) })}>
                        <KindOptions kinds={kindOpts} value={p.kind} />
                      </select>
                    </td>
                    <td><button type="button" className="btn-ghost btn-danger" aria-label={`Remove prefix ${p.prefix}`} onClick={() => setCfg({ ...cfg, prefixes: cfg.prefixes.filter((_x, j) => j !== i) })}>✕</button></td>
                  </tr>
                ))}
                <tr><td colSpan={4}><button type="button" className="btn-ghost" onClick={() => setCfg({ ...cfg, prefixes: [...cfg.prefixes, { prefix: "", contains: "", kind: "Manual" }] })}>+ Row</button>
                  <button type="button" className="btn-ghost" onClick={() => setCfg({ ...cfg, prefixes: DEFAULT_DOC_PREFIXES })}>Defaults (DS / IG / SS)</button></td></tr>
              </tbody>
            </table>
            <span className="muted" style={{ fontSize: 12 }}>The prefix is the text before the part number, part-line numbers left out (<code>DS_B1.2a_2907595.pdf</code> → DS). <b>Contains</b> is wildcard text the file name must contain, in standard glob syntax: <code>*</code> any characters, <code>?</code> one character, <code>[abc]</code> / <code>[0-9]</code> one of, <code>[!abc]</code> none of, <code>\</code> escapes (case-insensitive; e.g. <code>spec*sheet</code>, <code>*_IOM_*</code>, <code>rev[0-9]</code>, <code>*.docx</code>). A row with both needs both; a row with only Contains applies whatever the prefix. Rows are tried top to bottom, the first match wins. No match files under <b>Other</b>.</span>
            <label className="chk-l"><input type="checkbox" checked={cfg.useWords} onChange={(e) => setCfg({ ...cfg, useWords: e.target.checked })} /> When the prefix is unknown, also recognise words in the name</label>
            {cfg.useWords && (
              <table className="net dspfx">
                <thead><tr><th>Word in the name</th><th>Files under</th><th /></tr></thead>
                <tbody>
                  {cfg.words.map((w, i) => (
                    <tr key={i}>
                      <td><input type="text" aria-label={`Word ${i + 1}`} value={w.word} style={{ width: 140 }} onChange={(e) => setCfg({ ...cfg, words: cfg.words.map((x, j) => (j === i ? { ...x, word: e.target.value } : x)) })} /></td>
                      <td>
                        <select aria-label={`Kind of word ${w.word}`} value={w.kind} onChange={(e) => setCfg({ ...cfg, words: cfg.words.map((x, j) => (j === i ? { ...x, kind: e.target.value } : x)) })}>
                          <KindOptions kinds={kindOpts} value={w.kind} />
                        </select>
                      </td>
                      <td><button type="button" className="btn-ghost btn-danger" aria-label={`Remove word ${w.word}`} onClick={() => setCfg({ ...cfg, words: cfg.words.filter((_x, j) => j !== i) })}>✕</button></td>
                    </tr>
                  ))}
                  <tr><td colSpan={3}><button type="button" className="btn-ghost" onClick={() => setCfg({ ...cfg, words: [...cfg.words, { word: "", kind: "Manual" }] })}>+ Word</button>
                    <button type="button" className="btn-ghost" onClick={() => setCfg({ ...cfg, words: DEFAULT_DOC_WORDS })}>Defaults</button></td></tr>
                </tbody>
              </table>
            )}
            <label className="f">File types <input type="text" aria-label="File types" value={extText} onChange={(e) => setExtText(e.target.value)} placeholder="pdf, docx" /></label>
          </fieldset>
        </div>
        <div className="toolbar sub wrap" style={{ gap: "8px 18px" }}>
          <span className="seg" role="group" aria-label="Parts to match">
            <button type="button" aria-pressed={scope === "all"} onClick={() => setScope("all")}>All parts</button>
            <button type="button" aria-pressed={scope === "listed"} onClick={() => setScope("listed")}>Current list ({listed.length})</button>
            <button type="button" aria-pressed={scope === "selected"} disabled={!selected.length} onClick={() => setScope("selected")}>Ticked ({selected.length})</button>
          </span>
          <span className="seg" role="group" aria-label="Existing documents">
            <button type="button" aria-pressed={cfg.mode === "add"} onClick={() => setCfg({ ...cfg, mode: "add" })} title="A file whose name is already stored for the part is skipped">Add only files not yet stored</button>
            <button type="button" aria-pressed={cfg.mode === "overwrite"} onClick={() => setCfg({ ...cfg, mode: "overwrite" })} title="A stored document with the same file name gets the new file">Overwrite with the new files</button>
          </span>
          <label className="chk-l"><input type="checkbox" checked={cfg.useSku} onChange={(e) => setCfg({ ...cfg, useSku: e.target.checked })} /> Also match SKU / order codes</label>
          <span className="grow" />
          <button type="button" onClick={() => persist().then(() => ui.toast("Scan settings saved"))} disabled={!dirty}>Save settings</button>
          <button type="button" className="btn-primary" onClick={scan} disabled={!!busy || !dirs.length || !cur.exts.length || !!off}>{busy.startsWith("Scanning") ? busy : "Scan"}</button>
        </div>
        {res && (
          <>
            <div className="toolbar sub wrap">
              <span className="muted" style={{ fontSize: 12.5 }}>{res.scanned} file(s) looked at · {res.matched} match(es) · {res.unmatched} file(s) without a known part number{res.truncated ? " · stopped at 200 000 files" : ""}</span>
              <span className="chip info">{count("add")} new</span>
              {cfg.mode === "overwrite" && <span className="chip">{count("replace")} to overwrite</span>}
              <span className="chip">{count("exists") + count("identical")} already stored</span>
              {count("dup") > 0 && <span className="chip">{count("dup")} duplicate copies skipped</span>}
              {count("too-big") > 0 && <span className="chip err">{count("too-big")} too big</span>}
              <span className="grow" />
              <span className="seg" role="group" aria-label="Show">
                <button type="button" aria-pressed={show === "todo"} onClick={() => setShow("todo")}>To store</button>
                <button type="button" aria-pressed={show === "all"} onClick={() => setShow("all")}>All matches</button>
              </span>
            </div>
            {res.unmatchedFiles.length > 0 && (
              <details className="dsunm">
                <summary className="muted">{res.unmatched} file(s) without a known part number — add the part to the master list, or rename the file (e.g. <code>DS_&lt;part number&gt;.pdf</code>)</summary>
                <ul>{res.unmatchedFiles.map((f) => <li key={f} className="mono">{f}</li>)}</ul>
              </details>
            )}
            <div className="colprev dsres">
              <table className="net">
                <thead><tr>
                  <th><input type="checkbox" aria-label="Tick all" checked={rows.length > 0 && rows.every(({ i }) => pick.has(i) || !(items[i].action === "add" || items[i].action === "replace"))}
                    onChange={(e) => setPick(e.target.checked ? new Set([...pick, ...rows.filter(({ it }) => it.action === "add" || it.action === "replace").map(({ i }) => i)]) : new Set([...pick].filter((i) => !rows.some((r) => r.i === i))))} /></th>
                  <th>File</th><th>Part</th><th>Prefix</th><th>Document type</th><th>Size</th><th>Action</th>
                </tr></thead>
                <tbody>
                  {rows.slice(0, 2000).map(({ it, i }) => {
                    const can = it.action === "add" || it.action === "replace";
                    return (
                      <tr key={i} className={can ? undefined : "dim"}>
                        <td><input type="checkbox" aria-label={`Store ${it.name}`} disabled={!can} checked={can && pick.has(i)} onChange={() => setPick((s) => { const n = new Set(s); if (n.has(i)) n.delete(i); else n.add(i); return n; })} /></td>
                        <td title={it.path}><span className="mono">{it.rel}</span></td>
                        <td>{it.manufacturer} <b className="mono">{it.partNumber}</b></td>
                        <td className="mono" title={it.by === "word" ? "Kind from a word in the name" : it.by === "contains" ? "Kind from a Contains (wildcard) row" : it.by === "prefix" ? "Kind from the prefix" : "Unknown or no prefix: Other"}>{it.prefix || <span className="muted">—</span>}{it.by === "word" && <span className="muted"> · word</span>}{it.by === "contains" && <span className="muted"> · contains</span>}</td>
                        <td>
                          <select aria-label={`Kind of ${it.name}`} value={kinds[i] ?? it.kind} disabled={!can} onChange={(e) => setKinds({ ...kinds, [i]: e.target.value })}>
                            {kindOpts.map((k) => <option key={k}>{k}</option>)}
                          </select>
                        </td>
                        <td className="muted">{kb(it.size)}</td>
                        <td><span className={`chip ${ACTION[it.action][1]}`}>{ACTION[it.action][0]}</span></td>
                      </tr>
                    );
                  })}
                  {!rows.length && <tr><td colSpan={7} className="muted">{items.length ? "Nothing new to store — every match is already stored (show All matches)." : "No file name contains a part number of the chosen parts."}</td></tr>}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
      <div className="mf">
        {busy && <span className="muted">{busy}</span>}
        <span className="grow" />
        <button type="button" onClick={onClose}>Close</button>
        <button type="button" className="btn-primary" disabled={!chosen.length || !!busy} onClick={apply}>Store {chosen.length} document(s)</button>
      </div>
    </Modal>
  );
}
