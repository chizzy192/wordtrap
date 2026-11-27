// Daily decks from the web. One Firecrawl scrape per source per day (v2 /scrape with JSON extraction: a prompt plus a
// JSON schema, so no other AI key is needed) turns a page into 7 tiles in the built-in deck's shape. Tiles are
// validated before anything is stored; only the theme, the source URL and the tiles are kept, never page text.
// Storage: Supabase table decks(day, theme, source_url, tiles) unique on (day, theme), or memory without Supabase.
// Refresh is lazy (Render's free tier has no scheduler): a run that finds no deck for today starts one in the
// background and plays the newest stored deck, or the built-in decks. At most one refresh in flight, three a day.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Tile } from "./content.ts";
import type { SupabaseLike } from "./store.ts";

export interface DeckSource { name: string; site: string; url: string }
export interface DeckMeta { day: string; theme: string; sourceUrl: string; site: string }
export interface DailyDeck extends DeckMeta { tiles: Tile[] }
export const DECK_TILES = 7, OBVIOUS = 8, SIDEWAYS = 5, NEEDED = 3;

export function loadSources(): DeckSource[] {
  return JSON.parse(readFileSync(fileURLToPath(new URL("../config/deck-sources.json", import.meta.url)), "utf8"));
}

/** The shape Firecrawl is asked for: the built-in deck's tiles (a clue, obvious answers, sideways answers). */
export const DECK_SCHEMA = {
  type: "object",
  properties: {
    theme: { type: "string", description: "A short title for today's deck, drawn from the page, 2 to 6 words." },
    tiles: {
      type: "array", minItems: DECK_TILES, maxItems: DECK_TILES,
      items: {
        type: "object",
        properties: {
          clue: { type: "string", description: 'A short category drawn from the page, like "Things found on Mars".' },
          obvious: { type: "array", minItems: OBVIOUS, maxItems: OBVIOUS, items: { type: "string" }, description: "The 8 single-word answers most people would give, most obvious first." },
          sideways: { type: "array", minItems: SIDEWAYS, maxItems: SIDEWAYS, items: { type: "string" }, description: "5 less obvious but still correct single-word answers." },
        },
        required: ["clue", "obvious", "sideways"],
      },
    },
  },
  required: ["theme", "tiles"],
};
export const DECK_PROMPT = `From this page, write ${DECK_TILES} word-game tiles. Each tile is a short category drawn from what the page is about (for example "Things found on Mars" or "Words from a 1969 headline"), with ${OBVIOUS} obvious single-word answers (most obvious first) and ${SIDEWAYS} sideways answers (less obvious, still clearly correct). Every answer is one common English word in lowercase letters a to z only, 3 to 10 letters, no spaces, hyphens, digits or punctuation, no proper nouns, no names of people, places, brands or titles, and no word that appears in its own clue. Categories must not be about people. Only neutral, playful categories: nature, science, space, food, sport, places, objects, animals, hobbies. Nothing about violence, death, disaster, crime, disease, politics or religion. Do not copy sentences from the page.`;

/** The minimal Firecrawl surface the manager needs; the real one calls POST https://api.firecrawl.dev/v2/scrape. */
export interface FirecrawlLike { scrapeJson(url: string, schema: unknown, prompt: string): Promise<unknown> }
export class FirecrawlClient implements FirecrawlLike {
  private readonly key: string; private readonly base: string;
  constructor(key: string, base = "https://api.firecrawl.dev/v2") { this.key = key; this.base = base.replace(/\/$/, ""); }
  async scrapeJson(url: string, schema: unknown, prompt: string): Promise<unknown> {
    const r = await fetch(`${this.base}/scrape`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.key}`, "content-type": "application/json" },
      body: JSON.stringify({ url, formats: [{ type: "json", schema, prompt }], onlyMainContent: true, timeout: 90_000 }),
      signal: AbortSignal.timeout(120_000),
    });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok || j.success === false) throw new Error(`Firecrawl ${r.status}${j.code ? ` ${j.code}` : ""}${j.error ? `: ${String(j.error).slice(0, 120)}` : ""}`);
    const pageStatus = j.data?.metadata?.statusCode;
    if (pageStatus && pageStatus >= 400) throw new Error(`page answered ${pageStatus}`);
    return j.data?.json ?? null;
  }
}

// ---------------------------------------------------------------- validation

const BLOCKLIST = new Set(["ANAL", "ANUS", "ARSE", "ASS", "ASSES", "ASSHOLE", "BASTARD", "BITCH", "BITCHES", "BLOWJOB", "BOLLOCKS", "BONER", "BOOB", "BOOBS", "BUGGER", "BUKKAKE", "BUTT", "CHINK", "CLIT", "COCK", "COCKS", "COON", "CRAP", "CUM", "CUNT", "DAGO", "DAMN", "DICK", "DICKS", "DILDO", "DYKE", "FAG", "FAGGOT", "FAGS", "FUCK", "FUCKED", "FUCKER", "FUCKING", "FUCKS", "GOOK", "HOMO", "HONKY", "JAP", "JERK", "JIZZ", "KIKE", "KRAUT", "MICK", "MOLEST", "MUFF", "NAZI", "NEGRO", "NIGGA", "NIGGER", "NIGGERS", "NUDE", "NUDES", "PAKI", "PENIS", "PISS", "PISSED", "PORN", "PORNO", "PRICK", "PUSSY", "QUEER", "RAPE", "RAPED", "RAPIST", "RETARD", "RETARDED", "SCHLONG", "SCREW", "SCROTUM", "SEMEN", "SEX", "SEXY", "SHAG", "SHIT", "SHITS", "SHITTY", "SLUT", "SLUTS", "SMEGMA", "SPIC", "SPUNK", "TARD", "TIT", "TITS", "TITTIES", "TOSSER", "TRANNY", "TURD", "TWAT", "VAGINA", "WANK", "WANKER", "WETBACK", "WHORE", "WHORES", "WOG", "WOP"]);
/** Common given names: a tile naming people is dropped; the prompt forbids them, this catches the common slips. */
const GIVEN_NAMES = new Set(["JAMES", "JOHN", "ROBERT", "MICHAEL", "WILLIAM", "DAVID", "RICHARD", "JOSEPH", "THOMAS", "CHARLES", "DANIEL", "MATTHEW", "ANTHONY", "DONALD", "MARK", "PAUL", "STEVEN", "ANDREW", "KENNETH", "JOSHUA", "KEVIN", "BRIAN", "GEORGE", "EDWARD", "RONALD", "TIMOTHY", "JASON", "JEFFREY", "RYAN", "JACOB", "GARY", "NICHOLAS", "ERIC", "JONATHAN", "STEPHEN", "LARRY", "JUSTIN", "SCOTT", "BRANDON", "FRANK", "MARY", "PATRICIA", "JENNIFER", "LINDA", "ELIZABETH", "BARBARA", "SUSAN", "JESSICA", "SARAH", "KAREN", "NANCY", "LISA", "MARGARET", "BETTY", "SANDRA", "ASHLEY", "DOROTHY", "KIMBERLY", "EMILY", "DONNA", "MICHELLE", "CAROL", "AMANDA", "MELISSA", "DEBORAH", "STEPHANIE", "REBECCA", "LAURA", "SHARON", "CYNTHIA", "KATHLEEN", "HELEN", "AMY", "SHIRLEY", "ANGELA", "ANNA", "BRENDA", "PAMELA", "EMMA", "NICOLE", "ELON", "TAYLOR", "KANYE", "BEYONCE", "RIHANNA", "DRAKE", "TRUMP", "BIDEN", "OBAMA", "PUTIN", "MODI", "MACRON", "XI", "MUSK", "BEZOS", "ZUCKERBERG", "GATES", "MESSI", "RONALDO", "SWIFT", "HARRIS", "VANCE", "STARMER", "SUNAK", "MERZ", "SCHOLZ", "MILEI", "LULA", "ERDOGAN", "NETANYAHU", "ZELENSKY", "ZELENSKYY"]);
/** Topics a deck never touches, in a clue or an answer: violence, death, disaster, crime, disease, politics, religion. */
const SENSITIVE = /\b(war|wars|warfare|battle|battles|army|armies|military|soldier|soldiers|troops|invasion|invade|invaded|attack|attacks|attacked|bomb|bombs|bombing|missile|missiles|rocket attack|shooting|shooter|shot|gun|guns|rifle|weapon|weapons|terror|terrorist|terrorism|massacre|genocide|hostage|hostages|kill|killed|killing|killer|murder|murdered|murderer|slain|slaughter|violence|violent|assault|riot|riots|coup|rebel|rebels|insurgent|ceasefire|airstrike|airstrikes|drone strike|death|deaths|dead|die|died|dies|dying|funeral|funerals|grave|graves|cemetery|corpse|corpses|suicide|execution|executed|obituary|casualty|casualties|victim|victims|disaster|disasters|earthquake|earthquakes|tsunami|hurricane|hurricanes|typhoon|cyclone|tornado|tornadoes|flood|floods|flooding|wildfire|wildfires|famine|drought|landslide|avalanche|eruption|crash|crashed|crashes|collapse|collapsed|explosion|explosions|crime|crimes|criminal|criminals|arrest|arrested|arrests|police|prison|prisons|prisoner|jail|jailed|theft|thief|robbery|robber|fraud|scam|smuggling|trafficking|kidnap|kidnapped|kidnapping|abuse|rape|drugs|cartel|gang|gangs|disease|diseases|illness|epidemic|pandemic|outbreak|virus|viruses|infection|infections|infected|cancer|tumour|tumor|plague|cholera|malaria|ebola|covid|coronavirus|hospitalised|hospitalized|politics|political|politician|politicians|election|elections|elected|vote|votes|voting|voter|voters|ballot|ballots|parliament|congress|senate|senator|minister|ministers|president|presidents|presidential|prime minister|governor|mayor|campaign|campaigns|candidate|candidates|referendum|protest|protests|protesters|sanctions|treaty|regime|dictator|republican|democrat|democrats|conservative|labour|liberal|religion|religions|religious|church|churches|mosque|mosques|temple|temples|synagogue|cathedral|bible|quran|koran|torah|god|gods|goddess|allah|jesus|christ|christian|christians|muslim|muslims|islam|islamic|hindu|hindus|jewish|jew|jews|buddhist|buddhism|catholic|pope|priest|priests|prayer|prayers|holy|sacred|saint|saints|sin|sins|heaven|hell|worship)\b/i;
const PEOPLE_CLUE = /\b(people|person|persons|celebrit(y|ies)|actor|actress|singer|rapper|politician|president|presidents|prime minister|minister|senator|mayor|player|players|athlete|athletes|leader|leaders|ceo|founder|king|queen|prince|princess|billionaire|influencer|author|artist|scientist|astronaut|astronauts|winner|winners|born|died|deaths|birthdays)\b/i;

export interface Rejection { tile: number; reason: string }
/** Turn an extraction into a stored deck, or say why not. Words are upper-cased; failing tiles are dropped; a deck
 *  with fewer than 7 surviving tiles is dropped. Only the theme, the source URL and the tiles survive. */
export function validateDeck(raw: any, source: DeckSource, day: string): { deck: DailyDeck | null; rejected: Rejection[] } {
  const rejected: Rejection[] = [];
  const theme = String(raw?.theme ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
  if (!theme || !Array.isArray(raw?.tiles)) return { deck: null, rejected: [{ tile: -1, reason: "no theme or tiles" }] };
  const seen = new Set<string>();
  const tiles: Tile[] = [];
  raw.tiles.slice(0, 12).forEach((t: any, i: number) => {
    const clue = String(t?.clue ?? "").replace(/\s+/g, " ").trim();
    if (clue.length < 3 || clue.length > 80) { rejected.push({ tile: i, reason: "clue length" }); return; }
    if (PEOPLE_CLUE.test(clue)) { rejected.push({ tile: i, reason: "clue is about people" }); return; }
    if (SENSITIVE.test(clue)) { rejected.push({ tile: i, reason: `clue touches a sensitive topic (${clue.match(SENSITIVE)![0].toLowerCase()})` }); return; }
    const clueWords = new Set(clue.toUpperCase().replace(/[^A-Z ]/g, " ").split(/\s+/).filter(Boolean));
    const clean = (list: unknown): { ok: string[]; bad: string[] } => {
      const ok: string[] = [], bad: string[] = [];
      for (const x of Array.isArray(list) ? list : []) {
        const w = String(x ?? "").trim().toUpperCase();
        if (!/^[A-Z]{3,10}$/.test(w)) { bad.push(`${w || "?"}: not a 3-10 letter word`); continue; }
        if (BLOCKLIST.has(w)) { bad.push(`${w}: blocked`); continue; }
        if (GIVEN_NAMES.has(w)) { bad.push(`${w}: a name`); continue; }
        if (SENSITIVE.test(w)) { bad.push(`${w}: sensitive`); continue; }
        if (clueWords.has(w)) { bad.push(`${w}: appears in its clue`); continue; }
        if (seen.has(w)) { bad.push(`${w}: duplicate in deck`); continue; }
        seen.add(w); ok.push(w);
      }
      return { ok, bad };
    };
    const obvious = clean(t?.obvious), sideways = clean(t?.sideways);
    if (obvious.bad.some((b) => /blocked|a name|sensitive/.test(b)) || sideways.bad.some((b) => /blocked|a name|sensitive/.test(b))) { rejected.push({ tile: i, reason: `blocked word: ${[...obvious.bad, ...sideways.bad].filter((b) => /blocked|a name|sensitive/.test(b)).join(", ")}` }); [...obvious.ok, ...sideways.ok].forEach((w) => seen.delete(w)); return; }
    if (obvious.ok.length < 6 || sideways.ok.length < 4) { rejected.push({ tile: i, reason: `too few valid words (${obvious.ok.length} obvious, ${sideways.ok.length} sideways)` }); [...obvious.ok, ...sideways.ok].forEach((w) => seen.delete(w)); return; }
    tiles.push({ prompt: clue, obvious: obvious.ok, sideways: sideways.ok, needed: NEEDED });
  });
  if (tiles.length < DECK_TILES) { rejected.push({ tile: -1, reason: `only ${tiles.length} of ${DECK_TILES} tiles survived` }); return { deck: null, rejected }; }
  return { deck: { day, theme, sourceUrl: source.url, site: source.site, tiles: tiles.slice(0, DECK_TILES) }, rejected };
}
/** Stored words are upper case; the game plays lower-case cards. */
export function playable(deck: DailyDeck): Tile[] {
  return deck.tiles.map((t) => ({ prompt: t.prompt, needed: t.needed, obvious: t.obvious.map((w) => w.toLowerCase()), sideways: t.sideways.map((w) => w.toLowerCase()) }));
}

// ---------------------------------------------------------------- storage

export interface DeckStore {
  readonly kind: "memory" | "supabase";
  forDay(day: string): Promise<DailyDeck[]>;
  /** The newest stored decks (any day), newest day first. */
  newest(): Promise<DailyDeck[]>;
  put(deck: DailyDeck): Promise<void>;
}
export class MemoryDeckStore implements DeckStore {
  readonly kind = "memory" as const;
  private readonly decks = new Map<string, DailyDeck>();   // day|theme
  async forDay(day: string) { return [...this.decks.values()].filter((d) => d.day === day); }
  async newest() { const days = [...new Set([...this.decks.values()].map((d) => d.day))].sort().reverse(); return days.length ? this.forDay(days[0]) : []; }
  async put(deck: DailyDeck) { this.decks.set(`${deck.day}|${deck.theme}`, deck); }
}
export class SupabaseDeckStore implements DeckStore {
  readonly kind = "supabase" as const;
  readonly db: SupabaseLike;
  constructor(db: SupabaseLike) { this.db = db; }
  private row(r: any): DailyDeck { return { day: String(r.day), theme: String(r.theme), sourceUrl: String(r.source_url), site: siteOf(String(r.source_url)), tiles: (typeof r.tiles === "string" ? JSON.parse(r.tiles) : r.tiles) as Tile[] }; }
  async forDay(day: string) { const { data, error } = await this.db.from("decks").select("day, theme, source_url, tiles").eq("day", day); if (error) throw new Error(error.message); return (data ?? []).map((r: any) => this.row(r)); }
  async newest() {
    const { data, error } = await this.db.from("decks").select("day, theme, source_url, tiles").order("day", { ascending: false }).limit(12);
    if (error) throw new Error(error.message);
    const rows = (data ?? []).map((r: any) => this.row(r)); const top = rows[0]?.day;
    return rows.filter((d) => d.day === top);
  }
  async put(deck: DailyDeck) { const { error } = await this.db.from("decks").upsert({ day: deck.day, theme: deck.theme, source_url: deck.sourceUrl, tiles: deck.tiles }, { onConflict: "day,theme" }); if (error) throw new Error(error.message); }
}
export function siteOf(url: string): string { try { const h = new URL(url).hostname; return h.includes("wikipedia") ? "Wikipedia" : h.includes("nasa") ? "NASA" : h.replace(/^www\./, ""); } catch { return "the web"; } }
export const todayUtc = () => new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------- the manager

export class DeckManager {
  private inflight: Promise<{ stored: number; errors: string[] }> | null = null;
  private readonly attempts = new Map<string, number>();        // day → refresh attempts
  private readonly fetched = new Map<string, Set<string>>();      // day → source urls already requested (one per source per day)
  readonly sources: DeckSource[]; readonly store: DeckStore; readonly firecrawl: FirecrawlLike | null;
  private readonly log: (line: string) => void; private readonly today: () => string; readonly maxAttempts: number;
  constructor(o: { sources: DeckSource[]; store: DeckStore; firecrawl: FirecrawlLike | null; log?: (line: string) => void; today?: () => string; maxAttempts?: number }) {
    this.sources = o.sources; this.store = o.store; this.firecrawl = o.firecrawl; this.log = o.log ?? (() => {}); this.today = o.today ?? todayUtc; this.maxAttempts = o.maxAttempts ?? 3;
  }
  /** The deck for a new run, chosen before the run exists: one of today's at random, else the newest stored, else none
   *  (built-in). With nothing for today, a refresh starts in the background and never delays the run. */
  async pickForRun(): Promise<DailyDeck | null> {
    const day = this.today();
    let todays: DailyDeck[] = [];
    try { todays = await this.store.forDay(day); } catch (e) { this.log(`[decks] store read failed: ${(e as Error).message}`); }
    if (todays.length) return todays[Math.floor(Math.random() * todays.length)];
    void this.refresh().catch(() => {});
    try { const older = await this.store.newest(); return older.length ? older[Math.floor(Math.random() * older.length)] : null; } catch { return null; }
  }
  /** "today" when a deck for today is stored, "stale" when only older ones are, "builtin" when none. */
  async status(): Promise<"today" | "stale" | "builtin"> {
    try { if ((await this.store.forDay(this.today())).length) return "today"; return (await this.store.newest()).length ? "stale" : "builtin"; } catch { return "builtin"; }
  }
  /** One refresh at a time; at most `maxAttempts` a day (an admin `force` ignores the cap, not the one-per-source rule). */
  refresh(force = false): Promise<{ stored: number; errors: string[] }> {
    if (this.inflight) return this.inflight;
    const day = this.today();
    const n = this.attempts.get(day) ?? 0;
    if (!this.firecrawl) return Promise.resolve({ stored: 0, errors: ["FIRECRAWL_API_KEY is not set"] });
    if (!force && n >= this.maxAttempts) return Promise.resolve({ stored: 0, errors: [`${this.maxAttempts} refresh attempts already made today`] });
    this.attempts.set(day, n + 1);
    this.inflight = this.run(day).finally(() => { this.inflight = null; });
    return this.inflight;
  }
  private async run(day: string) {
    const done = this.fetched.get(day) ?? new Set<string>(); this.fetched.set(day, done);
    let stored = 0; const errors: string[] = [];
    for (const source of this.sources) {
      if (done.has(source.url)) continue;          // one request per source per day
      done.add(source.url);
      try {
        const raw = await this.firecrawl!.scrapeJson(source.url, DECK_SCHEMA, DECK_PROMPT);
        const { deck, rejected } = validateDeck(raw, source, day);
        if (!deck) { errors.push(`${source.name}: ${rejected.map((r) => r.reason).join("; ")}`); this.log(`[decks] ${source.name}: no deck (${rejected.map((r) => r.reason).join("; ")})`); continue; }
        await this.store.put(deck); stored++;
        this.log(`[decks] stored "${deck.theme}" from ${source.site} for ${day} (${deck.tiles.length} tiles${rejected.length ? `, ${rejected.length} dropped` : ""})`);
      } catch (e) { errors.push(`${source.name}: ${(e as Error).message}`); this.log(`[decks] ${source.name}: ${(e as Error).message}`); }
    }
    return { stored, errors };
  }
}
