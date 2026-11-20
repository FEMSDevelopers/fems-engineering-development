// Wait until a URL answers 2xx, then exit 0. Used so the web UI (and the browser) start only once the API is ready.
// Usage: node tools/wait-url.mjs <url> [timeoutSeconds=120] [label]
// Exits 0 on timeout as well (with a warning), so the next step still runs.
const [url, timeoutArg = "120", label = url] = process.argv.slice(2);
if (!url) {
  console.error("usage: node tools/wait-url.mjs <url> [timeoutSeconds] [label]");
  process.exit(2);
}
const deadline = Date.now() + Number(timeoutArg) * 1000;
let announced = false;
for (;;) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
    if (r.ok) {
      if (announced) console.log(`${label} is ready.`);
      process.exit(0);
    }
  } catch {
    /* not up yet */
  }
  if (!announced) {
    console.log(`Waiting for ${label} …`);
    announced = true;
  }
  if (Date.now() > deadline) {
    console.warn(`${label} did not answer within ${timeoutArg}s; continuing anyway.`);
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 500));
}
