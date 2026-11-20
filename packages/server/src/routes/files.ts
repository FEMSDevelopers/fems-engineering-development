import { normalizeGrid, parseDelimited, type Grid } from "@fpl/core";
import ExcelJS from "exceljs";
import type { FastifyInstance } from "fastify";

/** Excel cell value → display text (dates as ISO, formulas as their cached result). */
function cellText(v: ExcelJS.CellValue): string {
  if (v == null) return "";
  if (v instanceof Date) {
    const iso = v.toISOString();
    return v.getUTCHours() || v.getUTCMinutes() || v.getUTCSeconds() ? iso.replace(/\.000Z$/, "Z") : iso.slice(0, 10);
  }
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "object") {
    if ("result" in v) return cellText((v as ExcelJS.CellFormulaValue).result as ExcelJS.CellValue);
    if ("richText" in v) return (v as ExcelJS.CellRichTextValue).richText.map((t) => t.text).join("");
    if ("text" in v) return String((v as ExcelJS.CellHyperlinkValue).text);
    if ("error" in v) return String((v as ExcelJS.CellErrorValue).error);
  }
  return String(v);
}

export async function parseWorkbook(buf: Buffer): Promise<{ name: string; grid: Grid }[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  return wb.worksheets.map((ws) => {
    const rows: string[][] = [];
    ws.eachRow({ includeEmpty: true }, (row, n) => {
      const vals = row.values as ExcelJS.CellValue[]; // 1-based
      const out: string[] = [];
      for (let c = 1; c < vals.length; c++) out.push(cellText(vals[c]));
      rows[n - 1] = out;
    });
    for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
    return { name: ws.name, grid: normalizeGrid(rows) };
  });
}

/** POST /api/parse-file (multipart "file") → { sheets: [{ name, grid }] } */
export function fileRoutes(app: FastifyInstance) {
  app.post("/api/parse-file", async (req, reply) => {
    const part = await req.file();
    if (!part) return reply.code(400).send({ error: "No file uploaded" });
    const buf = await part.toBuffer();
    const name = part.filename.toLowerCase();
    if (/\.(csv|tsv|txt)$/.test(name)) return { sheets: [{ name: part.filename, grid: parseDelimited(buf.toString("utf8").replace(/^﻿/, "")) }] };
    if (/\.(xlsx|xlsm)$/.test(name)) {
      try {
        return { sheets: await parseWorkbook(buf) };
      } catch {
        return reply.code(422).send({ error: "Couldn't read that workbook. Is it a valid .xlsx file?" });
      }
    }
    return reply.code(415).send({ error: "Unsupported file type. Use .xlsx, .xlsm, .csv, .tsv or .txt (save older .xls files as .xlsx)." });
  });
}
