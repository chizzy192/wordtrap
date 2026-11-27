// A fake Supabase for tests: the four tables, credit_deposit and apply_delta with the documented rules, an offline switch.
import type { SupabaseLike } from "../src/store.ts";

/** A fake Supabase: four tables, credit_deposit + apply_delta with the documented rules, and an offline switch. */
export function fakeSupabase() {
  const t = { players: [] as any[], balances: [] as any[], deposits: [] as any[], ledger: [] as any[], decks: [] as any[] };
  let nextId = 1; const state = { offline: false, calls: [] as string[] };
  const fail = () => ({ data: null, error: { message: "TypeError: fetch failed" } });
  const bal = (u: string) => t.balances.find((b) => b.user_id === u);
  const rpc = async (fn: string, a: any) => {
    state.calls.push(fn);
    if (state.offline) return fail();
    if (fn === "credit_deposit") {
      if (t.deposits.some((d) => d.signature === a.p_signature)) return { data: false, error: null };
      t.deposits.push({ signature: a.p_signature, user_id: a.p_user, wallet: a.p_wallet, micro: Number(a.p_micro) });
      const b = bal(a.p_user) ?? (t.balances.push({ user_id: a.p_user, micro: 0 }), bal(a.p_user)!);
      b.micro += Number(a.p_micro);
      t.ledger.push({ id: nextId++, user_id: a.p_user, kind: "deposit", micro: Number(a.p_micro), ref: a.p_signature });
      return { data: true, error: null };
    }
    if (fn === "apply_delta") {
      const b = bal(a.p_user) ?? (t.balances.push({ user_id: a.p_user, micro: 0 }), bal(a.p_user)!);
      if (t.ledger.some((l) => l.user_id === a.p_user && l.kind === a.p_kind && l.ref === a.p_ref)) return { data: b.micro, error: null };
      if (b.micro + Number(a.p_delta) < 0) return { data: null, error: { message: "insufficient funds" } };
      b.micro += Number(a.p_delta);
      t.ledger.push({ id: nextId++, user_id: a.p_user, kind: a.p_kind, micro: Number(a.p_delta), ref: a.p_ref });
      return { data: b.micro, error: null };
    }
    return { data: null, error: { message: `unknown function ${fn}` } };
  };
  const from = (table: string) => {
    const filters: ((r: any) => boolean)[] = []; let cols: string[] | null = null, single = false, lim = Infinity, order: [string, boolean] | null = null, op: "select" | "upsert" = "select", payload: any = null, conflict = "user_id";
    const b: any = {
      select(c: string) { cols = c.split(",").map((x) => x.trim()); return b; },
      eq(k: string, v: any) { filters.push((r) => r[k] === v); return b; },
      in(k: string, vs: any[]) { filters.push((r) => vs.includes(r[k])); return b; },
      order(k: string, o: { ascending: boolean }) { order = [k, o.ascending]; return b; },
      limit(n: number) { lim = n; return b; },
      maybeSingle() { single = true; return b; },
      upsert(row: any, o: { onConflict: string }) { op = "upsert"; payload = row; conflict = o?.onConflict ?? "user_id"; return b; },
      then(res: any, rej: any) {
        state.calls.push(`${op} ${table}`);
        if (state.offline) return Promise.resolve(fail()).then(res, rej);
        const rows: any[] = (t as any)[table];
        if (op === "upsert") { const keys = conflict.split(",").map((k) => k.trim()); const i = rows.findIndex((r) => keys.every((k) => r[k] === payload[k])); if (i >= 0) rows[i] = { ...rows[i], ...payload }; else rows.push({ ...payload }); return Promise.resolve({ data: null, error: null }).then(res, rej); }
        let out = rows.filter((r) => filters.every((f) => f(r)));
        if (order) { const [k, asc] = order; out = [...out].sort((x, y) => (x[k] > y[k] ? 1 : -1) * (asc ? 1 : -1)); }
        out = out.slice(0, lim).map((r) => cols ? Object.fromEntries(cols.map((c) => [c, r[c]])) : r);
        return Promise.resolve({ data: single ? out[0] ?? null : out, error: null }).then(res, rej);
      },
    };
    return b;
  };
  return { client: { rpc, from } as SupabaseLike, tables: t, state };
}

