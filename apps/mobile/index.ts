// Polyfills must load before web3.js / anchor.
import "react-native-get-random-values";
import { Buffer } from "buffer";
(global as any).Buffer = (global as any).Buffer ?? Buffer;
import { registerRootComponent } from "expo";
import App from "./App";
registerRootComponent(App);
