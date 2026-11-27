// Rooms and seats. One room per run; four seats; a seat is a server-side record (the on-chain
// program knows nothing about seats). Humans take seats with their identity and get a token that
// plant-fiat requires; bots fill the empty seats. All counting is in turns, never wall-clock.
import { randomBytes } from "node:crypto";

export const SEAT_COUNT = 4;
export const IDLE_TURNS = 10;

export interface Seat { no: number; address: string; token: string; takenTurn: number; lastActiveTurn: number }
export interface SeatView { kind: "human" | "bot" | "open"; name?: string; address?: string; you?: boolean; no: number }

export class RoomError extends Error { readonly code: number; constructor(msg: string, code: number) { super(msg); this.code = code; } }

export class Room {
  readonly seats: (Seat | null)[] = [null, null, null, null];
  host: string | null = null;
  private = false;
  /** Bots sit in the empty seats when the crowd is on. */
  botsEnabled: boolean;
  constructor(botsEnabled: boolean) { this.botsEnabled = botsEnabled; }

  dump() { return { seats: this.seats.map((s) => (s ? { ...s } : null)), host: this.host, private: this.private, botsEnabled: this.botsEnabled }; }
  static load(d: any, botsEnabled?: boolean): Room {
    const r = new Room(botsEnabled ?? !!d.botsEnabled);
    (d.seats ?? []).forEach((s: any, i: number) => { if (i < SEAT_COUNT) r.seats[i] = s ? { no: Number(s.no), address: String(s.address), token: String(s.token), takenTurn: Number(s.takenTurn), lastActiveTurn: Number(s.lastActiveTurn) } : null; });
    r.host = d.host ?? null; r.private = !!d.private;
    return r;
  }
  humans(): Seat[] { return this.seats.filter((s): s is Seat => !!s); }
  seatOf(address: string): Seat | undefined { return this.humans().find((s) => s.address === address); }
  freeCount(): number { return this.seats.filter((s) => !s).length; }
  /** Number of bots planting right now: one per empty seat. */
  botCount(): number { return this.botsEnabled ? this.freeCount() : 0; }

  take(address: string, turn: number): Seat {
    const mine = this.seatOf(address);
    if (mine) { mine.lastActiveTurn = turn; return mine; }
    const no = this.seats.findIndex((s) => !s);
    if (no < 0) throw new RoomError("All four seats are taken. You can still back Byte.", 409);
    const seat: Seat = { no: no + 1, address, token: randomBytes(16).toString("hex"), takenTurn: turn, lastActiveTurn: turn };
    this.seats[no] = seat;
    if (!this.host) this.host = address;
    return seat;
  }
  leave(address: string): Seat | null {
    const seat = this.seatOf(address);
    if (!seat) return null;
    this.seats[seat.no - 1] = null;
    return seat;
  }
  /** Validates a seat token for the caller (the token proves the seat; the identity proves the caller). */
  check(address: string, token: string | undefined): Seat {
    const seat = this.seatOf(address);
    if (!seat) throw new RoomError("Take a seat first. Only seated players can plant mines.", 403);
    if (!token || token !== seat.token) throw new RoomError("That seat token is not valid. Take the seat again.", 403);
    return seat;
  }
  touch(address: string, turn: number) { const s = this.seatOf(address); if (s) s.lastActiveTurn = Math.max(s.lastActiveTurn, turn); }
  /** Frees seats idle for IDLE_TURNS turns. Returns the freed seats. */
  sweep(turn: number): Seat[] {
    const freed: Seat[] = [];
    for (const s of this.humans()) if (turn - s.lastActiveTurn >= IDLE_TURNS) { this.seats[s.no - 1] = null; freed.push(s); }
    return freed;
  }
  setPrivate(address: string, value: boolean) {
    if (address !== this.host) throw new RoomError("Only the host can make the room private.", 403);
    this.private = value;
  }
  /** The undelayed room as the pages read it: seats, host, private flag, and what the viewer is in it. */
  summary(viewer: string | null, names: Record<string, string>) {
    return { seats: this.view(viewer, names), host: this.host, private: this.private, you: { host: viewer !== null && this.host === viewer, seat: viewer === null ? null : (this.seatOf(viewer)?.no ?? null) } };
  }
  view(viewer: string | null, names: Record<string, string>): SeatView[] {
    let bots = this.botCount();
    return this.seats.map((s, i) => {
      if (s) return { kind: "human", no: i + 1, address: s.address, name: names[s.address], you: viewer === s.address };
      if (bots > 0) { bots--; return { kind: "bot", no: i + 1, name: "Bot" }; }
      return { kind: "open", no: i + 1 };
    });
  }
}
