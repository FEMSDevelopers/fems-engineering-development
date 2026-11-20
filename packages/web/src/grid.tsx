import { normName, parseDelimited, type Issue, type RowIssues } from "@fpl/core";
import { useState } from "react";
import { errMsg } from "./api";
import { ColorPick, Modal, useUi } from "./ui";

export interface GridCol<T> {
  /** Field name (or a virtual column id for kind "custom"). */
  key: string;
  /** Issue field shown on this column (defaults to key). */
  field?: string;
  label: string;
  mono?: boolean;
  kind?: "text" | "select" | "check" | "readonly" | "custom" | "color";
  /** color: shown when the stored value is empty (automatic colour). */
  auto?: (row: T) => string;
  /** custom: cell content */
  render?: (row: T) => React.ReactNode;
  /** select: [value, label] pairs */
  options?: (row: T) => [string, string][];
  placeholder?: (row: T) => string;
  /** readonly: what to show */
  display?: (row: T) => string;
  title?: string;
}

/** Spreadsheet-like table of inputs. Text saves on blur/Enter; selects and checkboxes save on change. */
export function EditGrid<T extends { id: string }>({
  rows, cols, issues, onSave, onDelete, rowStyle, rowTitle, group, sub, collapsed = [], onToggleGroup,
}: {
  rows: T[];
  cols: GridCol<T>[];
  issues: RowIssues;
  onSave: (id: string, key: string, value: string | boolean) => void;
  onDelete: (row: T) => void;
  rowStyle?: (row: T) => React.CSSProperties | undefined;
  rowTitle?: (row: T) => string | undefined;
  /** Rows (already sorted) get a header row whenever the group changes, if there is more than one group. */
  group?: (row: T) => { key: string; label: React.ReactNode };
  /** Second-level sections inside each group (always shown when given). */
  sub?: (row: T) => { key: string; label: React.ReactNode };
  /** Collapsed section keys ("g" or "g|s"). */
  collapsed?: string[];
  onToggleGroup?: (key: string) => void;
}) {
  const groups = group ? rows.map(group) : [];
  const subs = sub ? rows.map(sub) : [];
  const grouped = new Set(groups.map((g) => g.key)).size > 1;
  const gk = (i: number) => (grouped ? groups[i].key : "");
  const sk = (i: number) => `${gk(i)}|${subs[i]?.key ?? ""}`;
  const count = (pred: (i: number) => boolean) => rows.reduce((n, _r, i) => n + (pred(i) ? 1 : 0), 0);
  const closed = new Set(collapsed);
  const header = (key: string, label: React.ReactNode, n: number, level: 1 | 2) => {
    const open = !closed.has(key);
    return (
      <tr key={`g:${key}`} className={`grp${level === 2 ? " sub" : ""}`}>
        <td colSpan={cols.length + 2}>
          <button type="button" className="gcaret" aria-expanded={open} aria-label={open ? "Collapse section" : "Expand section"} onClick={() => onToggleGroup?.(key)} disabled={!onToggleGroup}>
            {open ? "▾" : "▸"}
          </button>
          {label} <span className="muted gcount">({n})</span>
        </td>
      </tr>
    );
  };
  return (
    <table className="net">
      <thead>
        <tr>
          {cols.map((c) => <th key={c.key} title={c.title}>{c.label}</th>)}
          <th>Checks</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {rows.map((r, ri) => {
          const is: Issue[] = issues[r.id] ?? [];
          const newG = grouped && (ri === 0 || gk(ri - 1) !== gk(ri));
          const newS = !!sub && (ri === 0 || sk(ri - 1) !== sk(ri));
          const gOpen = !grouped || !closed.has(gk(ri));
          const sOpen = !sub || !closed.has(sk(ri));
          const head = [
            newG ? header(gk(ri), groups[ri].label, count((i) => gk(i) === gk(ri)), 1) : null,
            newS && gOpen ? header(sk(ri), subs[ri].label, count((i) => sk(i) === sk(ri)), 2) : null,
          ];
          if (!gOpen || !sOpen) return head;
          return [
            ...head,
            <tr key={r.id} style={rowStyle?.(r)} title={rowTitle?.(r)}>
              {cols.map((c) => {
                const fi = is.filter((i) => i.field === (c.field ?? c.key));
                const cls = [c.mono && "mono-in", fi.some((i) => i.level === "error") ? "bad" : fi.length ? "warnc" : ""].filter(Boolean).join(" ");
                const raw = (r as unknown as Record<string, unknown>)[c.key];
                const val = raw == null ? "" : String(raw);
                const title = fi.map((i) => i.msg).join("\n") || undefined;
                let cell: React.ReactNode;
                if (c.kind === "custom") cell = c.render?.(r);
                else if (c.kind === "color")
                  cell = (
                    <span className="colorcell">
                      <ColorPick label={c.label} value={val || c.auto?.(r) || "#6b7782"} onCommit={(v) => v !== (val || c.auto?.(r)) && onSave(r.id, c.key, v)} />
                      {!val ? <span className="muted">auto</span> : <button type="button" className="btn-ghost" title="Back to automatic colour" onClick={() => onSave(r.id, c.key, "")}>↺</button>}
                    </span>
                  );
                else if (c.kind === "readonly") cell = <span className="ro">{c.display ? c.display(r) : val}</span>;
                else if (c.kind === "check")
                  cell = <input type="checkbox" aria-label={c.label} checked={!!raw} onChange={(e) => onSave(r.id, c.key, e.target.checked)} />;
                else if (c.kind === "select")
                  cell = (
                    <select aria-label={c.label} value={val} onChange={(e) => onSave(r.id, c.key, e.target.value)}>
                      {c.options?.(r).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                  );
                else
                  cell = (
                    <input
                      type="text"
                      aria-label={c.label}
                      defaultValue={val}
                      key={r.id + c.key + val}
                      placeholder={c.placeholder?.(r)}
                      spellCheck={false}
                      onBlur={(e) => e.target.value.trim() !== val && onSave(r.id, c.key, e.target.value.trim())}
                      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                    />
                  );
                return (
                  <td key={c.key} className={[cls, c.kind === "check" && "chk", c.kind === "custom" && "cus"].filter(Boolean).join(" ") || undefined} title={title}>
                    {cell}
                  </td>
                );
              })}
              <td className="iss" title={is.map((i) => `${i.level === "error" ? "Error" : "Warning"}: ${i.msg}`).join("\n") || "OK"}>
                {is.length ? <span className={`chip${is.some((i) => i.level === "error") ? " err" : ""}`}>{is.length} issue{is.length === 1 ? "" : "s"}</span> : <span className="muted">OK</span>}
              </td>
              <td><button type="button" className="btn-ghost btn-danger" aria-label="Delete row" onClick={() => onDelete(r)}>✕</button></td>
            </tr>,
          ];
        })}
      </tbody>
    </table>
  );
}

export const issueCounts = (issues: RowIssues) => {
  const all = Object.values(issues).flat();
  return { err: all.filter((i) => i.level === "error").length, warn: all.filter((i) => i.level === "warn").length };
};

export interface ImportField {
  key: string;
  label: string;
  /** Normalized header names that map to this field. */
  syn: string[];
}

/** Paste rows from Excel (with a header row); headers are matched to fields by name. */
export function ImportModal({
  title, fields, note, convert, onImport, onClose,
}: {
  title: string;
  fields: ImportField[];
  note?: string;
  convert: (raw: Record<string, string>) => Record<string, unknown>;
  onImport: (rows: Record<string, unknown>[]) => Promise<unknown>;
  onClose: () => void;
}) {
  const ui = useUi();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const g = text.trim() ? parseDelimited(text) : [];
  const head = g[0] ?? [];
  const used = new Set<number>();
  const map = fields.map((f) => {
    const j = head.findIndex((h, k) => !used.has(k) && (f.syn.includes(normName(h)) || normName(h) === normName(f.label)));
    if (j >= 0) used.add(j);
    return j;
  });
  const mapped = fields.filter((_, i) => map[i] >= 0).map((f) => f.label);
  const go = async () => {
    const rows = g.slice(1).filter((r) => r.some((v) => v.trim())).map((r) => {
      const raw: Record<string, string> = {};
      fields.forEach((f, i) => map[i] >= 0 && (raw[f.key] = (r[map[i]] ?? "").trim()));
      return convert(raw);
    });
    setBusy(true);
    try {
      await onImport(rows);
      ui.toast(`Imported ${rows.length} rows`);
      onClose();
    } catch (e) {
      ui.toast(`Import failed: ${errMsg(e)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal onClose={onClose} label={title}>
      <div className="mh"><h3>{title}</h3></div>
      <div className="mb">
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          Paste rows from Excel with a header row. Recognised columns: {fields.map((f) => f.label).join(", ")}.{note ? ` ${note}` : ""}
        </p>
        <textarea rows={10} value={text} placeholder="Click here and press Ctrl+V" onChange={(e) => setText(e.target.value)} style={{ fontFamily: "var(--f-mono)", fontSize: 12 }} />
        <span className="muted">{g.length ? `${g.length - 1} rows · matched columns: ${mapped.join(", ") || "none"}` : "Nothing pasted yet"}</span>
      </div>
      <div className="mf">
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" disabled={busy || g.length < 2 || !mapped.length} onClick={go}>Import {Math.max(0, g.length - 1)} rows</button>
      </div>
    </Modal>
  );
}
