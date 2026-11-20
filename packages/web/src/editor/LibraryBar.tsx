import { fmtDateTime, latest, sameVer, verLabel, type Ver } from "@fpl/core";
import { useState } from "react";
import { errMsg, type Versioned, type VersionedStore } from "../api";

type Item = Versioned & { sourceName?: string | null };
export interface MetaColumn {
  key: string;
  label: string;
  options: string[];
}
const metaOf = (v: { meta?: Record<string, unknown> } | undefined, c?: MetaColumn) => (c && v?.meta?.[c.key] != null ? String(v.meta[c.key]) : "");
import { HoldButton, Modal, Popover, useUi } from "../ui";

/** Saved-profile picker: table · Recent · version · sub-version · Edit… */
export function LibraryBar(p: {
  /** API for the saved items (editor profiles, diagrams, ...). */
  store: VersionedStore;
  /** "table", "diagram" ... used in labels. */
  noun?: string;
  profiles: Item[];
  profileId: string | null;
  loaded: Ver | null;
  onPickProfile: (id: string | null) => void;
  onLoad: (id: string, v: Ver) => void;
  onChanged: () => void;
  onDetach: () => void;
  /** Recent lists the latest saves of every variant (with a hold-to-delete ❌), not only the current one. */
  recentAll?: boolean;
  /** A version metadata value shown with each version and editable in Edit… (e.g. a BOM's stage); also written into the saved data. */
  metaColumn?: MetaColumn;
}) {
  const ui = useUi();
  const [editing, setEditing] = useState(false);
  const cur = p.profiles.find((x) => x.id === p.profileId);
  const versions = cur?.versions ?? [];
  const majors = [...new Set(versions.map((v) => v.major))].sort((a, b) => b - a);
  const mj = p.loaded && majors.includes(p.loaded.major) ? p.loaded.major : majors[0];
  const minors = versions.filter((v) => v.major === mj).sort((a, b) => b.minor - a.minor);
  const recent = (p.recentAll ? p.profiles.flatMap((x) => x.versions.map((v) => ({ ...v, pid: x.id, pname: x.name }))) : versions.map((v) => ({ ...v, pid: cur?.id ?? "", pname: cur?.name ?? "" })))
    .sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)))
    .slice(0, 20);
  const delVersion = async (pid: string, v: Ver) => {
    try {
      await p.store.removeVersion(pid, v.major, v.minor);
      ui.toast(`Deleted v${verLabel(v)}`);
      p.onChanged();
    } catch (e) {
      ui.toast(`Couldn’t delete: ${errMsg(e)}`);
    }
  };
  return (
    <div className="lib">
      <span className="ctl">Saved</span>
      <select aria-label={`Saved ${p.noun ?? "table"}`} value={cur ? cur.id : ""} onChange={(e) => p.onPickProfile(e.target.value || null)}>
        <option value="">— Unsaved / new {p.noun ?? "table"} —</option>
        {p.profiles.map((x) => (
          <option key={x.id} value={x.id}>
            {x.name}
            {p.metaColumn && metaOf(latest(x.versions), p.metaColumn) ? ` (${metaOf(latest(x.versions), p.metaColumn)})` : ""}
            {x.sourceName ? ` · ${x.sourceName}` : ""}
          </option>
        ))}
      </select>
      <Popover label={p.recentAll ? `Last 20 saves of all ${p.noun ?? "table"} variants` : `Last 20 saves of this ${p.noun ?? "table"}`} button="Recent" align="right">
        {(close) => (
          <div className="recmenu">
            <table>
              <thead><tr>{p.recentAll && <th>Variant</th>}<th>Version</th>{p.metaColumn && <th>{p.metaColumn.label}</th>}<th>Date saved</th>{p.recentAll && <th aria-label="Delete" />}</tr></thead>
              <tbody>
                {recent.length ? (
                  recent.map((v) => (
                    <tr
                      key={`${v.pid}:${v.major}.${v.minor}`}
                      tabIndex={0}
                      className={v.pid === p.profileId && sameVer(v, p.loaded) ? "cur" : undefined}
                      title={`${v.stamp}${v.notes ? " · " + v.notes : ""}`}
                      onClick={() => (close(), p.onLoad(v.pid, v))}
                      onKeyDown={(e) => e.key === "Enter" && (close(), p.onLoad(v.pid, v))}
                    >
                      {p.recentAll && <td className="vname">{v.pname}</td>}
                      <td>{verLabel(v)}</td>
                      {p.metaColumn && <td>{metaOf(v, p.metaColumn)}</td>}
                      <td>{fmtDateTime(v.savedAt)}</td>
                      {p.recentAll && (
                        <td className="del">
                          <HoldButton label={`Delete ${v.pname} v${verLabel(v)}`} onHold={() => delVersion(v.pid, v)}>❌</HoldButton>
                        </td>
                      )}
                    </tr>
                  ))
                ) : (
                  <tr><td colSpan={p.recentAll ? 4 : 2} className="muted">No saves yet</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </Popover>
      <select aria-label="Version" disabled={!majors.length} value={mj ?? ""} onChange={(e) => {
        const v = latest(versions.filter((x) => x.major === +e.target.value));
        if (v && cur) p.onLoad(cur.id, v);
      }}>
        {majors.length ? majors.map((m) => <option key={m} value={m}>v{m}</option>) : <option value="">v–</option>}
      </select>
      <select aria-label="Sub-version" disabled={!minors.length} value={p.loaded && p.loaded.major === mj ? p.loaded.minor : ""} onChange={(e) => {
        const v = minors.find((x) => x.minor === +e.target.value);
        if (v && cur) p.onLoad(cur.id, v);
      }}>
        {minors.length ? (
          minors.map((v) => (
            <option key={v.minor} value={v.minor}>
              .{String(v.minor).padStart(3, "0")}
              {metaOf(v, p.metaColumn) ? ` (${metaOf(v, p.metaColumn)})` : ""}
              {v.notes ? ` — ${v.notes.slice(0, 30)}` : ""}
            </option>
          ))
        ) : (
          <option value="">.–––</option>
        )}
      </select>
      <button type="button" disabled={!cur} onClick={() => setEditing(true)}>Edit…</button>
      {editing && cur && (
        <EditProfileModal store={p.store} noun={p.noun ?? "table"} profile={cur} loaded={p.loaded} metaColumn={p.metaColumn} onClose={() => setEditing(false)} onChanged={p.onChanged} onDetach={p.onDetach} />
      )}
    </div>
  );
}

function EditProfileModal({ store, noun, profile, loaded, metaColumn, onClose, onChanged, onDetach }: { profile: Item; store: VersionedStore; noun: string; loaded: Ver | null; metaColumn?: MetaColumn; onClose: () => void; onChanged: () => void; onDetach: () => void }) {
  const ui = useUi();
  const [name, setName] = useState(profile.name);
  const rows = profile.versions.slice().sort((a, b) => b.major - a.major || b.minor - a.minor);
  const [notes, setNotes] = useState(() => Object.fromEntries(rows.map((v) => [verLabel(v), { notes: v.notes, updateNotes: v.updateNotes }])));
  const [del, setDel] = useState<Set<string>>(new Set());
  const [metaVals, setMetaVals] = useState(() => Object.fromEntries(rows.map((v) => [verLabel(v), metaOf(v, metaColumn)])));
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      if (name.trim() && name.trim() !== profile.name) await store.rename(profile.id, name.trim());
      for (const v of rows) {
        const k = verLabel(v);
        if (del.has(k)) continue;
        const n = notes[k];
        const mv = metaColumn && metaVals[k] !== metaOf(v, metaColumn) ? { meta: { [metaColumn.key]: metaVals[k] }, dataSet: { [metaColumn.key]: metaVals[k] } } : {};
        if (n.notes !== v.notes || n.updateNotes !== v.updateNotes || "meta" in mv) await store.notes(profile.id, v.major, v.minor, { ...n, ...mv });
      }
      for (const v of rows) if (del.has(verLabel(v))) await store.removeVersion(profile.id, v.major, v.minor);
      if (del.size && del.size === rows.length) {
        await store.remove(profile.id);
        onDetach();
        ui.toast(`All versions deleted; ${noun} removed from the list`);
      } else {
        if (loaded && del.has(verLabel(loaded))) onDetach();
        ui.toast("Changes saved");
      }
      onChanged();
      onClose();
    } catch (e) {
      ui.toast(`Couldn’t save changes: ${errMsg(e)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal onClose={onClose} label={`Edit saved ${noun}`}>
      <div className="mh"><h3>Edit saved {noun}</h3>{profile.sourceName && <span className="chip info">Source: {profile.sourceName}</span>}</div>
      <div className="mb">
        <label className="f" style={{ maxWidth: 420 }}>
          {noun[0].toUpperCase() + noun.slice(1)} name
          <input type="text" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
        </label>
        <div style={{ overflowX: "auto" }}>
          <table className="vt">
            <thead><tr><th>Version</th>{metaColumn && <th>{metaColumn.label}</th>}<th>Saved</th><th>Size</th><th>Notes</th><th>Update notes</th><th /></tr></thead>
            <tbody>
              {rows.map((v) => {
                const k = verLabel(v);
                const d = del.has(k);
                const m = v.meta as { rows?: number; cols?: number };
                return (
                  <tr key={k} className={[d && "del", sameVer(v, loaded) && "cur"].filter(Boolean).join(" ") || undefined}>
                    <td className="v">v{k}</td>
                    {metaColumn && (
                      <td>
                        <input type="text" list={`meta-${metaColumn.key}`} aria-label={`${metaColumn.label} of v${k}`} value={metaVals[k]} style={{ width: 90 }} onChange={(e) => setMetaVals({ ...metaVals, [k]: e.target.value })} />
                        <datalist id={`meta-${metaColumn.key}`}>{metaColumn.options.map((o) => <option key={o} value={o} />)}</datalist>
                      </td>
                    )}
                    <td className="ts">{v.stamp}<br />{fmtDateTime(v.savedAt)}</td>
                    <td className="ts">{m?.rows ?? "?"}×{m?.cols ?? "?"}</td>
                    <td><textarea aria-label={`Notes for v${k}`} value={notes[k].notes} onChange={(e) => setNotes({ ...notes, [k]: { ...notes[k], notes: e.target.value } })} /></td>
                    <td><textarea aria-label={`Update notes for v${k}`} value={notes[k].updateNotes} onChange={(e) => setNotes({ ...notes, [k]: { ...notes[k], updateNotes: e.target.value } })} /></td>
                    <td>
                      <button type="button" className="btn-danger" onClick={() => {
                        const s = new Set(del);
                        if (d) s.delete(k);
                        else s.add(k);
                        setDel(s);
                      }}>{d ? "Undo" : "Delete"}</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      <div className="mf">
        <span className="info">{del.size ? `${del.size} version${del.size === 1 ? "" : "s"} will be deleted when you save` : `${rows.length} saved version${rows.length === 1 ? "" : "s"}`}</span>
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" disabled={busy} onClick={save}>Save changes</button>
      </div>
    </Modal>
  );
}
