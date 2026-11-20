import { NAMING_PLACEHOLDER_HELP, NAMING_PLACEHOLDERS, PN_SHORTHANDS, aliasOf, pnFields, type CustomFieldDef, type MfrAliases, type Part } from "@fpl/core";
import { useRef, useState } from "react";
import { Modal } from "../ui";
import { useMfrAliases } from "./aliases";

export type Entry = { token: string; label: string; value?: unknown };
type NamingDocLike = { prefix?: string; suffix?: string; title?: string; kind?: string; ref?: string };
const cap = (k: string) => k.charAt(0).toUpperCase() + k.slice(1);
const show = (v: unknown) => (v == null || v === "" ? "" : Array.isArray(v) ? (v.length === 2 && typeof v[0] !== "string" ? `${v[0] ?? ""}–${v[1] ?? ""}` : v.join(", ")) : typeof v === "object" ? JSON.stringify(v) : String(v));

const POWER_KEYS = ["kind", "voltage", "range", "watts", "amps", "pf", "feeds", "terminals", "efficiency"];

/** Fields of a part that rules can reference, per tab (Python syntax or naming placeholders). */
export function fieldTabs(mode: "python" | "naming", part: Partial<Part> | undefined, sub: string, aliases: MfrAliases, specFields: CustomFieldDef[] = [], doc?: NamingDocLike, extra?: [string, Entry[]][]): [string, Entry[]][] {
  const p = { manufacturer: "", partNumber: "", series: "", description: "", category: "", vendor: "", powerIn: null, powerOut: null, custom: {}, ...(part ?? {}) } as Part;
  const f = pnFields(p, sub, { aliases });
  const aliasTab: Entry[] = [
    ...(mode === "python" ? [{ token: "mfr_alias", label: "alias of this part's manufacturer", value: f.general.manufacturerAlias }, { token: 'General["ManufacturerAlias"]', label: "same, from General", value: f.general.manufacturerAlias }] : [{ token: "{mfra}", label: "alias of this part's manufacturer", value: aliasOf(aliases, p.manufacturer) }]),
    ...Object.entries(aliases).sort((a, b) => a[0].localeCompare(b[0])).map(([m, a]) => ({ token: mode === "python" ? `"${a}"` : a, label: m, value: a })),
  ];
  if (mode === "naming")
    return [
      ["Document naming", NAMING_PLACEHOLDERS.map((k) => ({ token: `{${k}}`, label: NAMING_PLACEHOLDER_HELP[k] ?? k, value: ({ mfr: p.manufacturer, pn: p.partNumber, series: p.series, sub, mfra: aliasOf(aliases, p.manufacturer), prefix: doc?.prefix ?? "", suffix: doc?.suffix ?? "", title: doc?.title ?? "", kind: doc?.kind ?? "", std: (doc?.ref ?? "").replace(/^cert:/, "") } as Record<string, string>)[k] }))],
      ["Manufacturer alias", aliasTab],
    ];
  const keysOf = (o: Record<string, unknown>, extra: string[]) => [...new Set([...extra, ...Object.keys(o)])].filter((k) => k !== "id");
  return [
    ["General", ["partNumber", "manufacturer", "manufacturerAlias", "series", "description", "category", "subcategory", "vendor"].map((k) => ({ token: `General["${cap(k)}"]`, label: k, value: (f.general as Record<string, unknown>)[k] }))],
    ["Configuration", Object.entries(f.config).map(([k, v]) => ({ token: `Config["${cap(k)}"]`, label: k, value: v }))],
    ["Power in", keysOf(f.powerIn, POWER_KEYS.filter((k) => k !== "efficiency")).map((k) => ({ token: `PowerIn["${k}"]`, label: k, value: f.powerIn[k] }))],
    ["Power out", keysOf(f.powerOut, ["kind", "voltage", "watts", "amps", "efficiency", "terminals"]).map((k) => ({ token: `PowerOut["${k}"]`, label: k, value: f.powerOut[k] }))],
    ["Specification", [...specFields.filter((x) => x.type !== "certs").map((x) => ({ token: `Spec["${x.key}"]`, label: `${x.label}${x.unit ? ` (${x.unit})` : ""}`, value: f.spec[x.key] })), ...Object.keys(f.spec).filter((k) => !specFields.some((x) => x.key === k)).map((k) => ({ token: `Spec["${k}"]`, label: k, value: f.spec[k] }))]],
    ["Shorthands", PN_SHORTHANDS.map(([k, l]) => ({ token: k, label: l, value: ({ pn: p.partNumber, mfr: p.manufacturer, mfr_alias: f.general.manufacturerAlias, series: p.series, sku: p.sku, config1: p.configCode1, config2: p.configCode2, config3: p.configCode3, desc: p.description, sub, cat: p.category, nl: "↵" } as Record<string, unknown>)[k] }))],
    ["Manufacturer alias", aliasTab],
    ...(extra ?? []),
    ["Syntax", [
      { token: 'f"{pn} ({sku})" if sku else pn', label: "conditional f-string" },
      { token: "nl.join(x for x in [pn, config1, config2] if x)", label: "one line per non-empty value" },
      { token: 'pn.upper().replace("-", "")', label: "string methods" },
      { token: 'Spec["poles"] == 3', label: "criteria (true / false)" },
      { token: 'mfr.lower() in ("siemens", "abb")', label: "criteria: one of" },
      { token: '"3VA" in pn', label: "criteria: contains" },
      { token: "x = pn\nif sku:\n    x += f\" ({sku})\"\nreturn x", label: "code block with return" },
    ]],
  ];
}

/** Text input for Python (or naming patterns) with a panel of the fields that can be referenced, by tab; click inserts at the cursor. */
export function PyEditor(props: PyEditorProps) {
  const [big, setBig] = useState(false);
  const { compact, value, onChange, label, preview, placeholder, mode = "python" } = props;
  const res = compact && preview && value.trim() ? preview(value) : null;
  return (
    <>
      {compact ? (
        <div className="pyfield">
          {label && <span className="muted pyed-l">{label}</span>}
          <div className="pyfield-row">
            <code className={`pyfield-v${value.trim() ? "" : " empty"}`} title={value} onClick={() => setBig(true)}>{value.trim() ? value.split("\n")[0] + (value.includes("\n") ? " …" : "") : placeholder || "(empty)"}</code>
            <button type="button" className="btn-ghost pyfx" onClick={() => setBig(true)} title={`Define with ${mode === "python" ? "Python" : "the pattern editor"}`}>ƒx Edit…</button>
            {value.trim() && <button type="button" className="btn-ghost" aria-label="Clear" onClick={() => onChange("")}>✕</button>}
          </div>
          {res && <span className={`pyfield-r${res.error ? " errtxt" : " muted"}`}>{res.error ? res.error : `→ ${res.text || "(empty)"}`}</span>}
        </div>
      ) : (
        <PyEditorInline {...props} onOpen={() => setBig(true)} />
      )}
      {big && <PyPopup {...props} onClose={() => setBig(false)} />}
    </>
  );
}

interface PyEditorProps {
  value: string; onChange: (v: string) => void; part?: Partial<Part>; sub?: string; specFields?: CustomFieldDef[]; mode?: "python" | "naming";
  rows?: number; placeholder?: string; label?: string; multiline?: boolean;
  /** Naming mode: the document whose prefix / suffix / title the panel shows. */
  namingDoc?: NamingDocLike;
  /** Extra tabs of names (e.g. the BOM part line of the documentation package). */
  extraTabs?: [string, Entry[]][];
  /** Show a one-line summary with an "ƒx Edit…" button; the code is written in a popup. */
  compact?: boolean;
  /** Live result of the code (shown under a compact field and in the popup). */
  preview?: (v: string) => { text: string; error?: string };
  /** Help shown at the top of the popup. */
  help?: string;
}

/** Popup editor: the code (large), the fields panel and the live result; Apply writes it back. */
function PyPopup(props: PyEditorProps & { onClose: () => void }) {
  const [draft, setDraft] = useState(props.value);
  const res = props.preview && draft.trim() ? props.preview(draft) : null;
  const multiline = props.mode !== "naming";
  return (
    <Modal onClose={props.onClose} label={props.label ?? "Python"}>
      <div className="mh"><h3>{props.label ?? (props.mode === "naming" ? "Pattern" : "Python")}</h3><span className="muted" style={{ fontSize: 12.5 }}>{props.help ?? (props.mode === "naming" ? "Click a field to insert it at the cursor." : "Expression, or several lines of code ending with return. Click a field to insert it at the cursor.")}</span></div>
      <div className="mb">
        <PyEditorInline {...props} label={undefined} value={draft} onChange={setDraft} rows={12} multiline={multiline} big />
        {res && <div className={`pnres${res.error ? " err" : ""}`}><span className="muted">Result:</span><pre>{res.text || "(empty)"}</pre>{res.error && <span className="errtxt">{res.error}</span>}</div>}
      </div>
      <div className="mf">
        <button type="button" onClick={props.onClose}>Cancel</button>
        <button type="button" className="btn-primary" onClick={() => (props.onChange(draft), props.onClose())}>Apply</button>
      </div>
    </Modal>
  );
}

function PyEditorInline({ value, onChange, part, sub = "", specFields, mode = "python", rows = 3, placeholder, label, multiline = true, namingDoc, extraTabs, onOpen, big }: {
  value: string; onChange: (v: string) => void; part?: Partial<Part>; sub?: string; specFields?: CustomFieldDef[]; mode?: "python" | "naming";
  rows?: number; placeholder?: string; label?: string; multiline?: boolean;
  /** Naming mode: the document whose prefix / suffix / title the panel shows. */
  namingDoc?: NamingDocLike;
  /** Extra tabs of names (e.g. the BOM part line of the documentation package). */
  extraTabs?: [string, Entry[]][];
  onOpen?: () => void;
  big?: boolean;
}) {
  const aliases = useMfrAliases();
  const tabs = fieldTabs(mode, part, sub, aliases, specFields, namingDoc, extraTabs);
  const [tab, setTab] = useState(tabs[0][0]);
  const [open, setOpen] = useState(true);
  const ref = useRef<HTMLTextAreaElement & HTMLInputElement>(null);
  const insert = (t: string) => {
    const el = ref.current;
    const a = el?.selectionStart ?? value.length;
    const b = el?.selectionEnd ?? value.length;
    const v = value.slice(0, a) + t + value.slice(b);
    onChange(v);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(a + t.length, a + t.length);
    });
  };
  const cur = tabs.find(([k]) => k === tab) ?? tabs[0];
  return (
    <div className={`pyed${open ? " open" : ""}${big ? " big" : ""}`}>
      <div className="pyed-in">
        {label && <span className="muted pyed-l">{label}</span>}
        {multiline ? (
          <textarea ref={ref} className="mono" rows={rows} value={value} spellCheck={false} placeholder={placeholder} aria-label={label} onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Tab") {
                e.preventDefault();
                insert("    ");
              }
            }} />
        ) : (
          <input ref={ref} type="text" className="mono" value={value} spellCheck={false} placeholder={placeholder} aria-label={label} onChange={(e) => onChange(e.target.value)} />
        )}
        <span className="pyed-tools">
          {onOpen && <button type="button" className="btn-ghost pyed-t" onClick={onOpen} title="Open in a larger editor">ƒx Open editor…</button>}
          <button type="button" className="btn-ghost pyed-t" onClick={() => setOpen(!open)} title="Fields that can be referenced">{open ? "Hide fields ▸" : "◂ Fields"}</button>
        </span>
      </div>
      {open && (
        <div className="pyed-panel" role="region" aria-label="Fields">
          <div className="tabs" role="tablist">
            {tabs.map(([k, l]) => <button key={k} type="button" role="tab" className="tab" aria-selected={cur[0] === k} onClick={() => setTab(k)}>{k}{l.length && k !== "Syntax" ? <span className="muted"> {l.length}</span> : null}</button>)}
          </div>
          <ul className="pyed-list">
            {cur[1].map((e, i) => (
              <li key={i}>
                <button type="button" className="btn-ghost" title={`Insert ${e.token}`} onClick={() => insert(e.token)}>
                  <code>{e.token.split("\n")[0]}{e.token.includes("\n") ? " …" : ""}</code>
                  <span className="muted">{e.label}</span>
                  {show(e.value) && <span className="pyv">{show(e.value).slice(0, 40)}</span>}
                </button>
              </li>
            ))}
            {!cur[1].length && <li className="muted" style={{ padding: 6 }}>Nothing in this tab for this part.</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
