import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
import { UiProvider } from "./ui";
import { initProject } from "./project";
import { PdfViewer } from "./viewer/PdfViewer";

// Full-window PDF viewer tab (opened from a document preview): no project needed.
if (new URLSearchParams(location.search).get("viewer") === "pdf")
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <PdfViewer />
    </StrictMode>,
  );
// The project must be known before anything is loaded (every /api request names it).
else void initProject().then(() =>
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <UiProvider>
        <App />
      </UiProvider>
    </StrictMode>,
  ),
);
