// Minimal Deriv WebSocket client for public market data (no account authorization).
import WebSocket from "ws";

export const TIMEFRAMES = {
  M1: 60, M2: 120, M3: 180, M5: 300, M10: 600, M15: 900, M30: 1800,
  H1: 3600, H2: 7200, H4: 14400, H8: 28800, D1: 86400,
};

// Friendly names -> Deriv symbols. Anything already in Deriv form (frx..., cry..., etc.) passes through.
const ALIASES = {
  BTC: "cryBTCUSD", BTCUSD: "cryBTCUSD", "BTC/USD": "cryBTCUSD",
  ETH: "cryETHUSD", ETHUSD: "cryETHUSD",
  GOLD: "frxXAUUSD", XAU: "frxXAUUSD", XAUUSD: "frxXAUUSD", "XAU/USD": "frxXAUUSD",
  SILVER: "frxXAGUSD", XAGUSD: "frxXAGUSD",
};

export function resolveSymbol(input) {
  const raw = String(input || "").trim();
  if (/^(frx|cry|OTC_|R_|1HZ|WLD|JD|BOOM|CRASH|stp|RDB|RDBEAR|RDBULL)/.test(raw)) return raw;
  const key = raw.toUpperCase().replace(/\s+/g, "");
  if (ALIASES[key]) return ALIASES[key];
  const compact = key.replace("/", "");
  if (/^[A-Z]{6}$/.test(compact)) return "frx" + compact;
  return raw;
}

function endpoints() {
  const appId = (globalThis.Netlify?.env.get("DERIV_APP_ID")) || process.env.DERIV_APP_ID || "1089";
  const custom = (globalThis.Netlify?.env.get("DERIV_WS_URL")) || process.env.DERIV_WS_URL;
  const list = [];
  if (custom) list.push(custom);
  list.push(`wss://ws.derivws.com/websockets/v3?app_id=${encodeURIComponent(appId)}`);
  list.push("wss://api.derivws.com/trading/v1/options/ws/public");
  return list;
}

function openSocket(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { handshakeTimeout: timeoutMs });
    const timer = setTimeout(() => { ws.terminate(); reject(new Error(`timeout connecting to ${url}`)); }, timeoutMs);
    ws.once("open", () => { clearTimeout(timer); resolve(ws); });
    ws.once("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

// Runs fn(call) on one connection; call(payload) sends a request and resolves with the matching response.
export async function withDeriv(fn, { timeoutMs = 12000 } = {}) {
  let ws, lastErr;
  for (const url of endpoints()) {
    try { ws = await openSocket(url, timeoutMs); break; } catch (e) { lastErr = e; }
  }
  if (!ws) throw new Error(`Deriv unreachable: ${lastErr?.message || "unknown error"}`);

  let nextId = 1;
  const pending = new Map();
  ws.on("message", (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }
    const p = pending.get(msg.req_id);
    if (!p) return;
    pending.delete(msg.req_id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(`${msg.error.code || "DerivError"}: ${msg.error.message}`));
    else p.resolve(msg);
  });
  ws.on("close", () => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error("Deriv connection closed")); } pending.clear(); });

  const call = (payload) => new Promise((resolve, reject) => {
    const req_id = nextId++;
    const timer = setTimeout(() => { pending.delete(req_id); reject(new Error("Deriv request timed out")); }, timeoutMs);
    pending.set(req_id, { resolve, reject, timer });
    ws.send(JSON.stringify({ ...payload, req_id }));
  });

  try { return await fn(call); } finally { try { ws.close(); } catch {} }
}

export async function fetchCandles(call, symbol, timeframe, count = 200) {
  const granularity = TIMEFRAMES[timeframe];
  if (!granularity) throw new Error(`Unknown timeframe ${timeframe}. Use one of ${Object.keys(TIMEFRAMES).join(", ")}`);
  const derivSymbol = resolveSymbol(symbol);
  const res = await call({
    ticks_history: derivSymbol, style: "candles", granularity,
    end: "latest", count: Math.max(1, Math.min(1000, count)), adjust_start_time: 1,
  });
  const candles = (res.candles || []).map((c) => [
    new Date(c.epoch * 1000).toISOString().replace(".000Z", "Z"), +c.open, +c.high, +c.low, +c.close,
  ]);
  return { symbol: derivSymbol, timeframe, pip_size: res.pip_size, count: candles.length, columns: ["time_utc", "open", "high", "low", "close"], candles };
}

export async function fetchLastPrice(call, symbol) {
  const derivSymbol = resolveSymbol(symbol);
  const res = await call({ ticks_history: derivSymbol, style: "ticks", end: "latest", count: 1 });
  const h = res.history || {};
  const price = h.prices?.[h.prices.length - 1];
  const epoch = h.times?.[h.times.length - 1];
  return { symbol: derivSymbol, price: price != null ? +price : null, time_utc: epoch ? new Date(epoch * 1000).toISOString() : null, pip_size: res.pip_size };
}

export async function fetchSymbols(call) {
  const res = await call({ active_symbols: "brief" });
  return (res.active_symbols || []).map((s) => ({
    symbol: s.symbol || s.underlying_symbol,
    name: s.display_name || s.underlying_symbol_name,
    market: s.market, submarket: s.submarket,
    open: s.exchange_is_open === 1 || s.exchange_is_open === true,
  }));
}
