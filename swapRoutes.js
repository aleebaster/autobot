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
      const probe = probeAmountFor(A.decimals);
      const q = await quote(router, probe, [A.address, B.address]);
      if (q === null) {
        log(`[ROUTES] ${A.symbol}→${B.symbol} pool exists but quote FAILED — rejected`, "warn");
        continue;
      }
      routes.push({
        fromSym: A.symbol, toSym: B.symbol,
        fromAddr: A.address, toAddr: B.address,
        path: [A.address, B.address],
        type: "direct",
        pool,
        quoteSample: q.toString(),
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
        const probe = probeAmountFor(A.decimals);
        const q = await quote(router, probe, [A.address, hubAddr, B.address]);
        if (q === null) continue;
        const hub = list.find(t => String(t.address).toLowerCase() === String(hubAddr).toLowerCase());
        routes.push({
          fromSym: A.symbol, toSym: B.symbol,
          fromAddr: A.address, toAddr: B.address,
          path: [A.address, hubAddr, B.address],
          type: "multi",
          hubSym: hub?.symbol || null,
          pool: leg1,
          pool2: leg2,
          quoteSample: q.toString(),
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
  routeCandidates,
  sourcesForTarget,
  probeAmountFor,
  formatRoutesTable,
  ROUTER_QUOTE_ABI,
};
