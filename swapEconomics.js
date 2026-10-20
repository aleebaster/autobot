// ═══════════════════════════════════════════════════════════════════════════════
//  SWAP ECONOMICS — per-leg execution vetoes (pure + one read-only evaluator)
//
//  A route that CAN be quoted is not a route that SHOULD be executed. This module
//  holds the economic sanity gates applied to every leg of a path BEFORE any
//  transaction is signed:
//
//    • POOL_SHARE      amountIn / reserveIn  ≤ maxPoolShareBps   (default 1%)
//    • PRICE_IMPACT    execution vs spot, fee removed, ≤ maxPriceImpactBps (2%)
//    • RATE_DEVIATION  implied rate vs the reverse direction's implied rate,
//                      corrected for the real per-leg fee — catches pools that
//                      contradict each other by orders of magnitude
//    • ZERO_OUT        amountOut == 0 or amountOutMin == 0 → never sent
//
//  All thresholds are configurable, and NONE of them is ever loosened
//  automatically to make more routes pass. A rejected route is a route the bot
//  does not take; that is strictly better than a loss-making swap.
//
//  Purity: `evaluateLegEconomics` / `evaluateRouteEconomics` are pure and take
//  already-fetched reserves, so they unit-test with no RPC. `probeRouteEconomics`
//  is the only function that touches the chain, and it is eth_call/read-only.
// ═══════════════════════════════════════════════════════════════════════════════

import { ethers } from "ethers";

export const BPS = 10_000n;

/** Gate names, stable across logs and tests. */
export const ECONOMY_GATES = Object.freeze({
  ZERO_AMOUNT_IN: "ZERO_AMOUNT_IN",
  ZERO_QUOTE: "ZERO_QUOTE",
  ZERO_AMOUNT_OUT_MIN: "ZERO_AMOUNT_OUT_MIN",
  ZERO_RESERVE: "ZERO_RESERVE",
  POOL_SHARE_HIGH: "POOL_SHARE_HIGH",
  PRICE_IMPACT_HIGH: "PRICE_IMPACT_HIGH",
  RATE_DEVIATION: "RATE_DEVIATION",
  RESERVE_UNREADABLE: "RESERVE_UNREADABLE",
});

export const DEFAULT_ECONOMY = Object.freeze({
  /** max amountIn as a share of the input reserve, per leg (1% = 100 bps) */
  maxPoolShareBps: 100,
  /** max |price impact| excluding the pool fee, per leg (2% = 200 bps) */
  maxPriceImpactBps: 200,
  /**
   * max relative deviation of the cross-direction rate product from its fee-
   * corrected expectation (1−fee)^(2×legs).
   *
   *   expected = (1 − feeFrac) ^ (2 × legs)     e.g. 0.99^2 = 0.9801 for 1 leg
   *   product  = rateAB × rateBA
   *   deviation = |product − expected| / expected  ≤  maxRateDeviation
   *
   * 0.05 (5%) is a SANITY band, not a pricing tolerance. Per-leg pool-share ≤1%
   * and price-impact ≤2% already bound the honest error to a few tenths of a
   * percent, so a 5% band never rejects a real route — while still vetoing the
   * degenerate pools actually seen on this deployment, whose products were 148×
   * and 3.15e5× (4–5 orders of magnitude, not percent-level). Compared against
   * the raw 1.0 product this would false-positive on EVERY honest multi-leg
   * route, which is why the fee-corrected expectation is essential.
   */
  maxRateDeviation: 0.05,
  /** how many legs a path may have (2-hop = 2 legs) */
  maxLegs: 2,
});

/**
 * Merge config overrides onto the defaults. Unknown/invalid values never widen a
 * threshold: a bad override falls back to the safe default.
 *
 * @param {object} [cfg] `config.swapEconomy` (or any flat object)
 */
export function normalizeEconomyConfig(cfg = {}) {
  const c = cfg && typeof cfg === "object" ? cfg : {};
  const num = (v, dflt, { min, max }) => {
    // An absent/blank override must fall back to the default. Without this,
    // `Number(null) === 0` would silently collapse a threshold to 0 (blocking
    // every route) instead of restoring the configured default.
    if (v === null || v === undefined || v === "") return dflt;
    // Accept bigint (callers may pass 10000n) — Math.min/max cannot take a
    // BigInt, so normalise to Number BEFORE the clamp.
    let n;
    try { n = Number(v); } catch { return dflt; }
    if (!Number.isFinite(n)) return dflt;
    return Math.min(max, Math.max(min, n));
  };
  const cap = Number(BPS);
  return {
    maxPoolShareBps: Math.round(num(c.maxPoolShareBps, DEFAULT_ECONOMY.maxPoolShareBps, { min: 0, max: cap })),
    maxPriceImpactBps: Math.round(num(c.maxPriceImpactBps, DEFAULT_ECONOMY.maxPriceImpactBps, { min: 0, max: cap })),
    maxRateDeviation: num(c.maxRateDeviation, DEFAULT_ECONOMY.maxRateDeviation, { min: 0, max: 1e6 }),
    maxLegs: Math.round(num(c.maxLegs, DEFAULT_ECONOMY.maxLegs, { min: 1, max: 4 })),
  };
}

/**
 * The pool fee as an exact rational. `swapFeeBps` is what the pool itself
 * reports (Nemesis pools use 100 = 1%); it is charged ON EVERY LEG, so a 2-hop
 * route pays 1% twice, not 1% once.
 */
export function feeFraction(swapFeeBps) {
  const b = BigInt(swapFeeBps ?? 0);
  if (b <= 0n) return { num: 0n, den: BPS, frac: 0 };
  if (b >= BPS) return { num: BPS, den: BPS, frac: 1 };
  return { num: b, den: BPS, frac: Number(b) / Number(BPS) };
}

/**
 * UniswapV2-style output for one leg, with the pool's REAL fee.
 * amountInWithFee = amountIn × (den − num); out = that × rOut / (rIn × den + that)
 */
export function legAmountOut({ amountIn, reserveIn, reserveOut, swapFeeBps }) {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;
  const { num, den } = feeFraction(swapFeeBps);
  if (num >= den) return 0n;
  const amountInWithFee = amountIn * (den - num);
  const numerator = amountInWithFee * reserveOut;
  const denominator = reserveIn * den + amountInWithFee;
  if (denominator <= 0n) return 0n;
  return numerator / denominator;
}

/**
 * Human-normalised spot price of a leg (output units per input unit), using each
 * token's OWN decimals. Returns null when either reserve is zero.
 */
export function legSpot({ reserveIn, reserveOut, decimalsIn, decimalsOut }) {
  const rIn = Number(reserveIn);
  const rOut = Number(reserveOut);
  if (!Number.isFinite(rIn) || !Number.isFinite(rOut) || rIn <= 0 || rOut <= 0) return null;
  const inH = rIn / 10 ** Number(decimalsIn);
  const outH = rOut / 10 ** Number(decimalsOut);
  if (!Number.isFinite(inH) || !Number.isFinite(outH) || inH <= 0 || outH <= 0) return null;
  return outH / inH;
}

/**
 * Pure per-leg economic evaluation.
 *
 * @param {object} o
 * @param {bigint} o.amountIn        raw input amount
 * @param {bigint} o.amountOut       raw quoted output (from getAmountsOut)
 * @param {bigint} o.reserveIn       raw input-side reserve
 * @param {bigint} o.reserveOut      raw output-side reserve
 * @param {number|bigint} o.swapFeeBps pool fee in bps (charged this leg)
 * @param {number} o.decimalsIn
 * @param {number} o.decimalsOut
 * @param {object} [o.economy]       normalized thresholds
 * @returns {{ok:boolean, gates:string[], poolShare:number, priceImpactExFee:number, spot:number|null, execRate:number|null}}
 */
export function evaluateLegEconomics(o = {}) {
  const economy = normalizeEconomyConfig(o.economy);
  const gates = [];
  const amountIn = BigInt(o.amountIn ?? 0n);
  const amountOut = BigInt(o.amountOut ?? 0n);
  const reserveIn = BigInt(o.reserveIn ?? 0n);
  const reserveOut = BigInt(o.reserveOut ?? 0n);
  const swapFeeBps = Number(o.swapFeeBps ?? 0);
  const decimalsIn = Number(o.decimalsIn ?? 18);
  const decimalsOut = Number(o.decimalsOut ?? 18);

  if (!(amountIn > 0n)) gates.push(ECONOMY_GATES.ZERO_AMOUNT_IN);
  if (!(amountOut > 0n)) gates.push(ECONOMY_GATES.ZERO_QUOTE);
  if (reserveIn <= 0n || reserveOut <= 0n) gates.push(ECONOMY_GATES.ZERO_RESERVE);

  let poolShare = NaN;
  let priceImpactExFee = NaN;
  let spot = null;
  let execRate = null;

  if (reserveIn > 0n) {
    // poolShare as an exact rational first (bigint division), then to float for
    // reporting/comparison — avoids overflow on 256-bit reserves.
    const shareBpsExact = (amountIn * BPS) / reserveIn;
    poolShare = Number(shareBpsExact) / Number(BPS);
    if (shareBpsExact > BigInt(economy.maxPoolShareBps)) gates.push(ECONOMY_GATES.POOL_SHARE_HIGH);
  }

  spot = legSpot({ reserveIn, reserveOut, decimalsIn, decimalsOut });
  const inH = Number(amountIn) / 10 ** decimalsIn;
  const outH = Number(amountOut) / 10 ** decimalsOut;
  if (Number.isFinite(inH) && inH > 0 && Number.isFinite(outH)) execRate = outH / inH;

  if (spot !== null && spot > 0 && execRate !== null && Number.isFinite(execRate)) {
    const { frac } = feeFraction(swapFeeBps);
    // price impact with the fee removed: exec / (spot × (1−fee)) − 1
    const denom = spot * (1 - frac);
    if (denom > 0) {
      priceImpactExFee = execRate / denom - 1;
      const impactBps = Math.round(Math.abs(priceImpactExFee) * Number(BPS));
      if (impactBps > economy.maxPriceImpactBps) gates.push(ECONOMY_GATES.PRICE_IMPACT_HIGH);
    }
  }

  return { ok: gates.length === 0, gates, poolShare, priceImpactExFee, spot, execRate };
}

/**
 * Cross-direction rate consistency for one pool.
 *
 * impliedRate(A→B) × impliedRate(B→A) must sit near (1−fee)^2. A product of 148×
 * or 3.15e5× means the two directions are pricing the pair with different
 * realities — the classic symptom of a pool whose reserves were moved by a
 * single-sided dump. Such a pool must not be traded in EITHER direction.
 *
 * @param {number} rateAB  implied out-per-in for A→B (human units)
 * @param {number} rateBA  implied out-per-in for B→A (human units)
 * @param {number} legs    number of legs in the A→B quote (1 = direct)
 * @param {number} feeFrac per-leg fee fraction (0.01 for 1%)
 * @param {number} maxDeviation
 */
export function checkRateConsistency({ rateAB, rateBA, legs = 1, feeFrac = 0.01, maxDeviation = 1.5 }) {
  if (!Number.isFinite(rateAB) || !Number.isFinite(rateBA) || rateAB <= 0 || rateBA <= 0) {
    return { ok: false, gates: [ECONOMY_GATES.RATE_DEVIATION], product: NaN, expected: NaN, deviation: Infinity };
  }
  // A 2-hop route pays the fee twice; the reverse of a 2-hop is also 2-hop.
  const expected = Math.pow(1 - feeFrac, 2 * legs);
  const product = rateAB * rateBA;
  const deviation = Math.abs(product - expected) / expected;
  const gates = deviation > maxDeviation ? [ECONOMY_GATES.RATE_DEVIATION] : [];
  return { ok: gates.length === 0, gates, product, expected, deviation };
}

/**
 * Pure whole-path evaluation. `legs` is an array of per-leg inputs in path order.
 * Every leg is checked independently (the fee is applied per leg, never once for
 * the whole route), and the path is additionally checked for leg count.
 *
 * @returns {{ok:boolean, gates:string[], legs:Array, worstPoolShare:number, worstPriceImpact:number}}
 */
export function evaluateRouteEconomics({ legs = [], economy = {} } = {}) {
  const e = normalizeEconomyConfig(economy);
  const gates = [];
  if (!Array.isArray(legs) || legs.length === 0) {
    return { ok: false, gates: [ECONOMY_GATES.ZERO_QUOTE], legs: [], worstPoolShare: NaN, worstPriceImpact: NaN };
  }
  if (legs.length > e.maxLegs) gates.push("TOO_MANY_LEGS");

  const evaluated = legs.map((leg) => evaluateLegEconomics({ ...leg, economy }));
  for (const ev of evaluated) for (const g of ev.gates) if (!gates.includes(g)) gates.push(g);

  const shares = evaluated.map(l => l.poolShare).filter(Number.isFinite);
  const impacts = evaluated.map(l => l.priceImpactExFee).filter(Number.isFinite).map(Math.abs);
  return {
    ok: gates.length === 0,
    gates,
    legs: evaluated,
    worstPoolShare: shares.length ? Math.max(...shares) : NaN,
    worstPriceImpact: impacts.length ? Math.max(...impacts) : NaN,
  };
}

/**
 * Largest amountIn (raw) whose pool share of `reserveIn` stays within
 * `maxPoolShareBps` — exact bigint math: amount ≤ reserve × bps / 10000.
 * Returns 0n when the pool is empty or the cap is unusable.
 */
export function poolShareCapAmountIn({ reserveIn, maxPoolShareBps }) {
  const r = BigInt(reserveIn ?? 0n);
  const bps = BigInt(Math.max(0, Math.round(Number(maxPoolShareBps ?? 0))));
  if (r <= 0n || bps <= 0n) return 0n;
  return (r * bps) / BPS;
}

/**
 * Shrink-and-retry a size-rejected amount through an INJECTED probe (the same
 * shape as `probeRouteEconomics`: async → { ok, gates, legs }). Thresholds are
 * never loosened — only the input amount is halved, and only while the failure
 * is size-driven (POOL_SHARE_HIGH / PRICE_IMPACT_HIGH). Non-size gates
 * (ZERO_RESERVE, RATE_DEVIATION, …) and amounts below `minAmountIn` stop the
 * search immediately: a smaller size cannot repair them.
 *
 * Pure aside from the probe callback — unit-testable with a mock probe.
 *
 * @param {object} o
 * @param {bigint} o.amountIn     starting (raw) amount
 * @param {bigint} [o.minAmountIn] smallest raw amount still worth swapping
 * @param {number} [o.maxHalvings] how many times to halve (default 4)
 * @param {(amountIn: bigint) => Promise<{ok:boolean, gates?:string[], legs?:Array}>} o.probe
 * @returns {{ok:boolean, amountIn:bigint, probe:object|null, halvings:number, history:Array, reason:string}}
 */
export async function shrinkToFitEconomy({ amountIn, minAmountIn = 1n, maxHalvings = 4, probe }) {
  let amt = BigInt(amountIn ?? 0n);
  const min = BigInt(minAmountIn ?? 1n);
  const history = [];
  const sizeGates = new Set([ECONOMY_GATES.POOL_SHARE_HIGH, ECONOMY_GATES.PRICE_IMPACT_HIGH]);

  for (let i = 0; i <= maxHalvings; i++) {
    const res = await probe(amt);
    const gates = Array.isArray(res?.gates) ? res.gates : [];
    history.push({ amountIn: String(amt), ok: !!res?.ok, gates: gates.slice() });
    if (res?.ok) {
      return { ok: true, amountIn: amt, probe: res, halvings: i, history, reason: "passes at this size" };
    }
    const shrinkable = gates.some(g => sizeGates.has(g));
    if (!shrinkable) {
      return { ok: false, amountIn: amt, probe: res, halvings: i, history, reason: `not size-driven (gates=${gates.join(",") || "none"})` };
    }
    if (amt <= min) {
      return { ok: false, amountIn: amt, probe: res, halvings: i, history, reason: `min amount reached (${min})` };
    }
    const next = amt / 2n;
    if (next === 0n || next < min) {
      return { ok: false, amountIn: amt, probe: res, halvings: i, history, reason: `next halving below min (${min})` };
    }
    amt = next;
  }
  return { ok: false, amountIn: amt, probe: null, halvings: maxHalvings, history, reason: "max halvings exhausted" };
}

// ─────────────────────────────────────────────────────────────────────────────
//  READ-ONLY ON-CHAIN PROBE
// ─────────────────────────────────────────────────────────────────────────────

const POOL_RESERVES_ABI = [
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1)",
  "function token0() view returns (address)",
  "function swapFeeBps() view returns (uint256)",
];
const FACTORY_POOL_ABI = ["function getPool(address,address) view returns (address)"];
const ERC20_DEC_ABI = ["function decimals() view returns (uint8)"];

/** Cache of `decimals()` per token address (lowercased). */
function decimalsCache() {
  const m = new Map();
  return async (provider, addr) => {
    const k = String(addr).toLowerCase();
    if (m.has(k)) return m.get(k);
    let d = null;
    try { d = Number(await new ethers.Contract(addr, ERC20_DEC_ABI, provider).decimals()); } catch { d = null; }
    m.set(k, d);
    return d;
  };
}

/**
 * Fetch reserves + fee for a single (tokenIn, tokenOut) pair via the factory.
 * Returns null when the pool is missing/unreadable — the caller must then treat
 * the leg as RESERVE_UNREADABLE and refuse the swap.
 */
export async function readLegReserves({ provider, factoryAddress, tokenIn, tokenOut }) {
  if (!provider || !factoryAddress) return null;
  try {
    const factory = new ethers.Contract(factoryAddress, FACTORY_POOL_ABI, provider);
    const pool = await factory.getPool(tokenIn, tokenOut);
    if (!pool || pool === ethers.ZeroAddress) return null;
    const code = await provider.getCode(pool);
    if (!code || code === "0x") return null;
    const pl = new ethers.Contract(pool, POOL_RESERVES_ABI, provider);
    const [reserves, token0, swapFeeBps] = await Promise.all([
      pl.getReserves(), pl.token0(), pl.swapFeeBps().catch(() => 100n),
    ]);
    const t0 = String(token0).toLowerCase();
    const inIs0 = t0 === String(tokenIn).toLowerCase();
    return {
      pool,
      reserveIn: inIs0 ? reserves[0] : reserves[1],
      reserveOut: inIs0 ? reserves[1] : reserves[0],
      swapFeeBps: Number(swapFeeBps),
    };
  } catch {
    return null;
  }
}

/**
 * Read-only economic evaluation of a whole path at a concrete `amountIn`.
 *
 * Never signs anything. Returns `{ ok, gates, legs, ... }`; `ok:false` means the
 * caller MUST skip this route (no approval, no transaction).
 *
 * @param {object} o
 * @param {ethers.Provider} o.provider
 * @param {string} o.factoryAddress
 * @param {string[]} o.path       token addresses, in order
 * @param {bigint} o.amountIn
 * @param {bigint} [o.amountOut]  pre-fetched getAmountsOut result (recomputed if absent)
 * @param {bigint} [o.amountOutMin]
 * @param {object} [o.economy]
 * @param {Function} [o.log]
 */
export async function probeRouteEconomics({ provider, factoryAddress, path, amountIn, amountOut = null, amountOutMin = null, economy = {}, log = () => {} }) {
  const e = normalizeEconomyConfig(economy);
  const gates = [];
  const p = Array.isArray(path) ? path : [];
  if (p.length < 2) return { ok: false, gates: [ECONOMY_GATES.ZERO_QUOTE], legs: [] };
  if (p.length - 1 > e.maxLegs) gates.push("TOO_MANY_LEGS");

  const getDec = decimalsCache();
  const legs = [];
  let cursor = BigInt(amountIn ?? 0n);

  for (let i = 0; i < p.length - 1; i++) {
    const tokenIn = p[i];
    const tokenOut = p[i + 1];
    const legIn = cursor;

    const meta = await readLegReserves({ provider, factoryAddress, tokenIn, tokenOut });
    if (!meta) {
      gates.push(ECONOMY_GATES.RESERVE_UNREADABLE);
      legs.push({ tokenIn, tokenOut, gate: ECONOMY_GATES.RESERVE_UNREADABLE });
      break;
    }
    const [decIn, decOut] = await Promise.all([getDec(provider, tokenIn), getDec(provider, tokenOut)]);
    if (decIn === null || decOut === null) {
      gates.push(ECONOMY_GATES.RESERVE_UNREADABLE);
      legs.push({ tokenIn, tokenOut, gate: ECONOMY_GATES.RESERVE_UNREADABLE });
      break;
    }

    const legOut = legAmountOut({ amountIn: legIn, reserveIn: meta.reserveIn, reserveOut: meta.reserveOut, swapFeeBps: meta.swapFeeBps });
    const ev = evaluateLegEconomics({
      amountIn: legIn, amountOut: legOut,
      reserveIn: meta.reserveIn, reserveOut: meta.reserveOut,
      swapFeeBps: meta.swapFeeBps, decimalsIn: decIn, decimalsOut: decOut,
      economy,
    });
    legs.push({
      tokenIn, tokenOut, pool: meta.pool, swapFeeBps: meta.swapFeeBps,
      amountIn: String(legIn), amountOut: String(legOut),
      reserveIn: String(meta.reserveIn), reserveOut: String(meta.reserveOut),
      ...ev,
    });
    for (const g of ev.gates) if (!gates.includes(g)) gates.push(g);
    cursor = legOut;
    if (!(legOut > 0n)) break;
  }

  // The caller's quoted amountOut must agree in DIRECTION with what we modelled:
  // a pre-fetched quote of 0 is a hard veto regardless of what the local model says.
  if (amountOut !== null && amountOut !== undefined && !(BigInt(amountOut) > 0n)) {
    if (!gates.includes(ECONOMY_GATES.ZERO_QUOTE)) gates.push(ECONOMY_GATES.ZERO_QUOTE);
  }
  if (amountOutMin !== null && amountOutMin !== undefined && !(BigInt(amountOutMin) > 0n)) {
    if (!gates.includes(ECONOMY_GATES.ZERO_AMOUNT_OUT_MIN)) gates.push(ECONOMY_GATES.ZERO_AMOUNT_OUT_MIN);
  }

  const shares = legs.map(l => l.poolShare).filter(Number.isFinite);
  const impacts = legs.map(l => l.priceImpactExFee).filter(Number.isFinite).map(Math.abs);
  const result = {
    ok: gates.length === 0,
    gates: [...new Set(gates)],
    legs,
    worstPoolShare: shares.length ? Math.max(...shares) : NaN,
    worstPriceImpact: impacts.length ? Math.max(...impacts) : NaN,
  };
  if (!result.ok) {
    log(`[SWAP ECON] REJECT path=${p.join("→")} gates=${result.gates.join(",")} worstPoolShare=${(result.worstPoolShare * 100).toFixed(4)}% worstPriceImpact=${(result.worstPriceImpact * 100).toFixed(4)}%`, "warn");
  }
  return result;
}

export default {
  ECONOMY_GATES,
  DEFAULT_ECONOMY,
  normalizeEconomyConfig,
  feeFraction,
  legAmountOut,
  legSpot,
  evaluateLegEconomics,
  evaluateRouteEconomics,
  checkRateConsistency,
  readLegReserves,
  probeRouteEconomics,
};
