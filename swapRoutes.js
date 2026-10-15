// ═══════════════════════════════════════════════════════════════════════════════
//  DYNAMIC SWAP ROUTE DISCOVERY — Nemesis V2 Router
//
//  Builds the token inventory and every VALID route between them:
//    • direct  A → B               when Factory has a live pool for (A,B) and
//                                   Router.getAmountsOut(A→B) succeeds
//    • multi   A → HUB → B         only when BOTH legs have a live pool and
//                                   Router.getAmountsOut(A→HUB→B) succeeds
//
//  A route is NEVER invented: it must pass getAmountsOut on-chain.
//  No hardcoded pairs, no hardcoded decimals (token.symbol()/decimals() only).
// ═══════════════════════════════════════════════════════════════════════════════

import { ethers } from "ethers";
import {
  ERC20_META_ABI,
  FACTORY_DISCOVERY_ABI,
  ZERO_ADDRESS,
  TokenMetaCache,
} from "./marketDiscovery.js";

export const ROUTER_QUOTE_ABI = [
  "function getAmountsOut(uint256 amountIn, address[] calldata path) view returns (uint256[] amounts)",
];

/** Probe amount = 1 whole token (scaled by that token's on-chain decimals). */
export function probeAmountFor(decimals) {
  const d = Number(decimals);
  if (!Number.isFinite(d) || d < 0 || d > 36) return 1n;
  return 10n ** BigInt(d);
}

/** Discovery probe ladder, in whole tokens (see probeAmountsFor). */
export const PROBE_LADDER_WHOLE = [1n, 10n, 100n, 1_000n, 10_000n, 100_000n, 1_000_000n, 10_000_000n, 100_000_000n];

/**
 * Ladder of probe amounts (in raw base units) for route discovery.
 *
 * A single "1 whole token" probe is NOT enough: on a heavily imbalanced pool the
 * 1-token quote rounds down to 0, `getAmountsOut` reverts/returns 0, and a
 * perfectly live pool gets dropped from the route set. That is exactly how the
 * directed route set degraded while the pools still quoted fine at real sizes.
 * The ladder keeps discovery size-tolerant (first rung that quotes wins, so
 * healthy pools still cost a single call); execution still re-quotes at the REAL
 * amount and skips when that quote is zero, so nothing with amountOut = 0 can
 * ever be sent.
 *
 * Upper rungs (10M / 100M whole tokens) exist so that a live-but-badly-
 * imbalanced pool is still REPORTED as a route instead of silently vanishing
 * from the matrix. Executability at the real trade size is decided later, at
 * execution time, by re-quoting the actual amount (zero quote → the pair is
 * skipped, nothing is sent).
 */
export function probeAmountsFor(decimals, wholeTokens = PROBE_LADDER_WHOLE) {
  const d = Number(decimals);
  const scale = (!Number.isFinite(d) || d < 0 || d > 36) ? 0n : BigInt(d);
  return wholeTokens.map(w => w * 10n ** scale);
}

/** First probe amount from the ladder that quotes a non-zero output (or null). */
async function probeQuote(router, path, decimals) {
  for (const probe of probeAmountsFor(decimals)) {
    const q = await quote(router, probe, path);
    if (q !== null) return { probe, out: q };
  }
  return null;
}

/**
 * Build the dynamic token inventory = deployment tokens ∪ every token seen in a market.
 * Deduplicated by address, meta always fetched on-chain.
 *
 * @returns {Promise<Array<{address, symbol, decimals}>>}
 */
export async function discoverTokens({ provider, tokens = {}, markets = [], log = () => {} }) {
  const cache = new TokenMetaCache(provider);
  const addresses = new Map(); // lowercase → checksum/first-seen

  for (const [sym, addr] of Object.entries(tokens || {})) {
    if (!addr) continue;
    const key = String(addr).toLowerCase();
    if (!addresses.has(key)) addresses.set(key, addr);
  }
  for (const m of markets || []) {
    for (const a of [m?.token0, m?.token1]) {
      if (!a) continue;
      const key = String(a).toLowerCase();
      if (!addresses.has(key)) addresses.set(key, a);
    }
  }

  const out = [];
  for (const addr of addresses.values()) {
    const meta = await cache.tryGet(addr);
    if (meta) out.push(meta);
    else log(`[ROUTES] token ${addr} meta unavailable — skipped`, "warn");
  }
  // Stable, human-friendly order (by symbol)
  out.sort((a, b) => a.symbol.localeCompare(b.symbol));
  log(`[ROUTES] token inventory: ${out.map(t => `${t.symbol}(${t.decimals})`).join(", ")}`, "info");
  return out;
}

async function poolExists(provider, factory, a, b) {
  try {
    const pool = await factory.getPool(a, b);
    if (!pool || pool === ZERO_ADDRESS) return null;
    const code = await provider.getCode(pool);
    if (!code || code === "0x") return null;
    return pool;
  } catch {
    return null;
  }
}

async function quote(router, amountIn, path) {
  try {
    const amounts = await router.getAmountsOut(amountIn, path);
    const out = amounts[amounts.length - 1];
    return out > 0n ? out : null;
  } catch {
    return null;
  }
}

/**
 * Discover every valid swap route across the token inventory.
 *
 * @param {Object} opts
 * @param {ethers.Provider} opts.provider
 * @param {string} opts.routerAddress
 * @param {string} opts.factoryAddress
 * @param {Array}  opts.tokens  [{address, symbol, decimals}]
 * @param {string[]} [opts.hubs] preferred hub tokens for multi-hop (default: stablecoins present)
 * @param {number} [opts.maxRoutes]
 * @param {Function} [opts.log]
 * @returns {Promise<Array<{fromSym,toSym,fromAddr,toAddr,path,type,pool,quoteSample,valid}>>}
 */
export async function discoverSwapRoutes({
  provider,
  routerAddress,
  factoryAddress,
  tokens = [],
  hubs = null,
  log = () => {},
}) {
  const factory = new ethers.Contract(factoryAddress, FACTORY_DISCOVERY_ABI, provider);
  const router = new ethers.Contract(routerAddress, ROUTER_QUOTE_ABI, provider);
  const list = (tokens || []).filter(t => t?.address && t.decimals !== null && t.decimals !== undefined);

  const hubCandidates = hubs && hubs.length
    ? hubs
    : list.filter(t => ["USDT", "USDC", "DAI"].includes(String(t.symbol).toUpperCase())).map(t => t.address);

  const routes = [];
  const poolCache = new Map();

  const key = (a, b) => [String(a).toLowerCase(), String(b).toLowerCase()].sort().join("|");
  const getPool = async (a, b) => {
    const k = key(a, b);
    if (poolCache.has(k)) return poolCache.get(k);
    const p = await poolExists(provider, factory, a, b);
    poolCache.set(k, p);
    return p;
  };

  // ── 1) DIRECT routes ──
  for (let i = 0; i < list.length; i++) {
    for (let j = 0; j < list.length; j++) {
      if (i === j) continue;
      const A = list[i], B = list[j];
      const pool = await getPool(A.address, B.address);
      if (!pool) continue;
      const hit = await probeQuote(router, [A.address, B.address], A.decimals);
      if (hit === null) {
        log(`[ROUTES] ${A.symbol}→${B.symbol} pool exists but quote FAILED — rejected`, "warn");
        continue;
      }
      routes.push({
        fromSym: A.symbol, toSym: B.symbol,
        fromAddr: A.address, toAddr: B.address,
        path: [A.address, B.address],
        type: "direct",
        pool,
        quoteSample: hit.out.toString(),
        valid: true,
      });
    }
  }

  const directKeys = new Set(routes.map(r => `${String(r.fromAddr).toLowerCase()}>${String(r.toAddr).toLowerCase()}`));

  // ── 2) MULTI-HOP fallback A → HUB → B (only when direct missing) ──
  for (let i = 0; i < list.length; i++) {
    for (let j = 0; j < list.length; j++) {
      if (i === j) continue;
      const A = list[i], B = list[j];
      const dk = `${String(A.address).toLowerCase()}>${String(B.address).toLowerCase()}`;
      if (directKeys.has(dk)) continue;

      let found = false;
      for (const hubAddr of hubCandidates) {
        if (String(hubAddr).toLowerCase() === String(A.address).toLowerCase()) continue;
        if (String(hubAddr).toLowerCase() === String(B.address).toLowerCase()) continue;
        const leg1 = await getPool(A.address, hubAddr);
        const leg2 = await getPool(hubAddr, B.address);
        if (!leg1 || !leg2) continue;
        const hit = await probeQuote(router, [A.address, hubAddr, B.address], A.decimals);
        if (hit === null) continue;
        const hub = list.find(t => String(t.address).toLowerCase() === String(hubAddr).toLowerCase());
        routes.push({
          fromSym: A.symbol, toSym: B.symbol,
          fromAddr: A.address, toAddr: B.address,
          path: [A.address, hubAddr, B.address],
          type: "multi",
          hubSym: hub?.symbol || null,
          pool: leg1,
          pool2: leg2,
          quoteSample: hit.out.toString(),
          valid: true,
        });
        found = true;
        break;
      }
      if (!found) {
        log(`[ROUTES] ${A.symbol}→${B.symbol} NO valid route`, "warn");
      }
    }
  }

  log(`[ROUTES] discovered ${routes.length} valid routes (${routes.filter(r => r.type === "direct").length} direct, ${routes.filter(r => r.type === "multi").length} multi-hop)`, "success");
  return routes;
}

/** Lookup a validated route (either direction must be explicitly present). */
export function findRoute(routes, fromAddr, toAddr) {
  if (!fromAddr || !toAddr) return null;
  const f = String(fromAddr).toLowerCase();
  const t = String(toAddr).toLowerCase();
  return (routes || []).find(r =>
    String(r.fromAddr).toLowerCase() === f && String(r.toAddr).toLowerCase() === t && r.valid
  ) || null;
}

const _l = (a) => String(a || "").toLowerCase();

/**
 * Bounded candidate paths for an ordered pair, best first:
 *   1. validated DIRECT route (or a read-only DIRECT probe when the pair has no
 *      validated route record — the probe is only accepted if the Router itself
 *      quotes amountOut > 0, so nothing invented is ever sent)
 *   2. validated 2-hop A→H→B (both legs must already be validated routes)
 * Never exceeds `maxPaths` (bounded search, no combinatorial explosion).
 */
export function candidatePaths(routes, fromAddr, toAddr, { maxPaths = 4, directProbe = true } = {}) {
  if (!fromAddr || !toAddr) return [];
  const f = _l(fromAddr), t = _l(toAddr);
  const valid = (routes || []).filter(r => r.valid);
  const leg = new Map();
  for (const r of valid) leg.set(`${_l(r.fromAddr)}>${_l(r.toAddr)}`, r);

  const out = [];
  const push = (path, type) => {
    if (!path || !path.length) return;
    const key = path.map(_l).join(">");
    if (out.some(o => o.key === key)) return;
    out.push({ path, type, key });
  };

  const direct = leg.get(`${f}>${t}`);
  if (direct) push(direct.path, "direct");
  else if (directProbe) push([fromAddr, toAddr], "direct-probe");

  for (const r1 of valid) {
    if (out.length >= maxPaths) break;
    if (_l(r1.fromAddr) !== f || !Array.isArray(r1.path) || r1.path.length !== 2) continue;
    const hub = _l(r1.toAddr);
    if (hub === t || hub === f) continue;
    const r2 = leg.get(`${hub}>${t}`);
    if (!r2 || !Array.isArray(r2.path) || r2.path.length !== 2) continue;
    push([fromAddr, r1.toAddr, toAddr], "multi");
  }
  return out.slice(0, maxPaths);
}

/**
 * Read-only quote across the bounded candidate paths (direct first, then validated
 * 2-hop). Returns { path, amountOut, type } for the FIRST path with amountOut > 0,
 * or null when every candidate path quotes zero/reverts — the caller must SKIP and
 * must never send a swap with amountOut = 0.
 *
 * @param {object} o
 * @param {boolean} [o.directProbe=true] allow the unvalidated A→B probe to be the
 *        FIRST candidate when the pair has no validated direct record. Callers that
 *        must exercise ONLY the validated multi-hop fallback (tests, diagnostics)
 *        pass `false`; production never does, because a live 1-hop pool is cheaper
 *        (one fee, one pool) than a 2-hop composition of the same two tokens.
 */
export async function quoteBestPath({ provider, routerAddress, routes, fromAddr, toAddr, amountIn, log = () => {}, maxPaths = 4, directProbe = true }) {
  if (!amountIn || amountIn <= 0n) return null;
  const cands = candidatePaths(routes, fromAddr, toAddr, { maxPaths, directProbe });
  if (!cands.length) {
    log(`[ROUTE] no validated path ${_l(fromAddr).slice(0, 10)}…→${_l(toAddr).slice(0, 10)}… — SKIP`, "warn");
    return null;
  }
  const router = new ethers.Contract(routerAddress, ROUTER_QUOTE_ABI, provider);
  for (const c of cands) {
    try {
      const amounts = await router.getAmountsOut(amountIn, c.path);
      const out = amounts[amounts.length - 1];
      if (out > 0n) return { path: c.path, amountOut: out, type: c.type };
      log(`[ROUTE] ${c.type} path quotes ZERO — trying next candidate path`, "warn");
    } catch (e) {
      log(`[ROUTE] ${c.type} path quote failed: ${e.message?.slice(0, 60)} — trying next candidate path`, "warn");
    }
  }
  log(`[ROUTE] QUOTE_ZERO across all ${cands.length} candidate path(s) — SKIP pair (no swap with amountOut=0)`, "warn");
  return null;
}

/**
 * Route candidates for a token inventory — used by the auto-swapper.
 * @returns {Array<{from, to, fromAddr, toAddr, path, type}>}
 */
export function routeCandidates(routes) {
  return (routes || [])
    .filter(r => r.valid)
    .map(r => ({
      from: r.fromSym, to: r.toSym,
      fromAddr: r.fromAddr, toAddr: r.toAddr,
      path: r.path, type: r.type,
      key: `${r.fromSym}>${r.toSym}`,
    }));
}

/**
 * Sources that can deliver `targetAddr` (every valid route ending at target).
 * Used for balance-aware collateral top-ups.
 */
export function sourcesForTarget(routes, targetAddr, excludeAddrs = []) {
  const excl = new Set((excludeAddrs || []).filter(Boolean).map(a => String(a).toLowerCase()));
  const t = String(targetAddr || "").toLowerCase();
  return (routes || []).filter(r =>
    r.valid &&
    String(r.toAddr).toLowerCase() === t &&
    !excl.has(String(r.fromAddr).toLowerCase())
  );
}

export function formatRoutesTable(routes) {
  const head = ["From", "To", "Route", "Valid", "Quote (probe)"];
  const rows = (routes || []).map(r => [
    r.fromSym, r.toSym,
    `${r.type}${r.hubSym ? ` via ${r.hubSym}` : ""}`,
    r.valid ? "YES" : "no",
    r.quoteSample ?? "-",
  ]);
  const all = [head, ...rows];
  const widths = head.map((_, i) => Math.max(...all.map(x => String(x[i] ?? "").length)));
  const line = r => "| " + r.map((c, i) => String(c ?? "").padEnd(widths[i])).join(" | ") + " |";
  const sep = "|" + widths.map(w => "-".repeat(w + 2)).join("|") + "|";
  return [line(head), sep, ...rows.map(line)].join("\n");
}

export default {
  discoverTokens,
  discoverSwapRoutes,
  findRoute,
  candidatePaths,
  quoteBestPath,
  routeCandidates,
  sourcesForTarget,
  probeAmountFor,
  probeAmountsFor,
  formatRoutesTable,
  ROUTER_QUOTE_ABI,
};
