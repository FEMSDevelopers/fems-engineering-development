import { useState } from "react";

/**
 * Drag-and-drop reordering of list rows from a handle at the far left of each row: spread `handle(i)` on the handle
 * element and `row(i)` on the row. `onMove(from, to)` receives indices in the current order.
 */
export function useRowDrag(onMove: (from: number, to: number) => void) {
  const [from, setFrom] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const end = () => (setFrom(null), setOver(null));
  const handle = (i: number) => ({
    draggable: true,
    className: "grip",
    role: "button",
    "aria-label": "Drag to move this row",
    title: "Drag to move",
    onDragStart: (e: React.DragEvent) => {
      e.stopPropagation();
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/x-fpl-row", String(i));
      setFrom(i);
    },
    onDragEnd: end,
  });
  const row = (i: number) => ({
    onDragOver: (e: React.DragEvent) => {
      if (from == null) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (over !== i) setOver(i);
    },
    onDrop: (e: React.DragEvent) => {
      if (from == null) return;
      e.preventDefault();
      if (from !== i) onMove(from, i);
      end();
    },
    "data-drop": over === i && from != null && from !== i ? (from < i ? "after" : "before") : undefined,
    "data-dragging": from === i ? "1" : undefined,
  });
  return { handle, row, dragging: from };
}

/** Move one element of a list from index `a` to index `b`. */
export function moveItem<T>(l: T[], a: number, b: number): T[] {
  const n = l.slice();
  const [x] = n.splice(a, 1);
  n.splice(b, 0, x);
  return n;
}
