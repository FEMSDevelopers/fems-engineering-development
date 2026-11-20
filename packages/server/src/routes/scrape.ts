import { htmlToText } from "@fpl/core";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

const MAX = 25 * 1024 * 1024;

/** Private, loopback, link-local and other non-public addresses are refused (the server must not be a proxy into the LAN). */
export function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  const s = ip.toLowerCase();
  if (s.startsWith("::ffff:")) return isPrivateIp(s.slice(7));
  return s === "::" || s === "::1" || s.startsWith("fc") || s.startsWith("fd") || s.startsWith("fe80");
}
async function assertPublic(u: URL) {
  if (!/^https?:$/.test(u.protocol)) throw new Error("Only http(s) links can be read");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addrs = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  if (!addrs.length || addrs.some(isPrivateIp)) throw new Error("That address is on a private network; only public OEM pages can be read");
}

/** Read an OEM product page or datasheet link for "Fill from OEM page / datasheet" in the part editor. */
export function scrapeRoutes(app: FastifyInstance) {
  app.post("/api/parts/scrape", async (req, reply) => {
    const { url } = z.object({ url: z.string().min(4).max(2000) }).parse(req.body);
    let u: URL;
    try {
      u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    } catch {
      return reply.code(400).send({ error: "Not a valid link" });
    }
    try {
      // Follow redirects by hand so every hop is checked.
      let res: Response | null = null;
      for (let hop = 0; hop < 6; hop++) {
        await assertPublic(u);
        res = await fetch(u, {
          redirect: "manual",
          signal: AbortSignal.timeout(25000),
          headers: { "user-agent": "Mozilla/5.0 (Fractal EMS engineering tools; parts list)", accept: "text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.5" },
        });
        const loc = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
        if (!loc) break;
        u = new URL(loc, u);
        res = null;
      }
      if (!res) return reply.code(400).send({ error: "Too many redirects" });
      if (!res.ok) return reply.code(502).send({ error: `The page answered ${res.status} ${res.statusText}` });
      const len = Number(res.headers.get("content-length") ?? 0);
      if (len > MAX) return reply.code(413).send({ error: "File larger than 25 MB" });
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX) return reply.code(413).send({ error: "File larger than 25 MB" });
      const type = res.headers.get("content-type") ?? "";
      if (/pdf/i.test(type) || buf.subarray(0, 5).toString() === "%PDF-") return { kind: "pdf", url: u.href, pdf: buf.toString("base64") };
      if (!/html|xml|text/i.test(type)) return reply.code(415).send({ error: `Can't read ${type || "this file type"}; link an HTML page or a PDF datasheet` });
      const pdfLinks = [...buf.toString("utf8").matchAll(/href=["']([^"']+\.pdf(?:\?[^"']*)?)["']/gi)].map((m) => new URL(m[1].replace(/&amp;/g, "&"), u).href);
      return { kind: "html", url: u.href, ...htmlToText(buf.toString("utf8")), pdfLinks: [...new Set(pdfLinks)].slice(0, 30) };
    } catch (e) {
      return reply.code(502).send({ error: `Couldn't read the page: ${(e as Error).message}` });
    }
  });
}
