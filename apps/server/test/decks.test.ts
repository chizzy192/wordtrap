// Daily decks from the web with a mocked Firecrawl: a good page gives a valid deck in the built-in shape, bad words
// are filtered, a short deck is rejected, an outage falls back to the built-in deck, one refresh at a time and three a
// day, the admin route refuses without the token, the run carries the deck it chose before any seat and keeps it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { MockChain } from "../src/chain/mock.ts";
import { createApp } from "../src/main.ts";
import { TILE_DECK } from "../src/content.ts";
import { DeckManager, MemoryDeckStore, SupabaseDeckStore, FirecrawlClient, validateDeck, playable, scoreDeck, letterRules, isBareCategory, buildRhymeTile, loadCurated, MIN_DECK_SCORE, DECK_SCHEMA, DECK_PROMPT, type DeckSource, type DatamuseLike } from "../src/decks.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
/** n distinct letter-only words sharing a tag: tag "lun" → lunxon, lunyum, … (far enough apart not to count as near-synonyms). */
const SUFFIX = ["xon", "yum", "zip", "kew", "vot", "mub", "gla", "pri", "shu", "dro", "fle", "tak"];
const words = (tag: string, n: number) => Array.from({ length: n }, (_, i) => `${tag}${SUFFIX[i]}`);
const OB = ["lun", "sol", "mar", "ven", "jup", "sat", "nep"], SW = ["tor", "pix", "bog", "rim", "fox", "hex", "zed"];
const STYLES = ["association", "constraint", "odd", "situation", "situation", "association", "constraint"];
/** A clean extraction: 7 styled tiles (4 styles, 5 from the page, a why each), 8 obvious + 5 sideways, all distinct single words. Scores 90. */
function goodPage(theme = "Mars rover day") {
  theme = theme.includes(" ") ? theme : `${theme} deck`;   // a theme is 2 to 5 words
  const tiles = ["Things found on Mars", "Parts of a rover", "Colours of the sky", "Rocket pieces that fall off", "Space foods eaten in orbit", "Night sky objects", "Lab tools a chemist grabs"].map((clue, t) => ({
    clue, style: STYLES[t], fromPage: t < 5, why: `page mentions tile ${t + 1}`, obvious: words(OB[t], 8), sideways: words(SW[t], 5),
  }));
  return { theme, tiles };
}
/** A fake Datamuse: scripted rhymes, or unreachable. */
function fakeDatamuse(rhymes: Record<string, string[]> = {}, down = false): DatamuseLike & { calls: string[] } {
  const calls: string[] = [];
  return { calls, rhymes: async (w) => { calls.push(`rhy:${w}`); return down ? null : rhymes[w] ?? []; }, related: async () => (down ? null : []), startingWith: async () => (down ? null : []) };
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
    assert.deepEqual(Object.keys(t).sort(), ["fromPage", "needed", "obvious", "prompt", "sideways", "style", "why"], "the built-in Tile shape plus style, fromPage and why (kept, never shown)");
    assert.equal(todays[0].score, 90, "scored and stored");
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
    assert.deepEqual(Object.keys(p[0]).sort(), ["needed", "obvious", "prompt", "sideways"], "what the game plays is the plain Tile: style, why and score never leave the server");
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
  const m = new DeckManager({ sources: SOURCES, store, firecrawl: fc.client, today: () => DAY, random: () => 0.99 });   // the rotation always picks the last kind available
  try {
    fc.setFail(408);
    const [a, b, c] = await Promise.all([m.refresh(), m.refresh(), m.refresh()]);
    assert.equal(fc.hits.length, 2, "concurrent calls share one refresh: one request per source");
    assert.ok(a === b && b === c && a.stored === 0 && a.errors.length === 2);
    assert.equal(await m.status(), "builtin");
    assert.deepEqual(await m.pickForRun(), { kind: "builtin" }, "no deck → built-in, and a background refresh is kicked off");
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
    await store.put(validateDeck(goodPage("Yesterday deck"), SOURCES[0], "2026-11-26").deck!);
    assert.equal(await m.status(), "stale");
    const picked = await m.pickForRun(); assert.equal(picked.kind, "web"); assert.equal(picked.kind === "web" && picked.deck.theme, "Yesterday deck");
  } finally { await fc.close(); }
});

test("decks: a new run picks today's deck before any seat and keeps it; the state and the admin route expose it; built-in decks when there is none", async () => {
  const fc = await mockFirecrawl(); const fake = fakeSupabase();
  fc.answers.set(SOURCES[0].url, goodPage("Mars rover day"));
  const app = createApp({ sim: false, makeChain: async () => new MockChain(), ledgerPath: null, cfg: { tiles: 3 }, supabase: fake.client, firecrawl: fc.client, deckSources: [SOURCES[0]], deckStore: new SupabaseDeckStore(fake.client), deckToday: () => DAY, adminToken: "tok-admin", deckRandom: () => 0.99, datamuse: null, curatedDecks: [] });
  const port = await app.listen(0); const base = `http://127.0.0.1:${port}`;
  try {
    assert.equal((await fetch(`${base}/healthz`).then((r) => r.json())).decks, "builtin");
    // the first run finds nothing for today: it plays the built-in deck and starts a refresh in the background
    const first = await fetch(`${base}/api/v1/runs`, { method: "POST", body: JSON.stringify({ callsign: "x" }) }).then((r) => r.json());
    assert.equal(first.state.deck, undefined);
    assert.ok(TILE_DECK.some((t) => t.prompt === first.state.tiles[0].prompt), "built-in prompt");
    for (let i = 0; i < 50 && fake.tables.decks.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(fake.tables.decks.map((d) => [d.day, d.theme, d.source_url, d.score]), [[DAY, "Mars rover day", SOURCES[0].url, 90]], "stored in Supabase decks(day, theme, source_url, tiles, score)");
    assert.equal((await fetch(`${base}/healthz`).then((r) => r.json())).decks, "today");
    // the next run plays today's deck; the choice is in the state from the very first response, before any seat exists
    const second = await fetch(`${base}/api/v1/runs`, { method: "POST", body: JSON.stringify({ callsign: "y" }) }).then((r) => r.json());
    assert.deepEqual(second.state.deck, { theme: "Mars rover day", sourceUrl: SOURCES[0].url, site: "Wikipedia", day: DAY }, "the state shape is unchanged: no style, why or score");
    assert.equal(second.state.tiles[0].prompt, "Things found on Mars");
    assert.deepEqual(Object.keys(second.state.tiles[0]).sort(), ["cleared", "needed", "played", "prompt"], "Byte's document gets nothing new");
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
    assert.equal(ok.decks, "today"); assert.deepEqual(ok.today, [{ theme: "Mars rover day", site: "Wikipedia", tiles: 7, score: 90 }]);
    assert.equal(fc.hits.length, 1, "the admin refresh does not request a source twice in a day");
  } finally { await app.close(); await fc.close(); }
  // no ADMIN_TOKEN configured: the route is closed
  const closed = createApp({ sim: false, makeChain: async () => new MockChain(), ledgerPath: null, cfg: { tiles: 2 }, firecrawl: null, adminToken: null, deckStore: new MemoryDeckStore(), datamuse: null });
  const p2 = await closed.listen(0);
  try {
    const r = await fetch(`http://127.0.0.1:${p2}/api/v1/decks/refresh`, { method: "POST", headers: { "x-admin-token": "anything" } });
    assert.equal(r.status, 403); assert.equal((await r.json()).error, "ADMIN_TOKEN is not configured on this server.");
    assert.equal((await fetch(`http://127.0.0.1:${p2}/healthz`).then((x) => x.json())).decks, "builtin");
  } finally { await closed.close(); }
});

// ---------------------------------------------------------------- clue quality

const SRC = SOURCES[0];
const tile = (clue: string, style: string, t: number, extra: Record<string, unknown> = {}) => ({ clue, style, fromPage: true, why: `page has tile ${t}`, obvious: words(OB[t % 7], 8), sideways: words(SW[t % 7], 5), ...extra });

test("quality: bare categories are rejected (\"Fruits\", \"Planets\", \"Kitchen things\"), clues are 3 to 8 words, the theme 2 to 5 words, every tile has a why", () => {
  for (const bare of ["Fruits", "Planets", "Kitchen things", "Animals"]) {
    assert.ok(isBareCategory(bare), bare);
    const page = goodPage(); page.tiles[0].clue = bare;
    const v = validateDeck(page, SRC, DAY);
    assert.ok(v.rejected.some((r) => r.tile === 0 && r.reason === `bare category ("${bare}")`), `${bare}: ${JSON.stringify(v.rejected)}`);
  }
  assert.ok(!isBareCategory("Fruits you have to peel") && !isBareCategory("Round things that are not balls"));
  const long = goodPage(); long.tiles[1].clue = "Things you would carry if you went camping in the rain tonight";
  assert.ok(validateDeck(long, SRC, DAY).rejected.some((r) => r.tile === 1 && /3 to 9 words/.test(r.reason)), "eleven words is too many");
  for (const theme of ["Mars", "A very long title about the rover on Mars"]) { const pg = goodPage(); pg.theme = theme; assert.match(validateDeck(pg, SRC, DAY).rejected[0].reason, /theme must be 2 to 5 words/, theme); }
  const noWhy = goodPage(); (noWhy.tiles[2] as any).why = ""; assert.ok(validateDeck(noWhy, SRC, DAY).rejected.some((r) => r.tile === 2 && r.reason === "no why"));
  const longWhy = goodPage(); (longWhy.tiles[2] as any).why = "one two three four five six seven eight nine ten eleven twelve"; assert.ok(validateDeck(longWhy, SRC, DAY).rejected.some((r) => r.tile === 2 && /12 words/.test(r.reason)));
  const badStyle = goodPage(); (badStyle.tiles[3] as any).style = "riddle"; assert.ok(validateDeck(badStyle, SRC, DAY).rejected.some((r) => r.tile === 3 && /unknown style/.test(r.reason)));
  assert.ok(DECK_PROMPT.includes('never a bare category: not "Fruits", not "Planets", not "Kitchen things"') && DECK_PROMPT.includes("Only neutral, playful categories: nature, science, space, food, sport, places, objects"));
});

test("quality: each of the five styles is accepted; a deck needs three styles and four page-derived tiles", () => {
  const page = { theme: "Volcano week", tiles: [
    tile("Fruits you have to peel", "constraint", 0),
    tile("Things you'd pack for Mars", "situation", 1),
    tile("Words a volcano scientist says daily", "association", 2),
    tile("Animals hiding a double letter", "letters", 3, { obvious: ["rabbit", "puppy", "kitten", "hippo", "parrot", "giraffe", "llama", "otter"], sideways: ["ferret", "gibbon", "moose", "sheep", "goose"] }),
    tile("Round things that are not balls", "odd", 4),
    tile("Things that start and end with the same letter", "letters", 5, { obvious: ["kayak", "level", "radar", "noon", "stats", "eye", "tenet", "civic"], sideways: ["deed", "sees", "peep", "toot", "gig"] }),
    tile("Sounds you'd hear near a crater", "association", 6),
  ] };
  const v = validateDeck(page, SRC, DAY);
  assert.ok(v.deck, JSON.stringify(v.rejected)); assert.equal(v.rejected.length, 0);
  assert.deepEqual(v.deck!.tiles.map((t) => t.style), ["constraint", "situation", "association", "letters", "odd", "letters", "association"]);
  assert.deepEqual(v.deck!.tiles.map((t) => t.why), page.tiles.map((t) => t.why), "the why is stored");
  assert.ok(v.deck!.score! >= MIN_DECK_SCORE, `score ${v.deck!.score}`);
  // fewer than three styles, or fewer than four tiles from the page: the whole deck is refused
  const two = goodPage(); two.tiles.forEach((t: any, i) => { t.style = i % 2 ? "constraint" : "situation"; });
  assert.match(validateDeck(two, SRC, DAY).rejected.at(-1)!.reason, /only 2 clue styles \(3 needed\)/);
  const few = goodPage(); few.tiles.forEach((t: any, i) => { t.fromPage = i < 3; });
  assert.match(validateDeck(few, SRC, DAY).rejected.at(-1)!.reason, /only 3 tiles from the page \(4 needed\)/);
});

test("quality: letter play is checked in code for every answer; one wrong answer drops the tile; rhymes come from Datamuse and the tile is skipped when it is unreachable", () => {
  assert.deepEqual(letterRules("Animals hiding a double letter").map((r) => r.describe), ["double letter"]);
  assert.deepEqual(letterRules("Five-letter words without an e").map((r) => r.describe), ["5 letters", "without e"]);
  assert.deepEqual(letterRules("Things that start with b and end with t").map((r) => r.describe), ["starts with b", "ends with t"]);
  assert.deepEqual(letterRules("Words that rhyme with moon").map((r) => r.rhymesWith), ["moon"]);
  assert.deepEqual(letterRules("Things in a kitchen"), [], "no rule in a plain clue");
  const page = goodPage();
  page.tiles[0] = tile("Animals hiding a double letter", "letters", 0, { obvious: ["rabbit", "puppy", "kitten", "hippo", "parrot", "giraffe", "llama", "tiger"], sideways: ["ferret", "gibbon", "moose", "sheep", "goose"] }) as any;
  const v = validateDeck(page, SRC, DAY);
  assert.ok(v.rejected.some((r) => r.tile === 0 && r.reason === "letter play failed (double letter): TIGER"), JSON.stringify(v.rejected));
  assert.equal(v.deck, null, "6 tiles left");
  const vague = goodPage(); vague.tiles[0] = tile("Animals with tricky spellings", "letters", 0) as any;
  assert.ok(validateDeck(vague, SRC, DAY).rejected.some((r) => r.tile === 0 && r.reason === "letter play not checkable"));
  const rhyme = goodPage(); rhyme.tiles[0] = tile("Words that rhyme with moon", "letters", 0, { obvious: ["spoon", "balloon", "noon", "soon", "cartoon", "lagoon", "tune", "june"], sideways: ["baboon", "monsoon", "croon", "swoon", "platoon"] }) as any;
  assert.ok(validateDeck(rhyme, SRC, DAY, { rhymes: () => null }).rejected.some((r) => r.tile === 0 && /rhyme check unavailable \(moon\)/.test(r.reason)), "Datamuse down: the tile is skipped");
  const set = new Set(["spoon", "balloon", "noon", "soon", "cartoon", "lagoon", "tune", "june", "baboon", "monsoon", "croon", "swoon", "platoon"]);
  assert.ok(validateDeck(rhyme, SRC, DAY, { rhymes: () => set }).deck, "every answer rhymes");
  set.delete("tune");
  assert.ok(validateDeck(rhyme, SRC, DAY, { rhymes: () => set }).rejected.some((r) => r.reason === "letter play failed (rhymes with moon): TUNE"));
});

test("quality: every deck is scored 0 to 100 and only 70+ is played; a low-scoring deck is stored, logged by score, and the run keeps the built-in deck", async () => {
  const { score, parts } = scoreDeck(validateDeck(goodPage(), SRC, DAY).deck!.tiles);
  assert.deepEqual(parts, { variety: 22, clues: 25, page: 18, spread: 25 }); assert.equal(score, 90);
  // weak three-word clues, three styles, four from the page, and near-synonym answers pull a deck under 70
  const weak = goodPage("Weak deck");
  weak.tiles.forEach((t: any, i) => { t.clue = `Things on tile${i}`; t.style = ["constraint", "situation", "odd"][i % 3]; t.fromPage = i < 4; });
  (weak.tiles[0] as any).obvious[0] = "running"; (weak.tiles[0] as any).obvious[1] = "runnings";
  const low = validateDeck(weak, SRC, DAY).deck!;
  assert.ok(low.score! < MIN_DECK_SCORE, `score ${low.score} ${JSON.stringify(scoreDeck(low.tiles).parts)}`);
  const fc = await mockFirecrawl(); const store = new MemoryDeckStore(); const log: string[] = [];
  const m = new DeckManager({ sources: [SRC], store, firecrawl: fc.client, today: () => DAY, log: (l) => log.push(l), random: () => 0.99, datamuse: null });
  try {
    fc.answers.set(SRC.url, weak);
    assert.deepEqual(await m.refresh(), { stored: 1, errors: [] });
    assert.ok(log.some((l) => l.startsWith(`[decks] stored "Weak deck" from Wikipedia for ${DAY}: score ${low.score}`) && l.includes("below 70: not played")), log.join("\n"));
    assert.ok(!log.some((l) => /tile0|runnings/.test(l)), "no page text or answers in the log");
    assert.equal((await store.forDay(DAY))[0].score, low.score, "stored with its score");
    assert.deepEqual(await m.pickForRun(), { kind: "builtin" }, "not played");
    assert.equal(await m.status(), "builtin");
  } finally { await fc.close(); }
});

test("quality: Datamuse builds a verified rhyme tile and tops up a short deck; unreachable means no built tiles", async () => {
  const rhymes = { crater: ["later", "gator", "waiter", "skater", "traitor", "equator", "theater", "creator", "spectator", "navigator", "dictator", "elevator", "narrator", "gladiator"] };
  const dm = fakeDatamuse(rhymes);
  const built = await buildRhymeTile(dm, "crater");
  assert.ok(built); assert.equal(built!.prompt, "Words that rhyme with crater"); assert.equal(built!.style, "letters"); assert.equal(built!.fromPage, false);
  assert.equal(built!.obvious.length, 8); assert.equal(built!.sideways.length, 5); assert.ok(built!.obvious.includes("LATER") && built!.sideways.includes("GLADIATOR"));
  assert.equal(await buildRhymeTile(dm, "orange"), null, "too few rhymes");
  assert.equal(await buildRhymeTile(fakeDatamuse({}, true), "crater"), null, "unreachable");
  // a 6-survivor extraction is topped up from a clue word's rhymes and stored
  const fc = await mockFirecrawl(); const store = new MemoryDeckStore(); const log: string[] = [];
  const short = goodPage("Crater lake day"); short.tiles[6] = tile("Fruits", "constraint", 6) as any;   // bare: dropped, six left
  short.tiles[0].clue = "Things found near a crater";
  const m = new DeckManager({ sources: [SRC], store, firecrawl: fc.client, datamuse: dm, today: () => DAY, log: (l) => log.push(l) });
  dm.calls.length = 0;
  try {
    fc.answers.set(SRC.url, short);
    assert.deepEqual(await m.refresh(), { stored: 1, errors: [] });
    const d = (await store.forDay(DAY))[0];
    assert.equal(d.tiles.length, 7); assert.equal(d.tiles[6].prompt, "Words that rhyme with crater"); assert.equal(d.tiles[6].why, "built from rhymes of crater");
    assert.ok(dm.calls.length <= 4, `one lookup per candidate word, cached (${dm.calls.length})`);
  } finally { await fc.close(); }
  // Datamuse down: the short deck stays short and is not stored
  const fc2 = await mockFirecrawl(); const store2 = new MemoryDeckStore();
  const m2 = new DeckManager({ sources: [SRC], store: store2, firecrawl: fc2.client, datamuse: fakeDatamuse({}, true), today: () => DAY });
  try { fc2.answers.set(SRC.url, short); const r = await m2.refresh(); assert.equal(r.stored, 0); assert.match(r.errors[0], /only 6 of 7 tiles survived/); } finally { await fc2.close(); }
});

test("quality: curated decks load from config in the built-in format; the naija template is valid but waits for 7 tiles; the rotation picks built-in, curated and web with equal weight", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wt-decks-"));
  const full = { theme: "Lagos nights", tiles: Array.from({ length: 7 }, (_, i) => ({ prompt: `Things you'd hear on street ${i}`, needed: 3, obvious: words(OB[i], 8), sideways: words(SW[i], 5) })) };
  writeFileSync(join(dir, "lagos.json"), JSON.stringify(full));
  writeFileSync(join(dir, "short.json"), JSON.stringify([{ prompt: "Fruits", obvious: words("aaa", 8), sideways: words("bbb", 5) }, { prompt: "Things you'd pack for Mars", obvious: words("ccc", 8), sideways: words("ddd", 5) }]));
  writeFileSync(join(dir, "broken.json"), "{ not json");
  const log: string[] = [];
  const curated = loadCurated(dir, (l) => log.push(l));
  assert.deepEqual(curated.map((c) => [c.name, c.theme, c.tiles.length]), [["lagos", "Lagos nights", 7]]);
  assert.ok(log.some((l) => l === "[decks] curated short.json: 1 playable tile (7 needed), not in rotation yet"), log.join("\n"));   // "Fruits" is a bare category, so one tile counts
  assert.ok(log.some((l) => l.startsWith("[decks] curated broken.json:")));
  // the template shipped in the repo
  const repo = loadCurated(fileURLToPath(new URL("../config/decks", import.meta.url)), (l) => log.push(l));
  assert.deepEqual(repo, [], "the template has two example tiles, so it is not in rotation yet");
  assert.ok(log.some((l) => l === "[decks] curated naija.json: 2 playable tiles (7 needed), not in rotation yet"));
  // rotation: kinds available, equal weight, picked by one random draw
  const store = new MemoryDeckStore(); await store.put(validateDeck(goodPage(), SRC, DAY).deck!);
  let r = 0;
  const m = new DeckManager({ sources: [SRC], store, firecrawl: null, curated, today: () => DAY, random: () => r });
  r = 0; assert.equal((await m.pickForRun()).kind, "builtin");
  r = 0.4; assert.equal((await m.pickForRun()).kind, "curated");
  r = 0.99; assert.equal((await m.pickForRun()).kind, "web");
  const noWeb = new DeckManager({ sources: [SRC], store: new MemoryDeckStore(), firecrawl: null, curated, today: () => DAY, random: () => r });
  r = 0.6; assert.equal((await noWeb.pickForRun()).kind, "curated"); r = 0.4; assert.equal((await noWeb.pickForRun()).kind, "builtin");
  const bare = new DeckManager({ sources: [SRC], store: new MemoryDeckStore(), firecrawl: null, today: () => DAY, random: () => 0.99 });
  assert.deepEqual(await bare.pickForRun(), { kind: "builtin" });
  // a curated deck in a run: the state carries a theme and the plain tile shape; the board shows the title, no link
  const app = createApp({ sim: false, makeChain: async () => new MockChain(), ledgerPath: null, cfg: { tiles: 3 }, firecrawl: null, datamuse: null, curatedDecks: curated, deckStore: new MemoryDeckStore(), deckToday: () => DAY, deckRandom: () => 0.6 });
  const port = await app.listen(0);
  try {
    const run = await fetch(`http://127.0.0.1:${port}/api/v1/runs`, { method: "POST", body: JSON.stringify({ callsign: "c" }) }).then((x) => x.json());
    assert.deepEqual(run.state.deck, { theme: "Lagos nights", sourceUrl: "", site: "WordTrap", day: DAY });
    assert.equal(run.state.tiles[0].prompt, "Things you'd hear on street 0");
  } finally { await app.close(); }
  const html = (await import("node:fs")).readFileSync(fileURLToPath(new URL("../../watch/index.html", import.meta.url)), "utf8");
  assert.ok(html.includes(`<p class="deckline" id="deckLine" hidden>Today's deck: <b id="deckTheme"></b></p>`) && !html.includes("deckSrc"), "the board shows the title only");
});
