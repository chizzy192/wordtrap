// Daily decks from the web, curated decks from config, and the built-in deck, in rotation.
// Web decks: one Firecrawl scrape per source per day (v2 /scrape with JSON extraction: a prompt plus a
// JSON schema, so no other AI key is needed) turns a page into 7 tiles in the built-in deck's shape. Tiles are
// validated before anything is stored; only the theme, the source URL and the tiles are kept, never page text.
// Storage: Supabase table decks(day, theme, source_url, tiles) unique on (day, theme), or memory without Supabase.
// Refresh is lazy (Render's free tier has no scheduler): a run that finds no deck for today starts one in the
// background and plays the newest stored deck, or the built-in decks. At most one refresh in flight, three a day.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readdirSync } from "node:fs";
import { basename, join } from "node:path";
import type { Tile } from "./content.ts";
import type { SupabaseLike } from "./store.ts";

export interface DeckSource { name: string; site: string; url: string }
export interface DeckMeta { day: string; theme: string; sourceUrl: string; site: string }
/** The five clue styles a web deck mixes (at least three per deck). */
export type ClueStyle = "constraint" | "situation" | "association" | "letters" | "odd";
export const CLUE_STYLES: ClueStyle[] = ["constraint", "situation", "association", "letters", "odd"];
/** A stored tile: the built-in shape plus its style, whether it came from the page, and a short "why" (kept, never shown). */
export interface DeckTile extends Tile { style?: ClueStyle; fromPage?: boolean; why?: string }
export interface DailyDeck extends DeckMeta { tiles: DeckTile[]; score?: number }
export const DECK_TILES = 7, OBVIOUS = 8, SIDEWAYS = 5, NEEDED = 3;
/** A web deck plays only with this score or better; otherwise the run uses the built-in or a curated deck. */
export const MIN_DECK_SCORE = 70;
// clues are asked for at 3 to 8 words; 9 is accepted so "Things that start and end with the same letter" can play
export const MIN_FROM_PAGE = 4, MIN_STYLES = 3, CLUE_WORDS = [3, 9] as const, THEME_WORDS = [2, 5] as const, WHY_WORDS = 12;

export function loadSources(): DeckSource[] {
  return JSON.parse(readFileSync(fileURLToPath(new URL("../config/deck-sources.json", import.meta.url)), "utf8"));
}

/** The shape Firecrawl is asked for: the built-in deck's tiles (a clue, obvious answers, sideways answers), each with its style, whether it came from the page, and a short why. */
export const DECK_SCHEMA = {
  type: "object",
  properties: {
    theme: { type: "string", description: "A title for today's deck, 2 to 5 words, drawn from the page." },
    tiles: {
      type: "array", minItems: DECK_TILES, maxItems: DECK_TILES,
      items: {
        type: "object",
        properties: {
          clue: { type: "string", description: 'A clue of 3 to 8 words with an angle, like "Fruits you have to peel". Never a bare category like "Fruits".' },
          style: { type: "string", enum: CLUE_STYLES, description: "constraint (category with a constraint), situation, association (from this page), letters (letter play a program can check), odd (odd one in)." },
          fromPage: { type: "boolean", description: "True when the clue comes from something on this page." },
          why: { type: "string", description: "Under 12 words, your own wording, never copied text: what on the page led to this tile." },
          obvious: { type: "array", minItems: OBVIOUS, maxItems: OBVIOUS, items: { type: "string" }, description: "The 8 single-word answers that clearly fit, most obvious first." },
          sideways: { type: "array", minItems: SIDEWAYS, maxItems: SIDEWAYS, items: { type: "string" }, description: "5 single-word answers that fit only with a stretch a player could argue." },
        },
        required: ["clue", "style", "fromPage", "why", "obvious", "sideways"],
      },
    },
  },
  required: ["theme", "tiles"],
};
export const DECK_PROMPT = `From this page, write ${DECK_TILES} tiles for a word game. Each tile is a clue of 3 to 8 words with an angle, never a bare category: not "Fruits", not "Planets", not "Kitchen things". Mix at least three of these five styles across the deck and label each tile with its style:
- constraint: a category with a constraint, like "Fruits you have to peel"
- situation: like "Things you'd pack for Mars"
- association: words tied to something on this page, like "Words a volcano scientist says daily"
- letters: letter play a program can check, like "Animals hiding a double letter" or "Things that start and end with the same letter". Only these forms: a double letter, start with a letter, end with a letter, start and end with the same letter, N-letter words, rhymes with a word, without a letter.
- odd: an odd one in, like "Round things that are not balls"
At least ${MIN_FROM_PAGE} of the ${DECK_TILES} clues must come from something on this page (fromPage true). Every tile carries a "why" of under ${WHY_WORDS} words in your own wording, never copied text, saying what on the page led to it. The theme is a title of 2 to 5 words. Each tile has ${OBVIOUS} obvious single-word answers that clearly fit (most obvious first) and ${SIDEWAYS} sideways answers that fit only with a stretch a player could argue; no two answers in the deck may be near-synonyms. Every answer is one common English word in lowercase letters a to z only, 3 to 10 letters, no spaces, hyphens, digits or punctuation, no proper nouns, no names of people, places, brands or titles, and no word that appears in its own clue. Clues must not be about people. Only neutral, playful categories: nature, science, space, food, sport, places, objects, animals, hobbies. Nothing about violence, death, disaster, crime, disease, politics or religion. Do not copy sentences from the page.`;

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
/** A clue that names or lists people is dropped: "Famous people born today", "Actors in a 1990s film", "Powers of the president".
 *  A profession as a point of view ("Words a volcano scientist says daily") is an association, not a list of people, and passes. */
const PEOPLE_CLUE = /\b(people|person|persons|celebrit(y|ies)|famous|well[- ]known|born|died|deaths|birthdays|politician|politicians|president|presidents|prime ministers?|ministers?|senators?|mayors?|who (is|are|was|were))\b|^(?:(?:the|some|top|great|best|living|dead|rich|young|old|new)\s+)*(actors|actresses|singers|rappers|players|athletes|leaders|ceos|founders|kings|queens|princes|princesses|billionaires|influencers|authors|artists|scientists|astronauts|winners)\b/i;

export interface Rejection { tile: number; reason: string }

const wordsOf = (text: string) => text.trim().split(/\s+/).filter(Boolean);
/** "Fruits", "Planets", "Kitchen things": one or two words, or a single plural noun, is a bare category. */
export function isBareCategory(clue: string): boolean {
  const w = wordsOf(clue);
  if (w.length <= 2) return true;
  return w.length === 1 && /s$/i.test(w[0]);
}
const NUMBER_WORDS: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
export interface LetterRule { describe: string; test?: (word: string) => boolean; rhymesWith?: string }
/** The letter-play forms a program can check. Every rule found in the clue must hold for every answer. */
export function letterRules(clue: string): LetterRule[] {
  const c = clue.toLowerCase().replace(/[“”"']/g, "");
  const rules: LetterRule[] = [];
  if (/\b(double|repeated|twin) letters?\b|\bsame letter (twice in a row|back to back)\b|\btwo of the same letter in a row\b/.test(c)) rules.push({ describe: "double letter", test: (w) => /(.)\1/.test(w) });
  if (/\bstart and end with the same letter\b|\bbegin and end with the same letter\b|\bsame first and last letter\b/.test(c)) rules.push({ describe: "same first and last letter", test: (w) => w[0] === w[w.length - 1] });
  const st = /\b(?:start|starts|starting|begin|begins|beginning) with (?:the letter |an? )?([a-z])\b/.exec(c); if (st) { const l = st[1]; rules.push({ describe: `starts with ${l}`, test: (w) => w.startsWith(l) }); }
  const en = /\b(?:end|ends|ending) (?:with|in) (?:the letter |an? )?([a-z])\b/.exec(c); if (en) { const l = en[1]; rules.push({ describe: `ends with ${l}`, test: (w) => w.endsWith(l) }); }
  const n = /\b(\d+|two|three|four|five|six|seven|eight|nine|ten)[- ]letter\b/.exec(c); if (n) { const k = NUMBER_WORDS[n[1]] ?? Number(n[1]); rules.push({ describe: `${k} letters`, test: (w) => w.length === k }); }
  const wo = /\b(?:without|no|missing) (?:the letter |an? )?([a-z])\b/.exec(c); if (wo) { const l = wo[1]; rules.push({ describe: `without ${l}`, test: (w) => !w.includes(l) }); }
  const co = /\b(?:contain|contains|containing|hiding|hide|with) (?:the letter |an? )([a-z])\b/.exec(c); if (co) { const l = co[1]; rules.push({ describe: `contains ${l}`, test: (w) => w.includes(l) }); }
  if (/\bevery vowel\b|\ball five vowels\b/.test(c)) rules.push({ describe: "every vowel", test: (w) => [..."aeiou"].every((v) => w.includes(v)) });
  if (/\bpalindrome/.test(c)) rules.push({ describe: "palindrome", test: (w) => w === [...w].reverse().join("") });
  const rh = /\brhymes? with (?:the word )?([a-z]+)\b/.exec(c); if (rh) rules.push({ describe: `rhymes with ${rh[1]}`, rhymesWith: rh[1] });
  return rules;
}
/** Stems that make two answers near-synonyms for the spread score: the same first five letters (6+ letters), or one letter apart. */
export function nearSynonyms(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length >= 6 && b.length >= 6 && a.slice(0, 5) === b.slice(0, 5)) return true;
  if (Math.abs(a.length - b.length) > 1 || Math.min(a.length, b.length) < 4) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) { if (a[i] === b[j]) { i++; j++; continue; } edits++; if (edits > 1) return false; if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; } }
  return edits + (a.length - i) + (b.length - j) <= 1;
}
/** 0 to 100: clue variety, no bare or weak categories, share of page-derived tiles, answer spread. */
export function scoreDeck(tiles: DeckTile[]): { score: number; parts: { variety: number; clues: number; page: number; spread: number } } {
  const styles = new Set(tiles.map((t) => t.style).filter(Boolean));
  const variety = styles.size >= 5 ? 25 : styles.size === 4 ? 22 : styles.size === 3 ? 18 : 0;
  // every stored clue already passed the bare-category rule; a three-word "Things in …"-style clue is still weak
  const weak = tiles.filter((t) => wordsOf(t.prompt).length <= 3 && /^(things|types|kinds|items|words|names|stuff|objects)\b/i.test(t.prompt)).length;
  const clues = Math.max(0, 25 - 5 * weak);
  const page = Math.round((25 * Math.min(DECK_TILES, tiles.filter((t) => t.fromPage).length)) / DECK_TILES);
  const all = tiles.flatMap((t) => [...t.obvious, ...t.sideways].map((w) => w.toLowerCase()));
  let pairs = 0;
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) if (nearSynonyms(all[i], all[j])) pairs++;
  const spread = Math.max(0, 25 - 5 * pairs);
  return { score: Math.max(0, Math.min(100, variety + clues + page + spread)), parts: { variety, clues, page, spread } };
}

export interface ValidateOptions {
  /** Perfect rhymes of a word (lower case), null when the rhyme service is unreachable: the tile is then dropped. */
  rhymes?: (word: string) => Set<string> | null | undefined;
}
/** Turn an extraction into a stored deck, or say why not. Words are upper-cased; failing tiles are dropped; a deck
 *  with fewer than 7 surviving tiles, fewer than 3 styles or fewer than 4 page-derived tiles is dropped. Only the
 *  theme, the source URL and the tiles (with style, fromPage and why) survive; never page text. */
export function validateDeck(raw: any, source: DeckSource, day: string, o: ValidateOptions = {}): { deck: DailyDeck | null; rejected: Rejection[]; survivors: DeckTile[] } {
  const rejected: Rejection[] = [];
  const theme = String(raw?.theme ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
  if (!theme || !Array.isArray(raw?.tiles)) return { deck: null, rejected: [{ tile: -1, reason: "no theme or tiles" }], survivors: [] };
  const themeWords = wordsOf(theme).length;
  if (themeWords < THEME_WORDS[0] || themeWords > THEME_WORDS[1]) return { deck: null, rejected: [{ tile: -1, reason: `theme must be ${THEME_WORDS[0]} to ${THEME_WORDS[1]} words` }], survivors: [] };
  const seen = new Set<string>();
  const tiles: DeckTile[] = [];
  raw.tiles.slice(0, 12).forEach((t: any, i: number) => {
    const clue = String(t?.clue ?? "").replace(/\s+/g, " ").trim();
    if (clue.length < 3 || clue.length > 80) { rejected.push({ tile: i, reason: "clue length" }); return; }
    if (isBareCategory(clue)) { rejected.push({ tile: i, reason: `bare category ("${clue}")` }); return; }
    const nWords = wordsOf(clue).length;
    if (nWords < CLUE_WORDS[0] || nWords > CLUE_WORDS[1]) { rejected.push({ tile: i, reason: `clue must be ${CLUE_WORDS[0]} to ${CLUE_WORDS[1]} words` }); return; }
    if (PEOPLE_CLUE.test(clue)) { rejected.push({ tile: i, reason: "clue is about people" }); return; }
    if (SENSITIVE.test(clue)) { rejected.push({ tile: i, reason: `clue touches a sensitive topic (${clue.match(SENSITIVE)![0].toLowerCase()})` }); return; }
    const style = String(t?.style ?? "").toLowerCase() as ClueStyle;
    if (!CLUE_STYLES.includes(style)) { rejected.push({ tile: i, reason: `unknown style "${t?.style ?? ""}"` }); return; }
    const why = String(t?.why ?? "").replace(/\s+/g, " ").trim();
    if (!why || wordsOf(why).length >= WHY_WORDS) { rejected.push({ tile: i, reason: why ? "why is 12 words or more" : "no why" }); return; }
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
    const unseen = () => [...obvious.ok, ...sideways.ok].forEach((w) => seen.delete(w));
    if (obvious.bad.some((b) => /blocked|a name|sensitive/.test(b)) || sideways.bad.some((b) => /blocked|a name|sensitive/.test(b))) { rejected.push({ tile: i, reason: `blocked word: ${[...obvious.bad, ...sideways.bad].filter((b) => /blocked|a name|sensitive/.test(b)).join(", ")}` }); unseen(); return; }
    if (obvious.ok.length < 6 || sideways.ok.length < 4) { rejected.push({ tile: i, reason: `too few valid words (${obvious.ok.length} obvious, ${sideways.ok.length} sideways)` }); unseen(); return; }
    if (style === "letters") {
      // letter play is checked in code: every answer must pass every rule the clue states, or the tile goes
      const rules = letterRules(clue);
      if (!rules.length) { rejected.push({ tile: i, reason: "letter play not checkable" }); unseen(); return; }
      for (const r of rules) {
        let test = r.test;
        if (r.rhymesWith) { const set = o.rhymes?.(r.rhymesWith); if (!set) { rejected.push({ tile: i, reason: `rhyme check unavailable (${r.rhymesWith})` }); unseen(); return; } test = (w) => set.has(w); }
        const failing = [...obvious.ok, ...sideways.ok].find((w) => !test!(w.toLowerCase()));
        if (failing) { rejected.push({ tile: i, reason: `letter play failed (${r.describe}): ${failing}` }); unseen(); return; }
      }
    }
    tiles.push({ prompt: clue, obvious: obvious.ok, sideways: sideways.ok, needed: NEEDED, style, fromPage: !!t?.fromPage, why: wordsOf(why).slice(0, WHY_WORDS - 1).join(" ") });
  });
  const kept = tiles.slice(0, DECK_TILES);
  const deckOf = (list: DeckTile[]): DailyDeck => ({ day, theme, sourceUrl: source.url, site: source.site, tiles: list, score: scoreDeck(list).score });
  if (kept.length < DECK_TILES) { rejected.push({ tile: -1, reason: `only ${kept.length} of ${DECK_TILES} tiles survived` }); return { deck: null, rejected, survivors: tiles }; }
  const check = deckRules(kept);
  if (check) { rejected.push({ tile: -1, reason: check }); return { deck: null, rejected, survivors: tiles }; }
  return { deck: deckOf(kept), rejected, survivors: tiles };
}
/** The deck-level rules: at least three styles, at least four tiles from the page. */
export function deckRules(tiles: DeckTile[]): string | null {
  const styles = new Set(tiles.map((t) => t.style));
  if (styles.size < MIN_STYLES) return `only ${styles.size} clue style${styles.size === 1 ? "" : "s"} (${MIN_STYLES} needed)`;
  const fromPage = tiles.filter((t) => t.fromPage).length;
  if (fromPage < MIN_FROM_PAGE) return `only ${fromPage} tile${fromPage === 1 ? "" : "s"} from the page (${MIN_FROM_PAGE} needed)`;
  return null;
}
/** Stored words are upper case; the game plays lower-case cards. The tile shape Byte sees is unchanged: style, fromPage and why never leave the server. */
export function playable(deck: { tiles: DeckTile[] }): Tile[] {
  return deck.tiles.map((t) => ({ prompt: t.prompt, needed: t.needed, obvious: t.obvious.map((w) => w.toLowerCase()), sideways: t.sideways.map((w) => w.toLowerCase()) }));
}

// ---------------------------------------------------------------- Datamuse (no key): rhymes and related words, cached

export interface DatamuseLike { rhymes(word: string): Promise<string[] | null>; related(word: string): Promise<string[] | null>; startingWith(letter: string): Promise<string[] | null> }
/** api.datamuse.com, no key. Every answer is cached for the process; an unreachable service answers null (tile styles that need it are skipped). */
export class DatamuseClient implements DatamuseLike {
  private readonly base: string; private readonly cache = new Map<string, string[] | null>(); private downUntil = 0;
  constructor(base = "https://api.datamuse.com") { this.base = base.replace(/\/$/, ""); }
  private async query(q: string): Promise<string[] | null> {
    const hit = this.cache.get(q); if (hit !== undefined) return hit;
    if (Date.now() < this.downUntil) return null;
    try {
      const r = await fetch(`${this.base}/words?${q}`, { signal: AbortSignal.timeout(8_000) });
      if (!r.ok) throw new Error(`datamuse ${r.status}`);
      const rows: any[] = await r.json();
      const words = rows.map((x) => String(x.word ?? "").toLowerCase()).filter((w) => /^[a-z]{3,10}$/.test(w));
      this.cache.set(q, words); return words;
    } catch { this.downUntil = Date.now() + 10 * 60_000; return null; }
  }
  rhymes(word: string) { return this.query(`rel_rhy=${encodeURIComponent(word)}&max=300`); }
  related(word: string) { return this.query(`ml=${encodeURIComponent(word)}&max=100`); }
  startingWith(letter: string) { return this.query(`sp=${encodeURIComponent(letter)}*&md=f&max=300`); }
}
/** A letter-play tile built from Datamuse, verified by construction: "Words that rhyme with <word>". Null when the service is unreachable or the word has too few rhymes. */
export async function buildRhymeTile(dm: DatamuseLike, word: string): Promise<DeckTile | null> {
  const list = await dm.rhymes(word);
  if (!list) return null;
  const ok = list.filter((w) => w !== word && !BLOCKLIST.has(w.toUpperCase()) && !GIVEN_NAMES.has(w.toUpperCase()) && !SENSITIVE.test(w)).filter((w, i, a) => a.indexOf(w) === i);
  if (ok.length < OBVIOUS + SIDEWAYS) return null;
  return { prompt: `Words that rhyme with ${word}`, needed: NEEDED, obvious: ok.slice(0, OBVIOUS).map((w) => w.toUpperCase()), sideways: ok.slice(OBVIOUS, OBVIOUS + SIDEWAYS).map((w) => w.toUpperCase()), style: "letters", fromPage: false, why: `built from rhymes of ${word}` };
}

// ---------------------------------------------------------------- curated decks (apps/server/config/decks/*.json)

export interface CuratedDeck { name: string; theme: string; tiles: Tile[] }
/** Hand-written decks in the built-in Tile format: `{ "theme": "...", "tiles": [ { prompt, needed, obvious, sideways } ] }` or a bare tile array. A file with fewer than 7 playable tiles is skipped (and said so once). */
export function loadCurated(dir: string, log: (line: string) => void = () => {}): CuratedDeck[] {
  let files: string[] = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort(); } catch { return []; }
  const out: CuratedDeck[] = [];
  for (const f of files) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, f), "utf8"));
      const name = basename(f, ".json");
      const theme = String((Array.isArray(raw) ? "" : raw?.theme) || name.replace(/[-_]+/g, " ")).trim();
      const list: any[] = Array.isArray(raw) ? raw : Array.isArray(raw?.tiles) ? raw.tiles : [];
      const tiles: Tile[] = [];
      for (const t of list) {
        const prompt = String(t?.prompt ?? "").trim();
        const words = (x: unknown) => (Array.isArray(x) ? x : []).map((w) => String(w).trim().toLowerCase()).filter((w) => /^[a-z]{3,10}$/.test(w));
        const obvious = words(t?.obvious), sideways = words(t?.sideways);
        if (!prompt || isBareCategory(prompt) || obvious.length < 6 || sideways.length < 4) continue;
        tiles.push({ prompt, needed: Math.max(1, Math.min(5, Number(t?.needed) || NEEDED)), obvious, sideways });
      }
      if (tiles.length < DECK_TILES) { log(`[decks] curated ${f}: ${tiles.length} playable tile${tiles.length === 1 ? "" : "s"} (${DECK_TILES} needed), not in rotation yet`); continue; }
      out.push({ name, theme, tiles });
    } catch (e) { log(`[decks] curated ${f}: ${(e as Error).message}`); }
  }
  return out;
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
  private row(r: any): DailyDeck { return { day: String(r.day), theme: String(r.theme), sourceUrl: String(r.source_url), site: siteOf(String(r.source_url)), tiles: (typeof r.tiles === "string" ? JSON.parse(r.tiles) : r.tiles) as DeckTile[], score: r.score == null ? undefined : Number(r.score) }; }
  async forDay(day: string) { const { data, error } = await this.db.from("decks").select("day, theme, source_url, tiles, score").eq("day", day); if (error) throw new Error(error.message); return (data ?? []).map((r: any) => this.row(r)); }
  async newest() {
    const { data, error } = await this.db.from("decks").select("day, theme, source_url, tiles, score").order("day", { ascending: false }).limit(12);
    if (error) throw new Error(error.message);
    const rows = (data ?? []).map((r: any) => this.row(r)); const top = rows[0]?.day;
    return rows.filter((d) => d.day === top);
  }
  async put(deck: DailyDeck) { const { error } = await this.db.from("decks").upsert({ day: deck.day, theme: deck.theme, source_url: deck.sourceUrl, tiles: deck.tiles, score: deck.score ?? null }, { onConflict: "day,theme" }); if (error) throw new Error(error.message); }
}
export function siteOf(url: string): string { try { const h = new URL(url).hostname; return h.includes("wikipedia") ? "Wikipedia" : h.includes("nasa") ? "NASA" : h.replace(/^www\./, ""); } catch { return "the web"; } }
export const todayUtc = () => new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------- the manager

/** What a new run plays: the built-in deck (null), a curated deck, or today's web deck (only when it scored 70 or more). */
export type DeckPick = { kind: "builtin" } | { kind: "curated"; deck: CuratedDeck } | { kind: "web"; deck: DailyDeck };
export class DeckManager {
  private inflight: Promise<{ stored: number; errors: string[] }> | null = null;
  private readonly attempts = new Map<string, number>();        // day → refresh attempts
  private readonly fetched = new Map<string, Set<string>>();      // day → source urls already requested (one per source per day)
  readonly sources: DeckSource[]; readonly store: DeckStore; readonly firecrawl: FirecrawlLike | null; readonly datamuse: DatamuseLike | null;
  readonly curated: CuratedDeck[];
  private readonly log: (line: string) => void; private readonly today: () => string; readonly maxAttempts: number; private readonly random: () => number;
  constructor(o: { sources: DeckSource[]; store: DeckStore; firecrawl: FirecrawlLike | null; datamuse?: DatamuseLike | null; curated?: CuratedDeck[]; log?: (line: string) => void; today?: () => string; maxAttempts?: number; random?: () => number }) {
    this.sources = o.sources; this.store = o.store; this.firecrawl = o.firecrawl; this.datamuse = o.datamuse ?? null; this.curated = o.curated ?? [];
    this.log = o.log ?? (() => {}); this.today = o.today ?? todayUtc; this.maxAttempts = o.maxAttempts ?? 3; this.random = o.random ?? Math.random;
  }
  /** Today's web decks that scored enough to play; with none for today, a refresh starts in the background and the newest good stored deck stands in. */
  private async webDecks(): Promise<DailyDeck[]> {
    const day = this.today();
    const good = (list: DailyDeck[]) => list.filter((d) => (d.score ?? 0) >= MIN_DECK_SCORE);
    let todays: DailyDeck[] = [];
    try { todays = await this.store.forDay(day); } catch (e) { this.log(`[decks] store read failed: ${(e as Error).message}`); }
    if (good(todays).length) return good(todays);
    if (!todays.length) void this.refresh().catch(() => {});
    try { return good(await this.store.newest()); } catch { return []; }
  }
  /** The deck for a new run, chosen before the run exists: built-in, a curated deck, or today's web deck (70+), one of the available kinds at random with equal weight. Never delays the run. */
  async pickForRun(): Promise<DeckPick> {
    const web = await this.webDecks();
    const kinds: DeckPick["kind"][] = ["builtin", ...(this.curated.length ? ["curated" as const] : []), ...(web.length ? ["web" as const] : [])];
    const kind = kinds[Math.min(kinds.length - 1, Math.floor(this.random() * kinds.length))];
    if (kind === "curated") return { kind, deck: this.curated[Math.floor(this.random() * this.curated.length)] };
    if (kind === "web") return { kind, deck: web[Math.floor(this.random() * web.length)] };
    return { kind: "builtin" };
  }
  /** "today" when a playable deck for today is stored, "stale" when only older ones are, "builtin" when none. */
  async status(): Promise<"today" | "stale" | "builtin"> {
    const good = (list: DailyDeck[]) => list.some((d) => (d.score ?? 0) >= MIN_DECK_SCORE);
    try { if (good(await this.store.forDay(this.today()))) return "today"; return good(await this.store.newest()) ? "stale" : "builtin"; } catch { return "builtin"; }
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
  /** Rhyme sets for every "rhymes with X" clue in the extraction, from Datamuse (cached); null entries mean the service is unreachable. */
  private async rhymeSets(raw: any): Promise<Map<string, Set<string> | null>> {
    const out = new Map<string, Set<string> | null>();
    for (const t of Array.isArray(raw?.tiles) ? raw.tiles : []) for (const r of letterRules(String(t?.clue ?? ""))) if (r.rhymesWith && !out.has(r.rhymesWith)) {
      const list = this.datamuse ? await this.datamuse.rhymes(r.rhymesWith) : null;
      out.set(r.rhymesWith, list ? new Set(list) : null);
    }
    return out;
  }
  /** A short deck (5 or 6 survivors) is topped up with letter-play tiles built from Datamuse rhymes of the clues' own words. */
  private async topUp(survivors: DeckTile[], theme: string): Promise<DeckTile[]> {
    if (!this.datamuse || survivors.length >= DECK_TILES || survivors.length < DECK_TILES - 2) return survivors;
    const used = new Set(survivors.flatMap((t) => [...t.obvious, ...t.sideways]));
    const seeds = [...new Set([...survivors.flatMap((t) => wordsOf(t.prompt)), ...wordsOf(theme)].map((w) => w.toLowerCase().replace(/[^a-z]/g, "")).filter((w) => w.length >= 4 && !/^(things|words|that|with|from|your|this|have|what|which|about|would|they)$/.test(w)))];
    const out = [...survivors];
    for (const seed of seeds) {
      if (out.length >= DECK_TILES) break;
      const tile = await buildRhymeTile(this.datamuse, seed);
      if (!tile || [...tile.obvious, ...tile.sideways].some((w) => used.has(w))) continue;
      [...tile.obvious, ...tile.sideways].forEach((w) => used.add(w)); out.push(tile);
    }
    return out;
  }
  private async run(day: string) {
    const done = this.fetched.get(day) ?? new Set<string>(); this.fetched.set(day, done);
    let stored = 0; const errors: string[] = [];
    for (const source of this.sources) {
      if (done.has(source.url)) continue;          // one request per source per day
      done.add(source.url);
      try {
        const raw = await this.firecrawl!.scrapeJson(source.url, DECK_SCHEMA, DECK_PROMPT);
        const rhymes = await this.rhymeSets(raw);
        let { deck, rejected, survivors } = validateDeck(raw, source, day, { rhymes: (w) => rhymes.get(w) });
        if (!deck && survivors.length) {
          // a short deck is topped up with built letter-play tiles, then checked against the same deck rules
          const topped = await this.topUp(survivors, String(raw?.theme ?? ""));
          if (topped.length >= DECK_TILES && !deckRules(topped.slice(0, DECK_TILES))) { const tiles = topped.slice(0, DECK_TILES); deck = { day, theme: String(raw.theme).replace(/\s+/g, " ").trim().slice(0, 60), sourceUrl: source.url, site: source.site, tiles, score: scoreDeck(tiles).score }; rejected = rejected.filter((r) => r.tile !== -1); }
        }
        if (!deck) { errors.push(`${source.name}: ${rejected.map((r) => r.reason).join("; ")}`); this.log(`[decks] ${source.name}: no deck (${rejected.map((r) => r.reason).join("; ")})`); continue; }
        await this.store.put(deck); stored++;
        const parts = scoreDeck(deck.tiles).parts;
        this.log(`[decks] stored "${deck.theme}" from ${source.site} for ${day}: score ${deck.score} (variety ${parts.variety}, clues ${parts.clues}, page ${parts.page}, spread ${parts.spread})${deck.score! < MIN_DECK_SCORE ? ", below 70: not played" : ""} (${deck.tiles.length} tiles${rejected.length ? `, ${rejected.length} dropped` : ""})`);
      } catch (e) { errors.push(`${source.name}: ${(e as Error).message}`); this.log(`[decks] ${source.name}: ${(e as Error).message}`); }
    }
    return { stored, errors };
  }
}
