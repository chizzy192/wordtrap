// What the game engine needs from the settlement layer. Two implementations:
//  - MockChain   : in-memory mirror of the Anchor program (offline demos, tests)
//  - SolanaChain : real devnet program via Anchor client
export interface PlantArgs { commitmentHex: string; stake: number; setter: string }
export interface RevealArgs { trapId: string; word: string; saltHex: string; setter: string }

export interface ChainTrap { id: string; setter: string; stake: number; armedTurn: number; status: "armed" | "fired" | "refunded"; word?: string }

export interface TrapFiredEvent { trap: ChainTrap; word: string; payout: number; turn: number }

export interface Chain {
  readonly kind: "mock" | "solana";
  /** On-chain Game PDA, once initialized (solana mode). */
  address?(): string | undefined;
  initMatch(matchId: string): Promise<void>;
  startMatch(): Promise<void>;
  advanceTurn(): Promise<number>;
  recordWords(words: string[], kind: "spoken" | "challenged"): Promise<string>; // returns tx sig
  endMatch(byteSurvived: boolean): Promise<void>;
  /** Server never knows trap words; it only learns them when a setter reveals. */
  onTrapFired(cb: (e: TrapFiredEvent) => void): void;
  onTrapPlanted(cb: (t: ChainTrap) => void): void;
  snapshot(): { turn: number; backerTotal: number; trapTotal: number; traps: ChainTrap[] };
  // Viewer-side calls. In production these are signed by the viewer (mobile MWA / Pollar);
  // the server exposes them only in mock mode for browser demos.
  plantTrap?(a: PlantArgs): Promise<ChainTrap>;
  revealTrap?(a: RevealArgs): Promise<TrapFiredEvent>;
  backByte?(user: string, amount: number): Promise<void>;
}
