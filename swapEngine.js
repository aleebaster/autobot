// ═══════════════════════════════════════════════════════════════════════════════
//  ROTATING SWAP ENGINE — pure, provider-free helpers
//
//  Everything in this file is deterministic/pure so it can be unit-tested
//  without a wallet, an RPC or a state file:
//
//    • normalizeSwapConfig()   — the `swap:` config block (+ legacy autoSwap)
//    • reserveRawFor()         — per-token reserve, scaled by THAT token's decimals
//    • computeSwapAmount()     — available = balance - reserve, then a practical size
//    • SwapRouteBackoff()      — PER-ROUTE backoff (never a global engine backoff)
//    • runSwapRotationQueue()  — the rotation loop: try → skip → next route
//
//  The engine walks EVERY validated direction (A→B and B→A are two independent
//  records) and never assumes a route is reversible.
// ═══════════════════════════════════════════════════════════════════════════════

import { ethers } from "ethers";
import { calculateRandomSwapAmount } from "./tokenInventory.js";

/** Failure codes surfaced by the maintenance cycle (logged as [SWAP SKIP]). */
export const SWAP_FAILURE_CODES = Object.freeze([
  "QUOTE_ZERO",
  "ZERO_AMOUNT_OUT_MIN",
  "INSUFFICIENT_BALANCE",
  "INSUFFICIENT_ALLOWANCE",
  "ALLOWANCE_MISSING",
  "APPROVAL_REQUIRED",
  "PREFLIGHT_REVERT",
  "LIQUIDITY_LOW",
  "ROUTE_UNAVAILABLE",
  "GAS_RESERVE",
  "GAS_TOO_HIGH",
  "TOKEN_DISABLED",
  "PINNED_AMOUNT",
  "ECONOMY_REJECTED",
  "RATE_DEVIATION",
  "RATE_DEVIATION_UNVERIFIED",
  "WAITING_FOR_ALLOWANCE",
  "WAITING_FOR_INVENTORY",
  "WAITING_FOR_LIQUIDITY",
  "WAITING_FOR_PRICE",
  // engine-specific extras (still per-route, still non-fatal)
  "TX_REVERTED",
  "VERIFY_FAILED",
  "EXCEPTION",
]);

/**
 * Per-direction states. A direction re-enters the queue on the next pass only
 * as cheaply re-checkable: WAITING_* states re-evaluate their precondition
 * every pass (balance / allowance / quote), FAILED routes go through the
 * per-route backoff. No state ever blocks the rest of the queue.
 */
export const SWAP_DIRECTION_STATES = Object.freeze({
  READY: "READY",
  WAITING_FOR_ALLOWANCE: "WAITING_FOR_ALLOWANCE",
  WAITING_FOR_INVENTORY: "WAITING_FOR_INVENTORY",
  WAITING_FOR_LIQUIDITY: "WAITING_FOR_LIQUIDITY",
  WAITING_FOR_PRICE: "WAITING_FOR_PRICE",
  EXECUTABLE: "EXECUTABLE",
  CONFIRMED: "CONFIRMED",
  FAILED: "FAILED",
});

/**
 * reasonCode → { state, recoverable, recommendedAction }.
 * Every skip/fail path classifies through this map — no anonymous SKIPs.
 */
export const SWAP_REASON_META = Object.freeze({
  INSUFFICIENT_BALANCE: {
    state: SWAP_DIRECTION_STATES.WAITING_FOR_INVENTORY, recoverable: true,
    recommendedAction: "top up the source token or wait until balance exceeds reserve + minimum",
  },
  WAITING_FOR_INVENTORY: {
    state: SWAP_DIRECTION_STATES.WAITING_FOR_INVENTORY, recoverable: true,
    recommendedAction: "resume automatically when the balance is sufficient",
  },
  TOKEN_DISABLED: {
    state: SWAP_DIRECTION_STATES.FAILED, recoverable: false,
    recommendedAction: "token decimals unreadable — check RPC/token address",
  },
  PINNED_AMOUNT: {
    state: SWAP_DIRECTION_STATES.FAILED, recoverable: false,
    recommendedAction: "operator amount does not round-trip at token decimals",
  },
  WAITING_FOR_ALLOWANCE: {
    state: SWAP_DIRECTION_STATES.WAITING_FOR_ALLOWANCE, recoverable: true,
    recommendedAction: "auto mode approves the v5 Router once, re-checks allowance, then swaps",
  },
  ALLOWANCE_MISSING: {
    state: SWAP_DIRECTION_STATES.WAITING_FOR_ALLOWANCE, recoverable: true,
    recommendedAction: "approve the v5 Router for the source token (auto mode does this once)",
  },
  APPROVAL_REQUIRED: {
    state: SWAP_DIRECTION_STATES.WAITING_FOR_ALLOWANCE, recoverable: false,
    recommendedAction: "single-swap mode refuses approvals — approve manually or use the maintenance cycle",
  },
  INSUFFICIENT_ALLOWANCE: {
    state: SWAP_DIRECTION_STATES.FAILED, recoverable: false,
    recommendedAction: "approve tx reverted — inspect the token contract",
  },
  ROUTE_UNAVAILABLE: {
    state: SWAP_DIRECTION_STATES.WAITING_FOR_LIQUIDITY, recoverable: true,
    recommendedAction: "no v5 route quotes at this size — retry when liquidity appears",
  },
  QUOTE_ZERO: {
    state: SWAP_DIRECTION_STATES.WAITING_FOR_LIQUIDITY, recoverable: true,
    recommendedAction: "router returned 0 — retry when liquidity appears",
  },
  WAITING_FOR_LIQUIDITY: {
    state: SWAP_DIRECTION_STATES.WAITING_FOR_LIQUIDITY, recoverable: true,
    recommendedAction: "retry automatically when pool quotes become non-zero",
  },
  ZERO_AMOUNT_OUT_MIN: {
    state: SWAP_DIRECTION_STATES.WAITING_FOR_PRICE, recoverable: true,
    recommendedAction: "output too small for the slippage floor — needs a larger input or deeper liquidity",
  },
  ECONOMY_REJECTED: {
    state: SWAP_DIRECTION_STATES.WAITING_FOR_PRICE, recoverable: true,
    recommendedAction: "economic gate — wait for a deeper book; a smaller safe size is tried automatically when the gates are size-driven",
  },
  WAITING_FOR_PRICE: {
    state: SWAP_DIRECTION_STATES.WAITING_FOR_PRICE, recoverable: true,
    recommendedAction: "retry automatically when pool share / price impact fall within the configured gates",
  },
  RATE_DEVIATION: {
    state: SWAP_DIRECTION_STATES.WAITING_FOR_PRICE, recoverable: false,
    recommendedAction: "round-trip quotes inconsistent — swap BLOCKED until quotes agree",
  },
  RATE_DEVIATION_UNVERIFIED: {
    state: SWAP_DIRECTION_STATES.WAITING_FOR_PRICE, recoverable: false,
    recommendedAction: "no symmetric round-trip quote — swap BLOCKED until the reverse quote is available",
  },
  PREFLIGHT_REVERT: {
    state: SWAP_DIRECTION_STATES.FAILED, recoverable: false,
    recommendedAction: "router eth_call reverted — inspect the revert text",
  },
  GAS_RESERVE: {
    state: SWAP_DIRECTION_STATES.FAILED, recoverable: true,
    recommendedAction: "fund ETH for gas",
  },
  GAS_TOO_HIGH: {
    state: SWAP_DIRECTION_STATES.FAILED, recoverable: true,
    recommendedAction: "network gas above the ceiling — wait",
  },
  TX_REVERTED: {
    state: SWAP_DIRECTION_STATES.FAILED, recoverable: false,
    recommendedAction: "transaction reverted — per-route backoff applies",
  },
  VERIFY_FAILED: {
    state: SWAP_DIRECTION_STATES.FAILED, recoverable: false,
    recommendedAction: "balance deltas contradict the quote — inspect the tx",
  },
  EXCEPTION: {
    state: SWAP_DIRECTION_STATES.FAILED, recoverable: false,
    recommendedAction: "unexpected error — inspect logs",
  },
  NO_RESULT: {
    state: SWAP_DIRECTION_STATES.FAILED, recoverable: false,
    recommendedAction: "attempt returned nothing",
  },
  UNKNOWN: {
    state: SWAP_DIRECTION_STATES.FAILED, recoverable: false,
    recommendedAction: "unknown failure — inspect logs",
  },
});

/** reasonCode → state/recoverable/action (unclassified codes degrade safely). */
export function swapReasonMeta(code) {
  return SWAP_REASON_META[code]
    || { state: SWAP_DIRECTION_STATES.FAILED, recoverable: false, recommendedAction: "unclassified — inspect logs" };
}

/**
 * Classify a router preflight revert. The two texts this deployment actually
 * produces must never hide behind a generic PREFLIGHT_REVERT:
 *   • TransferHelper: TRANSFER_FROM_FAILED  → allowance to the v5 Router
 *   • OMMLibrary: INSUFFICIENT_INPUT_AMOUNT → input below the pool minimum
 * @returns {{code:string, detail:string}|null} null = unclassified
 */
export function classifySwapRevert(text) {
  const t = String(text || "");
  if (/TRANSFER_FROM_FAILED/i.test(t)) {
    return { code: "ALLOWANCE_MISSING", detail: 'TransferHelper: TRANSFER_FROM_FAILED (allowance to the v5 Router missing or too low)' };
  }
  if (/INSUFFICIENT_INPUT_AMOUNT/i.test(t)) {
    return { code: "WAITING_FOR_LIQUIDITY", detail: "OMMLibrary: INSUFFICIENT_INPUT_AMOUNT (input below the pool minimum for this path)" };
  }
  if (/INSUFFICIENT_OUTPUT_AMOUNT/i.test(t)) {
    return { code: "QUOTE_ZERO", detail: "router: INSUFFICIENT_OUTPUT_AMOUNT (pool cannot pay this output)" };
  }
  return null;
}

/**
 * Reserve that is NEVER swapped away, per token symbol (human units).
 * A token missing from the map falls back to `defaultReserve` ("0" by default).
 */
export const DEFAULT_RESERVE_BY_TOKEN = Object.freeze({
  USDT: "1",
  USDC: "1",
  DAI: "1",
  NEMESIS: "1",
  UNI: "0.01",
  LINK: "0.01",
  WETH: "0.00005",
});

const num = (v, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
};

/**
 * Merge `config.swap` (new) with `config.autoSwap` (legacy) into one shape.
 * Unknown legacy keys are preserved because the amount calculator reads
 * `minSwapAmount{SYM}` / `maxSwapAmount{SYM}` straight off this object.
 */
export function normalizeSwapConfig(config = {}) {
  const legacy = { ...(config.autoSwap || {}) };
  const s = { ...(config.swap || {}) };

  const enabled = s.enabled !== undefined ? !!s.enabled
    : (legacy.enabled !== undefined ? !!legacy.enabled : true);

  const reserveByToken = {
    ...DEFAULT_RESERVE_BY_TOKEN,
    ...(legacy.reserveByToken || {}),
    ...(s.reserveByToken || {}),
  };

  return {
    ...legacy,
    enabled,
    minIntervalMs: Math.max(0, num(s.minIntervalMs, 8_000)),
    maxIntervalMs: Math.max(num(s.minIntervalMs, 8_000), num(s.maxIntervalMs, 30_000)),
    reserveByToken,
    defaultReserve: String(s.defaultReserve ?? legacy.defaultReserve ?? "0"),
    slippageBps: Math.max(0, Math.min(9999, num(s.slippageBps, num(legacy.slippageBps, num(config.slippageBps, 50))))),
    maxGasGwei: Math.max(0, num(s.maxGasGwei, 500)),
    maxConsecutiveFailures: Math.max(1, num(s.maxConsecutiveFailures, 3)),
    rotatePairs: s.rotatePairs !== false,
    reverseDirections: s.reverseDirections !== false,
    maxSwapsPerCycle: Math.max(1, num(s.maxSwapsPerCycle, 1)),
    routeBackoffMs: Math.max(0, num(s.routeBackoffMs, 15_000)),
    routeBackoffMaxMs: Math.max(0, num(s.routeBackoffMaxMs, 120_000)),
    // amount sizing (legacy keys, still honoured by calculateRandomSwapAmount)
    swapMinPercent: Math.max(0, num(legacy.swapMinPercent, 3)),
    swapMaxPercent: Math.max(0, num(legacy.swapMaxPercent, 15)),
    preferTokenToToken: legacy.preferTokenToToken !== false,
    swapCooldownMs: Math.max(0, num(legacy.swapCooldownMs, 20_000)),
  };
}

/** Parse a human-unit reserve string with the token's OWN decimals. */
export function reserveRawFor(sym, decimals, cfg = {}) {
  const map = cfg.reserveByToken || {};
  const raw = map[sym] ?? map[String(sym).toUpperCase()] ?? cfg.defaultReserve ?? "0";
  let d = Number(decimals);
  if (!Number.isFinite(d) || d < 0 || d > 36) d = 18;
  try {
    const v = ethers.parseUnits(String(raw), d);
    return v > 0n ? v : 0n;
  } catch {
    return 0n;
  }
}

/**
 * available = balance - reserve; the swap size is the practical minimum for
 * THIS token, expressed with THIS token's decimals (never a global fixed amount).
 *
 * @returns {{ok:true, amountRaw:bigint, reserve:bigint, availableRaw:bigint}
 *          |{ok:false, code:string, reason:string, reserve:bigint, availableRaw:bigint}}
 */
export function computeSwapAmount({ sym, balanceRaw, decimals, cfg = {}, calcAmount = null }) {
  let d = Number(decimals);
  if (!Number.isFinite(d) || d < 0 || d > 36) d = 18;
  const bal = BigInt(balanceRaw ?? 0n);
  const reserve = reserveRawFor(sym, d, cfg);
  const availableRaw = bal > reserve ? bal - reserve : 0n;
  const base = { reserve, availableRaw, balanceRaw: bal };

  if (availableRaw <= 0n) {
    return {
      ...base,
      ok: false,
      code: "INSUFFICIENT_BALANCE",
      reason: `SKIP_BALANCE: ${sym} balance ${ethers.formatUnits(bal, d)} <= reserve ${ethers.formatUnits(reserve, d)}`,
    };
  }

  const availableFloat = Number(ethers.formatUnits(availableRaw, d));
  const calc = calcAmount || ((avail) => calculateRandomSwapAmount(sym, avail, cfg, d, () => {}));
  const picked = calc(availableFloat);

  if (!picked || !Number.isFinite(picked.amountFloat) || picked.amountFloat <= 0) {
    return {
      ...base,
      ok: false,
      code: "INSUFFICIENT_BALANCE",
      reason: `SKIP_BALANCE: ${sym} available ${ethers.formatUnits(availableRaw, d)} is below the minimum practical swap size`,
    };
  }

  let amountRaw = 0n;
  try {
    amountRaw = ethers.parseUnits(Number(picked.amountFloat).toFixed(d), d);
  } catch {
    amountRaw = 0n;
  }

  if (amountRaw <= 0n) {
    return {
      ...base,
      ok: false,
      code: "INSUFFICIENT_BALANCE",
      reason: `SKIP_BALANCE: ${sym} amount rounds to 0 at ${d} decimals`,
    };
  }
  if (amountRaw > availableRaw) {
    return {
      ...base,
      ok: false,
      code: "INSUFFICIENT_BALANCE",
      reason: `SKIP_BALANCE: amount ${ethers.formatUnits(amountRaw, d)} exceeds available ${ethers.formatUnits(availableRaw, d)} (balance - reserve)`,
    };
  }
  return { ...base, ok: true, amountRaw };
}

/** Current network gas price in gwei (maxFeePerGas preferred when present). */
export function gasGweiFrom(feeData) {
  const price = feeData?.maxFeePerGas ?? feeData?.gasPrice ?? null;
  if (price === null || price === undefined) return null;
  return Number(price) / 1e9;
}

/**
 * PER-ROUTE backoff. A route that keeps failing is parked for a while; every
 * other route (and the engine as a whole) keeps running. There is deliberately
 * no global backoff in this class.
 */
export class SwapRouteBackoff {
  constructor({ maxConsecutiveFailures = 3, baseMs = 15_000, maxMs = 120_000 } = {}) {
    this.maxConsecutiveFailures = Math.max(1, maxConsecutiveFailures);
    this.baseMs = Math.max(0, baseMs);
    this.maxMs = Math.max(0, maxMs);
    this._m = new Map();
  }

  _delay(fails) {
    const over = fails >= this.maxConsecutiveFailures;
    const exp = Math.min(fails, 6) - 1;
    const scaled = this.baseMs * Math.pow(2, exp) * (over ? 4 : 1);
    return Math.min(scaled, this.maxMs);
  }

  canAttempt(key, now = Date.now()) {
    const e = this._m.get(key);
    if (!e || !e.until) return true;
    return now >= e.until;
  }

  recordFailure(key, code = "UNKNOWN", now = Date.now()) {
    const prev = this._m.get(key) || { fails: 0 };
    const fails = Number(prev.fails || 0) + 1;
    const entry = {
      fails,
      lastCode: code,
      lastAt: now,
      until: now + this._delay(fails),
    };
    this._m.set(key, entry);
    return entry;
  }

  recordSuccess(key) { this._m.delete(key); }

  get(key) { return this._m.get(key) || null; }
  size() { return this._m.size; }
  entries() { return [...this._m.entries()]; }
  reset() { this._m.clear(); }
}

const dirKey = (d) => d.key || `${d.from}>${d.to}`;

/**
 * Walk the rotation queue.
 *
 * • directions are tried in order; a route that cannot run never stops the pass
 * • `maxSwaps` verified swaps ends the pass (the caller then waits its interval)
 * • every attempt updates rotation/backoff through the callbacks, so the NEXT
 *   pass starts on a different direction/pair
 *
 * @param {object}   o
 * @param {Array}    o.directions   ordered rotation queue
 * @param {number}   o.maxSwaps
 * @param {Function} o.attempt      async (dir) => {status,...}
 * @param {Function} [o.canAttempt] (key) => boolean  — per-route backoff gate
 * @param {Function} [o.recordSkip] (dir) => void     — rotation advance (no TX)
 * @param {Function} [o.recordFailure] (dir, code) => void
 * @param {Function} [o.recordSuccess] (dir) => void
 * @param {Function} [o.stopRequested] () => boolean
 */
export async function runSwapRotationQueue({
  directions = [],
  maxSwaps = 1,
  attempt,
  canAttempt = () => true,
  recordSkip = () => {},
  recordFailure = () => {},
  recordSuccess = () => {},
  stopRequested = () => false,
}) {
  const summary = {
    attempted: 0, verified: 0, skipped: 0, failed: 0,
    total: directions.length, eligible: 0, results: [],
  };
  if (typeof attempt !== "function") return summary;

  const queue = directions.filter(d => {
    try { return canAttempt(dirKey(d)); } catch { return true; }
  });
  summary.eligible = queue.length;

  for (const dir of queue) {
    if (stopRequested()) break;
    if (summary.verified >= maxSwaps) break;

    const key = dirKey(dir);
    let r;
    try {
      r = await attempt(dir);
    } catch (e) {
      r = { status: "fail", code: "EXCEPTION", reason: String(e?.message || e).slice(0, 120) };
    }
    if (!r || typeof r !== "object") r = { status: "skip", code: "NO_RESULT", reason: "attempt returned nothing" };

    summary.results.push({ direction: `${dir.from}->${dir.to}`, key, ...r });

    if (r.status === "ok" || r.status === "dry") {
      summary.attempted++;
      summary.verified++;
      try { recordSuccess(dir); } catch { /* best-effort */ }
      break; // one settlement per pass — the caller waits its interval
    }
    if (r.status === "fail") {
      summary.attempted++;
      summary.failed++;
      try { recordFailure(dir, r.code || "UNKNOWN"); } catch { /* best-effort */ }
      try { recordSkip(dir); } catch { /* best-effort */ }
      continue; // ← a failed route NEVER stops the engine
    }
    if (r.status === "stop") {
      summary.results[summary.results.length - 1].stopped = true;
      break; // engine-wide condition (gas ceiling / shutdown) — not a route failure
    }
    summary.skipped++;
    try { recordSkip(dir); } catch { /* best-effort */ }
  }
  return summary;
}

export default {
  SWAP_FAILURE_CODES,
  DEFAULT_RESERVE_BY_TOKEN,
  normalizeSwapConfig,
  reserveRawFor,
  computeSwapAmount,
  gasGweiFrom,
  SwapRouteBackoff,
  runSwapRotationQueue,
};
