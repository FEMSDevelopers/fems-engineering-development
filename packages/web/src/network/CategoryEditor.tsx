import type { Device, DeviceCategory } from "@fpl/core";
import { useState } from "react";
import { api, errMsg } from "../api";
import { ColorPick, Modal, useUi } from "../ui";

const PALETTE = ["#2f7f8a", "#c46a1f", "#5b4fc4", "#3d8b3d", "#6b7782", "#b8417a", "#1f6fc4", "#8a6d2f"];

/** Add, rename, recolour, reorder and delete device categories. Saves as you go. */
export function CategoryEditor({ categories, devices, onChanged, onClose }: { categories: DeviceCategory[]; devices: Device[]; onChanged: () => Promise<void>; onClose: () => void }) {
  const ui = useUi();
  const [list, setList] = useState(categories);
  const used = (id: string) => devices.filter((d) => d.categoryId === id).length;

  const run = async (f: () => Promise<unknown>) => {
    try {
      await f();
      await onChanged();
    } catch (e) {
      ui.toast(`Couldn’t save: ${errMsg(e)}`);
    }
  };
  const patch = (id: string, b: Partial<DeviceCategory>) => {
    setList((l) => l.map((c) => (c.id === id ? { ...c, ...b } : c)));
    run(() => api.categories.update(id, b));
  };
  const move = (i: number, to: number) => {
    if (to < 0 || to >= list.length) return;
    const o = list.slice();
    const [m] = o.splice(i, 1);
    o.splice(to, 0, m);
    setList(o);
    run(() => api.categories.reorder(o.map((c) => c.id)));
  };
  const add = async () => {
    const name = await ui.prompt("New category name", "");
    if (!name) return;
    try {
      const c = await api.categories.create({ name, color: PALETTE[list.length % PALETTE.length] });
      setList([...list, c]);
      await onChanged();
    } catch (e) {
      ui.toast(errMsg(e));
    }
  };
  const del = async (c: DeviceCategory) => {
    const n = used(c.id);
    if (!(await ui.confirm(`Delete category “${c.name}”?${n ? ` ${n} device(s) will have no category.` : ""}`, "Delete"))) return;
    setList(list.filter((x) => x.id !== c.id));
    run(() => api.categories.remove(c.id));
  };

  return (
    <Modal onClose={onClose} size="sm" label="Device categories">
      <div className="mh"><h3>Device categories</h3></div>
      <div className="mb">
        <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>Categories are filters in Network → Devices and in the Data flow connection dialog. Changes save immediately.</p>
        <ul className="cated">
          {list.map((c, i) => (
            <li key={c.id}>
              <ColorPick label={`Colour of ${c.name}`} value={c.color} onCommit={(v) => patch(c.id, { color: v })} />
              <input type="text" aria-label="Category name" defaultValue={c.name} onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== c.name && patch(c.id, { name: e.target.value.trim() })} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
              <span className="muted use">{used(c.id)} device{used(c.id) === 1 ? "" : "s"}</span>
              <button type="button" className="btn-ghost" aria-label="Move up" disabled={i === 0} onClick={() => move(i, i - 1)}>↑</button>
              <button type="button" className="btn-ghost" aria-label="Move down" disabled={i === list.length - 1} onClick={() => move(i, i + 1)}>↓</button>
              <button type="button" className="btn-ghost btn-danger" aria-label={`Delete ${c.name}`} onClick={() => del(c)}>✕</button>
            </li>
          ))}
        </ul>
        <div><button type="button" onClick={add}>Add category</button></div>
      </div>
      <div className="mf"><button type="button" className="btn-primary" onClick={onClose}>Done</button></div>
    </Modal>
  );
}
