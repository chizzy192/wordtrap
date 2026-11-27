# Curated decks

Every `*.json` file in this folder is a hand-written deck in the built-in tile format:

```json
{
  "theme": "Naija everyday",
  "tiles": [
    { "prompt": "Things you'd buy at a Lagos street market", "needed": 3,
      "obvious": ["pepper", "tomato", "yam", "plantain", "fabric", "fish", "onion", "rice"],
      "sideways": ["generator", "sachet", "charger", "umbrella", "suya"] }
  ]
}
```

- `theme`: a 2 to 5 word title shown on the board as "Today's deck: …" (the file name is used when it is missing).
- `prompt`: the clue, 3 to 8 words with an angle. Never a bare category ("Fruits"); a category with a constraint
  ("Fruits you have to peel"), a situation ("Things you'd pack for Mars"), an association ("Words a market trader
  says daily"), letter play ("Animals hiding a double letter") or an odd one in ("Round things that are not balls").
- `obvious`: the 8 answers that clearly fit, most obvious first. These are the cards the crowd mines.
- `sideways`: 5 answers that fit only with a stretch a player could argue. Byte's safer cards.
- `needed`: cards Byte must play to clear the tile (3 is the norm).
- Every answer is one common lower-case word, 3 to 10 letters a to z, no word from its own clue, and no two answers in
  the deck should be near-synonyms. Keep it playful: nothing about people, violence, politics or religion.

A deck joins the run rotation (built-in, curated, today's web deck, equal weight) once it has 7 playable tiles; until
then the server logs `curated <file>: N playable tiles (7 needed), not in rotation yet` at start. The file is read at
server start, so restart after editing.
