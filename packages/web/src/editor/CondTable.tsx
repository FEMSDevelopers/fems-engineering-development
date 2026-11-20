import { colName, dataRows, headerText, listOrder, type ColumnRules, type ConditionState } from "@fpl/core";
import { useState } from "react";
import { CellInput } from "./DataTable";

export type RuleKey = "na" | "n" | "q" | "tf" | "t10" | "r";
export const RULE_BUTTONS: [RuleKey, string, string][] = [
  ["na", "NA", "Leave this column out of the JSON"],
  ["n", "#", "Strip quotes from value"],
  ["q", '"#"', "Add quotes around value"],
  ["tf", "b_tf", "1 → true, 0 → false"],
  ["t10", "b_10", "true → 1, false → 0"],
  ["r", "b_r", "Invert b_tf / b_10"],
];

function Toggles({ state, onToggle, list = RULE_BUTTONS }: { state: (f: RuleKey) => boolean | "mixed"; onToggle: (f: RuleKey) => void; list?: [RuleKey, string, string][] }) {
  return (
    <div className="tg">
      {list.map(([f, l, t]) => (
        <button key={f} type="button" title={t} aria-pressed={state(f)} onClick={(e) => (e.stopPropagation(), onToggle(f))}>
          {l}
        </button>
      ))}
    </div>
  );
}

export function CondTable(p: {
  st: ConditionState;
  rules: ColumnRules[];
  tplIdx: number;
  selCol: number;
  onSelectCol: (j: number) => void;
  onToggle: (target: number | "all", f: RuleKey) => void;
  onToggleName: (f: "n" | "q") => void;
  onDef: (j: number, v: string) => void;
  onDrop: (j: number, beforeCol: number, after: boolean) => void;
  onEdit: (r: number, c: number, v: string) => void;
}) {
  const { st, rules } = p;
  const w = st.grid[0]?.length ?? 0;
  const fixed = st.opts.listOrder === "table";
  const row = dataRows(st)[p.tplIdx] ?? [];
  const off = st.opts.hdr ? 1 : 0;
  const [editing, setEditing] = useState<{ r: number; c: number } | null>(null);
  const [drag, setDrag] = useState<{ col: number; over?: number; after?: boolean } | null>(null);
  const allState = (f: RuleKey): boolean | "mixed" => {
    const on = rules.filter((r) => r[f]).length;
    return on === w && w > 0 ? true : on ? "mixed" : false;
  };
  const editable = (r: number, c: number, v: string, cls: string) =>
    editing?.r === r && editing.c === c ? (
      <td className={cls + " editing"}>
        <CellInput
          value={v}
          onDone={(nv) => {
            setEditing(null);
            if (nv !== null && nv !== v) p.onEdit(r, c, nv);
          }}
        />
      </td>
    ) : (
      <td className={cls + (v === "" ? " empty" : "")} onDoubleClick={() => (r >= 0 ? setEditing({ r, c }) : undefined)}>
        {v}
      </td>
    );

  return (
    <table className={`grid ct${fixed ? " fixed" : ""}`}>
      <thead>
        <tr>
          <th className="idx">Col</th>
          <th />
          <th>Column name</th>
          <th>Value in row [{p.tplIdx}]</th>
          <th>Rules</th>
          <th title="Used when a cell in this column is empty">If empty</th>
        </tr>
        <tr className="tgr">
          <th className="idx" />
          <th className="all" colSpan={3}>All columns (values)</th>
          <th><Toggles state={allState} onToggle={(f) => p.onToggle("all", f)} /></th>
          <th />
        </tr>
        <tr className="tgr names">
          <th className="idx" />
          <th className="all" colSpan={3}>Column names (JSON keys)</th>
          <th>
            <Toggles
              state={(f) => !!st.nameRule[f as "n" | "q"]}
              onToggle={(f) => p.onToggleName(f as "n" | "q")}
              list={[["n", "#", "Strip quotes from column names"], ["q", '"#"', "Add quotes around column names"]]}
            />
          </th>
          <th />
        </tr>
      </thead>
      <tbody>
        {listOrder(st).map((j) => {
          const r = rules[j];
          const cls = [j === p.selCol && "sel", r.na && "na", drag?.col === j && "dragging", drag?.over === j && (drag.after ? "drop-after" : "drop-before")]
            .filter(Boolean)
            .join(" ");
          return (
            <tr
              key={j}
              className={cls || undefined}
              onClick={() => !editing && p.onSelectCol(j)}
              onDragOver={(e) => {
                if (!drag) return;
                e.preventDefault();
                const rc = e.currentTarget.getBoundingClientRect();
                const after = e.clientY > rc.top + rc.height / 2;
                if (drag.over !== j || drag.after !== after) setDrag({ ...drag, over: j, after });
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (drag && drag.col !== j) p.onDrop(drag.col, j, !!drag.after);
                setDrag(null);
              }}
            >
              <td className="idx">{colName(j)}</td>
              <td
                className="hdl"
                draggable={!fixed}
                title={fixed ? "Switch List to Rearranged to drag" : "Drag to reorder (Alt+↑/↓ also works)"}
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", String(j));
                  setDrag({ col: j });
                }}
                onDragEnd={() => setDrag(null)}
              >
                ⋮⋮
              </td>
              {editable(st.opts.hdr ? 0 : -1, j, headerText(st, j), "nm")}
              {editable(p.tplIdx + off, j, row[j] ?? "", "val")}
              <td>
                <Toggles state={(f) => !!r[f]} onToggle={(f) => p.onToggle(j, f)} />
              </td>
              <td className="def">
                <input
                  type="text"
                  value={r.def}
                  placeholder="leave empty"
                  spellCheck={false}
                  aria-label={`Value for empty cells in ${headerText(st, j)}`}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => p.onDef(j, e.target.value)}
                />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
