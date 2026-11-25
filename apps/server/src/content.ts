// Board tiles. `obvious` = the answers the crowd will most likely mine, ranked most→least obvious.
// The risk oracle and crowd simulator both read this; swap in an LLM/embedding generator later.
export interface Tile { prompt: string; obvious: string[]; minWords: number }

export const TILE_DECK: Tile[] = [
  { prompt: "Name three fruits you'd pack for a picnic", minWords: 3, obvious: ["apple", "banana", "grapes", "orange", "strawberry", "watermelon", "mango", "pear"] },
  { prompt: "Describe the ocean in five words", minWords: 4, obvious: ["blue", "deep", "vast", "waves", "salty", "water", "endless", "calm"] },
  { prompt: "Name a superpower and why you'd want it", minWords: 4, obvious: ["flying", "fly", "invisibility", "teleportation", "strength", "time", "speed", "mind"] },
  { prompt: "Give a weather forecast for tomorrow", minWords: 4, obvious: ["sunny", "rain", "cloudy", "wind", "storm", "temperature", "degrees", "hot", "cold"] },
  { prompt: "Pitch a startup in one sentence", minWords: 5, obvious: ["app", "uber", "platform", "blockchain", "users", "solana", "startup", "money"] },
  { prompt: "Name three animals at a farm", minWords: 3, obvious: ["cow", "pig", "chicken", "horse", "sheep", "goat", "duck", "dog"] },
  { prompt: "Describe your morning routine", minWords: 5, obvious: ["coffee", "shower", "breakfast", "alarm", "wake", "teeth", "brush", "morning"] },
  { prompt: "Name the colors of a rainbow", minWords: 3, obvious: ["red", "orange", "yellow", "green", "blue", "indigo", "violet", "purple"] },
  { prompt: "Explain what a blockchain is to a child", minWords: 6, obvious: ["blocks", "chain", "ledger", "computers", "money", "record", "trust", "bitcoin"] },
  { prompt: "Order food at a pizza place", minWords: 4, obvious: ["pizza", "cheese", "pepperoni", "large", "please", "slice", "mushrooms", "extra"] },
  { prompt: "Name three things in a kitchen", minWords: 3, obvious: ["fridge", "oven", "knife", "stove", "sink", "spoon", "plate", "microwave"] },
  { prompt: "Describe a sunset", minWords: 4, obvious: ["orange", "sky", "sun", "golden", "beautiful", "red", "pink", "horizon"] },
];

export function dealTiles(n: number, seed = Date.now()): Tile[] {
  const deck = [...TILE_DECK];
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck.slice(0, n);
}
