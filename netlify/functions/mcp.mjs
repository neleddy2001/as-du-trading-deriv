// Remote MCP server exposing Deriv public market data (candles, prices, symbols) to Claude.
// Access is gated by a secret path segment (/mcp/<token>) because claude.ai custom connectors
// cannot send custom Authorization headers. The token lives in the MCP_PATH_TOKEN env var.
import { timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { TIMEFRAMES, withDeriv, fetchCandles, fetchLastPrice, fetchSymbols } from "../lib/deriv.mjs";

const TF = z.enum(Object.keys(TIMEFRAMES));
const READ_ONLY = { readOnlyHint: true, openWorldHint: true };

const json = (data) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });
const fail = (e) => ({ isError: true, content: [{ type: "text", text: `Erreur Deriv : ${e.message}` }] });

function buildServer() {
  const server = new McpServer({ name: "deriv-market-data", version: "1.0.0" });

  server.registerTool("get_candles", {
    title: "Bougies OHLC Deriv",
    description:
      "Fetch OHLC candles for one Deriv instrument and timeframe, oldest first. The last candle may still be forming. " +
      "Accepts friendly names (GBPUSD, XAUUSD, BTCUSD, EURUSD) or exact Deriv symbols (frxGBPUSD, frxXAUUSD, cryBTCUSD). " +
      "Use list_symbols to find symbols for oil, indices or anything else. Read-only.",
    inputSchema: {
      symbol: z.string().describe("Instrument, e.g. GBPUSD, XAUUSD, BTCUSD or a Deriv symbol such as frxGBPUSD"),
      timeframe: TF.describe("Candle size: M1, M5, M15, M30, H1, H2, H4, H8 or D1"),
      count: z.number().int().min(1).max(1000).default(200).describe("Number of candles (1-1000, default 200)"),
    },
    annotations: READ_ONLY,
  }, async ({ symbol, timeframe, count }) => {
    try { return json(await withDeriv((call) => fetchCandles(call, symbol, timeframe, count))); }
    catch (e) { return fail(e); }
  });

  server.registerTool("get_multi_timeframe", {
    title: "Analyse multi-unités de temps",
    description:
      "Fetch candles for one instrument on several timeframes in a single call (default D1, H4, H1), for top-down analysis " +
      "starting with the dominant timeframe. Same symbol rules as get_candles. Read-only.",
    inputSchema: {
      symbol: z.string().describe("Instrument, e.g. GBPUSD, XAUUSD, BTCUSD or a Deriv symbol"),
      timeframes: z.array(TF).min(1).max(6).default(["D1", "H4", "H1"]).describe("Timeframes, dominant first"),
      count: z.number().int().min(1).max(500).default(120).describe("Candles per timeframe (default 120)"),
    },
    annotations: READ_ONLY,
  }, async ({ symbol, timeframes, count }) => {
    try {
      return json(await withDeriv(async (call) => {
        const out = {};
        for (const tf of timeframes) out[tf] = await fetchCandles(call, symbol, tf, count);
        return out;
      }));
    } catch (e) { return fail(e); }
  });

  server.registerTool("get_prices", {
    title: "Derniers prix Deriv",
    description: "Latest tick price and time for one or more instruments (friendly names or Deriv symbols). Read-only.",
    inputSchema: {
      symbols: z.array(z.string()).min(1).max(10).describe("Instruments, e.g. [\"GBPUSD\", \"XAUUSD\", \"BTCUSD\"]"),
    },
    annotations: READ_ONLY,
  }, async ({ symbols }) => {
    try {
      return json(await withDeriv(async (call) => {
        const out = [];
        for (const s of symbols) {
          try { out.push(await fetchLastPrice(call, s)); }
          catch (e) { out.push({ symbol: s, error: e.message }); }
        }
        return out;
      }));
    } catch (e) { return fail(e); }
  });

  server.registerTool("list_symbols", {
    title: "Instruments disponibles sur Deriv",
    description:
      "List Deriv instruments with their exact symbol, name, market and whether the market is open now. " +
      "Filter by market (forex, commodities, cryptocurrency, indices, synthetic_index) and/or a search text such as 'oil'. Read-only.",
    inputSchema: {
      market: z.string().optional().describe("Market filter, e.g. forex, commodities, cryptocurrency, indices"),
      search: z.string().optional().describe("Text to match in the symbol or name, e.g. oil, gold, GBP"),
    },
    annotations: READ_ONLY,
  }, async ({ market, search }) => {
    try {
      let list = await withDeriv((call) => fetchSymbols(call));
      if (market) list = list.filter((s) => (s.market || "").toLowerCase().includes(market.toLowerCase()));
      if (search) {
        const q = search.toLowerCase();
        list = list.filter((s) => `${s.symbol} ${s.name} ${s.submarket}`.toLowerCase().includes(q));
      }
      return json({ count: list.length, symbols: list.slice(0, 200) });
    } catch (e) { return fail(e); }
  });

  return server;
}

function tokenOk(provided) {
  const expected = globalThis.Netlify?.env.get("MCP_PATH_TOKEN") ?? process.env.MCP_PATH_TOKEN;
  if (!expected || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export default async (req, context) => {
  if (!tokenOk(context?.params?.token)) return new Response("Not found", { status: 404 });

  // Plain GET = quick health check, useful in a browser: confirms Deriv answers.
  // MCP clients that GET with Accept: text/event-stream are asking for an SSE stream we don't offer.
  if (req.method === "GET" && !(req.headers.get("accept") || "").includes("text/event-stream")) {
    const url = new URL(req.url);
    const symbol = url.searchParams.get("symbol") || "GBPUSD";
    try {
      const data = await withDeriv((call) => fetchCandles(call, symbol, url.searchParams.get("tf") || "H1", 5));
      return Response.json({ ok: true, ...data });
    } catch (e) {
      return Response.json({ ok: false, error: e.message }, { status: 502 });
    }
  }
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const server = buildServer();
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(req);
};

export const config = {
  path: "/mcp/:token",
  rateLimit: { windowSize: 60, windowLimit: 120, aggregateBy: ["ip", "domain"] },
};
