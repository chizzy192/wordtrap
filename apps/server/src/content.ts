// Board tiles. `obvious` = the answers the crowd will most likely mine, ranked most→least obvious.
// `sideways` = oddball synonyms that are usually safer to play. Byte sees a shuffled hand of both.
// The risk oracle and crowd simulator both read this; swap in an LLM/embedding generator later.
import { isMineable } from "@wordtrap/shared";

export interface Tile { prompt: string; obvious: string[]; sideways: string[]; needed: number }

export const TILE_DECK: Tile[] = [
  { prompt: "Name three fruits you'd pack for a picnic", needed: 3, obvious: ["apple", "banana", "grapes", "orange", "strawberry", "watermelon", "mango", "pear"], sideways: ["lychee", "persimmon", "quince", "kumquat", "fig"] },
  { prompt: "Describe the ocean in five words", needed: 3, obvious: ["blue", "deep", "vast", "waves", "salty", "water", "endless", "calm"], sideways: ["turquoise", "restless", "briny", "immense", "murmuring"] },
  { prompt: "Name a superpower and why you'd want it", needed: 2, obvious: ["flying", "invisibility", "teleportation", "strength", "speed", "mind", "healing", "time"], sideways: ["photosynthesis", "ubiquity", "lunch", "forever", "naps"] },
  { prompt: "Give a weather forecast for tomorrow", needed: 3, obvious: ["sunny", "rain", "cloudy", "wind", "storm", "temperature", "degrees", "hot", "cold"], sideways: ["drizzly", "breezy", "overcast", "humid", "later"] },
  { prompt: "Pitch a startup in one sentence", needed: 3, obvious: ["app", "uber", "platform", "blockchain", "users", "solana", "startup", "money"], sideways: ["robots", "fold", "laundry", "while", "sleeping"] },
  { prompt: "Name three animals at a farm", needed: 3, obvious: ["cow", "pig", "chicken", "horse", "sheep", "goat", "duck", "dog"], sideways: ["llama", "alpaca", "turkey", "rooster", "donkey"] },
  { prompt: "Describe your morning routine", needed: 3, obvious: ["coffee", "shower", "breakfast", "alarm", "wake", "teeth", "brush", "morning"], sideways: ["stretch", "journal", "oatmeal", "podcast", "commute"] },
  { prompt: "Name the colors of a rainbow", needed: 3, obvious: ["red", "orange", "yellow", "green", "blue", "indigo", "violet", "purple"], sideways: ["crimson", "amber", "lime", "teal", "lavender"] },
  { prompt: "Explain what a blockchain is to a child", needed: 3, obvious: ["blocks", "chain", "ledger", "computers", "money", "record", "trust", "bitcoin"], sideways: ["shared", "notebook", "everyone", "copies", "erases"] },
  { prompt: "Order food at a pizza place", needed: 3, obvious: ["pizza", "cheese", "pepperoni", "large", "please", "slice", "mushrooms", "extra"], sideways: ["margherita", "basil", "thin", "crust", "thanks"] },
  { prompt: "Name three things in a kitchen", needed: 3, obvious: ["fridge", "oven", "knife", "stove", "sink", "spoon", "plate", "microwave"], sideways: ["colander", "whisk", "ladle", "toaster", "spatula"] },
  { prompt: "Describe a sunset", needed: 3, obvious: ["orange", "sky", "sun", "golden", "beautiful", "red", "pink", "horizon"], sideways: ["amber", "glowing", "dusk", "lavender", "fading"] },
];

/** Small deterministic PRNG so hands and decks are reproducible from a seed. */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

function shuffle<T>(arr: T[], rnd: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function dealTiles(n: number, seed = Date.now()): Tile[] {
  return shuffle(TILE_DECK, lcg(seed)).slice(0, n);
}

export const HAND_SIZE = 10;

/**
 * The hand Byte sees for a tile: ~4 obvious + ~4 sideways + up to 2 extras, deduped, all mineable,
 * deterministically shuffled from `seed`, at most HAND_SIZE cards.
 */
export function handFor(tile: Tile, extraTics: string[], seed: number): string[] {
  const rnd = lcg(seed);
  const obvious = shuffle(tile.obvious, rnd).slice(0, 4);
  const sideways = shuffle(tile.sideways, rnd).slice(0, 4);
  const extras = shuffle(extraTics, rnd).slice(0, 2);
  const seen = new Set<string>();
  const hand: string[] = [];
  for (const w of [...obvious, ...sideways, ...extras]) {
    if (!isMineable(w) || seen.has(w)) continue;
    seen.add(w); hand.push(w);
  }
  return shuffle(hand, rnd).slice(0, HAND_SIZE);
}
