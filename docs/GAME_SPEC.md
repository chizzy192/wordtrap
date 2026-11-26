# WordTrap — game document for the Byte Arena "My games" upload

**One line:** Byte has to clear a board of word prompts by playing word cards before its fuse burns out, while viewers secretly mine the very cards it can see.

## What the game is

WordTrap is a turn-based word-survival game played over HTTP. A run is a board of 7 tiles. Each tile is a prompt such as "Name three animals at a farm" and comes with a visible **hand** of up to 10 word cards: a mix of the obvious answers ("cow", "pig") and sideways synonyms ("alpaca", "rooster"). Byte clears a tile by playing the number of cards the tile needs (`state.tiles[position].needed`, usually 3), one card per turn. Clear all 7 tiles and Byte escapes.

The twist: viewers can see the same hand, and they stake USDC on cards they think Byte will play. A mine is a sha256 commitment of the word plus a secret salt, so nobody, including the game server, knows which card is mined until it goes off. Every card Byte plays is recorded on a Solana program. When Byte plays a mined card, the viewer's device reveals the mine, the fuse loses 22 units, and the viewer is paid their stake plus a bounty. If Byte escapes, the viewers who backed Byte split every mine that never fired.

## The fuse

The fuse is an integer that starts at **180**. It does not burn in real time. Every action burns a fixed amount, so Byte can think as long as it likes. The run ends when all tiles are cleared (`status: "escaped"`), when the fuse reaches 0, or at turn 60 (`status: "dead"`).

## The five actions

| Action | Fuse cost | What it does |
|---|---|---|
| `play_word` (`word`) | 5 | Plays one card from `state.hand` onto the current tile. The word must be in the hand; anything else is rejected with an error and the current state. If the card is mined and the mine is armed, it detonates in the same response: 22 extra fuse burned, the trapper paid. |
| `buy_hint` | 3 (plus $0.001 USDC paid over x402) | Buys a risk score from 0 to 1 for every card in the hand. The scores appear in `state.hint` on this and every later response until the tile changes. Scores are computed from public signals only: how obvious a card is for the prompt, which words already detonated, and how much the crowd has staked recently. They are a guess, not a reveal. |
| `challenge_word` (`word`) | 8 | Names a word Byte suspects is mined **without playing it**. If a mine on that word is already armed, that mine is disarmed. The card becomes safer, not guaranteed. The word stays in the hand. A mine planted on the same turn as the challenge still arms on the next turn, so a challenge covers what exists now, not what comes later. |
| `defuse_tile` | 20 | Skips the current tile without playing anything. Only `state.defusesLeft` uses remain (2 per run). |
| `pass_turn` | 10 | Does nothing. |

Every action advances `state.turn` by exactly 1. Mines viewers plant during a turn arm on the following turn, so a card that was safe on this response may be mined on the next.

## Looking ahead

`state.nextHand` (with `state.nextPrompt` and `state.nextSafeCard`) and `state.laterHand` show the
cards of the next two tiles. They are **visible, not playable**: `play_word` only accepts cards in
`state.hand`. Viewers can see them too and mine them early, so by the time Byte reaches a tile some of
its cards may already be live mines.

**Safe card.** Every hand has exactly one, `state.safeCard`. Playing it is never recorded as spoken, so
no mine can fire on it; it still counts toward the tile. A challenge on it is refused (there is nothing
to disarm).

**One penalty per word.** However many mines sit on one word, playing it costs 22 fuse once. Every
setter is still paid.

**Shield.** After two detonations on a tile, `state.shielded` becomes true and no more mines fire there
until the tile is cleared.

**Seats.** Four viewers can sit in a room and plant; the rest watch and back Byte. Seats are enforced
by the server, not on-chain.

## Reading the state

Every response is the full state. The fields that matter for a decision:

- `hand`: the cards Byte may play right now. Played cards leave the hand.
- `tiles[position]`: the current prompt, how many cards it `needed`, and which have been `played`.
- `fuse`, `defusesLeft`, `hint` (null until bought), `challenged`, `spoken`.
- `traps`: every mine on the board, with its stake, the turn it arms on, and whether it has fired. Fired mines show their word; armed ones show only a hash.
- `backerTotal` and `trapTotal`: how much is riding on Byte escaping versus detonating.
- `status`, `score`, and `turn`.

Optionally send `"turn": <state.turn>` with any action. If it does not match the current turn the server answers 409 with the current state instead of applying the move twice.

## Finishing

The run is over when `status` is `"escaped"` or `"dead"`. A win is `"escaped"`. The score is `position * 100 + max(0, fuse)`: 100 points per tile cleared plus whatever fuse is left, so an escape with a fat fuse beats a scrappy one. Finished runs keep answering with their final state.

## What viewers see

The watch page shows the board, the fuse, Byte's hand (cards that detonated turn red, challenged cards are struck through), the hidden mines as hashes, the backer pool, and each detonation as it lands. Viewers on the TrapSetter mobile app swipe cards from Byte's hand into a combo and arm it with one wallet signature. Their phone reveals the mine the instant Byte plays the card.
