import { useCallback, useState } from "react";
import { BomView } from "./bom/BomView";
import { DataFlowView } from "./dataflow/DataFlowView";
import { EditorView, type EditorRequest } from "./editor/EditorView";
import { JsonView } from "./json/JsonView";
import { MechView } from "./mech/MechView";
import { NetworkView } from "./network/NetworkView";
import { OutputsView } from "./outputs/OutputsView";
import { SourcesView } from "./sources/SourcesView";
import { ICONS, useLocal } from "./ui";
import { ProjectRailButton, ProjectsView } from "./projects/ProjectsView";

type View = "sources" | "editor" | "json" | "network" | "dataflow" | "outputs" | "bom" | "mech" | "projects";
const NAV: [Exclude<View, "projects">, string][] = [
  ["sources", "Sources"],
  ["editor", "Excel → JSON editor"],
  ["network", "Network"],
  ["dataflow", "Data flow"],
  ["outputs", "Outputs"],
  ["json", "JSON editor"],
  ["bom", "Parts & BOM"],
  ["mech", "Mechanical Design"],
];

export function App() {
  const [nav, setNav] = useLocal<{ view: View }>("fpl.nav", { view: "sources" });
  const [request, setRequest] = useState<EditorRequest | null>(null);
  /** Sources hands columns or a saved profile to the editor. */
  const openInEditor = useCallback(
    (r: EditorRequest) => {
      setRequest({ ...r, nonce: Date.now() });
      setNav({ view: "editor" });
    },
    [setNav],
  );
  const view = nav.view;
  return (
    <div className="shell">
      <nav className="rail" aria-label="Modules">
        {NAV.map(([v, label]) => (
          <button key={v} type="button" title={label} aria-label={label} aria-current={view === v ? "page" : undefined} onClick={() => setNav({ view: v })}>
            {ICONS[v]}
          </button>
        ))}
        <span className="rail-grow" />
        {/* 📔 click: change project · click and hold 0.25 s: Projects section. */}
        <ProjectRailButton active={view === "projects"} onOpenSection={() => setNav({ view: "projects" })} />
      </nav>
      {/* Every module stays mounted so drafts and selections survive switching. */}
      <div hidden={view !== "sources"} className="module">
        <SourcesView active={view === "sources"} openInEditor={openInEditor} />
      </div>
      <div hidden={view !== "editor"} className="module">
        <EditorView active={view === "editor"} request={request} onRequestHandled={() => setRequest(null)} />
      </div>
      <div hidden={view !== "json"} className="module">
        <JsonView active={view === "json"} />
      </div>
      <div hidden={view !== "network"} className="module">
        <NetworkView active={view === "network"} />
      </div>
      <div hidden={view !== "dataflow"} className="module">
        <DataFlowView active={view === "dataflow"} />
      </div>
      <div hidden={view !== "bom"} className="module">
        <BomView active={view === "bom"} />
      </div>
      <div hidden={view !== "mech"} className="module">
        <MechView active={view === "mech"} />
      </div>
      <div hidden={view !== "projects"} className="module">
        <ProjectsView active={view === "projects"} />
      </div>
      <div hidden={view !== "outputs"} className="module">
        <OutputsView active={view === "outputs"} />
      </div>
    </div>
  );
}
