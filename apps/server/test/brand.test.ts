// Brand files: the favicons, touch icon, wordmarks and web app manifest are served at the site root with the
// right content types, and every page we serve links them in its <head>.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MockChain } from "../src/chain/mock.ts";
import { createApp } from "../src/main.ts";

const FILES: [string, string][] = [
  ["/favicon.ico", "image/x-icon"],
  ["/favicon-light-32.png", "image/png"],
  ["/favicon-dark-32.png", "image/png"],
  ["/apple-touch-icon.png", "image/png"],
  ["/icon-192.png", "image/png"],
  ["/icon-512.png", "image/png"],
  ["/wordtrap-wordmark-light.png", "image/png"],
  ["/wordtrap-wordmark-dark.png", "image/png"],
];
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

test("brand: the eight brand URLs and the manifest answer 200 with the right content type at the site root", async () => {
  const app = createApp({ sim: false, makeChain: async () => new MockChain(), ledgerPath: null, cfg: { tiles: 2 } });
  const port = await app.listen(0);
  const base = `http://127.0.0.1:${port}`;
  try {
    for (const [path, type] of FILES) {
      const r = await fetch(base + path);
      assert.equal(r.status, 200, path);
      assert.equal(r.headers.get("content-type"), type, path);
      const body = Buffer.from(await r.arrayBuffer());
      assert.ok(body.length > 100, `${path} has content`);
      if (type === "image/png") assert.ok(body.subarray(0, 4).equals(PNG), `${path} is a PNG`);
      else assert.equal(body.readUInt16LE(2), 1, `${path} is an ICO`);
    }
    const m = await fetch(`${base}/site.webmanifest`);
    assert.equal(m.status, 200);
    assert.equal(m.headers.get("content-type"), "application/manifest+json");
    const manifest = await m.json();
    assert.equal(manifest.name, "WordTrap"); assert.equal(manifest.short_name, "WordTrap");
    assert.equal(manifest.theme_color, "#FFD60A"); assert.equal(manifest.background_color, "#FFFDF7"); assert.equal(manifest.display, "standalone");
    assert.deepEqual(manifest.icons.map((i: any) => i.src), ["/icon-192.png", "/icon-512.png"]);
    // nothing else leaks from the folder, and paths cannot escape it
    assert.equal((await fetch(`${base}/nope.png`)).status, 404);
    assert.equal((await fetch(`${base}/..%2Findex.html`)).status, 404);
  } finally { await app.close(); }
});

test("brand: every page we serve links the favicon set, the manifest and the theme colour, and shows the wordmark image", () => {
  const pages = ["../../watch/index.html", "../../watch/play.html", "../../stake/index.html", "../../stake/side.html"];
  for (const rel of pages) {
    const html = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
    for (const tag of ['<link rel="icon" href="/favicon.ico" sizes="48x48">', 'href="/favicon-light-32.png" media="(prefers-color-scheme: light)"', 'href="/favicon-dark-32.png" media="(prefers-color-scheme: dark)"', '<link rel="apple-touch-icon" href="/apple-touch-icon.png">', '<link rel="manifest" href="/site.webmanifest">', '<meta name="theme-color" content="#FFD60A">']) {
      assert.ok(html.includes(tag), `${rel} has ${tag}`);
    }
  }
  for (const rel of ["../../watch/index.html", "../../watch/play.html", "../../stake/src/SidePage.tsx", "../../stake/src/App.tsx"]) {
    const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
    assert.ok(src.includes('src="/wordtrap-wordmark-dark.png" alt="WordTrap"'), `${rel} shows the wordmark image`);
    assert.ok(!/>Word<b>Trap<\/b>|WORD<b>TRAP<\/b>/.test(src), `${rel} no longer spells the wordmark in text`);
  }
});
