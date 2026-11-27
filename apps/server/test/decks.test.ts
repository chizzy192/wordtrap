// Daily decks from the web with a mocked Firecrawl: a good page gives a valid deck in the built-in shape, bad words
// are filtered, a short deck is rejected, an outage falls back to the built-in deck, one refresh at a time and three a
// day, the admin route refuses without the token, the run carries the deck it chose before any seat and keeps it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { MockChain } from "../src/chain/mock.ts";
import { createApp } from "../src/main.ts";
import { TILE_DECK } from "../src/content.ts";
import { DeckManager, MemoryDeckStore, SupabaseDeckStore, FirecrawlClient, validateDeck, playable, DECK_SCHEMA, DECK_PROMPT, type DeckSource } from "../src/decks.ts";
import { fakeSupabase } from "./fake-supabase.ts";

const SOURCES: DeckSource[] = [
  { name: "Wikipedia: On this day", site: "Wikipedia", url: "https://en.wikipedia.org/wiki/Wikipedia:On_this_day/Today" },
  { name: "NASA Astronomy Picture of the Day", site: "NASA", url: "https://apod.nasa.gov/apod/astropix.html" },
];

test("decks: sensitive topics are filtered (clue or word: violence, death, disaster, crime, disease, politics, religion); the prompt asks for neutral categories; the sources are On this day, Did you know and APOD", async () => {
  const src = SOURCES[0];
  const page = goodPage("Mixed news");
  page.tiles[0].clue = "Weapons used in the war";                 // violence in the clue
  page.tiles[1].obvious[2] = "earthquake";                      // disaster as an answer
  page.tiles[2].clue = "Results of the election";                 // politics
  page.tiles[3].sideways[1] = "church";                          // religion
  page.tiles[4].clue = "Symptoms of the virus outbreak";          // disease
  page.tiles[5].obvious[0] = "murder";                           // crime
  const v = validateDeck(page, src, DAY);
  assert.equal(v.deck, null, "six tiles dropped, only one left");
  assert.deepEqual(v.rejected.map((r) => r.tile), [0, 1, 2, 3, 4, 5, -1]);
  assert.match(v.rejected[0].reason, /sensitive topic \((weapons|war)\)/); assert.match(v.rejected[1].reason, /EARTHQUAKE: sensitive/); assert.match(v.rejected[2].reason, /sensitive topic \(election\)/);
  assert.match(v.rejected[3].reason, /CHURCH: sensitive/); assert.match(v.rejected[4].reason, /sensitive topic \(virus\)/); assert.match(v.rejected[5].reason, /MURDER: sensitive/);
  // playful categories pass untouched
  const calm = goodPage("Calm"); calm.tiles[0].clue = "Things found in a kitchen"; calm.tiles[1].clue = "Planets and moons"; calm.tiles[2].obvious[0] = "volcano";
  calm.tiles[3].clue = "Things at a birthday party"; calm.tiles[4].sideways[0] = "party";   // (on another tile: a word may not appear in its own clue)
  const ok = validateDeck(calm, src, DAY); assert.ok(ok.deck); assert.equal(ok.rejected.length, 0);
  assert.equal(ok.deck!.tiles[3].prompt, "Things at a birthday party"); assert.ok(ok.deck!.tiles[4].sideways.includes("PARTY"), "party is not political");
  // the political words stay filtered
  for (const clue of ["Who won the election", "How a country votes", "Powers of the president", "Seats in parliament", "Members of the senate"]) {
    const pol = goodPage("Pol"); pol.tiles[0].clue = clue;
    assert.ok(validateDeck(pol, src, DAY).rejected.some((r) => r.tile === 0 && /sensitive topic|about people/.test(r.reason)), clue);   // "president" is caught by the people filter, the rest by the topic list
  }
  assert.ok(DECK_PROMPT.includes("Only neutral, playful categories: nature, science, space, food, sport, places, objects") && DECK_PROMPT.includes("Nothing about violence, death, disaster, crime, disease, politics or religion"));
  const { loadSources } = await import("../src/decks.ts");
  assert.deepEqual(loadSources().map((s) => s.name), ["Wikipedia: On this day", "Wikipedia: Did you know", "NASA Astronomy Picture of the Day"]);
  assert.ok(loadSources()[1].url.startsWith("https://en.wikipedia.org/wiki/Main_Page"));
  assert.ok(!loadSources().some((s) => /Current_events/.test(s.url)), "the Current events portal is gone");
});
/** n distinct letter-only words sharing a tag: tag "oba" → obaa, obab, … (letters only, so each tile's words differ). */
const words = (tag: string, n: number) => Array.from({ length: n }, (_, i) => `${tag}${"abcdefghijkl"[i]}`);
/** A clean extraction: 7 tiles, 8 obvious + 5 sideways, all distinct single words. */
function goodPage(theme = "Mars rover day") {
  const tiles = ["Things found on Mars", "Parts of a rover", "Colours of the sky", "Rocket pieces", "Space foods", "Night sky objects", "Lab tools"].map((clue, t) => ({
    clue, obvious: words(`ob${"abcdefg"[t]}`, 8), sideways: words(`sw${"abcdefg"[t]}`, 5),
  }));
  return { theme, tiles };
}
/** Mocked Firecrawl v2: answers per URL from a script, counts requests, can be told to fail. */
async function mockFirecrawl() {
  const answers = new Map<string, any>(); const hits: string[] = []; const bodies: any[] = []; let fail: null | number = null;
  const srv = createServer((req, res) => {
    let raw = ""; req.on("data", (c) => (raw += c)); req.on("end", () => {
      const body = JSON.parse(raw || "{}"); bodies.push({ auth: req.headers.authorization, url: req.url, body });
      hits.push(body.url);
      const reply = (status: number, j: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(j)); };
      if (req.url !== "/v2/scrape" || req.method !== "POST") return reply(404, { success: false, error: "not found" });
      if (fail) return reply(fail, { success: false, error: "Request timed out", code: "SCRAPE_TIMEOUT" });
      const a = answers.get(body.url);
      if (a === undefined) return reply(200, { success: true, data: { json: null, metadata: { statusCode: 404 } } });
      reply(200, { success: true, data: { json: a, metadata: { statusCode: 200 } } });
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const client = new FirecrawlClient("fc-test-key", `http://127.0.0.1:${(srv.address() as any).port}/v2`);
  return { client, answers, hits, bodies, setFail: (s: number | null) => { fail = s; }, close: () => new Promise<void>((r) => srv.close(() => r())) };
}
const DAY = "2026-11-27";

test("decks: a good page becomes a stored deck in the built-in shape (7 tiles, 8 obvious + 5 sideways, upper-cased words), with the v2 request shape", async () => {
  const fc = await mockFirecrawl(); const store = new MemoryDeckStore();
  const log: string[] = [];
  const m = new DeckManager({ sources: SOURCES, store, firecrawl: fc.client, today: () => DAY, log: (l) => log.push(l) });
  try {
    fc.answers.set(SOURCES[0].url, goodPage("Mars rover day")); fc.answers.set(SOURCES[1].url, goodPage("A nebula in Orion"));
    const r = await m.refresh();
    assert.deepEqual(r, { stored: 2, errors: [] });
    const todays = await store.forDay(DAY);
    assert.deepEqual(todays.map((d) => [d.theme, d.site, d.sourceUrl, d.tiles.length]).sort(), [["A nebula in Orion", "NASA", SOURCES[1].url, 7], ["Mars rover day", "Wikipedia", SOURCES[0].url, 7]]);
    const t = todays[0].tiles[0];
    assert.deepEqual(Object.keys(t).sort(), ["needed", "obvious", "prompt", "sideways"], "the built-in Tile shape");
    assert.equal(t.obvious.length, 8); assert.equal(t.sideways.length, 5); assert.equal(t.needed, 3);
    assert.ok([...t.obvious, ...t.sideways].every((w) => /^[A-Z]{3,10}$/.test(w)), "upper-cased letters only");
    assert.ok(JSON.stringify(todays).length < 6000 && !JSON.stringify(todays).includes("metadata"), "only theme, source and tiles are kept");
    // the Firecrawl v2 request: POST /v2/scrape, Bearer key, formats [{ type: json, schema, prompt }]
    const b = fc.bodies[0];
    assert.equal(b.url, "/v2/scrape"); assert.equal(b.auth, "Bearer fc-test-key");
    assert.deepEqual(b.body.formats, [{ type: "json", schema: DECK_SCHEMA, prompt: DECK_PROMPT }]); assert.equal(b.body.onlyMainContent, true);
    assert.ok(!log.some((l) => l.includes("fc-test-key")), "the key is never logged");
    // playable tiles are lower case for the game
    const p = playable(todays[0]); assert.ok(p[0].obvious.every((w) => /^[a-z]+$/.test(w)));
    assert.equal(await m.status(), "today");
  } finally { await fc.close(); }
});

test("decks: validation drops bad words and bad tiles, rejects short decks, and never keeps page text", () => {
  const src = SOURCES[0];
  const page = goodPage("Filtered");
  page.tiles[0].obvious[0] = "not a word"; page.tiles[0].obvious[1] = "mars";       // clue "Things found on Mars"
  page.tiles[0].obvious.push("Supercalifragilistic"); page.tiles[0].sideways[0] = page.tiles[0].obvious[3];   // too long; a duplicate within the deck
  const { deck, rejected } = validateDeck(page, src, DAY);
  assert.ok(deck, "the deck survives with the bad words removed");
  const t0 = deck!.tiles[0];
  assert.ok(!t0.obvious.includes("MARS") && !t0.obvious.some((w) => w.includes(" ")) && !t0.obvious.includes("SUPERCALIFRAGILISTIC"), "word in clue, multi-word and too long dropped");
  assert.equal(new Set(deck!.tiles.flatMap((t) => [...t.obvious, ...t.sideways])).size, deck!.tiles.reduce((n, t) => n + t.obvious.length + t.sideways.length, 0), "no duplicates within the deck");
  // a slur or profanity anywhere drops the whole tile; a given name drops the tile; a people category drops the tile
  const dirty = goodPage("Dirty"); dirty.tiles[1].sideways[1] = "shit"; dirty.tiles[2].obvious[3] = "Elon"; dirty.tiles[3].clue = "Famous people born today";
  const v = validateDeck(dirty, src, DAY);
  assert.equal(v.deck, null, "7 tiles were needed and 3 were dropped");
  assert.deepEqual(v.rejected.map((r) => r.tile), [1, 2, 3, -1]);
  assert.match(v.rejected[0].reason, /blocked word: SHIT: blocked/); assert.match(v.rejected[1].reason, /ELON: a name/); assert.match(v.rejected[2].reason, /about people/);
  // too few valid words in a tile drops that tile; fewer than 7 tiles drops the deck
  const thin = goodPage("Thin"); thin.tiles[4].obvious = ["one", "two"];
  const w = validateDeck(thin, src, DAY); assert.equal(w.deck, null); assert.match(w.rejected.at(-1)!.reason, /only 6 of 7 tiles survived/);
  // nonsense in, nothing out
  assert.equal(validateDeck({ theme: "x" }, src, DAY).deck, null); assert.equal(validateDeck(null, src, DAY).deck, null);
  // 12 candidate tiles: the first 7 good ones are kept
  const many = goodPage("Many"); for (let i = 0; i < 5; i++) many.tiles.push({ clue: `Extra ${i}`, obvious: words(`ex${"abcde"[i]}`, 8), sideways: words(`ey${"abcde"[i]}`, 5) });
  assert.equal(validateDeck(many, src, DAY).deck!.tiles.length, 7);
});

test("decks: one refresh at a time, one request per source per day, three attempts a day; an outage leaves the built-in deck in play", async () => {
  const fc = await mockFirecrawl(); const store = new MemoryDeckStore();
  const m = new DeckManager({ sources: SOURCES, store, firecrawl: fc.client, today: () => DAY });
  try {
    fc.setFail(408);
    const [a, b, c] = await Promise.all([m.refresh(), m.refresh(), m.refresh()]);
    assert.equal(fc.hits.length, 2, "concurrent calls share one refresh: one request per source");
    assert.ok(a === b && b === c && a.stored === 0 && a.errors.length === 2);
    assert.equal(await m.status(), "builtin");
    assert.equal(await m.pickForRun(), null, "no deck → built-in, and a background refresh is kicked off");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(fc.hits.length, 2, "a source already requested today is not requested again");
    // the daily cap on attempts
    assert.deepEqual(await m.refresh(), { stored: 0, errors: [] });   // attempt 3 (pickForRun made attempt 2): sources already requested today, no new request
    const capped = await m.refresh();
    assert.deepEqual(capped, { stored: 0, errors: ["3 refresh attempts already made today"] });
    const forced = await m.refresh(true);
    assert.deepEqual(forced, { stored: 0, errors: [] }, "an admin force ignores the cap but not the one-per-source rule");
    assert.equal(fc.hits.length, 2);
    // a new day: sources are requested again; a stale deck from an earlier day is used until then
    await store.put({ day: "2026-11-26", theme: "Yesterday", sourceUrl: SOURCES[0].url, site: "Wikipedia", tiles: validateDeck(goodPage("Yesterday"), SOURCES[0], "2026-11-26").deck!.tiles });
    assert.equal(await m.status(), "stale");
    const picked = await m.pickForRun(); assert.equal(picked?.theme, "Yesterday");
  } finally { await fc.close(); }
});

test("decks: a new run picks today's deck before any seat and keeps it; the state and the admin route expose it; built-in decks when there is none", async () => {
  const fc = await mockFirecrawl(); const fake = fakeSupabase();
  fc.answers.set(SOURCES[0].url, goodPage("Mars rover day"));
  const app = createApp({ sim: false, makeChain: async () => new MockChain(), ledgerPath: null, cfg: { tiles: 3 }, supabase: fake.client, firecrawl: fc.client, deckSources: [SOURCES[0]], deckStore: new SupabaseDeckStore(fake.client), deckToday: () => DAY, adminToken: "tok-admin" });
  const port = await app.listen(0); const base = `http://127.0.0.1:${port}`;
  try {
    assert.equal((await fetch(`${base}/healthz`).then((r) => r.json())).decks, "builtin");
    // the first run finds nothing for today: it plays the built-in deck and starts a refresh in the background
    const first = await fetch(`${base}/api/v1/runs`, { method: "POST", body: JSON.stringify({ callsign: "x" }) }).then((r) => r.json());
    assert.equal(first.state.deck, undefined);
    assert.ok(TILE_DECK.some((t) => t.prompt === first.state.tiles[0].prompt), "built-in prompt");
    for (let i = 0; i < 50 && fake.tables.decks.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(fake.tables.decks.map((d) => [d.day, d.theme, d.source_url]), [[DAY, "Mars rover day", SOURCES[0].url]], "stored in Supabase decks(day, theme, source_url, tiles)");
    assert.equal((await fetch(`${base}/healthz`).then((r) => r.json())).decks, "today");
    // the next run plays today's deck; the choice is in the state from the very first response, before any seat exists
    const second = await fetch(`${base}/api/v1/runs`, { method: "POST", body: JSON.stringify({ callsign: "y" }) }).then((r) => r.json());
    assert.deepEqual(second.state.deck, { theme: "Mars rover day", sourceUrl: SOURCES[0].url, site: "Wikipedia", day: DAY });
    assert.equal(second.state.tiles[0].prompt, "Things found on Mars");
    assert.ok(second.state.hand.every((w: string) => /^[a-z]+$/.test(w)), "lower-case cards");
    const fresh = await fetch(`${base}/runs/${second.runId}/spectate?delay=0`).then((r) => r.json());
    assert.deepEqual(fresh.room.seats.map((s: any) => s.kind), ["open", "open", "open", "open"], "no seat taken yet when the deck was chosen");
    await fetch(`${base}/runs/${second.runId}/seat`, { method: "POST", headers: { "content-type": "application/json", "x-user": "guest-DECKSEAT" }, body: JSON.stringify({ action: "take" }) });
    const later = await fetch(`${base}/runs/${second.runId}/spectate?delay=0`).then((r) => r.json());
    assert.deepEqual(later.state.deck, second.state.deck, "the deck never changes during a run");
    assert.equal(later.state.nextHand.prompt, "Parts of a rover", "setters see upcoming clues as before");
    // the admin route
    const noTok = await fetch(`${base}/api/v1/decks/refresh`, { method: "POST" }); assert.equal(noTok.status, 401); assert.equal((await noTok.json()).error, "Admin token required.");
    const bad = await fetch(`${base}/api/v1/decks/refresh`, { method: "POST", headers: { "x-admin-token": "wrong" } }); assert.equal(bad.status, 401);
    const ok = await fetch(`${base}/api/v1/decks/refresh`, { method: "POST", headers: { "x-admin-token": "tok-admin" } }).then((r) => r.json());
    assert.equal(ok.decks, "today"); assert.deepEqual(ok.today, [{ theme: "Mars rover day", site: "Wikipedia", tiles: 7 }]);
    assert.equal(fc.hits.length, 1, "the admin refresh does not request a source twice in a day");
  } finally { await app.close(); await fc.close(); }
  // no ADMIN_TOKEN configured: the route is closed
  const closed = createApp({ sim: false, makeChain: async () => new MockChain(), ledgerPath: null, cfg: { tiles: 2 }, firecrawl: null, adminToken: null, deckStore: new MemoryDeckStore() });
  const p2 = await closed.listen(0);
  try {
    const r = await fetch(`http://127.0.0.1:${p2}/api/v1/decks/refresh`, { method: "POST", headers: { "x-admin-token": "anything" } });
    assert.equal(r.status, 403); assert.equal((await r.json()).error, "ADMIN_TOKEN is not configured on this server.");
    assert.equal((await fetch(`http://127.0.0.1:${p2}/healthz`).then((x) => x.json())).decks, "builtin");
  } finally { await closed.close(); }
});
