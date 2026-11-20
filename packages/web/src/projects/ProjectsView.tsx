import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, errMsg } from "../api";
import { useColResize } from "../colResize";
import { NumIn, TextIn } from "../bom/shared";
import { HoldButton, useLocal, useUi } from "../ui";
import { PROJECT_STAGES, PROJECT_STATES, currentProjectId, forgetProject, projectLabel, switchProject, type Project } from "../project";

/** Projects list, shared by the rail button and the Projects section (refreshed after every change). */
export function useProjects() {
  const [items, setItems] = useState<Project[]>([]);
  const [err, setErr] = useState("");
  const refresh = useCallback(() => api.projects.list().then((l) => (setItems(l), setErr(""))).catch((e) => setErr(errMsg(e))), []);
  useEffect(() => {
    refresh();
    window.addEventListener("fpl:projects-changed", refresh);
    return () => window.removeEventListener("fpl:projects-changed", refresh);
  }, [refresh]);
  return { items, err, refresh };
}
const changed = () => window.dispatchEvent(new Event("fpl:projects-changed"));
const stateOrder = (s: string) => (PROJECT_STATES.indexOf(s) < 0 ? 9 : PROJECT_STATES.indexOf(s));

/**
 * 📔 at the bottom of the rail: a click opens the project switcher; click and hold 0.25 s opens the Projects section.
 */
export function ProjectRailButton({ onOpenSection, active }: { onOpenSection: () => void; active: boolean }) {
  const { items } = useProjects();
  const cur = items.find((p) => p.id === currentProjectId());
  const [menu, setMenu] = useState<DOMRect | null>(null);
  const [holding, setHolding] = useState(false);
  const t = useRef(0);
  const held = useRef(false);
  const btn = useRef<HTMLButtonElement>(null);
  const cancel = () => {
    window.clearTimeout(t.current);
    setHolding(false);
  };
  return (
    <>
      <button ref={btn} type="button" className={`projbtn${holding ? " holding" : ""}`} aria-current={active ? "page" : undefined}
        title={`Project: ${cur?.name ?? "…"}\nClick: change project · click and hold: Projects section`} aria-label="Projects"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          held.current = false;
          setHolding(true);
          t.current = window.setTimeout(() => {
            held.current = true;
            setHolding(false);
            setMenu(null);
            onOpenSection();
          }, 250);
        }}
        onPointerUp={cancel}
        onPointerLeave={cancel}
        onPointerCancel={cancel}
        onClick={() => {
          if (held.current) return void (held.current = false);
          setMenu((m) => (m ? null : btn.current!.getBoundingClientRect()));
        }}>
        <span className="pe" aria-hidden="true">📔</span>
        <span className="pl">{cur ? projectLabel(cur) : "…"}</span>
      </button>
      {menu && createPortal(<ProjectMenu at={menu} items={items} onManage={() => (setMenu(null), onOpenSection())} onClose={() => setMenu(null)} />, document.body)}
    </>
  );
}

function ProjectMenu({ at, items, onManage, onClose }: { at: DOMRect; items: Project[]; onManage: () => void; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [q, setQ] = useState("");
  const [showClosed, setShowClosed] = useState(false);
  const cur = currentProjectId();
  useEffect(() => {
    const down = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && !(e.target as HTMLElement).closest?.(".projbtn") && onClose();
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", down, true);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("mousedown", down, true);
      window.removeEventListener("keydown", key);
    };
  }, [onClose]);
  const ql = q.trim().toLowerCase();
  const list = items
    .filter((p) => (showClosed || p.activeState !== "Closed" || p.id === cur) && (!ql || [p.name, p.alias, p.contractor, p.endUser, p.state, p.country].join(" ").toLowerCase().includes(ql)))
    .sort((a, b) => stateOrder(a.activeState) - stateOrder(b.activeState) || (b.lastUsedAt ?? "").localeCompare(a.lastUsedAt ?? "") || a.name.localeCompare(b.name));
  const closed = items.filter((p) => p.activeState === "Closed").length;
  return (
    <div ref={box} className="projmenu" role="dialog" aria-label="Change project" style={{ left: at.right + 8, bottom: Math.max(8, window.innerHeight - at.bottom) }}>
      <input type="search" autoFocus placeholder="Search projects…" aria-label="Search projects" value={q} onChange={(e) => setQ(e.target.value)} />
      <ul>
        {list.map((p) => (
          <li key={p.id}>
            <button type="button" aria-current={p.id === cur ? "true" : undefined} disabled={p.id === cur} onClick={() => void switchProject(p.id)}
              title={[p.name, p.contractor && `Contractor: ${p.contractor}`, p.endUser && `End-user: ${p.endUser}`, p.stage && `Stage: ${p.stage}`].filter(Boolean).join("\n")}>
              <span className="nm">{p.id === cur ? "✓ " : ""}{p.name}{p.alias ? <span className="muted"> · {p.alias}</span> : null}</span>
              <span className="meta muted">{[p.stage, p.activeState !== "Active" ? p.activeState : "", [p.state, p.country].filter(Boolean).join(", ")].filter(Boolean).join(" · ")}</span>
            </button>
          </li>
        ))}
        {!list.length && <li className="muted" style={{ padding: 8 }}>No project matches.</li>}
      </ul>
      <div className="pmf">
        {closed > 0 && <label className="chk-l"><input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} /> Closed ({closed})</label>}
        <span className="grow" />
        <button type="button" className="btn-ghost" onClick={onManage}>Manage projects…</button>
      </div>
    </div>
  );
}

const FIELDS: { key: keyof Project; label: string; w?: number; num?: boolean }[] = [
  { key: "name", label: "Name", w: 200 }, { key: "alias", label: "Alias", w: 90 }, { key: "country", label: "Country", w: 90 }, { key: "state", label: "State", w: 70 },
  { key: "contractor", label: "Contractor", w: 130 }, { key: "endUser", label: "End-user", w: 130 }, { key: "iso", label: "ISO", w: 80 },
  { key: "dispatcher", label: "Dispatcher", w: 110 }, { key: "qse", label: "QSE", w: 110 }, { key: "kw", label: "kW", w: 80, num: true },
  { key: "kwh", label: "kWh", w: 80, num: true }, { key: "pcsOem", label: "PCS OEM", w: 110 }, { key: "bessOem", label: "BESS OEM", w: 110 },
];

/** Projects section (click and hold 📔): first sub-module, the list of projects. */
export function ProjectsView({ active }: { active: boolean }) {
  const ui = useUi();
  const { items, err, refresh } = useProjects();
  const [tab, setTab] = useLocal<"list">("fpl.project.tab", "list");
  const [filter, setFilter] = useLocal<string>("fpl.project.filter", "");
  const [q, setQ] = useState("");
  const [counts, setCounts] = useState<Record<string, Record<string, number>>>({});
  const colRef = useColResize("projects.list");
  const cur = currentProjectId();
  useEffect(() => {
    if (active) refresh();
  }, [active, refresh]);
  useEffect(() => {
    if (!active) return;
    for (const p of items) if (!counts[p.id]) api.projects.counts(p.id).then((c) => setCounts((m) => ({ ...m, [p.id]: c }))).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, items]);
  const patch = async (p: Project, b: Partial<Project>) => {
    try {
      await api.projects.update(p.id, b);
      changed();
    } catch (e) {
      ui.toast(errMsg(e));
      refresh();
    }
  };
  const ql = q.trim().toLowerCase();
  const rows = useMemo(
    () => items.filter((p) => (!filter || p.activeState === filter) && (!ql || FIELDS.some((f) => String(p[f.key] ?? "").toLowerCase().includes(ql)))),
    [items, filter, ql],
  );
  const create = async () => {
    const name = await ui.prompt("Name of the new project", "", "Create");
    if (!name?.trim()) return;
    try {
      const p = await api.projects.create({ name: name.trim(), activeState: "Active", stage: "Proposal" });
      changed();
      if (await ui.confirm(`“${p.name}” created — it starts empty (the master parts list, naming standards, assembly templates and other shared tools are available). Switch to it now?`, "Switch")) await switchProject(p.id);
    } catch (e) {
      ui.toast(errMsg(e));
    }
  };
  const remove = async (p: Project) => {
    const c = counts[p.id];
    const what = c ? `${c.sources} sources, ${c.devices} devices, ${c.connections} connections, ${c.bom_projects} project BOMs, ${c.mech_racks + c.mech_fnes} layouts, ${c.json_instances} JSON instances` : "all of its content";
    const typed = await ui.prompt(`Delete project “${p.name}” and ${what}? This cannot be undone. Type the project name to confirm.`, "", "Delete");
    if (typed == null) return;
    try {
      await api.projects.remove(p.id, typed);
      forgetProject(p.id);
      changed();
      ui.toast(`Project “${p.name}” deleted`);
    } catch (e) {
      ui.toast(errMsg(e));
    }
  };
  return (
    <section className="view simple projects" aria-label="Projects">
      <header className="toolbar">
        <h1>Projects</h1>
        <div className="seg" role="tablist" aria-label="Projects section">
          <button type="button" role="tab" aria-pressed={tab === "list"} onClick={() => setTab("list")}>Projects ({items.length})</button>
        </div>
        <span className="muted projnote">Each project has every tool but only its own content. Shared by all projects: master parts list, naming standards and Python formats, assembly templates, table formatting, unit / data-type sets, column-condition rule sets, device categories, protocols, function libraries.</span>
      </header>
      {tab === "list" && (
        <div className="projlist">
          <div className="toolbar">
            <button type="button" className="btn-primary" onClick={create}>+ New project</button>
            <div className="seg" role="group" aria-label="Active state">
              {["", ...PROJECT_STATES].map((s) => <button key={s || "all"} type="button" aria-pressed={filter === s} onClick={() => setFilter(s)}>{s || "All"} ({s ? items.filter((p) => p.activeState === s).length : items.length})</button>)}
            </div>
            <input type="search" placeholder="Search name, contractor, OEM…" aria-label="Search projects" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 240 }} />
            {err && <span className="chip err">{err}</span>}
          </div>
          <div className="scroll">
            <table className="net projtab" ref={colRef}>
              <thead>
                <tr>
                  <th />
                  {FIELDS.map((f) => <th key={f.key} className={f.num ? "num" : undefined}>{f.label}</th>)}
                  <th>Project stage</th>
                  <th>Active state</th>
                  <th title="Content of the project">Content</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => {
                  const c = counts[p.id];
                  const isCur = p.id === cur;
                  return (
                    <tr key={p.id} className={[isCur && "cur", p.activeState === "Closed" && "closed"].filter(Boolean).join(" ")}>
                      <td>{isCur ? <span className="chip info" title="Current project">current</span> : <button type="button" className="btn-ghost" onClick={() => void switchProject(p.id)}>Switch</button>}</td>
                      {FIELDS.map((f) => (
                        <td key={f.key} className={f.num ? "num" : undefined}>
                          {f.num
                            ? <NumIn label={`${f.label} of ${p.name}`} value={p[f.key] as number | null} min={0} width={f.w} onChange={(v) => patch(p, { [f.key]: v })} />
                            : <TextIn label={`${f.label} of ${p.name}`} value={String(p[f.key] ?? "")} width={f.w} onChange={(v) => (f.key === "name" && !v.trim() ? refresh() : patch(p, { [f.key]: v }))} />}
                        </td>
                      ))}
                      <td>
                        <select aria-label={`Project stage of ${p.name}`} value={p.stage} onChange={(e) => patch(p, { stage: e.target.value })}>
                          <option value="">—</option>
                          {[...new Set([...PROJECT_STAGES, p.stage].filter(Boolean))].map((s) => <option key={s}>{s}</option>)}
                        </select>
                      </td>
                      <td>
                        <select aria-label={`Active state of ${p.name}`} value={p.activeState} onChange={(e) => patch(p, { activeState: e.target.value })}>
                          {[...new Set([...PROJECT_STATES, p.activeState].filter(Boolean))].map((s) => <option key={s}>{s}</option>)}
                        </select>
                      </td>
                      <td className="muted" style={{ fontSize: 12 }} title={c ? Object.entries(c).map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`).join("\n") : undefined}>
                        {c ? `${c.sources} src · ${c.devices} dev · ${c.connections} conn · ${c.bom_projects} BOM · ${c.mech_racks + c.mech_fnes} layouts` : "…"}
                      </td>
                      <td>
                        {!isCur && items.length > 1 && <HoldButton ms={500} className="btn-ghost btn-danger" label={`Delete project ${p.name}`} onHold={() => void remove(p)}>✕</HoldButton>}
                      </td>
                    </tr>
                  );
                })}
                {!rows.length && <tr><td colSpan={FIELDS.length + 5} className="muted">No project.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}
