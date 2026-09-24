// ═══════════════════════════════════════════════════════════════════════════════
//  DYNAMIC MARKET DISCOVERY — Nemesis V2 (Sepolia)
//
//  Single source of truth for "which markets exist, which directions they allow".
//
//  Candidate sources (merged, never invented):
//    1. config.json           → availableMarkets  (declared symbols, supportsLong/Short, isActive)
//    2. deployments/v2.js     → confirmedPools     (verified pool + manager addresses)
//    3. deployments/v2.js     → knownMarkets       (reference symbols)
//    4. on-chain Factory      → getPool(tA,tB) / getManager(pool)  (authoritative pool set)
//    5. on-chain Pool         → token0() / token1() / getReserves() / swapFeeBps()
//    6. on-chain ERC20        → symbol() / decimals()   (NO hardcoded decimals anywhere)
//
//  Rules enforced here:
//    • pool/manager without code            → market NOT usable
//    • declared isActive === false          → market NOT usable
//    • declared deployed === false          → that pool address NOT usable
//    • supportsLong === false               → LONG forbidden  (honoured)
//    • supportsShort === false              → SHORT forbidden (honoured)
//    • undeclared factory markets           → directions start enabled, but the runtime
//                                             capability learner can disable them on failure
//    • LONG collateral = token0, SHORT collateral = token1   (contract rule, per market)
// ═══════════════════════════════════════════════════════════════════════════════

import { ethers } from "ethers";

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export const ERC20_META_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
];

export const FACTORY_DISCOVERY_ABI = [
  "function getPool(address tokenA, address tokenB) view returns (address)",
  "function getManager(address pool) view returns (address)",
];

export const POOL_DISCOVERY_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1)",
  "function swapFeeBps() view returns (uint256)",
];

// Stablecoins → used only to identify the "risky" (payment) token of a market.
export const STABLE_SYMBOLS = new Set(["USDT", "USDC", "DAI", "USDE", "BUSD", "TUSD"]);

// ═══════════════════════════════════════════════════════════════════════════════
//  TOKEN META CACHE — always `await token.decimals()` / `await token.symbol()`
// ═══════════════════════════════════════════════════════════════════════════════

export class TokenMetaCache {
  constructor(provider) {
    this.provider = provider;
    this.cache = new Map();
  }

  async get(addr) {
    if (!addr) throw new Error("TokenMetaCache.get: address required");
    const key = String(addr).toLowerCase();
    const cached = this.cache.get(key);
    // Seeded placeholders may have decimals:null — always re-fetch until complete
    if (cached && cached.symbol && cached.decimals !== null && cached.decimals !== undefined) {
      return cached;
    }
    const c = new ethers.Contract(addr, ERC20_META_ABI, this.provider);
    const [symbol, decimals] = await Promise.all([c.symbol(), c.decimals()]);
    const meta = { address: addr, symbol: String(symbol), decimals: Number(decimals) };
    this.cache.set(key, meta);
    return meta;
  }

  async tryGet(addr) {
    try { return await this.get(addr); } catch { return null; }
  }

  seed(meta) {
    if (meta?.address) this.cache.set(String(meta.address).toLowerCase(), meta);
  }
}

/**
 * Resolve {address, symbol, decimals} for a token — ALWAYS on-chain, never hardcoded.
 * @param {ethers.Provider} provider
 * @param {string} addr
 * @param {TokenMetaCache} [cache]
 */
export async function resolveTokenMeta(provider, addr, cache) {
  if (cache) return cache.get(addr);
  const c = new ethers.Contract(addr, ERC20_META_ABI, provider);
  const [symbol, decimals] = await Promise.all([c.symbol(), c.decimals()]);
  return { address: addr, symbol: String(symbol), decimals: Number(decimals) };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  PURE HELPERS (unit-testable, no network)
// ═══════════════════════════════════════════════════════════════════════════════

/** "UNI/USDT" | "USDT/UNI" → "UNI|USDT" (order-independent) */
export function normalizeSymbolKey(symbol) {
  if (!symbol) return "";
  return String(symbol)
    .split("/")
    .map(s => s.trim().toUpperCase())
    .filter(Boolean)
    .sort()
    .join("|");
}

/** address pair → order-independent lowercase key */
export function pairKeyFromAddresses(a, b) {
  const x = String(a || "").toLowerCase();
  const y = String(b || "").toLowerCase();
  return [x, y].sort().join("|");
}

export function addrEq(a, b) {
  return !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();
}

/**
 * Contract collateral rule:  token0 → LONG,  token1 → SHORT.
 * Never a global constant — resolved per market.
 */
export function collateralForSide(market, side) {
  if (!market) return null;
  if (side === "LONG") return market.token0 || market.poolToken0 || null;
  if (side === "SHORT") return market.token1 || market.poolToken1 || null;
  return null;
}

export function collateralDecimalsForSide(market, side) {
  if (!market) return null;
  if (side === "LONG") return market.token0Decimals ?? null;
  if (side === "SHORT") return market.token1Decimals ?? null;
  return null;
}

export function collateralSymbolForSide(market, side) {
  if (!market) return null;
  if (side === "LONG") return market.token0Symbol || null;
  if (side === "SHORT") return market.token1Symbol || null;
  return null;
}

/**
 * paymentToken = "risky" token of the market (non-stablecoin side).
 * Falls back to token0 when both legs are stablecoins.
 */
export function paymentTokenForMarket(market) {
  if (!market) return null;
  const t0 = market.token0 || market.poolToken0;
  const t1 = market.token1 || market.poolToken1;
  const s0 = (market.token0Symbol || "").toUpperCase();
  const s1 = (market.token1Symbol || "").toUpperCase();
  if (t0 && !STABLE_SYMBOLS.has(s0)) return t0;
  if (t1 && !STABLE_SYMBOLS.has(s1)) return t1;
  return t0 || null;
}

export function supportsSide(market, side, runtimeDisabled = null) {
  if (!market || market.isActive === false) return false;
  if (side === "LONG" && market.supportsLong === false) return false;
  if (side === "SHORT" && market.supportsShort === false) return false;
  if (runtimeDisabled) {
    const key = `${marketKey(market)}|${side}`;
    if (runtimeDisabled[key]) return false;
  }
  return true;
}

export function marketKey(market) {
  return market?.marketSymbol || market?.symbol || marketKeyFromPool(market?.poolAddr);
}

export function marketKeyFromPool(poolAddr) {
  return poolAddr ? `pool:${String(poolAddr).toLowerCase()}` : "unknown";
}

// ═══════════════════════════════════════════════════════════════════════════════
//  STEP 1 — merge declared sources (config + deployments) into candidates
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Merge config.availableMarkets + deployments confirmedPools + knownMarkets.
 * Matching is done by POOL ADDRESS first (authoritative), symbol key second —
 * this is what unifies "UNI/USDT" (config) with "USDT/UNI" (deployments).
 *
 * @returns {Array} candidates — each may be partially filled, on-chain pass completes them
 */
export function mergeMarketSources({
  availableMarkets = [],
  confirmedPools = {},
  knownMarkets = [],
} = {}) {
  const byPool = new Map();
  const bySymbol = new Map();
  const order = [];

  const touch = ({ poolAddr, symbol }) => {
    const poolKey = poolAddr ? String(poolAddr).toLowerCase() : null;
    const symKey = normalizeSymbolKey(symbol);
    let cand = (poolKey && byPool.get(poolKey)) || (symKey && bySymbol.get(symKey)) || null;
    if (!cand) {
      cand = {
        symbol: symbol || null,
        symbolKey: symKey || null,
        poolAddr: poolAddr || null,
        managerAddr: null,
        supportsLong: null,
        supportsShort: null,
        isActive: null,
        deployedFlag: null,
        poolToken0Hint: null,
        collateralHint: null,
        liquidity: null,
        sources: [],
      };
      order.push(cand);
    }
    if (poolKey) byPool.set(poolKey, cand);
    if (symKey) bySymbol.set(symKey, cand);
    if (!cand.poolAddr && poolAddr) cand.poolAddr = poolAddr;
    if (!cand.symbol && symbol) { cand.symbol = symbol; cand.symbolKey = symKey; bySymbol.set(symKey, cand); }
    return cand;
  };

  // 1) config.availableMarkets — declares direction support + activity
  for (const m of availableMarkets || []) {
    if (!m) continue;
    const poolAddr = m.poolAddress || m.pool || null;
    const cand = touch({ poolAddr, symbol: m.symbol });
    cand.sources.push("config");
    if (m.supportsLong !== undefined) cand.supportsLong = m.supportsLong !== false;
    if (m.supportsShort !== undefined) cand.supportsShort = m.supportsShort !== false;
    if (m.isActive !== undefined) cand.isActive = m.isActive !== false;
    if (m.managerAddress || m.manager) cand.managerAddr = m.managerAddress || m.manager;
    if (m.poolToken0) cand.poolToken0Hint = m.poolToken0;
    if (m.collateralToken) cand.collateralHint = m.collateralToken;
    if (m.liquidity !== undefined && m.liquidity !== null) cand.liquidity = m.liquidity;
  }

  // 2) deployments confirmedPools — verified pool/manager addresses
  for (const [symbol, p] of Object.entries(confirmedPools || {})) {
    if (!p?.pool) continue;
    const cand = touch({ poolAddr: p.pool, symbol });
    cand.sources.push("confirmed");
    if (!cand.managerAddr && p.manager) cand.managerAddr = p.manager;
    if (p.deployed === false) {
      // Only this exact pool address is known-dead; a factory may serve the
      // same pair at a different (live) address — that stays a separate candidate
      // until the on-chain pass drops the dead one.
      cand.deployedFlag = false;
    } else if (cand.deployedFlag === null) {
      cand.deployedFlag = true;
    }
  }

  // 3) deployments knownMarkets — symbol-level reference only
  for (const k of knownMarkets || []) {
    if (!k?.symbol) continue;
    const symKey = normalizeSymbolKey(k.symbol);
    const existing = bySymbol.get(symKey);
    if (existing) {
      existing.sources.push("known");
      if (!existing.collateralHint && k.collateralToken) existing.collateralHint = k.collateralToken;
      continue;
    }
    const cand = touch({ poolAddr: null, symbol: k.symbol });
    cand.sources.push("known");
    if (k.collateralToken) cand.collateralHint = k.collateralToken;
  }

  // Stable output order: config order first, then confirmed, then known
  return order;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  STEP 2 — factory enumeration (authoritative pool set)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Enumerate every pool the Factory knows for the given token universe.
 * @returns {Array<{pool, tokenA, tokenB}>}
 */
export async function enumerateFactoryPools({ provider, factoryAddress, tokenAddresses }) {
  const factory = new ethers.Contract(factoryAddress, FACTORY_DISCOVERY_ABI, provider);
  const uniq = [...new Set((tokenAddresses || []).filter(Boolean).map(a => String(a).toLowerCase()))];
  const out = [];
  const seen = new Set();
  for (let i = 0; i < uniq.length; i++) {
    for (let j = i + 1; j < uniq.length; j++) {
      try {
        const pool = await factory.getPool(uniq[i], uniq[j]);
        if (!pool || pool === ZERO_ADDRESS) continue;
        const key = String(pool).toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ pool, tokenA: uniq[i], tokenB: uniq[j] });
      } catch { /* pair simply has no pool */ }
    }
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  STEP 3 — finalize a candidate with on-chain data (pure-ish, unit-testable)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build the final market record from a candidate + verified on-chain facts.
 * @param {Object} cand      merged candidate
 * @param {Object} onChain    { token0, token1, token0Meta, token1Meta, managerAddr, reserve0, reserve1, swapFeeBps, poolCodeSize, managerCodeSize, factoryManager }
 * @param {Object} [runtime]  { directionDisabled: {key:boolean} }
 */
export function finalizeMarket(cand, onChain, runtime = {}) {
  const {
    token0, token1, token0Meta, token1Meta,
    managerAddr, reserve0 = 0n, reserve1 = 0n, swapFeeBps = null,
    poolCodeSize = 0, managerCodeSize = 0,
  } = onChain || {};

  const poolAlive = poolCodeSize > 0;
  const managerAlive = managerCodeSize > 0;
  const hasReserves = BigInt(reserve0 || 0) > 0n && BigInt(reserve1 || 0) > 0n;

  const isActive = poolAlive && managerAlive && hasReserves && cand.isActive !== false && cand.deployedFlag !== false;

  const token0Symbol = token0Meta?.symbol || null;
  const token1Symbol = token1Meta?.symbol || null;
  const token0Decimals = token0Meta?.decimals ?? null;
  const token1Decimals = token1Meta?.decimals ?? null;

  const derivedSymbol = token0Symbol && token1Symbol ? `${token0Symbol}/${token1Symbol}` : null;
  const symbol = cand.symbol || derivedSymbol;

  const market = {
    marketSymbol: symbol,
    symbol,
    pairKey: token0 && token1 ? pairKeyFromAddresses(token0, token1) : (cand.symbolKey || null),
    managerAddr: managerAddr || cand.managerAddr || null,
    poolAddr: onChain?.poolAddr || cand.poolAddr || null,
    token0,
    token1,
    poolToken0: token0,
    poolToken1: token1,
    token0Symbol,
    token1Symbol,
    token0Decimals,
    token1Decimals,
    // Direction support: declared flags win; undeclared → enabled (runtime learner may disable)
    supportsLong: cand.supportsLong === null || cand.supportsLong === undefined ? true : cand.supportsLong,
    supportsShort: cand.supportsShort === null || cand.supportsShort === undefined ? true : cand.supportsShort,
    isActive,
    declared: (cand.sources || []).length > 0,
    sources: [...(cand.sources || [])],
    liquidity: cand.liquidity ?? null,
    reserve0: BigInt(reserve0 || 0),
    reserve1: BigInt(reserve1 || 0),
    swapFeeBps,
    poolCodeSize,
    managerCodeSize,
  };

  // Direction support precedence:
  //   1. declared `false` in config  → FORBIDDEN (never overridden)
  //   2. declared `true`             → allowed
  //   3. undeclared (factory-only)   → allowed, runtime learner may disable it later
  market.supportsLong = cand.supportsLong !== false;
  market.supportsShort = cand.supportsShort !== false;

  // Runtime direction kill-switch (learned from repeated preflight failures)
  if (runtime?.directionDisabled) {
    if (runtime.directionDisabled[`${marketKey(market)}|LONG`]) market.supportsLong = false;
    if (runtime.directionDisabled[`${marketKey(market)}|SHORT`]) market.supportsShort = false;
  }

  market.collateralLong = collateralForSide(market, "LONG");
  market.collateralShort = collateralForSide(market, "SHORT");
  market.paymentToken = paymentTokenForMarket(market);

  return market;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  MAIN — discoverMarkets()
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Discover every usable market, fully verified on-chain.
 *
 * @param {Object} opts
 * @param {ethers.Provider} opts.provider
 * @param {string} opts.factoryAddress
 * @param {Object} opts.tokens            { SYMBOL: address } from the active deployment
 * @param {Array}  [opts.availableMarkets] config.availableMarkets
 * @param {Object} [opts.confirmedPools]   deployments confirmedPools
 * @param {Array}  [opts.knownMarkets]     deployments knownMarkets
 * @param {Object} [opts.runtime]          { directionDisabled }
 * @param {boolean}[opts.enumerateFactory] enumerate all factory pools (default true)
 * @param {Function}[opts.log]
 * @returns {Promise<{markets: Array, rejected: Array, tokenMeta: Array}>}
 */
export async function discoverMarkets({
  provider,
  factoryAddress,
  tokens = {},
  availableMarkets = [],
  confirmedPools = {},
  knownMarkets = [],
  runtime = {},
  enumerateFactory = true,
  log = () => {},
}) {
  const tokenMetaCache = new TokenMetaCache(provider);
  const declared = mergeMarketSources({ availableMarkets, confirmedPools, knownMarkets });

  // Seed meta cache from deployment token table (still verified on-chain below)
  for (const [sym, addr] of Object.entries(tokens)) {
    if (!addr) continue;
    tokenMetaCache.seed({ address: addr, symbol: sym === "ETH" ? "WETH" : sym, decimals: null });
  }

  // ── factory enumeration ──
  let factoryPools = [];
  if (enumerateFactory) {
    try {
      factoryPools = await enumerateFactoryPools({
        provider, factoryAddress,
        tokenAddresses: Object.values(tokens),
      });
      log(`[DISCOVERY] Factory enumerated ${factoryPools.length} pools`, "info");
    } catch (e) {
      log(`[DISCOVERY] Factory enumeration failed: ${e.message?.slice(0, 60)}`, "warn");
    }
  }

  // Add factory pools as undeclared candidates (they may match declared ones by pool addr)
  const candidates = [...declared];
  const knownPoolKeys = new Set(candidates.filter(c => c.poolAddr).map(c => String(c.poolAddr).toLowerCase()));
  for (const fp of factoryPools) {
    const key = String(fp.pool).toLowerCase();
    if (knownPoolKeys.has(key)) continue;
    const cand = {
      symbol: null,
      symbolKey: null,
      poolAddr: fp.pool,
      managerAddr: null,
      supportsLong: null,
      supportsShort: null,
      isActive: null,
      deployedFlag: null,
      poolToken0Hint: null,
      collateralHint: null,
      liquidity: null,
      sources: [],
      _factoryPair: [fp.tokenA, fp.tokenB],
    };
    candidates.push(cand);
    knownPoolKeys.add(key);
  }

  const factory = new ethers.Contract(factoryAddress, FACTORY_DISCOVERY_ABI, provider);
  const markets = [];
  const rejected = [];

  for (const cand of candidates) {
    const poolAddr = cand.poolAddr;
    if (!poolAddr) {
      rejected.push({ symbol: cand.symbol, reason: "no pool address" });
      continue;
    }
    if (cand.deployedFlag === false) {
      // Declared-dead address — but still verify: a live contract may exist now
      // (the on-chain code check below is the real gate).
    }

    try {
      const poolCode = await provider.getCode(poolAddr);
      const poolCodeSize = poolCode && poolCode !== "0x" ? (poolCode.length - 2) / 2 : 0;
      if (poolCodeSize === 0) {
        rejected.push({ symbol: cand.symbol || poolAddr, pool: poolAddr, reason: "pool has no code" });
        log(`[DISCOVERY] REJECT ${cand.symbol || shortAddr(poolAddr)} — pool has no code`, "warn");
        continue;
      }

      // token0 / token1 — ALWAYS on-chain, never assumed
      const pool = new ethers.Contract(poolAddr, POOL_DISCOVERY_ABI, provider);
      let token0, token1, reserve0 = 0n, reserve1 = 0n, swapFeeBps = null;
      try {
        [token0, token1] = await Promise.all([pool.token0(), pool.token1()]);
      } catch (e) {
        rejected.push({ symbol: cand.symbol || poolAddr, pool: poolAddr, reason: `token0/token1: ${e.message?.slice(0, 40)}` });
        continue;
      }
      try {
        const r = await pool.getReserves();
        reserve0 = BigInt(r[0]); reserve1 = BigInt(r[1]);
      } catch {}
      try { swapFeeBps = BigInt(await pool.swapFeeBps()); } catch {}

      // manager — declared address verified, factory used as fallback/consistency check
      let managerAddr = cand.managerAddr || null;
      let factoryManager = null;
      try {
        factoryManager = await factory.getManager(poolAddr);
        if (!factoryManager || factoryManager === ZERO_ADDRESS) factoryManager = null;
      } catch {}
      if (!managerAddr) managerAddr = factoryManager;
      if (!managerAddr) {
        rejected.push({ symbol: cand.symbol || poolAddr, pool: poolAddr, reason: "no manager" });
        continue;
      }
      if (factoryManager && !addrEq(factoryManager, managerAddr)) {
        log(`[DISCOVERY] WARN ${cand.symbol}: declared manager ${shortAddr(managerAddr)} != factory manager ${shortAddr(factoryManager)} — using declared`, "warn");
      }

      const managerCode = await provider.getCode(managerAddr);
      const managerCodeSize = managerCode && managerCode !== "0x" ? (managerCode.length - 2) / 2 : 0;
      if (managerCodeSize === 0) {
        rejected.push({ symbol: cand.symbol || poolAddr, pool: poolAddr, reason: "manager has no code" });
        continue;
      }

      // Token meta — on-chain symbol()/decimals()
      const [meta0, meta1] = await Promise.all([
        tokenMetaCache.tryGet(token0),
        tokenMetaCache.tryGet(token1),
      ]);
      if (!meta0 || !meta1) {
        rejected.push({ symbol: cand.symbol || poolAddr, pool: poolAddr, reason: "token meta unavailable" });
        continue;
      }

      const market = finalizeMarket(cand, {
        poolAddr,
        token0, token1,
        token0Meta: meta0, token1Meta: meta1,
        managerAddr,
        reserve0, reserve1, swapFeeBps,
        poolCodeSize, managerCodeSize,
      }, runtime);

      if (!market.isActive) {
        rejected.push({ symbol: market.marketSymbol, pool: poolAddr, reason: "inactive (declared/liquidity)" });
        log(`[DISCOVERY] REJECT ${market.marketSymbol} — inactive`, "warn");
        continue;
      }

      markets.push(market);
      log(`[DISCOVERY] OK ${market.marketSymbol} pool=${shortAddr(poolAddr)} mgr=${shortAddr(market.managerAddr)} LONG=${market.supportsLong} SHORT=${market.supportsShort} t0=${market.token0Symbol}(${market.token0Decimals}) t1=${market.token1Symbol}(${market.token1Decimals})`, "info");
    } catch (e) {
      rejected.push({ symbol: cand.symbol || poolAddr, pool: poolAddr, reason: e.message?.slice(0, 60) });
      log(`[DISCOVERY] ERROR ${cand.symbol || shortAddr(poolAddr)}: ${e.message?.slice(0, 60)}`, "error");
    }
  }

  const tokenMeta = [...tokenMetaCache.cache.values()].filter(m => m.decimals !== null && m.decimals !== undefined);

  return { markets, rejected, tokenMeta, tokenMetaCache };
}

function shortAddr(a) {
  return a ? `${String(a).slice(0, 6)}...${String(a).slice(-4)}` : "N/A";
}

// ═══════════════════════════════════════════════════════════════════════════════
//  MARKET × SIDE ENUMERATION — every supported combination
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @returns {Array<{market, side, symbol, key}>} all supported MARKET × SIDE combos
 */
export function enumerateMarketSides(markets, runtime = {}) {
  const out = [];
  for (const m of markets || []) {
    for (const side of ["LONG", "SHORT"]) {
      if (!supportsSide(m, side, runtime.directionDisabled || null)) continue;
      out.push({ market: m, side, symbol: m.marketSymbol, key: `${marketKey(m)}|${side}` });
    }
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  REPORT FORMATTING
// ═══════════════════════════════════════════════════════════════════════════════

export function formatMarketsTable(markets) {
  const head = ["Market", "Manager", "Pool", "token0", "token1", "LONG", "SHORT", "Active"];
  const rows = (markets || []).map(m => [
    m.marketSymbol || "?",
    m.managerAddr || "?",
    m.poolAddr || "?",
    `${m.token0Symbol || "?"}(${m.token0Decimals ?? "?"})`,
    `${m.token1Symbol || "?"}(${m.token1Decimals ?? "?"})`,
    m.supportsLong ? "YES" : "no",
    m.supportsShort ? "YES" : "no",
    m.isActive ? "YES" : "no",
  ]);
  return renderTable(head, rows);
}

export function formatCoverageTable(markets, runtime = {}) {
  const head = ["Market", "LONG", "SHORT"];
  const rows = (markets || []).map(m => [
    m.marketSymbol || "?",
    supportsSide(m, "LONG", runtime.directionDisabled || null) ? "supported" : "—",
    supportsSide(m, "SHORT", runtime.directionDisabled || null) ? "supported" : "—",
  ]);
  return renderTable(head, rows);
}

export function renderTable(head, rows) {
  const all = [head, ...rows];
  const widths = head.map((_, i) => Math.max(...all.map(r => String(r[i] ?? "").length)));
  const line = (r) => "| " + r.map((c, i) => String(c ?? "").padEnd(widths[i])).join(" | ") + " |";
  const sep = "|" + widths.map(w => "-".repeat(w + 2)).join("|") + "|";
  return [line(head), sep, ...rows.map(line)].join("\n");
}

export default {
  TokenMetaCache,
  resolveTokenMeta,
  normalizeSymbolKey,
  pairKeyFromAddresses,
  collateralForSide,
  collateralDecimalsForSide,
  collateralSymbolForSide,
  paymentTokenForMarket,
  supportsSide,
  mergeMarketSources,
  enumerateFactoryPools,
  finalizeMarket,
  discoverMarkets,
  enumerateMarketSides,
  formatMarketsTable,
  formatCoverageTable,
  STABLE_SYMBOLS,
};
