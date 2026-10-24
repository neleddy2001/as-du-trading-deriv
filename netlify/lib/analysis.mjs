// Compact market-structure summary computed from OHLC candles ([time, open, high, low, close], oldest first).

function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

function atr(candles, period = 14) {
  if (candles.length <= period) return null;
  const tr = candles.slice(1).map((c, i) => {
    const prevClose = candles[i][4];
    return Math.max(c[2] - c[3], Math.abs(c[2] - prevClose), Math.abs(c[3] - prevClose));
  });
  let a = tr.slice(0, period).reduce((x, y) => x + y, 0) / period;
  for (let i = period; i < tr.length; i++) a = (a * (period - 1) + tr[i]) / period; // Wilder smoothing
  return a;
}

// Fractal swings: a high (low) higher (lower) than `k` bars on each side. Ignores the forming last candle.
function swings(candles, k = 2) {
  const closed = candles.slice(0, -1);
  const highs = [], lows = [];
  for (let i = k; i < closed.length - k; i++) {
    const win = closed.slice(i - k, i + k + 1);
    if (closed[i][2] === Math.max(...win.map((c) => c[2]))) highs.push({ time: closed[i][0], price: closed[i][2] });
    if (closed[i][3] === Math.min(...win.map((c) => c[3]))) lows.push({ time: closed[i][0], price: closed[i][3] });
  }
  return { highs, lows };
}

function structureLabel(highs, lows) {
  if (highs.length < 2 || lows.length < 2) return "indéterminée";
  const [h1, h2] = highs.slice(-2).map((s) => s.price);
  const [l1, l2] = lows.slice(-2).map((s) => s.price);
  if (h2 > h1 && l2 > l1) return "haussière (sommets et creux montants)";
  if (h2 < h1 && l2 < l1) return "baissière (sommets et creux descendants)";
  if (h2 < h1 && l2 > l1) return "compression (triangle)";
  return "mixte (expansion ou transition)";
}

const round = (x, d) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);

export function summarize(tfData) {
  const c = tfData.candles;
  const d = Math.max(2, tfData.pip_size ?? 5);
  const closes = c.map((x) => x[4]);
  const last = c[c.length - 1];
  const close = last[4];
  const e20 = ema(closes, 20), e50 = ema(closes, 50), e200 = ema(closes, 200);
  const a14 = atr(c, 14);
  const { highs, lows } = swings(c);

  let bias = "neutre";
  if (e20 && e50) {
    if (close > e50 && e20 > e50) bias = "haussier";
    else if (close < e50 && e20 < e50) bias = "baissier";
  }

  const window = c.slice(-21, -1);
  const rangeHigh = Math.max(...window.map((x) => x[2]));
  const rangeLow = Math.min(...window.map((x) => x[3]));
  const body = Math.abs(last[4] - last[1]);
  const span = last[2] - last[3] || 1e-12;
  const upperWick = last[2] - Math.max(last[1], last[4]);
  const lowerWick = Math.min(last[1], last[4]) - last[3];
  let candle = last[4] >= last[1] ? "haussière" : "baissière";
  if (lowerWick > 2 * body && lowerWick > upperWick) candle += ", longue mèche basse (rejet vendeur)";
  else if (upperWick > 2 * body && upperWick > lowerWick) candle += ", longue mèche haute (rejet acheteur)";
  else if (body / span > 0.7) candle += ", corps plein (élan)";

  return {
    timeframe: tfData.timeframe,
    last_time_utc: last[0],
    close: round(close, d),
    bias,
    structure: structureLabel(highs, lows),
    ema20: round(e20, d), ema50: round(e50, d), ema200: round(e200, d),
    atr14: round(a14, d),
    close_vs_ema50_in_atr: e50 && a14 ? round((close - e50) / a14, 2) : null,
    range20: { high: round(rangeHigh, d), low: round(rangeLow, d), position_pct: round(((close - rangeLow) / (rangeHigh - rangeLow || 1e-12)) * 100, 0) },
    last_candle: candle + " (peut être encore en formation)",
    swing_highs: highs.slice(-4).map((s) => ({ time: s.time, price: round(s.price, d) })),
    swing_lows: lows.slice(-4).map((s) => ({ time: s.time, price: round(s.price, d) })),
  };
}

// Nearest levels above and below price, pooled from all timeframes' swings plus previous D1 high/low.
export function keyLevels(byTf, price, digits) {
  const pool = [];
  for (const [tf, data] of Object.entries(byTf)) {
    const { highs, lows } = swings(data.candles);
    highs.slice(-6).forEach((s) => pool.push({ price: s.price, source: `sommet ${tf}` }));
    lows.slice(-6).forEach((s) => pool.push({ price: s.price, source: `creux ${tf}` }));
    if (tf === "D1" && data.candles.length > 1) {
      const prev = data.candles[data.candles.length - 2];
      pool.push({ price: prev[2], source: "plus haut veille D1" }, { price: prev[3], source: "plus bas veille D1" });
    }
  }
  const fmt = (l) => ({ price: round(l.price, digits), source: l.source });
  const above = pool.filter((l) => l.price > price).sort((a, b) => a.price - b.price).slice(0, 4).map(fmt);
  const below = pool.filter((l) => l.price < price).sort((a, b) => b.price - a.price).slice(0, 4).map(fmt);
  return { above, below };
}
