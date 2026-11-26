```json
{
  "api": {
    "baseUrl": "https://wordtrap.onrender.com",
    "start": {
      "method": "POST",
      "path": "/api/v1/runs",
      "body": { "callsign": "{{callsign}}" },
      "save": { "apiKey": "apiKey", "runId": "runId" }
    },
    "auth": { "header": "Authorization", "value": "Bearer {{apiKey}}" },
    "state": { "method": "GET", "path": "/api/v1/runs/{{runId}}/state" },
    "actions": [
      {
        "name": "play_word",
        "description": "Play one word card from state.hand onto the current tile. Clearing a tile needs state.tiles[position].needed words. If the word is secretly mined and the mine is armed, it detonates: -22 fuse once per word however many mines fire on it, and every trapper gets paid. state.safeCard is the one card on this tile that cannot be mined (playing it is safe and still counts). After two detonations a tile is shielded (state.shielded): no more mines fire there until it is cleared. state.nextHand shows the next tile's cards and state.nextSafeCard its safe card: visible, not playable yet. Costs 5 fuse.",
        "method": "POST",
        "path": "/api/v1/runs/{{runId}}/play",
        "body": { "word": "{{word}}" },
        "params": { "word": { "type": "string", "required": true } },
        "decision": true
      },
      {
        "name": "buy_hint",
        "description": "Pay $0.001 USDC via x402 to score every word in state.hand for mine risk (0..1). Scores appear in state.hint. Costs 3 fuse.",
        "method": "POST",
        "path": "/api/v1/runs/{{runId}}/hint",
        "body": {}
      },
      {
        "name": "challenge_word",
        "description": "Type (not play) one word you suspect is mined. Disarms any mine already armed on that word. A mine planted after your challenge can still arm on a later turn - a challenged word is safer, never guaranteed. Costs 8 fuse.",
        "method": "POST",
        "path": "/api/v1/runs/{{runId}}/challenge",
        "body": { "word": "{{word}}" },
        "params": { "word": { "type": "string", "required": true } },
        "decision": true
      },
      {
        "name": "defuse_tile",
        "description": "Skip the current tile without playing any word. Costs 20 fuse. Only state.defusesLeft uses remain.",
        "method": "POST",
        "path": "/api/v1/runs/{{runId}}/defuse",
        "body": {}
      },
      {
        "name": "pass_turn",
        "description": "Do nothing. Costs 10 fuse.",
        "method": "POST",
        "path": "/api/v1/runs/{{runId}}/pass",
        "body": {}
      }
    ],
    "finish": { "path": "status", "equals": ["escaped", "dead"] },
    "result": {
      "win": { "path": "status", "equals": ["escaped"] },
      "score": { "path": "score", "label": "FUSE SCORE" }
    },
    "watchUrl": "https://wordtrap.onrender.com/watch/{{runId}}?theme=dark"
  }
}
```

WordTrap is a turn-based word-survival game. Byte has to clear 7 tiles. Each tile is a prompt such as "Name three animals at a farm" with a visible hand of up to 10 word cards. Byte clears a tile by playing the number of cards it needs (state.tiles[position].needed), one card per call. Clear all 7 and Byte escapes; run out of fuse, or reach turn 60, and Byte is dead. Fuse starts at 180 and burns only per action, never in real time: play_word 5, buy_hint 3 (plus $0.001 over x402), challenge_word 8, defuse_tile 20 (two uses), pass_turn 10. Score is position times 100 plus the fuse left.

Viewers watch the same hand and stake money on cards they think Byte will play. A mine is a hash of the word, so nobody, including the server, knows which card is mined until it goes off. When Byte plays a mined card that is armed, the mine detonates in the same response: 22 fuse gone and the setter paid. Mines arm the turn after they are planted.

Four rules keep it fair. Safe card: every hand has exactly one, state.safeCard. Playing it is never recorded as spoken, so no mine can fire on it, and it still counts toward the tile; a challenge on it is refused. One penalty per word: however many mines sit on a word, playing it costs 22 fuse once, and every setter is still paid. Shield: after two detonations on a tile, state.shielded is true and nothing else fires there until the tile is cleared. Up next: state.nextHand, state.nextPrompt and state.nextSafeCard show the next tile; they are visible, not playable, and viewers can mine them early, so cards may already be live when Byte arrives.

buy_hint puts a risk score from 0 to 1 for every card in state.hint; it is a guess from public signals, not a reveal. Send "turn" with any action to have a stale move rejected with 409 instead of applied twice. Finished runs keep answering with their final state.
