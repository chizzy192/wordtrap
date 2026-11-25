// TrapSetter — second-screen co-play. Swipe right to add a card from Byte's hand to your mine
// combo, left to skip; one MWA signature arms the combo. Mines arm on Byte's next turn.
// Polls the server (no websocket): /api/v1/current until a run exists, then /runs/:id/spectate.
import { useEffect, useRef, useState } from "react";
import { Animated, PanResponder, Pressable, SafeAreaView, StyleSheet, Text, TextInput, View } from "react-native";
import Constants from "expo-constants";
import { PublicKey } from "@solana/web3.js";
import { armCombo, detonate, loadSecrets } from "./src/chain";

const SERVER = (Constants.expoConfig!.extra as any).serverUrl as string;
const POLL_MS = 1500;
const C = { bg: "#0b0a10", panel: "#15131d", line: "#2a2636", ink: "#ece8f4", dim: "#8c86a0", fuse: "#ffb020", hot: "#ff3b4e", mine: "#9b7bff", safe: "#3ce0a0" };

export default function App() {
  const [runId, setRunId] = useState<string | null>(null);
  const [state, setState] = useState<any>(null);
  const [deck, setDeck] = useState<string[]>([]);
  const [combo, setCombo] = useState<string[]>([]);
  const [stake, setStake] = useState(0.25);
  const [toast, setToast] = useState("");
  const [custom, setCustom] = useState("");
  const seq = useRef(0);
  const dealtFor = useRef<string>("");
  const gameKey = state?.matchPda ? new PublicKey(state.matchPda) : null;

  // live feed: poll for the current run, then poll its spectator feed
  useEffect(() => {
    let alive = true;
    let id: string | null = runId;
    const tick = async () => {
      try {
        if (!id) {
          const cur = await fetch(`${SERVER}/api/v1/current`).then((r) => r.json());
          if (!cur.runId) return;
          id = cur.runId; seq.current = 0; setRunId(id);
        }
        const r = await fetch(`${SERVER}/runs/${id}/spectate?after=${seq.current}&delay=0`);   // the phone reveals against the real game
        if (!r.ok) { if (r.status === 404) { id = null; setRunId(null); } return; }
        const { seq: s, events, state: st } = await r.json();
        if (!alive) return;
        seq.current = s;
        for (const e of events) if (e.type === "trap_fired") setToast(`💥 ${e.trap.word.toUpperCase()} paid $${e.payout.toFixed(2)}`);
        setState(st);
        autoDetonate(st);
        // a fresh swipe deck whenever Byte moves to a new tile (the hand is public)
        const key = `${st.matchId}:${st.position}`;
        if (dealtFor.current !== key) { dealtFor.current = key; setDeck(st.hand); }
        if (st.status !== "live") { id = null; setRunId(null); }   // next run picks up automatically
      } catch { /* offline — retry on the next tick */ }
    };
    tick();
    const t = setInterval(tick, POLL_MS);
    return () => { alive = false; clearInterval(t); };
  }, []);

  async function autoDetonate(s: any) {
    if (!s?.matchPda) return;
    for (const sec of await loadSecrets()) {
      if (s.spoken.some((w: any) => w.word === sec.word)) {
        detonate(new PublicKey(s.matchPda), sec).then(() => setToast(`💥 YOUR MINE "${sec.word}" FIRED`)).catch(() => { /* not armed yet / challenged */ });
      }
    }
  }

  async function arm() {
    if (!gameKey || !combo.length) return;
    try {
      await armCombo(gameKey, combo, stake);
      setToast(`Armed ${combo.length} mine${combo.length > 1 ? "s" : ""} · $${(stake * combo.length).toFixed(2)} · live on Byte's next turn`);
      setCombo([]);
    } catch (e: any) { setToast(e.message ?? "wallet rejected"); }
  }

  const top = deck[0];
  const swipe = (right: boolean) => {
    if (!top) return;
    if (right && !combo.includes(top)) setCombo([...combo, top]);
    setDeck(deck.slice(1));
  };

  const tile = state?.tiles?.[state.position];
  const fuse = state?.fuse ?? 0;
  const live = state?.status === "live";

  return (
    <SafeAreaView style={s.root}>
      <View style={s.head}>
        <Text style={s.logo}>WORD<Text style={{ color: C.hot }}>TRAP</Text></Text>
        <Text style={[s.fuse, fuse <= 30 && { color: C.hot }]}>{fuse}</Text>
      </View>
      <Text style={s.prompt}>{tile?.prompt ?? (runId ? "run over — waiting for the next one…" : "waiting for a run…")}</Text>
      <Text style={s.window}>
        {live ? `TURN ${state.turn} · ${tile?.played?.length ?? 0}/${tile?.needed ?? 0} cards played · mines arm next turn` : "Byte is not playing right now"}
      </Text>

      <View style={s.deck}>{top ? <SwipeCard key={top} word={top} onSwipe={swipe} /> : <Text style={s.dim}>No cards left — type your own below</Text>}</View>

      <View style={s.row}>
        <TextInput style={s.input} value={custom} onChangeText={setCustom} placeholder="custom word" placeholderTextColor={C.dim} autoCapitalize="none" />
        <Pressable style={s.small} onPress={() => { const w = custom.toLowerCase().replace(/[^a-z]/g, ""); if (w.length >= 3) setCombo([...new Set([...combo, w])]); setCustom(""); }}><Text style={s.smallT}>+</Text></Pressable>
      </View>

      <View style={s.panel}>
        <Text style={s.label}>COMBO</Text>
        <View style={s.chips}>{combo.map((w) => <Pressable key={w} onPress={() => setCombo(combo.filter((x) => x !== w))}><Text style={s.chip}>{w} ✕</Text></Pressable>)}</View>
        <View style={s.row}>
          {[0.1, 0.25, 0.5, 1].map((v) => (
            <Pressable key={v} onPress={() => setStake(v)} style={[s.stake, stake === v && { borderColor: C.mine }]}><Text style={s.stakeT}>${v}</Text></Pressable>
          ))}
        </View>
        <Pressable style={[s.arm, (!combo.length || !live) && { opacity: 0.4 }]} onPress={arm}>
          <Text style={s.armT}>ARM {combo.length || ""} MINE{combo.length === 1 ? "" : "S"} · ${(stake * combo.length).toFixed(2)}</Text>
        </Pressable>
      </View>
      {!!toast && <Text style={s.toast} onPress={() => setToast("")}>{toast}</Text>}
    </SafeAreaView>
  );
}

function SwipeCard({ word, onSwipe }: { word: string; onSwipe: (right: boolean) => void }) {
  const x = useRef(new Animated.Value(0)).current;
  const pan = useRef(PanResponder.create({
    onMoveShouldSetPanResponder: () => true,
    onPanResponderMove: Animated.event([null, { dx: x }], { useNativeDriver: false }),
    onPanResponderRelease: (_, g) => {
      if (Math.abs(g.dx) > 110) Animated.timing(x, { toValue: g.dx > 0 ? 500 : -500, duration: 160, useNativeDriver: false }).start(() => onSwipe(g.dx > 0));
      else Animated.spring(x, { toValue: 0, useNativeDriver: false }).start();
    },
  })).current;
  const rotate = x.interpolate({ inputRange: [-200, 200], outputRange: ["-12deg", "12deg"] });
  return (
    <Animated.View {...pan.panHandlers} style={[s.card, { transform: [{ translateX: x }, { rotate }] }]}>
      <Text style={s.cardWord}>{word}</Text>
      <Text style={s.dim}>← skip · mine it →</Text>
    </Animated.View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg, padding: 18 },
  head: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 24 },
  logo: { color: C.ink, fontSize: 24, fontWeight: "900", letterSpacing: 1 },
  fuse: { color: C.fuse, fontSize: 28, fontWeight: "900" },
  prompt: { color: C.ink, fontSize: 20, fontWeight: "700", marginTop: 14 },
  window: { color: C.mine, marginTop: 6, fontWeight: "700", letterSpacing: 1 },
  deck: { height: 220, alignItems: "center", justifyContent: "center", marginVertical: 16 },
  card: { width: "85%", height: 200, backgroundColor: C.panel, borderRadius: 18, borderWidth: 1, borderColor: C.mine, alignItems: "center", justifyContent: "center", gap: 12 },
  cardWord: { color: C.ink, fontSize: 40, fontWeight: "900" },
  dim: { color: C.dim },
  row: { flexDirection: "row", gap: 8, marginVertical: 6 },
  input: { flex: 1, backgroundColor: C.panel, color: C.ink, borderRadius: 10, paddingHorizontal: 12, borderWidth: 1, borderColor: C.line },
  small: { backgroundColor: C.mine, borderRadius: 10, width: 48, alignItems: "center", justifyContent: "center" },
  smallT: { fontSize: 22, fontWeight: "900" },
  panel: { backgroundColor: C.panel, borderRadius: 14, padding: 14, marginTop: 8, borderWidth: 1, borderColor: C.line },
  label: { color: C.dim, fontSize: 11, letterSpacing: 1.5 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginVertical: 8, minHeight: 24 },
  chip: { color: C.mine, borderWidth: 1, borderColor: C.mine, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 2 },
  stake: { flex: 1, borderWidth: 1, borderColor: C.line, borderRadius: 10, paddingVertical: 8, alignItems: "center" },
  stakeT: { color: C.ink, fontWeight: "700" },
  arm: { backgroundColor: C.hot, borderRadius: 12, paddingVertical: 14, alignItems: "center", marginTop: 6 },
  armT: { color: "#fff", fontWeight: "900", letterSpacing: 1 },
  toast: { position: "absolute", bottom: 30, left: 18, right: 18, backgroundColor: C.panel, color: C.ink, padding: 14, borderRadius: 12, textAlign: "center", borderWidth: 1, borderColor: C.hot, overflow: "hidden" },
});
