import type { PartDoc } from "@fpl/core";
import { api, errMsg } from "../api";
import { HoldButton, useUi } from "../ui";

/** Manufacturer + product series a part's documents can move to (the saved part's), or null when it has none. */
export type SeriesRef = { mfr: string; series: string } | null;

/** ⏫: hold 0.5 s to move a part's document (or certificate) to the part's product series. */
export function ToSeriesBtn({ doc, series, onMoved }: { doc: PartDoc; series: SeriesRef; onMoved: () => void }) {
  const ui = useUi();
  const name = doc.title || doc.fileName || doc.url;
  return (
    <HoldButton ms={500} className="btn-ghost tosrs" label={`Move ${name} to the product series`} disabled={!series || !!doc.seriesName}
      title={doc.seriesName ? "Already a product-series document" : series ? `Move to product series ${series.mfr} · ${series.series} (hold 0.5s): listed under every part of the series` : "Define the product series (Item information → General) and save the part to move documents to it"}
      onHold={async () => {
        try {
          const m = await api.parts.docToSeries(doc.id);
          ui.toast(`Moved to product series ${m.seriesMfr} · ${m.seriesName}`);
        } catch (e) {
          ui.toast(errMsg(e));
        }
        onMoved();
      }}>⏫</HoldButton>
  );
}

/** P-Series tag of a document hosted by the product series; hold 0.3 s to open the product-series documents. */
export function PSeriesTag({ doc, onOpen }: { doc: PartDoc; onOpen?: () => void }) {
  if (!doc.seriesName) return null;
  return (
    <HoldButton ms={300} className="chip pseries-tag" label={`Product series ${doc.seriesMfr} · ${doc.seriesName}`}
      title={`Hosted by product series ${doc.seriesMfr} · ${doc.seriesName} — listed under every part of the series. Hold 0.3s to open the product-series documents.`}
      onHold={() => onOpen?.()}>P-Series</HoldButton>
  );
}
