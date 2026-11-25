// TrapSetter — second-screen co-play. Swipe right to add a word to your mine combo,
// left to skip; one MWA signature arms the combo before Byte's turn resolves.
import { useEffect, useRef, useState } from "react";
import { Animated, PanResponder, Pressable, SafeAreaView, StyleSheet, Text, TextInput, View } from "react-native";
import Constants from "expo-constants";
import { PublicKey } from "@solana/web3.js";
import { armCombo, detonate, loadSecrets } from "./src/chain";

const SERVER = (Constants.expoConfig!.extra as any).serverUrl as string;
const C = { bg: "#0b0a10", panel: "#15131d", line: "#2a2636", ink: "#ece8f4", dim: "#8c86a0", fuse: "#ffb020", hot: "#ff3b4e", mine: "#9b7bff", safe: "#3ce0a0" };

export default function App() {
  const [state, setState] = useState<any>(null);
  const [deck, setDeck] = useState<string[]>([]);
  const [combo, setCombo] = useState<string[]>([]);
  const [stake, setStake] = useState(0.25);
  const [windowLeft, setWindowLeft] = useState(0);
  const [toast, setToast] = useState("");
  const [custom, setCustom] = useState("");
  const gameKey = state?.matchPda ? new PublicKey(state.matchPda) : null;

  // live feed
  useEffect(() => {
    let ws: WebSocket; let alive = true;
    const open = () => {
      ws = new WebSocket(SERVER.replace(/^http/, "ws") + "/ws");
      ws.onmessage = async (m) => {
        const e = JSON.parse(m.data as string);
        if (e.type === "state") { setState(e.state); autoDetonate(e.state); }
        if (e.type === "turn_window") { setWindowLeft(Math.ceil(e.closesInMs / 1000)); refreshDeck(); }
        if (e.type === "trap_fired") setToast(`💥 ${e.trap.word.toUpperCase()} paid $${e.payout.toFixed(2)}`);
      };
      ws.onclose = () => alive && setTimeout(open, 1500);
    };
    open();
    return () => { alive = false; ws?.close(); };
  }, []);

  useEffect(() => { if (windowLeft <= 0) return; const t = setTimeout(() => setWindowLeft(windowLeft - 1), 1000); return () => clearTimeout(t); }, [windowLeft]);

  async function refreshDeck() {
    const r = await fetch(`${SERVER}/suggest`).then((r) => r.json()).catch(() => ({ words: [] }));
    setDeck(r.words);
  }

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
      setToast(`Armed ${combo.length} mine${combo.length > 1 ? "s" : ""} · $${(stake * combo.length).toFixed(2)}`);
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
  const fuse = state ? Math.ceil(state.fuseMs / 1000) : 0;

  return (
    <SafeAreaView style={s.root}>
      <View style={s.head}>
        <Text style={s.logo}>WORD<Text style={{ color: C.hot }}>TRAP</Text></Text>
        <Text style={[s.fuse, fuse <= 30 && { color: C.hot }]}>{fuse}s</Text>
      </View>
      <Text style={s.prompt}>{tile?.prompt ?? "waiting for match…"}</Text>
      <Text style={[s.window, { opacity: windowLeft > 0 ? 1 : 0.35 }]}>
        {windowLeft > 0 ? `MINES ARMING · ${windowLeft}s` : "Byte is speaking…"}
      </Text>

      <View style={s.deck}>{top ? <SwipeCard key={top} word={top} onSwipe={swipe} /> : <Text style={s.dim}>No cards — type your own below</Text>}</View>

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
        <Pressable style={[s.arm, (!combo.length || windowLeft <= 0) && { opacity: 0.4 }]} onPress={arm}>
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
