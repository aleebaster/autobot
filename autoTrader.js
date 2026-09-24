import { ethers } from "ethers";
import fs from "fs";
import { TokenInventory, EthSessionTracker, DEFAULT_ETH_GUARD, calculateInventoryDeficit, SwapJournal, selectRandomSwapPair, calculateRandomSwapAmount, getTokenAddress, getSwapPairs, TOKEN_DECIMALS } from "./tokenInventory.js";
import { getRouterAddress, getFactoryAddress, getActiveDeployment, getAllTokens, getConfirmedPools, getKnownMarkets } from "./deployments/index.js";
import {
  TokenMetaCache,
  discoverMarkets,
  mergeMarketSources,
  collateralForSide,
  collateralDecimalsForSide,
  collateralSymbolForSide,
  paymentTokenForMarket,
  supportsSide,
  marketKey,
  normalizeSymbolKey,
  enumerateMarketSides,
  formatMarketsTable,
  formatCoverageTable,
} from "./marketDiscovery.js";
import { discoverTokens, discoverSwapRoutes, findRoute, routeCandidates, sourcesForTarget, formatRoutesTable } from "./swapRoutes.js";
import { RotationMemory } from "./rotation.js";

// ═══════════════════════════════════════════════════════════════════════════
//  AUTONOMOUS TRADING LOOP — Nemesis Sepolia (V2 — MULTI-MARKET)
//  FIX: openPosition ABI, borrowAmount, amountOutMin, oracle checkpoint
//  NEW: dynamic market discovery, token0/token1 collateral rule, route-aware
//       swaps and MARKET×SIDE rotation (no single-market hardcoding)
// ═══════════════════════════════════════════════════════════════════════════

const OPEN_POSITION_SELECTOR = "0xfa2b1dfd";
const CLOSE_POSITION_SELECTOR = "0xb35648d7";
const BPS = 10000n;
// Frontend extra words appended after the 7 ABI args (not in selector signature):
// bytes32 r (constant across successful opens), uint256 v, address paymentToken
const OPEN_EXTRAS_R = "0x1fef349898a4b7d9f2092024bb4addeca01b5c4f708aac30a980544b3a70bac5";

// ═══════════════════════════════════════════════════════════════════════════
//  TX MANAGER — centralized nonce + serialization + retry
//  All state-changing blockchain transactions MUST go through this manager
// ═══════════════════════════════════════════════════════════════════════════

class TxManager {
  constructor() {
    this._mutex = Promise.resolve();
    this._nonce = null;
    this._provider = null;
    this._walletAddr = null;
  }

  /**
   * Serialize all state-changing TXs through a single mutex.
   * Returns a promise that resolves when it's this TX's turn.
   */
  async acquire() {
    let release;
    const waiter = new Promise(resolve => { release = resolve; });
    const prev = this._mutex;
    this._mutex = waiter;
    await prev;
    return release;
  }

  /**
   * Get next nonce using 'pending' tag to include unconfirmed TXs.
   * Always fetches from chain to prevent collisions from external TXs
   * on the same wallet (e.g. other bot instances, manual transactions).
   */
  async getNextNonce(provider, walletAddr) {
    const nonce = await provider.getTransactionCount(walletAddr, "pending");
    this._nonce = nonce;
    this._provider = provider;
    this._walletAddr = walletAddr;
    return this._nonce;
  }

  /**
   * Send a TX with managed nonce, wait for receipt, handle "replacement fee too low".
   * @param {Object} opts - { wallet, provider, sendFn, txType, log }
   *   sendFn(nonce) should return a TransactionResponse
   */
  async sendAndWait({ wallet, provider, sendFn, txType, log }) {
    const walletAddr = wallet.address;
    const release = await this.acquire();
    try {
      return await this._sendWithRetry({ wallet, provider, walletAddr, sendFn, txType, log, attempt: 0 });
    } finally {
      release();
    }
  }

  async _sendWithRetry({ wallet, provider, walletAddr, sendFn, txType, log, attempt }) {
    const MAX_RETRIES = 3;
    const nonce = await this.getNextNonce(provider, walletAddr);

    log(`[TX] ${txType} nonce=${nonce} pendingNonce=${await provider.getTransactionCount(walletAddr, "pending")} latestNonce=${await provider.getTransactionCount(walletAddr, "latest")}`, "info");

    let tx;
    try {
      tx = await sendFn(nonce);
    } catch (e) {
      const msg = e?.message || String(e);
      if (msg.includes("replacement fee too low") || msg.includes("nonce has already been used")) {
        // Nonce collision — invalidate cache and retry
        log(`[TX] ${txType} nonce=${nonce} COLLISION — invalidating nonce cache`, "warn");
        this._nonce = null;
        if (attempt < MAX_RETRIES) {
          // Wait for any pending TX to confirm
          log(`[TX] ${txType} waiting 5s for pending TX to resolve...`, "warn");
          await new Promise(r => setTimeout(r, 5000));
          return this._sendWithRetry({ wallet, provider, walletAddr, sendFn, txType, log, attempt: attempt + 1 });
        }
        throw e;
      }
      throw e;
    }

    log(`[TX] ${txType} SENT nonce=${nonce} hash=${tx.hash}`, "warn");

    // Wait for receipt with timeout
    let receipt;
    try {
      receipt = await tx.wait();
    } catch (waitErr) {
      const waitMsg = waitErr?.message || String(waitErr);
      // TX might still be pending — check on-chain
      log(`[TX] ${txType} wait() failed: ${waitMsg.slice(0, 60)} — checking chain status...`, "warn");
      try {
        receipt = await provider.getTransactionReceipt(tx.hash);
        if (receipt) {
          log(`[TX] ${txType} found on-chain: status=${receipt.status} block=${receipt.blockNumber}`, "info");
        } else {
          // TX might be pending — wait more
          log(`[TX] ${txType} not yet mined — waiting up to 60s...`, "warn");
          for (let i = 0; i < 12; i++) {
            await new Promise(r => setTimeout(r, 5000));
            receipt = await provider.getTransactionReceipt(tx.hash);
            if (receipt) {
              log(`[TX] ${txType} confirmed after ${(i+1)*5}s: status=${receipt.status}`, "info");
              break;
            }
          }
        }
      } catch (checkErr) {
        log(`[TX] ${txType} chain check failed: ${checkErr.message?.slice(0, 60)}`, "error");
      }
    }

    if (!receipt) {
      log(`[TX] ${txType} TIMEOUT — no receipt after extended wait. TX may still confirm later.`, "warn");
      // Invalidate nonce cache since TX might be pending
      this._nonce = null;
      return { hash: tx.hash, status: null, pending: true };
    }

    if (receipt.status !== 1) {
      log(`[TX] ${txType} REVERTED status=0 nonce=${receipt.nonce} gas=${receipt.gasUsed}`, "error");
      // Nonce was consumed by failed TX — invalidate cache
      this._nonce = null;
      return { hash: tx.hash, status: 0, receipt };
    }

    log(`[TX] ${txType} CONFIRMED status=1 nonce=${receipt.nonce} block=${receipt.blockNumber} gas=${receipt.gasUsed}`, "success");
    return { hash: tx.hash, status: 1, receipt };
  }

  /**
   * Invalidate nonce cache (call after external TX or error recovery)
   */
  resetNonce() {
    this._nonce = null;
  }
}

const WETH = "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9";
const USDT = "0x5f2E83cCDEa73D60aF400e03F1Cd8Fb9eaB07b20";
const USDC = "0x5dcf1Db10F87CB7839640F9B85C4ECfA29b56e80";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const POSITION_CREATED_TOPIC = "0x2e462fabb57854af0ee2383faf948da3dc380bd08e582513c3e8e1177478c64a";

// CORRECT ABI — params: isLong, collateralToken, collateralAmount, borrowAmount, leverageX10, amountOutMin, deadline
const MANAGER_ABI = [
  "function openPosition(bool isLong, address collateralToken, uint256 collateralAmount, uint256 borrowAmount, uint256 leverageX10, uint256 amountOutMin, uint256 deadline) returns (uint256)",
  "function closePosition(uint256 positionId, uint256 amountOutMin, uint256 deadline)",
  "function nonces(address user) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function factory() view returns (address)",
  "function getAvailableLiquidity() view returns (uint256)",
  "function LTV_BPS() view returns (uint256)",
  "function PROTOCOL_FEE_BPS() view returns (uint256)",
];

const POOL_ABI = [
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1)",
  "function totalSupply() view returns (uint256)",
  "function token0() view returns (address)",
  "function getOraclePrice() view returns (uint256, uint256)",
  "function swapFeeBps() view returns (uint256)",
  "function getRiskPrice() view returns (uint256 price0Avg, uint256 price1Avg)",
  "function checkpointOracle()",
  "function emaInitialized() view returns (bool)",
  "function emaInitTimestamp() view returns (uint256)",
  "function MIN_TWAP_WINDOW() view returns (uint256)",
];

const ERC20_ABI = [
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

const ROUTER_ABI = [
  "function swapExactETHForTokens(uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) payable returns (uint256[] memory)",
  "function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) returns (uint256[] memory)",
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) returns (uint256[] memory)",
  "function getAmountsOut(uint256 amountIn, address[] calldata path) view returns (uint256[] memory amounts)",
];

const FACTORY_ABI = [
  "function getPool(address tokenA, address tokenB) view returns (address)",
  "function getManager(address pool) view returns (address)",
];

const POSITION_IFACE = new ethers.Interface([
  "function openPosition(bool isLong, address collateralToken, uint256 collateralAmount, uint256 borrowAmount, uint256 leverageX10, uint256 amountOutMin, uint256 deadline) returns (uint256)",
  "function closePosition(uint256 positionId, uint256 amountOutMin, uint256 deadline)",
]);

// ═══════════════════════════════════════════════════════════════════════════
//  HELPER FUNCTIONS — ported from historical index.js
// ═══════════════════════════════════════════════════════════════════════════

function short(addr) {
  return addr ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : "N/A";
}

function sortTokenPair(a, b) {
  return [a, b].sort((x, y) => x.toLowerCase().localeCompare(y.toLowerCase()));
}

function feeAdjusted(amount, feeBps = 100n) {
  if (amount === 0n) return 0n;
  if (feeBps <= 0n) return amount;
  if (feeBps >= BPS) return 0n;
  return amount * (BPS - feeBps) / BPS;
}

function collateralAsLp({ collateralToken, collateralAmount, reserve0, reserve1, totalSupply, token0, oraclePrice0 }) {
  const q112 = 1n << 112n;
  if (collateralAmount === 0n || reserve0 === 0n || reserve1 === 0n || totalSupply === 0n || oraclePrice0 === 0n) return 0n;
  const collateralValue = collateralToken.toLowerCase() === token0.toLowerCase()
    ? collateralAmount * oraclePrice0 / q112
    : collateralAmount;
  const poolValue = reserve0 * oraclePrice0 / q112 + reserve1;
  return poolValue === 0n ? 0n : collateralValue * totalSupply / poolValue;
}

function lpBorrowToExpectedOut({ lpBorrowAmount, collateralToken, reserve0, reserve1, totalSupply, token0, swapFeeBps }) {
  if (lpBorrowAmount === 0n || reserve0 === 0n || reserve1 === 0n || totalSupply === 0n || swapFeeBps >= BPS) return 0n;
  const collateralIsToken0 = collateralToken.toLowerCase() === token0.toLowerCase();
  const amountIn = collateralIsToken0 ? lpBorrowAmount * reserve1 / totalSupply : lpBorrowAmount * reserve0 / totalSupply;
  const collateralFromLp = collateralIsToken0 ? lpBorrowAmount * reserve0 / totalSupply : lpBorrowAmount * reserve1 / totalSupply;
  const reserveIn = collateralIsToken0 ? reserve1 : reserve0;
  const reserveOut = collateralIsToken0 ? reserve0 : reserve1;
  if (amountIn === 0n || reserveIn <= amountIn || reserveOut <= collateralFromLp) return 0n;
  const adjustedReserveIn = reserveIn - amountIn;
  const adjustedReserveOut = reserveOut - collateralFromLp;
  const amountInWithFee = amountIn * (BPS - swapFeeBps);
  return amountInWithFee * adjustedReserveOut / (adjustedReserveIn * BPS + amountInWithFee);
}

// ═══════════════════════════════════════════════════════════════════════════
//  DISCOVERED MARKET REGISTRY — shared, on-chain verified
//  Populated by ensureDiscoveredMarkets() / AutoTrader.ensureMarkets()
// ═══════════════════════════════════════════════════════════════════════════

let _discoveredMarkets = [];
let _discoveredRoutes = [];
let _discoveredTokens = [];
let _discoveredMetaCache = null;
const KNOWN_TOKEN_SYMBOLS = new Map(); // address(lower) → on-chain symbol (for logs only)

export function setDiscoveredMarkets(markets = [], routes = [], tokens = [], metaCache = null) {
  _discoveredMarkets = markets || [];
  _discoveredRoutes = routes || [];
  _discoveredTokens = tokens || [];
  _discoveredMetaCache = metaCache || _discoveredMetaCache;
  for (const t of _discoveredTokens) {
    if (t?.address && t.symbol) KNOWN_TOKEN_SYMBOLS.set(String(t.address).toLowerCase(), t.symbol);
  }
  for (const m of _discoveredMarkets) {
    if (m.token0 && m.token0Symbol) KNOWN_TOKEN_SYMBOLS.set(String(m.token0).toLowerCase(), m.token0Symbol);
    if (m.token1 && m.token1Symbol) KNOWN_TOKEN_SYMBOLS.set(String(m.token1).toLowerCase(), m.token1Symbol);
  }
}

export function getDiscoveredMarkets() { return _discoveredMarkets; }
export function getDiscoveredRoutes() { return _discoveredRoutes; }
export function getDiscoveredTokens() { return _discoveredTokens; }

function readConfigJson() {
  try { return JSON.parse(fs.readFileSync("config.json", "utf8")); } catch { return {}; }
}

// ═══════════════════════════════════════════════════════════════════════════
//  TOKEN META — ALWAYS `await token.decimals()` / `await token.symbol()`
//  Hardcoded decimals are forbidden for any amount maths.
// ═══════════════════════════════════════════════════════════════════════════

const _metaCaches = new WeakMap();

function metaCacheFor(provider) {
  let c = _metaCaches.get(provider);
  if (!c) { c = new TokenMetaCache(provider); _metaCaches.set(provider, c); }
  if (_discoveredMetaCache) {
    for (const meta of _discoveredMetaCache.cache.values()) c.seed(meta);
  }
  return c;
}

/** @returns {Promise<{address, symbol, decimals}>} — on-chain, cached */
export async function tokenMetaOnChain(provider, addr, cache = null) {
  if (!addr) throw new Error("tokenMetaOnChain: address required");
  return cache ? cache.get(addr) : metaCacheFor(provider).get(addr);
}

export async function tokenDecimalsOnChain(provider, addr, cache = null) {
  return (await tokenMetaOnChain(provider, addr, cache)).decimals;
}

export async function tokenSymbolOnChain(provider, addr, cache = null) {
  return (await tokenMetaOnChain(provider, addr, cache)).symbol;
}

/** LOG-ONLY symbol label. Never used for amount maths. */
function tokenSymbolOf(addr) {
  if (!addr) return "?";
  const a = String(addr).toLowerCase();
  const known = KNOWN_TOKEN_SYMBOLS.get(a);
  if (known) return known;
  if (a === USDT.toLowerCase()) return "USDT";
  if (a === USDC.toLowerCase()) return "USDC";
  if (a === WETH.toLowerCase()) return "WETH";
  return short(addr);
}

// ═══════════════════════════════════════════════════════════════════════════
//  MARKET PAIR / COLLATERAL HELPERS — per-market, token0/token1 driven
// ═══════════════════════════════════════════════════════════════════════════

function addrEqLocal(a, b) {
  return !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();
}

/** Resolve both legs of a market from symbol + deployment token table (declared markets). */
function derivePairTokens(token0Hint, symbol) {
  const tokens = getAllTokens();
  const parts = symbol ? String(symbol).split("/").map(s => s.trim().toUpperCase()) : [];
  if (parts.length !== 2) return { token0: token0Hint || null, token1: null, s0: null, s1: null };
  const addrOf = (p) => (p === "ETH" ? (tokens.WETH || tokens.ETH) : tokens[p]) || null;
  const a = addrOf(parts[0]);
  const b = addrOf(parts[1]);
  if (!a || !b) return { token0: token0Hint || null, token1: null, s0: null, s1: null };
  if (token0Hint) {
    if (addrEqLocal(token0Hint, a)) return { token0: a, token1: b, s0: parts[0], s1: parts[1] };
    if (addrEqLocal(token0Hint, b)) return { token0: b, token1: a, s0: parts[1], s1: parts[0] };
  }
  return { token0: a, token1: b, s0: parts[0], s1: parts[1] };
}

/**
 * Both legs of a market + its "risky" (payment) token.
 * token0 → LONG collateral, token1 → SHORT collateral (contract rule).
 */
function pairTokensOfMarket(market) {
  if (!market) return { token0: null, token1: null, risky: null };
  if (market.token0 && market.token1) {
    const risky = market.paymentToken || paymentTokenForMarket(market) || market.token0;
    return { token0: market.token0, token1: market.token1, risky };
  }
  const symbol = market.symbol || market.marketSymbol;
  const derived = derivePairTokens(market.poolToken0 || market.token0, symbol);
  const token0 = derived.token0;
  const token1 = derived.token1;
  const risky = paymentTokenForMarket({
    token0, token1,
    token0Symbol: market.token0Symbol || derived.s0,
    token1Symbol: market.token1Symbol || derived.s1,
  }) || token0;
  return { token0, token1, risky };
}

function collateralTargetStr(config, collateralToken) {
  const t = (collateralToken || "").toLowerCase();
  if (t === WETH.toLowerCase()) return config.targetCollateralWETH || "0.002";
  if (t === USDT.toLowerCase()) return config.targetCollateralUSDT || "10";
  return config.targetCollateralGeneric || "10";
}

function reserveTargetStr(config, collateralToken) {
  const t = (collateralToken || "").toLowerCase();
  if (t === WETH.toLowerCase()) return config.targetReserveWETH || "0.004";
  if (t === USDT.toLowerCase()) return config.targetReserveUSDT || "20";
  return config.targetReserveGeneric || "20";
}

/**
 * Every token that can fund `collateralToken` — dynamic, from the discovered
 * token inventory (deployment tokens ∪ market tokens). Never a fixed 3-token list.
 */
function swapSourcesFor(collateralToken, side, allTokens = null) {
  const target = String(collateralToken || "").toLowerCase();
  const pool = (allTokens && allTokens.length ? allTokens : Object.values(getAllTokens()))
    .map(t => (typeof t === "string" ? t : t?.address))
    .filter(a => a && String(a).toLowerCase() !== target);
  return [...new Set(pool)];
}

/**
 * Build a market descriptor for `side` from a discovered/declared market record.
 */
function describeResolvedMarket(market, side) {
  const { token0, token1, risky } = pairTokensOfMarket(market);
  const collateralToken = collateralForSide({ ...market, token0, token1 }, side);
  const decimals = side === "LONG" ? market.token0Decimals : market.token1Decimals;
  const collateralSym = side === "LONG" ? market.token0Symbol : market.token1Symbol;
  return {
    symbol: market.marketSymbol || market.symbol,
    managerAddr: market.managerAddr,
    poolAddr: market.poolAddr,
    poolToken0: token0,
    poolToken1: token1,
    token0,
    token1,
    token0Symbol: market.token0Symbol || null,
    token1Symbol: market.token1Symbol || null,
    token0Decimals: market.token0Decimals ?? null,
    token1Decimals: market.token1Decimals ?? null,
    riskyToken: risky,
    paymentToken: market.paymentToken || risky,
    collateralToken,
    decimals: decimals ?? null,
    collateralSym: collateralSym || null,
    supportsLong: market.supportsLong !== false,
    supportsShort: market.supportsShort !== false,
    isActive: market.isActive !== false,
    market,
  };
}

/** Declared-only market (config/confirmedPools) — used when on-chain discovery hasn't run yet. */
function declaredMarketFromCandidate(cand) {
  const derived = derivePairTokens(cand.poolToken0Hint, cand.symbol);
  const token0 = derived.token0;
  const token1 = derived.token1;
  const token0Symbol = derived.s0;
  const token1Symbol = derived.s1;
  const market = {
    marketSymbol: cand.symbol,
    symbol: cand.symbol,
    pairKey: normalizeSymbolKey(cand.symbol),
    managerAddr: cand.managerAddr,
    poolAddr: cand.poolAddr,
    token0, token1,
    poolToken0: token0, poolToken1: token1,
    token0Symbol, token1Symbol,
    token0Decimals: null, token1Decimals: null,
    supportsLong: cand.supportsLong !== false,
    supportsShort: cand.supportsShort !== false,
    isActive: cand.isActive !== false && cand.deployedFlag !== false,
    declared: true,
    sources: cand.sources,
  };
  market.paymentToken = paymentTokenForMarket(market);
  return market;
}

function buildDeclaredMarkets({ confirmedPools = {}, availableMarkets = [], knownMarkets = [] } = {}) {
  const cands = mergeMarketSources({ availableMarkets, confirmedPools, knownMarkets });
  return cands
    .filter(c => c.poolAddr && c.isActive !== false && c.deployedFlag !== false)
    .map(declaredMarketFromCandidate);
}

/**
 * Resolve the trading market for a side.
 *
 * Collateral rule (per market, NEVER global):
 *   LONG  → token0
 *   SHORT → token1
 *
 * Ordering: `forceSymbol` (rotation pick) → explicit `preferSymbol` → least-recently-used.
 * When the on-chain registry is populated it is always preferred over config-only data.
 */
function resolveTradingMarket({
  side,
  confirmedPools = {},
  availableMarkets = [],
  preferSymbol = null,
  recentMarkets = [],
  excludeSymbols = [],
  discoveredMarkets = null,
  forceSymbol = null,
}) {
  const registry = (discoveredMarkets && discoveredMarkets.length)
    ? discoveredMarkets
    : (getDiscoveredMarkets().length ? getDiscoveredMarkets() : null);

  const pool = registry && registry.length
    ? registry
    : buildDeclaredMarkets({ confirmedPools, availableMarkets, knownMarkets: getKnownMarkets() });

  const excluded = new Set(excludeSymbols || []);
  let eligible = pool.filter(m => {
    if (!m || m.isActive === false) return false;
    if (excluded.has(marketKey(m))) return false;
    if (side === "LONG" && m.supportsLong === false) return false;
    if (side === "SHORT" && m.supportsShort === false) return false;
    if (!m.managerAddr || !m.poolAddr) return false;
    return true;
  });

  if (eligible.length === 0) return null;

  if (forceSymbol) {
    const forced = eligible.find(m => marketKey(m) === forceSymbol || m.marketSymbol === forceSymbol || m.symbol === forceSymbol);
    if (forced) return describeResolvedMarket(forced, side);
  }

  // Least-recently-used first → prevents one market hogging the rotation
  const recentIdx = new Map((recentMarkets || []).map((k, i) => [k, i]));
  eligible = [...eligible].sort((a, b) => {
    const ra = recentIdx.has(marketKey(a)) ? recentIdx.get(marketKey(a)) : -1;
    const rb = recentIdx.has(marketKey(b)) ? recentIdx.get(marketKey(b)) : -1;
    if (ra !== rb) return ra - rb;
    return String(a.marketSymbol || a.symbol || "").localeCompare(String(b.marketSymbol || b.symbol || ""));
  });

  if (preferSymbol) {
    const pref = eligible.find(m => (m.marketSymbol || m.symbol) === preferSymbol);
    if (pref) return describeResolvedMarket(pref, side);
  }

  return describeResolvedMarket(eligible[0], side);
}

/**
 * openPosition ABI order (selector 0xfa2b1dfd):
 *   isLong, collateralToken, collateralAmount, borrowAmount, leverageX10, amountOutMin, deadline
 * Optional trailing extras (frontend): bytes32 r, uint256 v, address paymentToken
 *   v = (paymentToken == collateralToken) ? 1 : 0
 */
function encodeOpenPositionCalldata({
  isLong, collateralToken, collateralAmount, borrowAmount, leverageX10, amountOutMin, deadline,
  paymentToken, withExtras = true,
}) {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const core = coder.encode(
    ["bool", "address", "uint256", "uint256", "uint256", "uint256", "uint256"],
    [isLong, collateralToken, collateralAmount, borrowAmount, leverageX10, amountOutMin, BigInt(deadline)]
  );
  if (!withExtras) return OPEN_POSITION_SELECTOR + core.slice(2);
  const pay = paymentToken || collateralToken;
  const v = pay.toLowerCase() === collateralToken.toLowerCase() ? 1n : 0n;
  const extras = coder.encode(["bytes32", "uint256", "address"], [OPEN_EXTRAS_R, v, pay]);
  return OPEN_POSITION_SELECTOR + core.slice(2) + extras.slice(2);
}

function applySlippage(amount, slippageBps = 50n) {
  const bps = BigInt(Math.max(0, Number(slippageBps) || 0));
  if (amount <= 0n || bps >= BPS) return 0n;
  return amount * (BPS - bps) / BPS;
}

async function getFeeParams(provider) {
  try {
    const feeData = await provider.getFeeData();
    if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
      return { maxFeePerGas: feeData.maxFeePerGas, maxPriorityFeePerGas: feeData.maxPriorityFeePerGas, type: 2 };
    }
    return { gasPrice: feeData.gasPrice || ethers.parseUnits("1", "gwei"), type: 0 };
  } catch {
    return { gasPrice: ethers.parseUnits("1", "gwei"), type: 0 };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  INVENTORY LOGGING — full token balances at cycle start
// ═══════════════════════════════════════════════════════════════════════════

async function logInventory(provider, walletAddr, log = () => {}) {
  // Dynamic inventory: every discovered token + native ETH
  const discovered = getDiscoveredTokens();
  const tokens = [
    { sym: "ETH", addr: null, decimals: 18, type: "native" },
    ...(discovered.length
      ? discovered.map(t => ({ sym: t.symbol, addr: t.address, decimals: t.decimals, type: "erc20" }))
      : Object.entries(getAllTokens()).map(([sym, addr]) => ({
          sym, addr, decimals: TOKEN_DECIMALS[sym] ?? null, type: "erc20",
        }))),
  ];
  const seen = new Set();
  const lines = [];
  for (const t of tokens) {
    const k = t.type === "native" ? "ETH" : String(t.addr).toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    try {
      let bal;
      let decimals = t.decimals;
      if (t.type === "native") {
        bal = await provider.getBalance(walletAddr);
        decimals = 18;
      } else {
        if (decimals === null || decimals === undefined) {
          decimals = await tokenDecimalsOnChain(provider, t.addr);
        }
        const c = new ethers.Contract(t.addr, ["function balanceOf(address) view returns (uint256)"], provider);
        bal = await c.balanceOf(walletAddr);
      }
      lines.push(`${t.sym}=${ethers.formatUnits(bal, decimals)}`);
    } catch {
      lines.push(`${t.sym}=ERR`);
    }
  }
  log(`[INVENTORY] ${lines.join(" | ")}`, "info");
}

// ═══════════════════════════════════════════════════════════════════════════
//  STATE MACHINE
// ═══════════════════════════════════════════════════════════════════════════

const STATES = {
  IDLE:               "IDLE",
  AUTO_SWAP:          "AUTO_SWAP",
  SIGNAL:             "SIGNAL",
  WAIT:               "WAIT",
  PREPARE_COLLATERAL: "PREPARE_COLLATERAL",
  SWAP:               "SWAP",
  ORACLE:             "ORACLE",
  QUOTE:              "QUOTE",
  PRE_FLIGHT:         "PRE_FLIGHT",
  OPEN:               "OPEN",
  MONITOR:            "MONITOR",
  CLOSE:              "CLOSE",
  COOLDOWN:           "COOLDOWN",
};

// ═══════════════════════════════════════════════════════════════════════════
//  CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

const DEFAULT_AUTO_CONFIG = {
  autoLoopIntervalMs: 30_000,
  maxOpenPositions: 1,
  defaultLeverage: 2,
  maxLeverage: 5,
  targetCollateralUSDT: "10",
  targetCollateralWETH: "0.002",
  targetCollateralGeneric: "10",
  // Inventory targets — when collateral balance < targetReserve, SWAP from other tokens
  // This triggers inventory-aware rebalancing, not just critical deficit swaps
  targetReserveUSDT: "20",
  targetReserveWETH: "0.004",
  targetReserveGeneric: "20",
  minCollateralUSD: 1,
  slippageBps: 50,
  deadlineSeconds: 1200,
  cooldownAfterOpenMs: 60_000,
  cooldownAfterCloseMs: 30_000,
  maxRetries: 3,
  retryDelayMs: 5000,
  dryRun: false,
  ethGuard: { ...DEFAULT_ETH_GUARD },
  availableMarkets: [],
  // No preferred/single market: rotation covers every active MARKET × SIDE
  preferredMarket: null,
  // How many distinct markets to try per cycle when collateral can't be sourced
  maxMarketAttemptsPerCycle: 3,
  // Runtime direction kill-switch: disable a MARKET×SIDE after N consecutive open failures
  maxDirectionFailures: 2,
  marketRefreshMs: 120_000,
};

// ═══════════════════════════════════════════════════════════════════════════
//  SIGNAL ENGINE — RSI-based
// ═══════════════════════════════════════════════════════════════════════════

async function fetchRSI(pair = "ethereum") {
  try {
    const url = `https://api.coingecko.com/api/v3/coins/${pair}/market_chart?vs_currency=usd&days=1&interval=daily`;
    const resp = await fetch(url);
    const data = await resp.json();
    if (!data.prices || data.prices.length < 15) return null;
    const prices = data.prices.map(p => p[1]);
    const changes = [];
    for (let i = 1; i < prices.length; i++) changes.push(prices[i] - prices[i - 1]);
    if (changes.length === 0) return null;
    const period = Math.min(changes.length, 14);
    const recentChanges = changes.slice(-period);
    let avgGain = 0, avgLoss = 0;
    for (const c of recentChanges) {
      if (c > 0) avgGain += c;
      else avgLoss += Math.abs(c);
    }
    avgGain /= recentChanges.length;
    avgLoss /= recentChanges.length;
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return Math.round((100 - (100 / (1 + rs))) * 100) / 100;
  } catch { return null; }
}

function getSignal(rsi, config) {
  if (rsi === null) return "WAIT";
  if (rsi < (config.rsiLong || 30)) return "LONG";
  if (rsi > (config.rsiShort || 70)) return "SHORT";
  return "WAIT";
}

// ═══════════════════════════════════════════════════════════════════════════
//  POSITION STATE — restart-safe persistence
// ═══════════════════════════════════════════════════════════════════════════

const STATE_FILE = "auto-trader-state.json";

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {}
  return { activePosition: null, sessionStats: { opens: 0, closes: 0 }, lastCycleTime: 0, lastSide: null };
}

function saveState(state) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch {}
}

// ═══════════════════════════════════════════════════════════════════════════
//  RESTART RECOVERY — detect on-chain positions
// ═══════════════════════════════════════════════════════════════════════════

async function recoverPosition(provider, walletAddr, managerAddr, log = () => {}) {
  const latestBlock = await provider.getBlockNumber();
  const fromBlock = Math.max(latestBlock - 2000, 0);
  try {
    const logs = await provider.getLogs({
      address: managerAddr,
      topics: [null, "0x000000000000000000000000" + walletAddr.slice(2).toLowerCase()],
      fromBlock,
      toBlock: latestBlock,
    });
    const positionCreatedLogs = logs.filter(l => l.topics[0] === POSITION_CREATED_TOPIC);
    if (positionCreatedLogs.length === 0) return null;
    const lastOpen = positionCreatedLogs[positionCreatedLogs.length - 1];
    const positionId = Number(BigInt(lastOpen.topics[2]));
    const allTxHashes = [...new Set(logs.map(l => l.transactionHash))];
    let positionClosed = false;
    for (const txHash of allTxHashes) {
      try {
        const tx = await provider.getTransaction(txHash);
        if (tx && tx.data && tx.data.startsWith(CLOSE_POSITION_SELECTOR)) {
          const closePosId = Number(BigInt("0x" + tx.data.slice(74, 138)));
          if (closePosId === positionId) { positionClosed = true; break; }
        }
      } catch {}
    }
    if (positionClosed) {
      log(`[RECOVERY] position #${positionId} was already closed`, "info");
      return null;
    }
    // Check for zombie position (zeroed collateral/debt on-chain)
    try {
      const mgr = new ethers.Contract(managerAddr, [
        "function positions(uint256) view returns (bool isLong, address user, address collateralToken, uint256 collateralAmount, uint256 debtAmount, uint256 currentDebt)"
      ], provider);
      const pos = await mgr.positions(positionId);
      if (pos && pos.collateralAmount === 0n && pos.currentDebt === 0n) {
        log(`[RECOVERY] position #${positionId} is zombie (zero collateral+debt) — clearing`, "warn");
        return null;
      }
      if (pos && pos.collateralAmount === 0n && pos.currentDebt > 0n) {
        log(`[RECOVERY] position #${positionId} is zombie (zero collateral, debt=${pos.currentDebt}) — clearing`, "warn");
        return null;
      }
    } catch {}
    log(`[RECOVERY] found active position #${positionId}`, "warn");
    return { positionId, side: "LONG", collateralToken: USDT, openedAt: lastOpen.blockNumber, managerAddr };
  } catch (e) {
    log(`[RECOVERY] error: ${e.message?.slice(0, 60)}`, "error");
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  ORACLE CHECKPOINT FLOW — prevents MAM_OpenOracleDivergence (0x56e7f09d)
// ═══════════════════════════════════════════════════════════════════════════

const ORACLE_MAX_DIVERGENCE_BPS = 500n;
const ORACLE_CHECKPOINT_CONFIRMATIONS = 4;

async function ensureOracleReady(wallet, poolAddress, side, provider, log = () => {}, txManager) {
  if (!ethers.isAddress(poolAddress) || poolAddress === ZERO_ADDRESS) {
    log(`[ORACLE] Pool address invalid — skipping`, "warn");
    return;
  }

  const pool = new ethers.Contract(poolAddress, POOL_ABI, provider);
  log(`[ORACLE] Checking oracle state for pool=${short(poolAddress)}`, "info");

  // Step 1: Check emaInitialized
  let emaInitialized = false;
  try { emaInitialized = await pool.emaInitialized(); } catch {}
  log(`[ORACLE] emaInitialized=${emaInitialized}`, "info");
  if (!emaInitialized) {
    log(`[ORACLE] EMA not initialized — oracle warmup incomplete`, "warn");
    return;
  }

  // Step 2: Check TWAP window
  try {
    const [initTs, minWindow] = await Promise.all([pool.emaInitTimestamp(), pool.MIN_TWAP_WINDOW()]);
    const now = Math.floor(Date.now() / 1000);
    const remaining = Math.max(0, Number(minWindow) - (now - Number(initTs)));
    log(`[ORACLE] TWAP warmup remaining=${remaining}s`, "info");
    if (remaining > 0) {
      log(`[ORACLE] Oracle still warming up — ${remaining}s left`, "warn");
      return;
    }
  } catch {}

  // Step 3: Try getRiskPrice
  let riskPrice0 = 0n, riskPrice1 = 0n, needsCheckpoint = false;
  try {
    const rp = await pool.getRiskPrice();
    riskPrice0 = rp[0]; riskPrice1 = rp[1];
    log(`[ORACLE] getRiskPrice OK: price0Avg=${riskPrice0} price1Avg=${riskPrice1}`, "info");
    if (riskPrice0 === 0n && riskPrice1 === 0n) needsCheckpoint = true;
  } catch (rpErr) {
    const errStr = rpErr?.shortMessage || rpErr?.message || String(rpErr);
    if (errStr.includes("RiskOracleUnavailable") || errStr.includes("revert")) {
      needsCheckpoint = true;
      log(`[ORACLE] getRiskPrice reverted — checkpoint needed`, "warn");
    }
  }

  // Step 4: Check oracle deviation
  if (!needsCheckpoint && riskPrice0 > 0n) {
    try {
      const [spotPrice0] = await pool.getOraclePrice();
      if (spotPrice0 > 0n) {
        const deviationBps = spotPrice0 > riskPrice0
          ? (spotPrice0 - riskPrice0) * 10000n / riskPrice0
          : (riskPrice0 - spotPrice0) * 10000n / spotPrice0;
        log(`[ORACLE] deviation=${deviationBps} bps (max=${ORACLE_MAX_DIVERGENCE_BPS})`, "info");
        if (deviationBps > ORACLE_MAX_DIVERGENCE_BPS) needsCheckpoint = true;
      }
    } catch {}
  }

  // Always send checkpoint to ensure fresh oracle state.
  // The contract threshold for MAM_OpenOracleDivergence may differ from
  // our 500 bps check, so checkpoint unconditionally before every open.
  log(`[ORACLE] Sending checkpoint to ensure fresh oracle state`, "info");

  // Step 5: Send checkpointOracle — best-effort, never throw
  log(`[ORACLE] Sending Pool.checkpointOracle()...`, "warn");
  const poolWrite = new ethers.Contract(poolAddress, POOL_ABI, wallet);
  const feeParams = await getFeeParams(provider);
  try {
    if (txManager) {
      await txManager.sendAndWait({
        wallet, provider, txType: "ORACLE-CHECKPOINT",
        sendFn: (nonce) => poolWrite.checkpointOracle({ gasLimit: 500000n, ...feeParams, nonce }),
        log,
      });
    } else {
      const checkpointTx = await poolWrite.checkpointOracle({ gasLimit: 500000n, ...feeParams });
      log(`[ORACLE] checkpointOracle tx hash=${checkpointTx.hash}`, "warn");
      await checkpointTx.wait(ORACLE_CHECKPOINT_CONFIRMATIONS);
    }
    log(`[ORACLE] Checkpoint confirmed — waiting for oracle to update...`, "success");
  } catch (cpErr) {
    const decodedErr = cpErr?.shortMessage || cpErr?.message || String(cpErr);
    log(`[ORACLE] checkpointOracle FAILED (proceeding anyway): ${decodedErr}`, "error");
    return;
  }

  // Wait for 2 blocks after checkpoint for oracle to propagate
  try {
    const curBlock = await provider.getBlockNumber();
    log(`[ORACLE] Waiting for blocks after checkpoint (current=${curBlock})...`, "info");
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 3000));
      const newBlock = await provider.getBlockNumber();
      if (newBlock >= curBlock + 2) {
        log(`[ORACLE] Blocks confirmed (${newBlock})`, "info");
        break;
      }
    }
  } catch (e) {
    log(`[ORACLE] Block wait failed: ${e.message?.slice(0, 40)}`, "warn");
  }

  // Re-verify oracle state
  try {
    const rpAfter = await pool.getRiskPrice();
    const [spotAfter] = await pool.getOraclePrice();
    const devBps = spotAfter > rpAfter[0]
      ? (spotAfter - rpAfter[0]) * 10000n / rpAfter[0]
      : rpAfter[0] > spotAfter ? (rpAfter[0] - spotAfter) * 10000n / spotAfter : 0n;
    log(`[ORACLE] Post-checkpoint: risk=${rpAfter[0]} spot=${spotAfter} deviation=${devBps}bps`, "info");
  } catch {}

  log(`[ORACLE] Oracle checkpoint complete`, "success");
}

// ═══════════════════════════════════════════════════════════════════════════
//  QUOTE — compute borrowAmount + amountOutMin from pool reserves
// ═══════════════════════════════════════════════════════════════════════════

async function quoteLeveragedAmountOutMin(provider, { pool, manager, collateralToken, collateralAmount, leverageX10, isLong, log = () => {} }) {
  const lev = Number(leverageX10) / 10;
  if (!Number.isFinite(lev) || lev <= 1) throw new Error("Invalid leverage for quote");

  const poolContract = new ethers.Contract(pool, POOL_ABI, provider);
  const managerContract = new ethers.Contract(manager, MANAGER_ABI, provider);

  const [reserves, totalSupply, token0, oraclePrice, swapFeeBps, availableLiquidity, ltvBps, protocolFeeBps] = await Promise.all([
    poolContract.getReserves(),
    poolContract.totalSupply(),
    poolContract.token0(),
    poolContract.getOraclePrice(),
    poolContract.swapFeeBps(),
    managerContract.getAvailableLiquidity(),
    managerContract.LTV_BPS(),
    managerContract.PROTOCOL_FEE_BPS().catch(() => 100n),
  ]);

  const reserve0 = BigInt(reserves[0]);
  const reserve1 = BigInt(reserves[1]);
  const effectiveCollateral = feeAdjusted(collateralAmount, BigInt(protocolFeeBps));
  const collateralLp = collateralAsLp({
    collateralToken, collateralAmount: effectiveCollateral,
    reserve0, reserve1, totalSupply, token0, oraclePrice0: BigInt(oraclePrice[0]),
  });

  if (collateralLp === 0n) throw new Error("Leveraged quoteOut is zero");

  // borrowAmount = collateralLp * (leverage - 1)
  let lpBorrowAmount = collateralLp * BigInt(Math.floor(10000 * Math.max(0, lev - 1))) / BPS;

  // Cap by LTV
  const maxByLtv = BigInt(ltvBps) >= BPS ? lpBorrowAmount : collateralLp * BigInt(ltvBps) / (BPS - BigInt(ltvBps));
  if (lpBorrowAmount > maxByLtv) lpBorrowAmount = maxByLtv;

  // Cap by available liquidity
  if (lpBorrowAmount > BigInt(availableLiquidity)) lpBorrowAmount = BigInt(availableLiquidity);

  const amountOutMinRaw = lpBorrowToExpectedOut({
    lpBorrowAmount, collateralToken, reserve0, reserve1, totalSupply, token0, swapFeeBps: BigInt(swapFeeBps),
  });

  let amountOutMinFinal = applySlippage(amountOutMinRaw, BigInt(200));
  if (amountOutMinRaw <= 0n || amountOutMinFinal <= 0n) throw new Error("Leveraged amountOutMin is zero");

  // SAFETY CAP: Emergency upper bound for amountOutMin.
  // When pool state shifts between quote and execution, lpBorrowToExpectedOut()
  // can produce astronomically high values (e.g. 40T when max possible is ~20M).
  // Cap at 10x effectiveCollateral as a sanity check — this is intentionally
  // generous because the pre-flight will catch any remaining issues.
  const maxPossibleOut = effectiveCollateral * 10n;
  if (amountOutMinFinal > maxPossibleOut) {
    log(`[QUOTE] amountOutMin ${amountOutMinFinal} exceeds 10x collateral ${maxPossibleOut} — capping`, "warn");
    amountOutMinFinal = maxPossibleOut;
  }

  log(`[QUOTE] collateralLp=${collateralLp} borrowAmount=${lpBorrowAmount} amountOutMinRaw=${amountOutMinRaw} amountOutMinFinal=${amountOutMinFinal}`, "info");
  return { amountOutMinFinal, borrowAmount: lpBorrowAmount };
}

// ═══════════════════════════════════════════════════════════════════════════
//  SWAP LOGIC — ETH safety preserved
// ═══════════════════════════════════════════════════════════════════════════

async function ensureCollateral({ wallet, provider, side, collateralToken: collateralTokenArg, collateralAmount, config, log, dryRun, txManager, routes = null, allTokens = null }) {
  const walletAddr = wallet.address;
  const collateralToken = collateralTokenArg;
  if (!collateralToken) {
    log(`[BLOCKED] ensureCollateral: no collateral token for side=${side} (must come from market token0/token1)`, "error");
    return false;
  }
  // decimals/symbol ALWAYS from the token contract
  const decimals = await tokenDecimalsOnChain(provider, collateralToken);
  const sym = await tokenSymbolOnChain(provider, collateralToken);
  const tokenContract = new ethers.Contract(collateralToken, ERC20_ABI, provider);
  const balance = await tokenContract.balanceOf(walletAddr);
  const routerAddr = getRouterAddress();

  log(`[SWAP-DEBUG] requiredCollateral=${ethers.formatUnits(collateralAmount, decimals)} ${sym}`, "info");
  log(`[SWAP-DEBUG] currentCollateral=${ethers.formatUnits(balance, decimals)} ${sym}`, "info");
  log(`[SWAP-DEBUG] router=${routerAddr}`, "info");

  if (balance >= collateralAmount) {
    log(`[COLLATERAL] SUFFICIENT — no swap needed`, "success");
    return true;
  }

  if (dryRun) {
    const deficit = collateralAmount - balance;
    log(`[DRY] Would swap for ${sym}: deficit=${ethers.formatUnits(deficit, decimals)}`, "info");
    return true;
  }

  const deficit = collateralAmount - balance;
  log(`[SWAP-DEBUG] deficit=${ethers.formatUnits(deficit, decimals)} ${sym}`, "warn");
  log(`[COLLATERAL] INSUFFICIENT — deficit=${ethers.formatUnits(deficit, decimals)} ${sym}`, "warn");

  const activeRoutes = routes || getDiscoveredRoutes();
  const sources = swapSourcesFor(collateralToken, side, allTokens || getDiscoveredTokens());
  const router = new ethers.Contract(routerAddr, ROUTER_ABI, provider);

  for (const sourceToken of sources) {
    const sourceContract = new ethers.Contract(sourceToken, ERC20_ABI, provider);
    let sourceBalance, sourceDecimals, sourceSym;
    try {
      sourceBalance = await sourceContract.balanceOf(walletAddr);
      const meta = await tokenMetaOnChain(provider, sourceToken);
      sourceDecimals = meta.decimals;
      sourceSym = meta.symbol;
    } catch (e) {
      log(`[SWAP] source ${short(sourceToken)} meta/balance failed — skip`, "warn");
      continue;
    }

    if (sourceBalance <= 0n) { log(`[SWAP] ${sourceSym} balance=0 — skip`, "info"); continue; }
    log(`[SWAP] Trying ${sourceSym} → ${sym}: balance=${ethers.formatUnits(sourceBalance, sourceDecimals)}`, "info");

    // Route discovery: direct A→B first, validated multi-hop A→HUB→B otherwise
    const route = findRoute(activeRoutes, sourceToken, collateralToken);
    const path = route ? route.path : [sourceToken, collateralToken];
    if (activeRoutes.length && !route) {
      log(`[SWAP] ${sourceSym} → ${sym}: no validated route — skip`, "warn");
      continue;
    }

    try {
      const fullQuote = await router.getAmountsOut(sourceBalance, path);
      const expectedOut = fullQuote[fullQuote.length - 1];
      if (expectedOut < deficit) {
        log(`[SWAP] ${sourceSym} insufficient: max output < deficit`, "warn");
        continue;
      }
      const neededWithBuffer = deficit * 101n / 100n;
      const swapAmount = neededWithBuffer * sourceBalance / expectedOut;
      const safeSwapAmount = swapAmount > sourceBalance ? sourceBalance : swapAmount;
      const amountOutMin = deficit * 99n / 100n;

      log(`[SWAP-DEBUG] tokenIn=${sourceSym} tokenOut=${sym} path=${path.length} hops=${route?.type || "direct"}`, "info");
      log(`[SWAP-DEBUG] sourceBalance=${ethers.formatUnits(sourceBalance, sourceDecimals)} ${sourceSym}`, "info");
      log(`[SWAP-DEBUG] fullQuoteOut=${ethers.formatUnits(expectedOut, decimals)} ${sym}`, "info");
      log(`[SWAP-DEBUG] neededWithBuffer=${ethers.formatUnits(neededWithBuffer, decimals)} ${sym}`, "info");
      log(`[SWAP-DEBUG] swapAmount=${ethers.formatUnits(safeSwapAmount, sourceDecimals)} ${sourceSym}`, "info");
      log(`[SWAP-DEBUG] amountOutMin=${ethers.formatUnits(amountOutMin, decimals)} ${sym}`, "info");
      log(`[SWAP-DEBUG] allowance=${ethers.formatUnits(await sourceContract.allowance(walletAddr, routerAddr), sourceDecimals)} ${sourceSym}`, "info");

      log(`[SWAP] quote: ${ethers.formatUnits(safeSwapAmount, sourceDecimals)} ${sourceSym} → ~${ethers.formatUnits(expectedOut * safeSwapAmount / sourceBalance, decimals)} ${sym}`, "info");

      const swapResult = await executeSwap({
        wallet, provider, fromToken: sourceToken, toToken: collateralToken,
        amount: safeSwapAmount, amountOutMin, config, log, txManager, path,
      });
      if (!swapResult) { log(`[SWAP] FAILED — trying next source`, "error"); continue; }

      const newBalance = await tokenContract.balanceOf(walletAddr);
      log(`[COLLATERAL] balance_after=${ethers.formatUnits(newBalance, decimals)} required=${ethers.formatUnits(collateralAmount, decimals)}`, "info");
      if (newBalance >= collateralAmount) {
        log(`[COLLATERAL] VERIFIED — sufficient after swap`, "success");
        return true;
      }
      continue;
    } catch (e) {
      log(`[SWAP] Quote/swap failed for ${sourceSym}: ${e.message?.slice(0, 60)}`, "error");
      continue;
    }
  }

  // Last resort: ETH → WETH (wrap only the deficit, not all ETH) — only when target is WETH
  if (String(collateralToken).toLowerCase() === WETH.toLowerCase()) {
    const currentWethBal = await new ethers.Contract(WETH, ERC20_ABI, provider).balanceOf(walletAddr);
    const remainingDeficit = collateralAmount > currentWethBal ? collateralAmount - currentWethBal : 0n;
    if (remainingDeficit > 0n) {
      const ethBalance = await provider.getBalance(walletAddr);
      const gasReserve = ethers.parseEther(String(config.ethGuard?.MIN_ETH_GAS_RESERVE ?? 0.003));
      const ethAvail = ethBalance - gasReserve - ethers.parseEther("0.005");
      const wrapAmount = remainingDeficit > ethAvail ? ethAvail : remainingDeficit;
      if (wrapAmount > ethers.parseEther("0.0001")) {
        log(`[SWAP] Last resort: ETH → WETH: wrapping ${ethers.formatEther(wrapAmount)} (deficit=${ethers.formatEther(remainingDeficit)}, available=${ethers.formatEther(ethAvail)})`, "warn");
        const wethContract = new ethers.Contract(WETH, ["function deposit() payable", "function balanceOf(address) view returns (uint256)"], wallet);
        const wrapResult = await (txManager ? txManager.sendAndWait({
          wallet, provider, txType: "WETH-WRAP",
          sendFn: (nonce) => wethContract.deposit({ value: wrapAmount, gasLimit: 100000n, nonce }),
          log,
        }) : (async () => { const wrapTx = await wethContract.deposit({ value: wrapAmount, gasLimit: 100000n }); await wrapTx.wait(); return { hash: wrapTx.hash, status: 1 }; })());
        log(`[SWAP] Wrapped ${ethers.formatEther(wrapAmount)} ETH → WETH`, "success");
        const wethBal = await new ethers.Contract(WETH, ERC20_ABI, provider).balanceOf(walletAddr);
        if (wethBal >= collateralAmount) {
          log(`[COLLATERAL] VERIFIED — WETH sufficient after wrap`, "success");
          return true;
        }
      }
    }
  }

  log(`[SWAP] BLOCKED — no source token can cover deficit`, "error");
  return false;
}

/**
 * Execute a Router swap.
 * @param {string[]} [path] — validated route path (direct [A,B] or multi-hop [A,HUB,B])
 */
async function executeSwap({ wallet, provider, fromToken, toToken, amount, amountOutMin, config, log, txManager, path: pathArg = null }) {
  const walletAddr = wallet.address;
  const routerAddr = getRouterAddress();
  const router = new ethers.Contract(routerAddr, ROUTER_ABI, wallet);
  const fromContract = new ethers.Contract(fromToken, ERC20_ABI, wallet);
  const fromMeta = await tokenMetaOnChain(provider, fromToken);
  const toMeta = await tokenMetaOnChain(provider, toToken);
  const fromSym = fromMeta.symbol;
  const srcDecimals = fromMeta.decimals;

  const allowance = await fromContract.allowance(walletAddr, routerAddr);
  log(`[SWAP-DEBUG] executeSwap: from=${fromSym} to=${toMeta.symbol} amount=${ethers.formatUnits(amount, srcDecimals)} allowance=${ethers.formatUnits(allowance, srcDecimals)}`, "info");
  if (allowance < amount) {
    log(`[SWAP] Approve ${fromSym} → Router...`, "info");
    if (txManager) {
      const r = await txManager.sendAndWait({
        wallet, provider, txType: "SWAP-APPROVE",
        sendFn: (nonce) => fromContract.approve(routerAddr, ethers.MaxUint256, { gasLimit: 100000n, nonce }),
        log,
      });
      if (r.status === 0) { log(`[SWAP] Approve REVERTED`, "error"); return false; }
    } else {
      const approveTx = await fromContract.approve(routerAddr, ethers.MaxUint256, { gasLimit: 100000n });
      await approveTx.wait();
    }
    log(`[SWAP] Approved`, "success");
  }

  const path = (pathArg && pathArg.length >= 2) ? pathArg : [fromToken, toToken];
  const deadline = Math.floor(Date.now() / 1000) + config.deadlineSeconds;
  const calldata = router.interface.encodeFunctionData("swapExactTokensForTokens", [amount, amountOutMin, path, walletAddr, deadline]);

  try { await provider.call({ from: walletAddr, to: routerAddr, data: calldata, value: 0n }); }
  catch (e) { log(`[SWAP] Pre-flight REVERTED: ${e.message?.slice(0, 60)}`, "error"); return false; }

  let gasEstimate;
  try { gasEstimate = await provider.estimateGas({ from: walletAddr, to: routerAddr, data: calldata, value: 0n }); }
  catch (e) { log(`[SWAP] Gas estimation FAILED`, "error"); return false; }

  log(`[SWAP-DEBUG] gasEstimate=${gasEstimate}`, "info");

  const ethBalance = await provider.getBalance(walletAddr);
  const feeData = await provider.getFeeData();
  const gasCost = gasEstimate * (feeData.gasPrice || 0n);
  const gasReserve = ethers.parseEther(String(config.ethGuard?.MIN_ETH_GAS_RESERVE ?? 0.003));
  log(`[SWAP-DEBUG] ethBalance=${ethers.formatEther(ethBalance)} gasCost=${ethers.formatEther(gasCost)} gasReserve=${ethers.formatEther(gasReserve)}`, "info");
  if (ethBalance < gasCost + gasReserve) { log(`[SWAP] BLOCKED: ETH < gas reserve`, "error"); return false; }

  const gasLimit = gasEstimate + gasEstimate / 5n;
  if (txManager) {
    const r = await txManager.sendAndWait({
      wallet, provider, txType: "SWAP",
      sendFn: (nonce) => router.swapExactTokensForTokens(amount, amountOutMin, path, walletAddr, deadline, { gasLimit, nonce }),
      log,
    });
    if (!r || r.status === 0) { log(`[SWAP] TX FAILED`, "error"); return false; }
    if (r.pending) { log(`[SWAP] TX pending — will confirm later`, "warn"); return true; }
    log(`[SWAP] SUCCESS gas=${r.receipt.gasUsed}`, "success");
    return true;
  } else {
    log(`[SWAP] TX_SENT`, "warn");
    const swapTx = await router.swapExactTokensForTokens(amount, amountOutMin, path, walletAddr, deadline, { gasLimit });
    log(`[SWAP] TX hash=${swapTx.hash}`, "info");
    const receipt = await swapTx.wait();
    if (receipt.status !== 1) { log(`[SWAP] TX FAILED (status=0)`, "error"); return false; }
    log(`[SWAP] SUCCESS gas=${receipt.gasUsed}`, "success");
    return true;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  OPEN POSITION — CORRECTED (with oracle checkpoint + proper quote)
// ═══════════════════════════════════════════════════════════════════════════

async function openPosition({ wallet, provider, managerAddr, poolAddr, side, collateralToken, collateralAmount, leverage, config, log, dryRun, txManager, paymentToken }) {
  const walletAddr = wallet.address;
  const isLong = side === "LONG";
  if (!collateralToken) {
    log(`[BLOCKED] openPosition: collateralToken missing (side=${side})`, "error");
    return null;
  }
  // decimals + symbol ALWAYS read from the collateral token contract
  const collateralMeta = await tokenMetaOnChain(provider, collateralToken);
  const decimals = collateralMeta.decimals;
  const collSym = collateralMeta.symbol;
  const leverageX10 = BigInt(leverage * 10);

  // Validate leverage
  if (leverage < 1 || leverage > config.maxLeverage) {
    log(`[BLOCKED] Leverage ${leverage}x exceeds max ${config.maxLeverage}x`, "error");
    return null;
  }

  // Manager code check
  const managerCode = await provider.getCode(managerAddr);
  if (!managerCode || managerCode === "0x") {
    log(`[BLOCKED] Manager ${short(managerAddr)} has no code`, "error");
    return null;
  }

  // STEP 1: Oracle checkpoint (fixes 0x56e7f09d)
  try {
    await ensureOracleReady(wallet, poolAddr, side, provider, log, txManager);
  } catch (e) {
    log(`[BLOCKED] Oracle checkpoint failed: ${e.message?.slice(0, 80)}`, "error");
    return null;
  }

  // STEP 2: Quote — compute borrowAmount + amountOutMin
  let borrowAmount, amountOutMin;
  try {
    const quoteResult = await quoteLeveragedAmountOutMin(provider, {
      pool: poolAddr, manager: managerAddr, collateralToken, collateralAmount, leverageX10, isLong, log,
    });
    borrowAmount = quoteResult.borrowAmount;
    amountOutMin = quoteResult.amountOutMinFinal;
    log(`[QUOTE] borrowAmount=${borrowAmount} amountOutMin=${amountOutMin}`, "info");
  } catch (e) {
    log(`[BLOCKED] Quote failed: ${e.message?.slice(0, 80)}`, "error");
    return null;
  }

  if (borrowAmount <= 0n) {
    log(`[BLOCKED] borrowAmount is zero`, "error");
    return null;
  }

  if (dryRun) {
    log(`[DRY] Would OPEN ${side} collateral=${ethers.formatUnits(collateralAmount, decimals)} borrow=${borrowAmount} ${leverage}x`, "info");
    return { dryRun: true, side, collateralAmount: collateralAmount.toString() };
  }

  // Ensure approval
  const token = new ethers.Contract(collateralToken, ERC20_ABI, wallet);
  const allowance = await token.allowance(walletAddr, managerAddr);
  if (allowance < collateralAmount) {
    log(`[OPEN] Approve collateral → Manager...`, "info");
    if (txManager) {
      const r = await txManager.sendAndWait({
        wallet, provider, txType: "OPEN-APPROVE",
        sendFn: (nonce) => token.approve(managerAddr, ethers.MaxUint256, { gasLimit: 100000n, nonce }),
        log,
      });
      if (r.status === 0) { log(`[OPEN] Approve REVERTED`, "error"); return null; }
    } else {
      const approveTx = await token.approve(managerAddr, ethers.MaxUint256, { gasLimit: 100000n });
      await approveTx.wait();
    }
    log(`[OPEN] Approved`, "success");
  }

  // Encode calldata — CORRECT parameter order per on-chain Manager ABI (0xfa2b1dfd):
  // openPosition(isLong, collateralToken, collateralAmount, borrowAmount, leverageX10, amountOutMin, deadline)
  // + optional frontend extras (r, v, paymentToken). a6 MUST be amountOutMin (slippage check).
  const deadline = Math.floor(Date.now() / 1000) + config.deadlineSeconds;
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const payToken = paymentToken || collateralToken;

  // Pre-flight simulation — encode calldata with the computed amountOutMin
  const encodeCalldata = (aom) => encodeOpenPositionCalldata({
    isLong, collateralToken, collateralAmount,
    borrowAmount, leverageX10, amountOutMin: aom, deadline,
    paymentToken: payToken, withExtras: true,
  });

  let calldata = encodeCalldata(amountOutMin);

  // Attempt 1: pre-flight with computed amountOutMin
  try {
    await provider.call({ from: walletAddr, to: managerAddr, data: calldata, value: 0n });
    log(`[PREFLIGHT] isLong=${isLong} collateralToken=${collSym} collateralAmount=${collateralAmount} leverageX10=${leverageX10} borrowAmount=${borrowAmount} amountOutMin=${amountOutMin} deadline=${deadline}`, "info");
    log(`[PREFLIGHT] PASS`, "success");
  } catch (e) {
    const revertData = e?.data || e?.info?.error?.data || e?.cause?.data || e?.cause?.info?.error?.data || null;
    const match = (e?.shortMessage || e?.message || "").match(/0x[0-9a-fA-F]{8,}/);
    const rawRevert = revertData || match?.[0] || "unknown";
    log(`[PREFLIGHT] isLong=${isLong} collateralToken=${collSym} collateralAmount=${collateralAmount} leverageX10=${leverageX10} borrowAmount=${borrowAmount} amountOutMin=${amountOutMin} deadline=${deadline}`, "info");
    log(`[PREFLIGHT] rawRevertData=${rawRevert}`, "error");

    // Attempt 2: diagnostic — try amountOutMin=0 ONLY for eth_call (never for TX)
    const diagnosticCalldata = encodeCalldata(0n);
    try {
      await provider.call({ from: walletAddr, to: managerAddr, data: diagnosticCalldata, value: 0n });
      log(`[PREFLIGHT] amountOutMin=0 diagnostic PASS — pool rejects computed amountOutMin ${amountOutMin}`, "warn");
      log(`[PREFLIGHT] Re-computing quote with fresh pool state...`, "warn");
      const freshQuote = await quoteLeveragedAmountOutMin(provider, {
        pool: poolAddr, manager: managerAddr, collateralToken, collateralAmount, leverageX10, isLong, log,
      });
      amountOutMin = freshQuote.amountOutMinFinal;
      calldata = encodeCalldata(amountOutMin);
      log(`[PREFLIGHT] Fresh amountOutMin=${amountOutMin}`, "info");
      await provider.call({ from: walletAddr, to: managerAddr, data: calldata, value: 0n });
      log(`[PREFLIGHT] PASS (fresh quote)`, "success");
    } catch (e2) {
      const revertData2 = e2?.data || e2?.info?.error?.data || e2?.cause?.data || e2?.cause?.info?.error?.data || null;
      const match2 = (e2?.shortMessage || e2?.message || "").match(/0x[0-9a-fA-F]{8,}/);
      log(`[PREFLIGHT] Re-computed quote also failed: ${revertData2 || match2?.[0] || e2.message?.slice(0, 60)}`, "error");
      log(`[BLOCKED] Pre-flight REVERTED after retry: ${rawRevert}`, "error");
      if (rawRevert === "0x56e7f09d") {
        log(`[PREFLIGHT] MAM_OpenOracleDivergence — sending checkpoint + retry`, "warn");
        // Decode error params (uint256,uint256,uint256)
        try {
          const errParams = coder.decode(["uint256","uint256","uint256"], "0x" + rawRevert.slice(10));
          log(`[PREFLIGHT] Error params: spot=${errParams[0]} risk=${errParams[1]} threshold=${errParams[2]}`, "info");
        } catch {}
        // Send oracle checkpoint and wait
        try {
          await ensureOracleReady(wallet, poolAddr, side, provider, log, txManager);
        } catch (ckErr) {
          log(`[PREFLIGHT] Retry checkpoint failed: ${ckErr.message?.slice(0, 60)}`, "error");
        }
        // Wait extra blocks for oracle to propagate
        try {
          const curBlk = await provider.getBlockNumber();
          for (let i = 0; i < 8; i++) {
            await new Promise(r => setTimeout(r, 3000));
            if (await provider.getBlockNumber() >= curBlk + 3) break;
          }
        } catch {}
        // Retry quote + preflight
        try {
          const retryQuote = await quoteLeveragedAmountOutMin(provider, {
            pool: poolAddr, manager: managerAddr, collateralToken, collateralAmount, leverageX10, isLong, log,
          });
          const retryAom = retryQuote.amountOutMinFinal;
          const retryCalldata = encodeCalldata(retryAom);
          await provider.call({ from: walletAddr, to: managerAddr, data: retryCalldata, value: 0n });
          amountOutMin = retryAom;
          calldata = retryCalldata;
          log(`[PREFLIGHT] PASS (after oracle checkpoint retry)`, "success");
        } catch (retryErr) {
          const retryData = retryErr?.data || retryErr?.info?.error?.data || retryErr?.cause?.data || retryErr?.cause?.info?.error?.data || null;
          const retryMatch = (retryErr?.shortMessage || retryErr?.message || "").match(/0x[0-9a-fA-F]{8,}/);
          log(`[PREFLIGHT] Retry also failed: ${retryData || retryMatch?.[0] || retryErr.message?.slice(0, 60)}`, "error");
          log(`[BLOCKED] Pre-flight REVERTED after oracle checkpoint retry`, "error");
          return null;
        }
      } else {
        return null;
      }
    }
  }

  // Estimate gas
  let gasEstimate;
  try {
    gasEstimate = await provider.estimateGas({ from: walletAddr, to: managerAddr, data: calldata, value: 0n });
    log(`[OPEN] Gas estimate: ${gasEstimate}`, "info");
  } catch (e) {
    log(`[BLOCKED] Gas estimation FAILED: ${e.message?.slice(0, 80)}`, "error");
    return null;
  }

  // ETH reserve check
  const ethBalance = await provider.getBalance(walletAddr);
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice || 0n;
  const gasCost = gasEstimate * gasPrice;
  const gasReserve = ethers.parseEther(String(config.ethGuard?.MIN_ETH_GAS_RESERVE ?? 0.003));
  if (ethBalance < gasCost + gasReserve) {
    log(`[BLOCKED] ETH ${ethers.formatEther(ethBalance)} below gas reserve`, "error");
    return null;
  }

  // Send TX
  const gasLimit = gasEstimate + gasEstimate / 5n;
  let txHash, receipt;
  if (txManager) {
    const r = await txManager.sendAndWait({
      wallet, provider, txType: `OPEN-${side}`,
      sendFn: (nonce) => wallet.sendTransaction({ to: managerAddr, data: calldata, value: 0n, gasLimit, nonce }),
      log,
    });
    if (!r || r.status === 0) { log(`[BLOCKED] TX FAILED`, "error"); return null; }
    if (r.pending) {
      log(`[OPEN] TX pending — will confirm later`, "warn");
      return { txHash: r.hash, positionId: null, gasUsed: 0n, blockNumber: null, pending: true };
    }
    txHash = r.hash;
    receipt = r.receipt;
  } else {
    log(`[OPEN] Sending openPosition TX...`, "warn");
    const tx = await wallet.sendTransaction({ to: managerAddr, data: calldata, value: 0n, gasLimit });
    txHash = tx.hash;
    log(`[OPEN] TX: ${tx.hash}`, "info");
    receipt = await tx.wait();
    if (receipt.status !== 1) { log(`[BLOCKED] TX FAILED (status=0)`, "error"); return null; }
  }

  log(`[OPEN] SUCCESS gas=${receipt.gasUsed}`, "success");

  // Extract positionId from PositionCreated event
  let positionId = null;
  for (const logEntry of receipt.logs) {
    if (logEntry.topics[0] === POSITION_CREATED_TOPIC && logEntry.address.toLowerCase() === managerAddr.toLowerCase()) {
      positionId = Number(BigInt(logEntry.topics[2]));
      break;
    }
  }

  if (positionId === null) {
    log(`[BLOCKED] TX succeeded but PositionCreated event not found`, "error");
    return null;
  }

  log(`[OPEN] Position ID: ${positionId}`, "success");
  return { txHash, positionId, gasUsed: receipt.gasUsed, blockNumber: receipt.blockNumber };
}

// ═══════════════════════════════════════════════════════════════════════════
//  CLOSE POSITION
// ═══════════════════════════════════════════════════════════════════════════

async function closePositionFn({ wallet, provider, managerAddr, positionId, config, log, dryRun, txManager }) {
  const walletAddr = wallet.address;

  if (dryRun) {
    log(`[DRY] Would CLOSE position #${positionId}`, "info");
    return { dryRun: true };
  }

  const deadline = Math.floor(Date.now() / 1000) + config.deadlineSeconds;
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const params = coder.encode(["uint256", "uint256", "uint256"], [positionId, 0n, BigInt(deadline)]);
  const calldata = CLOSE_POSITION_SELECTOR + params.slice(2);

  // Pre-flight
  try {
    await provider.call({ from: walletAddr, to: managerAddr, data: calldata, value: 0n });
    log(`[CLOSE] Pre-flight OK`, "info");
  } catch (e) {
    const closeErrData = e?.data || e?.info?.error?.data || e?.cause?.data || e?.cause?.info?.error?.data || null;
    const closeErrMatch = (e?.shortMessage || e?.message || "").match(/0x[0-9a-fA-F]{8,}/);
    const closeRawErr = closeErrData || closeErrMatch?.[0] || "";
    // MAM_InvalidPosition (0xa5732d32) — zombie position (zeroed collateral/debt)
    if (closeRawErr.startsWith("0xa5732d32")) {
      log(`[CLOSE] MAM_InvalidPosition — zombie position detected, clearing state`, "warn");
      return { failed: true, reason: "zombie" };
    }
    log(`[BLOCKED] Close pre-flight REVERTED: ${e.message?.slice(0, 80)}`, "error");
    log(`[WARN] Position may no longer exist — clearing state`, "warn");
    return { failed: true, reason: e.message?.slice(0, 60) };
  }

  let gasEstimate;
  try {
    gasEstimate = await provider.estimateGas({ from: walletAddr, to: managerAddr, data: calldata, value: 0n });
  } catch (e) {
    log(`[BLOCKED] Close gas estimation FAILED`, "error");
    return null;
  }

  const gasLimit = gasEstimate + gasEstimate / 5n;
  let txHash, receipt;
  if (txManager) {
    const r = await txManager.sendAndWait({
      wallet, provider, txType: "CLOSE",
      sendFn: (nonce) => wallet.sendTransaction({ to: managerAddr, data: calldata, value: 0n, gasLimit, nonce }),
      log,
    });
    if (!r || r.status === 0) { log(`[BLOCKED] Close TX FAILED`, "error"); return null; }
    if (r.pending) {
      log(`[CLOSE] TX pending — will confirm later`, "warn");
      return { txHash: r.hash, gasUsed: 0n, blockNumber: null, pending: true };
    }
    txHash = r.hash;
    receipt = r.receipt;
  } else {
    log(`[CLOSE] Sending closePosition TX...`, "warn");
    const tx = await wallet.sendTransaction({ to: managerAddr, data: calldata, value: 0n, gasLimit });
    txHash = tx.hash;
    log(`[CLOSE] TX: ${tx.hash}`, "info");
    receipt = await tx.wait();
    if (receipt.status !== 1) { log(`[BLOCKED] Close TX FAILED (status=0)`, "error"); return null; }
  }

  log(`[CLOSE] SUCCESS gas=${receipt.gasUsed}`, "success");
  return { txHash, gasUsed: receipt.gasUsed, blockNumber: receipt.blockNumber };
}

// ═══════════════════════════════════════════════════════════════════════════
//  AUTO TRADER — Main Orchestrator
// ═══════════════════════════════════════════════════════════════════════════

export class AutoTrader {
  constructor(deps) {
    this.deps = deps;
    this.config = { ...DEFAULT_AUTO_CONFIG, ...deps.config };
    this.running = false;
    this.stopRequested = false;
    this.cycleRunning = false;
    this.state = loadState();
    this.inventory = new TokenInventory();
    this.swapJournal = new SwapJournal(10);
    this.currentState = STATES.IDLE;
    this._logListeners = [];
    this.txManager = new TxManager();
    this.lastCycleAction = "idle";

    // Dynamic market/route discovery (populated by ensureMarkets)
    this.markets = [];
    this.routes = [];
    this.tokenList = [];
    this.metaCache = new TokenMetaCache();
    this.rotation = RotationMemory.fromJSON(this.state.rotation || null);
    // MARKET×SIDE runtime kill-switch: { "SYMBOL:SIDE": failCount }
    this.directionDisabled = this.state.directionDisabled || {};
    this._marketsReady = false;
    this._lastMarketRefresh = 0;
    this._planned = null;
  }

  /**
   * Discover ALL active markets + swap routes on-chain (cached, refreshed periodically).
   */
  async ensureMarkets({ force = false } = {}) {
    const now = Date.now();
    const refreshMs = Number(this.config.marketRefreshMs || 120_000);
    if (!force && this._marketsReady && (now - this._lastMarketRefresh) < refreshMs) return this.markets;

    try {
      const { provider } = this.getRuntime();
      const cfg = readConfigJson();
      const discovered = await discoverMarkets({
        provider,
        factoryAddress: getFactoryAddress(),
        tokens: getAllTokens(),
        confirmedPools: this.deps.confirmedPools || getConfirmedPools(),
        knownMarkets: getKnownMarkets?.() || [],
        availableMarkets: this.config.availableMarkets || this.deps.availableMarkets || (cfg || this.config).availableMarkets || [],
        runtime: { directionDisabled: this.directionDisabled },
        log: this.log.bind(this),
      });
      this.markets = discovered.markets || [];
      this.metaCache = discovered.tokenMetaCache || this.metaCache;
      // Full token inventory: deployment tokens ∪ every market token (on-chain meta)
      this.tokenList = await discoverTokens({
        provider,
        tokens: getAllTokens(),
        markets: this.markets,
        log: this.log.bind(this),
      });

      this.routes = await discoverSwapRoutes({
        provider,
        routerAddress: getRouterAddress(),
        factoryAddress: getFactoryAddress(),
        tokens: this.tokenList,
        log: this.log.bind(this),
      });
      setDiscoveredMarkets(this.markets, this.routes, this.tokenList, this.metaCache);

      this._marketsReady = true;
      this._lastMarketRefresh = now;

      this.log(formatMarketsTable(this.markets), "info");
      this.log(formatCoverageTable(this.markets, { directionDisabled: this.directionDisabled }), "info");
      this.log(formatRoutesTable(this.routes), "info");
    } catch (e) {
      this.log(`[DISCOVERY] failed: ${e.message?.slice(0, 80)}`, "error");
    }
    return this.markets;
  }

  _directionKey(marketSymbol, side) {
    return `${marketSymbol}|${side}`;
  }

  _isDirectionDisabled(marketSymbol, side) {
    if (this.directionDisabled[this._directionKey(marketSymbol, side)]) return true;
    const m = this.markets.find(x => (x.marketSymbol || x.symbol) === marketSymbol);
    return m ? !supportsSide(m, side) : false;
  }

  _disableDirection(marketSymbol, side, reason = "") {
    const key = this._directionKey(marketSymbol, side);
    if (this.directionDisabled[key]) return;
    this.directionDisabled[key] = { since: Date.now(), reason };
    this.state.directionDisabled = this.directionDisabled;
    saveState(this.state);
    this.log(`[DISCOVERY] DISABLED ${key} — ${reason}`, "warn");
  }

  _recordDirectionFailure(marketSymbol, side) {
    const key = this._directionKey(marketSymbol, side);
    const entry = this.directionDisabled[key] || { fails: 0 };
    entry.fails = (entry.fails || 0) + 1;
    const maxFails = Number(this.config.maxDirectionFailures || 2);
    if (entry.fails >= maxFails) {
      this._disableDirection(marketSymbol, side, `${entry.fails} consecutive preflight/open failures`);
    } else {
      this.directionDisabled[key] = entry;
      this.state.directionDisabled = this.directionDisabled;
      saveState(this.state);
    }
  }

  _recordDirectionSuccess(marketSymbol, side) {
    const key = this._directionKey(marketSymbol, side);
    if (this.directionDisabled[key]) {
      delete this.directionDisabled[key];
      this.state.directionDisabled = this.directionDisabled;
      saveState(this.state);
      this.log(`[DISCOVERY] RE-ENABLED ${key}`, "success");
    }
  }

  onLog(fn) { this._logListeners.push(fn); }
  offLog(fn) { this._logListeners = this._logListeners.filter(f => f !== fn); }

  log(msg, level = "info") {
    this.deps.log(msg, level);
    for (const fn of this._logListeners) {
      try { fn(msg, level); } catch {}
    }
  }

  getRuntime() {
    const { accounts, selectedWalletIndex, proxies, getProvider, rpcUrl, chainId } = this.deps;
    const proxyUrl = proxies[selectedWalletIndex % proxies.length] || null;
    const provider = getProvider(rpcUrl, chainId, proxyUrl);
    const wallet = new ethers.Wallet(accounts[selectedWalletIndex].privateKey, provider);
    return { provider, wallet };
  }

  /**
   * Resolve market for a side (sync). Uses discovered markets when ensureMarkets()
   * has run (callers should await it first); falls back to declared config otherwise.
   * Honors declared supportsLong/supportsShort + runtime directionDisabled kill-switch,
   * prefers least-recently-used via rotation memory. No hardcoded market preference.
   */
  resolveMarket(side, opts = {}) {
    const discovered = this.markets;
    const availableMarkets = this.config.availableMarkets || this.deps.availableMarkets || [];
    const confirmedPools = this.deps.confirmedPools || {};
    const rotation = this.rotation;
    const excludeSymbols = opts.excludeSymbols || [];
    const preferSymbol = opts.preferSymbol !== undefined ? opts.preferSymbol : (this.config.preferredMarket ?? null);

    const candidates = discovered && discovered.length ? discovered : null;
    if (!candidates) {
      return resolveTradingMarket({
        side, confirmedPools, availableMarkets, preferSymbol, excludeSymbols,
        recentMarkets: rotation ? rotation.recentMarkets : [],
      });
    }

    const enabled = candidates.filter(m =>
      (m.marketSymbol || m.symbol) &&
      supportsSide(m, side) &&
      !this._isDirectionDisabled(m.marketSymbol || m.symbol, side) &&
      !excludeSymbols.includes(m.marketSymbol || m.symbol) &&
      m.isActive !== false
    );
    if (!enabled.length) return null;

    // Least-recently-used first (rotation), then preferred, then declaration order
    const recent = rotation ? rotation.recentMarkets : [];
    // recentMarkets entries are "SYMBOL|SIDE" keys — extract per-market recency index
    const marketRecency = new Map();
    recent.forEach((key, idx) => {
      const mkt = String(key).split("|")[0];
      // later index = more recent; keep the highest (most recent) per market
      if (!marketRecency.has(mkt) || marketRecency.get(mkt) < idx) marketRecency.set(mkt, idx);
    });
    const score = m => {
      const sym = m.marketSymbol || m.symbol;
      const idx = marketRecency.has(sym) ? marketRecency.get(sym) : -1;
      // Higher = chosen first: never-used >> least-recently-used >> most-recent
      const recency = idx === -1 ? 1_000_000 : (recent.length - idx);
      const pref = preferSymbol && sym === preferSymbol ? 10_000_000 : 0;
      return pref + recency;
    };
    const sorted = [...enabled].sort((a, b) => score(b) - score(a));
    const chosen = sorted[0];

    const collateralToken = collateralForSide(chosen, side);
    const decimals = collateralDecimalsForSide(chosen, side);
    const collSym = collateralSymbolForSide(chosen, side);
    return {
      symbol: chosen.marketSymbol || chosen.symbol,
      poolAddr: chosen.poolAddr,
      managerAddr: chosen.managerAddr,
      collateralToken,
      collateralSym: collSym,
      decimals,
      paymentToken: chosen.paymentToken || paymentTokenForMarket(chosen),
      token0: chosen.token0,
      token1: chosen.token1,
      market: chosen,
    };
  }

  /**
   * Plan one (or more) market candidates for a side — used by prepareAndOpen fallback.
   */
  async planMarketsForSide(side, { max = 3 } = {}) {
    await this.ensureMarkets();
    const out = [];
    let exclude = [];
    for (let i = 0; i < max; i++) {
      const m = this.resolveMarket(side, { excludeSymbols: exclude });
      if (!m) break;
      out.push(m);
      exclude.push(m.symbol);
    }
    return out;
  }

  /** Rotation-picked next (market, side) pair — for display/planning. */
  async nextMarketSide() {
    await this.ensureMarkets();
    const sides = enumerateMarketSides(this.markets, { directionDisabled: this.directionDisabled })
      .filter(x => x.market && x.market.isActive !== false);
    if (!sides.length) return null;
    return this.rotation.pickMarketSide(sides);
  }

  getManagerAddr(side) {
    if (side) {
      const m = this.resolveMarket(side);
      if (m?.managerAddr) return m.managerAddr;
    }
    if (this.state?.activePosition?.managerAddr) return this.state.activePosition.managerAddr;
    const forSide = this.resolveMarket(this.state?.lastSide || "SHORT") || this.resolveMarket("LONG");
    if (forSide?.managerAddr) return forSide.managerAddr;
    // Fallback: first discovered market's manager (never a hardcoded address)
    const first = this.markets.find(m => m.managerAddr) || Object.values(this.deps.confirmedPools || {}).find(p => p?.manager);
    if (first?.managerAddr) return first.managerAddr;
    if (first?.manager) return first.manager;
    return this.deps.confirmedPools?.["NEMESIS/USDT"]?.manager || null;
  }

  getPoolAddr(side) {
    if (side) {
      const m = this.resolveMarket(side);
      if (m?.poolAddr) return m.poolAddr;
    }
    if (this.state?.activePosition?.poolAddr) return this.state.activePosition.poolAddr;
    const forSide = this.resolveMarket(this.state?.lastSide || "SHORT") || this.resolveMarket("LONG");
    if (forSide?.poolAddr) return forSide.poolAddr;
    const first = this.markets.find(m => m.poolAddr) || Object.values(this.deps.confirmedPools || {}).find(p => p?.pool);
    if (first?.poolAddr) return first.poolAddr;
    if (first?.pool) return first.pool;
    return this.deps.confirmedPools?.["NEMESIS/USDT"]?.pool || null;
  }

  setState(newState) {
    this.currentState = newState;
  }

  async runCycle() {
    if (this.cycleRunning) {
      this.log("[BLOCKED] Cycle already running — skipping", "warn");
      return;
    }
    this.cycleRunning = true;
    const dryRun = this.config.dryRun;

    try {
      const { provider, wallet } = this.getRuntime();
      const walletAddr = wallet.address;
      // Discover all markets/routes before any planning
      await this.ensureMarkets();
      // Default market for inventory logs / recovery — actual OPEN resolves per side
      const defaultMarket = this.resolveMarket(this.state.lastSide || "SHORT") || this.resolveMarket("LONG");
      const managerAddr = defaultMarket?.managerAddr || this.getManagerAddr();
      const poolAddr = defaultMarket?.poolAddr || this.getPoolAddr();

      this.log("[CYCLE] ═══ CYCLE START ═══", "info");

      // Log full token inventory
      await logInventory(provider, walletAddr, this.log.bind(this));

      // NEXT ACTION prediction for TUI
      if (this.state.activePosition) {
        this.log(`[AUTO] NEXT ACTION: CLOSE position #${this.state.activePosition.positionId}`, "info");
      } else {
        this.log(`[AUTO] NEXT ACTION: SWAP + OPEN ${this.config.defaultLeverage}x`, "info");
      }

      // PHASE 0: AUTO-SWAP — proactive token rebalancing across ALL discovered tokens
      const autoSwapConfig = this.config.autoSwap || {};
      if (autoSwapConfig.enabled) {
        this.setState(STATES.AUTO_SWAP);
        const maxSwaps = autoSwapConfig.maxSwapsPerCycle || 2;
        let swapsDone = 0;

        // Dynamic token map: discovered tokens (on-chain decimals) ∪ deployment tokens
        const tokenAddrs = {};
        const tokenDecimalsMap = {};
        for (const t of (this.tokenList.length ? this.tokenList : Object.entries(getAllTokens()).map(([symbol, address]) => ({ symbol, address, decimals: TOKEN_DECIMALS[symbol] ?? null })))) {
          tokenAddrs[t.symbol] = t.address;
          tokenDecimalsMap[t.symbol] = t.decimals;
        }

        this.log(`[AUTO-SWAP] Phase started (max ${maxSwaps} swaps per cycle, ${this.routes.length} routes)`, "info");

        // Refresh inventory for auto-swap decisions
        const inventoryTokenMap = {};
        for (const [sym, addr] of Object.entries(tokenAddrs)) {
          inventoryTokenMap[sym] = { address: addr, decimals: tokenDecimalsMap[sym] ?? TOKEN_DECIMALS[sym] ?? 6 };
        }
        try {
          await this.inventory.refreshBalances(provider, walletAddr, inventoryTokenMap, this.log.bind(this));
          this.inventory.logStatus(this.log.bind(this));
        } catch (e) {
          this.log(`[AUTO-SWAP] Inventory refresh failed: ${e.message?.slice(0, 60)}`, "error");
        }

        for (let i = 0; i < maxSwaps; i++) {
          try {
            // Re-fetch fresh balances for each swap (decimals from discovery / on-chain)
            const freshBalances = {};
            for (const [sym, addr] of Object.entries(tokenAddrs)) {
              try {
                let dec = tokenDecimalsMap[sym];
                if (dec === null || dec === undefined) dec = await tokenDecimalsOnChain(provider, addr);
                tokenDecimalsMap[sym] = dec;
                const c = new ethers.Contract(addr, ERC20_ABI, provider);
                const bal = await c.balanceOf(walletAddr);
                freshBalances[sym] = { raw: bal, float: parseFloat(ethers.formatUnits(bal, dec)) };
              } catch { freshBalances[sym] = { raw: 0n, float: 0 }; }
            }

            // Select a pair from validated routes + rotation (avoid recent repeats)
            const pair = selectRandomSwapPair(this.swapJournal, freshBalances, autoSwapConfig, tokenAddrs, this.log.bind(this), this.routes, this.rotation);
            if (!pair) {
              this.log(`[AUTO-SWAP] No valid pair found — stopping auto-swap phase`, "info");
              break;
            }

            // Calculate random amount
            const fromBal = freshBalances[pair.from];
            if (!fromBal || fromBal.float <= 0) {
              this.log(`[AUTO-SWAP] ${pair.from} balance=0 — skip`, "info");
              continue;
            }

            const amountResult = calculateRandomSwapAmount(pair.from, fromBal.float, autoSwapConfig, tokenDecimalsMap[pair.from]);
            if (!amountResult) {
              this.log(`[AUTO-SWAP] Amount too small for ${pair.from} — skip`, "info");
              continue;
            }

            // Convert float amount to raw BigInt
            const decimals = tokenDecimalsMap[pair.from] ?? TOKEN_DECIMALS[pair.from] ?? 6;
            const amountRaw = ethers.parseUnits(amountResult.amountFloat.toFixed(decimals), decimals);

            // Safety: don't use more than 90% of balance
            if (amountRaw > fromBal.raw * 90n / 100n) {
              this.log(`[AUTO-SWAP] Amount exceeds 90% of balance — capping`, "warn");
              continue;
            }

            // Safety: don't use more than available balance
            if (amountRaw > fromBal.raw) {
              this.log(`[AUTO-SWAP] Insufficient ${pair.from} balance`, "warn");
              continue;
            }

            // Validated route path (direct or multi-hop via hub)
            const route = findRoute(this.routes, pair.fromAddr, pair.toAddr);
            const path = route ? route.path : [pair.fromAddr, pair.toAddr];

            // Get quote from Router along the route
            const router = new ethers.Contract(getRouterAddress(), ROUTER_ABI, provider);
            let quote;
            try {
              quote = await router.getAmountsOut(amountRaw, path);
            } catch (e) {
              this.log(`[AUTO-SWAP] Quote failed for ${pair.from}→${pair.to}: ${e.message?.slice(0, 60)}`, "error");
              continue;
            }

            const expectedOut = quote[quote.length - 1];
            const toDecimals = tokenDecimalsMap[pair.to] ?? TOKEN_DECIMALS[pair.to] ?? 6;
            const amountOutMin = applySlippage(expectedOut, BigInt(autoSwapConfig.slippageBps || 50));

            // Log pre-swap details
            this.log(`[SWAP] pair=${pair.from}→${pair.to} hops=${route?.type || "direct"}`, "warn");
            this.log(`[SWAP] amountIn=${ethers.formatUnits(amountRaw, decimals)} ${pair.from}`, "warn");
            this.log(`[SWAP] expectedOut=${ethers.formatUnits(expectedOut, toDecimals)} ${pair.to}`, "warn");
            this.log(`[SWAP] amountOutMin=${ethers.formatUnits(amountOutMin, toDecimals)} ${pair.to}`, "warn");

            if (dryRun) {
              this.log(`[DRY] Would swap ${amountResult.amountFloat.toFixed(4)} ${pair.from} → ${pair.to}`, "info");
              this.swapJournal.record({ from: pair.from, to: pair.to, amount: amountResult.amountFloat });
              this.rotation.recordSwapPair(pair.from, pair.to);
              swapsDone++;
              continue;
            }

            // Execute swap (route path: direct or multi-hop)
            const swapResult = await executeSwap({
              wallet, provider,
              fromToken: pair.fromAddr, toToken: pair.toAddr,
              amount: amountRaw, amountOutMin,
              config: this.config, log: this.log.bind(this), txManager: this.txManager, path,
            });

            if (!swapResult) {
              this.log(`[SWAP] ${pair.from}→${pair.to} FAILED`, "error");
              continue;
            }

            // Wait for balance update
            await new Promise(r => setTimeout(r, 2000));

            // Verify new balance
            const newFromContract = new ethers.Contract(pair.fromAddr, ERC20_ABI, provider);
            const newToContract = new ethers.Contract(pair.toAddr, ERC20_ABI, provider);
            const newFromBal = await newFromContract.balanceOf(walletAddr);
            const newToBal = await newToContract.balanceOf(walletAddr);

            this.log(`[SWAP] SUCCESS ${pair.from}→${pair.to}`, "success");
            this.log(`[SWAP] actualOut≈${ethers.formatUnits(expectedOut, toDecimals)} ${pair.to}`, "success");
            this.log(`[SWAP] balanceAfter: ${pair.from}=${ethers.formatUnits(newFromBal, decimals)} ${pair.to}=${ethers.formatUnits(newToBal, toDecimals)}`, "success");

            // Record in journal + rotation
            this.swapJournal.record({ from: pair.from, to: pair.to, amount: amountResult.amountFloat });
            this.rotation.recordSwapPair(pair.from, pair.to);
            this.state.rotation = this.rotation.toJSON();
            saveState(this.state);
            swapsDone++;

            // Cooldown between swaps
            if (i < maxSwaps - 1) {
              const cooldownMs = autoSwapConfig.swapCooldownMs || 20000;
              this.log(`[AUTO-SWAP] Waiting ${cooldownMs / 1000}s before next swap...`, "info");
              await this.sleep(cooldownMs);
            }
          } catch (e) {
            this.log(`[AUTO-SWAP] Swap ${i + 1} error: ${e.message?.slice(0, 80)}`, "error");
            this.txManager.resetNonce();
          }
        }

        this.log(`[AUTO-SWAP] Phase complete — ${swapsDone} swaps executed`, "info");

        // Log updated inventory
        await logInventory(provider, walletAddr, this.log.bind(this));
      }

      // PHASE 1: If active position → CLOSE (always via the position's own manager)
      if (this.state.activePosition) {
        this.setState(STATES.CLOSE);
        const activeManager = this.state.activePosition.managerAddr
          || this.getManagerAddr(this.state.activePosition.side)
          || managerAddr;
        this.log(`[CLOSE] position #${this.state.activePosition.positionId} (${this.state.activePosition.side}) market=${this.state.activePosition.marketSymbol || "?"} manager=${short(activeManager)}`, "warn");

        const closeResult = await closePositionFn({
          wallet, provider, managerAddr: activeManager,
          positionId: this.state.activePosition.positionId,
          config: this.config, log: this.log.bind(this), dryRun, txManager: this.txManager,
        });

        if (closeResult?.failed) {
          this.log(`[CLOSE] failed — clearing state`, "warn");
          this.state.activePosition = null;
          this.state.sessionStats.closes++;
          saveState(this.state);
        } else if (closeResult) {
          this.log(`[CLOSE] SUCCESS TX: ${closeResult.txHash || "dry-run"}`, "success");
          this.state.activePosition = null;
          this.state.sessionStats.closes++;
          saveState(this.state);
          this.setState(STATES.COOLDOWN);
          this.log(`[COOLDOWN] ${this.config.cooldownAfterCloseMs / 1000}s...`, "info");
          await this.sleep(this.config.cooldownAfterCloseMs);
        } else {
          this.log(`[CLOSE] failed — will retry next cycle`, "warn");
        }

        this.lastCycleAction = "close";
        this.log("[CYCLE] ═══ CYCLE END ═══", "info");
        return;
      }

      // PHASE 2: SELECT DIRECTION + MARKET — RSI may bias side, rotation picks MARKET×SIDE
      this.setState(STATES.SIGNAL);
      const lastSide = this.state.lastSide || null;
      let side = null;
      let preferredSideFromSignal = null;

      // Try RSI first
      try {
        const rsi = await fetchRSI("ethereum");
        if (rsi !== null) {
          const signal = getSignal(rsi, { rsiLong: 30, rsiShort: 70 });
          this.log(`[RSI] value=${rsi} signal=${signal}`, "info");
          if (signal !== "WAIT") {
            preferredSideFromSignal = signal;
          }
        }
      } catch {}

      // Rotation-backed side selection: RSI may bias; otherwise use rotated MARKET×SIDE
      const planned = await this.nextMarketSide();
      if (preferredSideFromSignal) {
        side = preferredSideFromSignal;
      } else if (planned) {
        side = planned.side;
      } else {
        side = lastSide === "LONG" ? "SHORT" : "LONG";
      }
      this.log(`[DIRECTION] ${side}${planned ? ` (rotated candidate: ${planned.marketSymbol || planned.symbol}×${planned.side})` : ""}`, "warn");

      // PHASE 3: PREPARE COLLATERAL — INVENTORY-AWARE, pool-aware market (with fallbacks)
      this.setState(STATES.PREPARE_COLLATERAL);
      const marketCandidates = await this.planMarketsForSide(side, {
        max: Number(this.config.maxMarketAttemptsPerCycle || 3),
      });
      if (!marketCandidates.length) {
        this.log(`[BLOCKED] No active market supports ${side}`, "error");
        return;
      }
      const market = marketCandidates[0];
      this.log(`[MARKET] ${market.symbol} manager=${short(market.managerAddr)} pool=${short(market.poolAddr)} coll=${market.collateralSym || "?"} (candidates: ${marketCandidates.map(m => m.symbol).join(", ")})`, "info");
      const collateralToken = market.collateralToken;
      if (!collateralToken) {
        this.log(`[BLOCKED] Market ${market.symbol} has no collateral token for ${side}`, "error");
        return;
      }
      // decimals/symbol ALWAYS from token contract (never hardcoded)
      const collateralDecimals = market.decimals ?? await tokenDecimalsOnChain(provider, collateralToken);
      const collateralSym = market.collateralSym ?? await tokenSymbolOnChain(provider, collateralToken);

      // Required collateral for position open
      const targetStr = collateralTargetStr(this.config, collateralToken);
      const collateralAmount = ethers.parseUnits(targetStr, collateralDecimals);

      // Inventory target — swap UP TO this level (not just critical deficit)
      const reserveStr = reserveTargetStr(this.config, collateralToken);
      const targetReserve = ethers.parseUnits(reserveStr, collateralDecimals);

      const tokenContract = new ethers.Contract(collateralToken, ERC20_ABI, provider);
      const balance = await tokenContract.balanceOf(walletAddr);

      this.log(`[INVENTORY] ═══ COLLATERAL CHECK ═══`, "info");
      this.log(`[INVENTORY] ${collateralSym} balance=${ethers.formatUnits(balance, collateralDecimals)}`, "info");
      this.log(`[INVENTORY] ${collateralSym} required=${ethers.formatUnits(collateralAmount, collateralDecimals)} (position open)`, "info");
      this.log(`[INVENTORY] ${collateralSym} targetReserve=${ethers.formatUnits(targetReserve, collateralDecimals)} (inventory target)`, "info");

      if (collateralAmount <= 0n) {
        this.log(`[BLOCKED] Invalid collateral target`, "error");
        return;
      }

      // Calculate inventory deficit using the new method
      const deficit = calculateInventoryDeficit({
        balance,
        required: collateralAmount,
        targetReserve,
        decimals: collateralDecimals,
        sym: collateralSym,
        log: this.log.bind(this),
      });

      if (deficit.action === "none") {
        // Sufficient — no swap needed, proceed to OPEN
        this.log(`[INVENTORY] RESERVE OK — ${collateralSym} ${ethers.formatUnits(balance, collateralDecimals)} >= target ${ethers.formatUnits(targetReserve, collateralDecimals)}`, "success");
      } else {
        // SWAP needed — critical deficit OR top-up to target
        this.setState(STATES.SWAP);
        this.log(`[SWAP] ${deficit.reason}`, "warn");
        this.log(`[SWAP] searching inventory for source tokens...`, "warn");

        // Select swap source from discovered routes (direct or multi-hop)
        const sources = swapSourcesFor(collateralToken, side, this.tokenList);
        let swapSuccess = false;

        for (const sourceToken of sources) {
          const sourceContract = new ethers.Contract(sourceToken, ERC20_ABI, provider);
          const sourceBalance = await sourceContract.balanceOf(walletAddr);
          let sourceDecimals, sourceSym;
          try {
            const meta = await tokenMetaOnChain(provider, sourceToken);
            sourceDecimals = meta.decimals;
            sourceSym = meta.symbol;
          } catch {
            this.log(`[SWAP] source ${short(sourceToken)} meta failed — skip`, "warn");
            continue;
          }

          if (sourceBalance <= 0n) {
            this.log(`[SWAP] ${sourceSym} balance=0 — skip`, "info");
            continue;
          }

          this.log(`[SWAP] ${sourceSym} balance=${ethers.formatUnits(sourceBalance, sourceDecimals)} — trying ${sourceSym} → ${collateralSym}`, "info");

          try {
            const route = findRoute(this.routes, sourceToken, collateralToken);
            const path = route ? route.path : [sourceToken, collateralToken];
            if (this.routes.length && !route) {
              this.log(`[SWAP] ${sourceSym} → ${collateralSym}: no validated route — skip`, "warn");
              continue;
            }
            const router = new ethers.Contract(getRouterAddress(), ROUTER_ABI, provider);
            const fullQuote = await router.getAmountsOut(sourceBalance, path);
            const expectedOut = fullQuote[fullQuote.length - 1];

            if (expectedOut < deficit.swapAmount) {
              this.log(`[SWAP] ${sourceSym} insufficient: max output ${ethers.formatUnits(expectedOut, collateralDecimals)} < needed ${ethers.formatUnits(deficit.swapAmount, collateralDecimals)}`, "warn");
              continue;
            }

            // Calculate exact swap amount — don't swap more than needed
            const neededWithBuffer = deficit.swapAmount * 101n / 100n; // 1% buffer for slippage
            let swapAmount = neededWithBuffer * sourceBalance / expectedOut;
            if (swapAmount > sourceBalance) swapAmount = sourceBalance;
            const amountOutMin = deficit.swapAmount * 98n / 100n; // 2% slippage protection

            this.log(`[SWAP] quote: ${ethers.formatUnits(swapAmount, sourceDecimals)} ${sourceSym} → ~${ethers.formatUnits(expectedOut * swapAmount / sourceBalance, collateralDecimals)} ${collateralSym}`, "info");
            this.log(`[SWAP] amountOutMin=${ethers.formatUnits(amountOutMin, collateralDecimals)} ${collateralSym}`, "info");

            if (dryRun) {
              this.log(`[DRY] Would swap ${ethers.formatUnits(swapAmount, sourceDecimals)} ${sourceSym} → ${collateralSym}`, "info");
              swapSuccess = true;
              break;
            }

            // Execute swap — wait for receipt before proceeding
            const swapResult = await executeSwap({
              wallet, provider, fromToken: sourceToken, toToken: collateralToken,
              amount: swapAmount, amountOutMin, config: this.config,
              log: this.log.bind(this), txManager: this.txManager, path,
            });

            if (!swapResult) {
              this.log(`[SWAP] ${sourceSym} → ${collateralSym} FAILED — trying next source`, "error");
              continue;
            }

            // Verify balance after swap
            const newBalance = await tokenContract.balanceOf(walletAddr);
            this.log(`[SWAP] ${collateralSym} balance_after=${ethers.formatUnits(newBalance, collateralDecimals)} (target=${ethers.formatUnits(targetReserve, collateralDecimals)})`, "info");

            if (newBalance >= collateralAmount) {
              this.log(`[SWAP] CONFIRMED — ${collateralSym} sufficient after swap`, "success");
              swapSuccess = true;
              break;
            } else {
              this.log(`[SWAP] ${collateralSym} still below required after swap: ${ethers.formatUnits(newBalance, collateralDecimals)} < ${ethers.formatUnits(collateralAmount, collateralDecimals)}`, "warn");
            }
          } catch (e) {
            this.log(`[SWAP] ${sourceSym} → ${collateralSym} failed: ${e.message?.slice(0, 80)}`, "error");
            continue;
          }
        }

        if (!swapSuccess && !dryRun) {
          this.log(`[BLOCKED] No source token could cover ${collateralSym} deficit — skipping cycle`, "error");
          return;
        }

        // Final verification before OPEN
        const finalBalance = await tokenContract.balanceOf(walletAddr);
        if (finalBalance < collateralAmount) {
          this.log(`[BLOCKED] ${collateralSym} still insufficient after all swaps: ${ethers.formatUnits(finalBalance, collateralDecimals)} < ${ethers.formatUnits(collateralAmount, collateralDecimals)}`, "error");
          return;
        }
        this.log(`[INVENTORY] POST-SWAP ${collateralSym}=${ethers.formatUnits(finalBalance, collateralDecimals)} — ready for OPEN`, "success");
      }

      // PHASE 4: OPEN — try market candidates in order, record rotation + direction health
      this.setState(STATES.OPEN);
      this.log(`[OPEN] ${side} ${this.config.defaultLeverage}x...`, "warn");

      let openResult = null;
      let openedMarket = null;
      for (const candidate of marketCandidates) {
        this.log(`[OPEN] trying market ${candidate.symbol} manager=${short(candidate.managerAddr)}`, "info");
        const attempt = await openPosition({
          wallet, provider, managerAddr: candidate.managerAddr, poolAddr: candidate.poolAddr,
          side, collateralToken, collateralAmount,
          leverage: this.config.defaultLeverage,
          config: this.config, log: this.log.bind(this), dryRun, txManager: this.txManager,
          paymentToken: candidate.paymentToken,
        });
        openResult = attempt;
        if (attempt) {
          openedMarket = candidate;
          break;
        }
        this._recordDirectionFailure(candidate.symbol, side);
        this.log(`[OPEN] market ${candidate.symbol} failed — trying next candidate`, "warn");
      }
      const marketUsed = openedMarket || market;

      if (openResult?.dryRun) {
        this.log(`[DRY] Open would execute on ${marketUsed.symbol}`, "info");
        this.state.lastSide = side;
        this.rotation.recordMarketSide(marketUsed.symbol, side);
        this.state.rotation = this.rotation.toJSON();
        saveState(this.state);
      } else if (openResult) {
        this._recordDirectionSuccess(marketUsed.symbol, side);
        this.rotation.recordMarketSide(marketUsed.symbol, side);
        this.state.rotation = this.rotation.toJSON();
        this.state.activePosition = {
          positionId: openResult.positionId,
          side,
          collateralToken,
          collateralAmount: collateralAmount.toString(),
          leverage: this.config.defaultLeverage,
          openedAt: Date.now(),
          txHash: openResult.txHash,
          marketSymbol: marketUsed.symbol,
          managerAddr: marketUsed.managerAddr,
          poolAddr: marketUsed.poolAddr,
        };
        this.state.lastSide = side;
        this.state.sessionStats.opens++;
        saveState(this.state);

        this.setState(STATES.MONITOR);
        this.log(`[MONITOR] position #${openResult.positionId} (${side} ${marketUsed.symbol})`, "success");

        this.log(`[COOLDOWN] ${this.config.cooldownAfterOpenMs / 1000}s...`, "info");
        await this.sleep(this.config.cooldownAfterOpenMs);
      } else {
        this.log(`[BLOCKED] Open failed on all candidate markets — skipping cycle`, "error");
      }

      this.lastCycleAction = openResult ? "open" : "idle";
      this.log("[CYCLE] ═══ CYCLE END ═══", "info");
    } catch (e) {
      this.log(`[ERROR] Cycle error: ${e.message?.slice(0, 80)}`, "error");
      this.txManager.resetNonce();
    } finally {
      this.cycleRunning = false;
    }
  }

  async start() {
    if (this.running) { this.log("[AUTO] Already running.", "warn"); return; }
    this.running = true;
    this.stopRequested = false;

    try {
      this.log("══════════════════════════════════════════════", "warn");
      this.log("  CONTINUOUS AUTO TRADING STARTED", "warn");
      this.log(`  Leverage: ${this.config.defaultLeverage}x`, "info");
      this.log(`  Dry run: ${this.config.dryRun}`, "info");
      this.log("══════════════════════════════════════════════", "warn");

      // Recovery — scan EVERY discovered manager (all active markets)
      try {
        this.log("[RECOVERY] scanning on-chain...", "info");
        const { provider } = this.getRuntime();
        const walletAddr = this.deps.accounts[this.deps.selectedWalletIndex].address;
        await this.ensureMarkets({ force: true });
        const discoveredMgrs = this.markets.map(m => m.managerAddr).filter(Boolean);
        const managers = [...new Set([
          ...discoveredMgrs,
          this.state.activePosition?.managerAddr,
          ...Object.values(this.deps.confirmedPools || {}).map(p => p?.manager),
        ].filter(Boolean))];
        this.log(`[RECOVERY] ${managers.length} manager(s) to scan`, "info");
        let recovered = null;
        for (const mgr of managers) {
          recovered = await recoverPosition(provider, walletAddr, mgr, this.log.bind(this));
          if (recovered) {
            recovered.managerAddr = mgr;
            const mk = this.markets.find(m => m.managerAddr?.toLowerCase() === mgr.toLowerCase());
            if (mk) {
              recovered.marketSymbol = mk.marketSymbol || mk.symbol;
              recovered.poolAddr = mk.poolAddr;
            } else {
              const sym = Object.entries(this.deps.confirmedPools || {})
                .find(([, p]) => p?.manager?.toLowerCase() === mgr.toLowerCase())?.[0];
              if (sym) {
                recovered.marketSymbol = sym;
                recovered.poolAddr = this.deps.confirmedPools?.[sym]?.pool;
              }
            }
            break;
          }
        }
        if (recovered) {
          this.log(`[RECOVERED] position #${recovered.positionId} side=${recovered.side} market=${recovered.marketSymbol || "?"}`, "warn");
          this.state.activePosition = recovered;
          this.state.sessionStats.opens++;
          saveState(this.state);
        } else if (this.state.activePosition) {
          this.log(`[WARN] Local state had position but on-chain says none — clearing`, "warn");
          this.state.activePosition = null;
          saveState(this.state);
        }
      } catch (re) {
        this.log(`[RECOVERY] failed: ${re.message?.slice(0, 60)}`, "error");
      }

      // CONTINUOUS RUNNER — never stops
      while (!this.stopRequested) {
        try {
          // STEP 1: Random token-to-token swaps across ALL discovered routes
          if (!this.stopRequested) {
            await this.doRandomSwaps();
          }

          // STEP 2: Open position if none active — rotation picks MARKET×SIDE
          if (!this.state.activePosition && !this.stopRequested) {
            const planned = await this.nextMarketSide();
            const side = planned?.side || this.nextSide();
            this.log(`[AUTO] NEXT ACTION: OPEN ${side}${planned ? ` on ${planned.marketSymbol || planned.symbol}` : ""}`, "info");
            this.setState(STATES.OPEN);
            await this.prepareAndOpen(side);
          }

          // STEP 3: Brief wait after open
          if (!this.stopRequested) {
            await this.sleep(this.randomDelay(3000, 5000));
          }

          // STEP 4: Close position if active
          if (this.state.activePosition && !this.stopRequested) {
            this.log(`[AUTO] NEXT ACTION: CLOSE position #${this.state.activePosition.positionId}`, "info");
            await this.closeActivePosition();
          }

          // STEP 5: Brief wait after close
          if (!this.stopRequested) {
            await this.sleep(this.randomDelay(3000, 5000));
          }

        } catch (e) {
          this.log(`[ERROR] Loop iteration: ${e.message?.slice(0, 80)}`, "error");
          this.txManager.resetNonce();
          await this.sleep(5000);
        }
      }
    } catch (fatal) {
      this.log(`[FATAL] ${fatal.message?.slice(0, 80)}`, "error");
    } finally {
      this.running = false;
      this.log("[AUTO] Trading loop stopped.", "warn");
    }
  }

  stop() {
    this.stopRequested = true;
    this.log("[AUTO] Stop requested.", "warn");
  }

  randomDelay(minMs, maxMs) {
    return minMs + Math.floor(Math.random() * (maxMs - minMs));
  }

  nextSide() {
    return this.state.lastSide === "LONG" ? "SHORT" : "LONG";
  }

  async doRandomSwaps() {
    const autoSwapConfig = this.config.autoSwap || {};
    if (!autoSwapConfig.enabled) return;

    await this.ensureMarkets();
    const { provider, wallet } = this.getRuntime();
    const walletAddr = wallet.address;
    const dryRun = this.config.dryRun;

    // Dynamic token map from discovery (on-chain decimals)
    const tokenAddrs = {};
    const decimalsMap = {};
    for (const t of (this.tokenList.length ? this.tokenList : Object.entries(getAllTokens()).map(([symbol, address]) => ({ symbol, address, decimals: TOKEN_DECIMALS[symbol] ?? null })))) {
      tokenAddrs[t.symbol] = t.address;
      decimalsMap[t.symbol] = t.decimals;
    }

    const swapCount = 1 + Math.floor(Math.random() * 2);
    this.log(`[AUTO] SWAPPING — ${swapCount} random swap(s) (${this.routes.length} routes)`, "info");

    for (let i = 0; i < swapCount; i++) {
      if (this.stopRequested) break;

      try {
        const freshBalances = {};
        for (const [sym, addr] of Object.entries(tokenAddrs)) {
          try {
            let dec = decimalsMap[sym];
            if (dec === null || dec === undefined) dec = await tokenDecimalsOnChain(provider, addr);
            decimalsMap[sym] = dec;
            const c = new ethers.Contract(addr, ERC20_ABI, provider);
            const bal = await c.balanceOf(walletAddr);
            freshBalances[sym] = { raw: bal, float: parseFloat(ethers.formatUnits(bal, dec)) };
          } catch { freshBalances[sym] = { raw: 0n, float: 0 }; }
        }

        const pair = selectRandomSwapPair(this.swapJournal, freshBalances, autoSwapConfig, tokenAddrs, this.log.bind(this), this.routes, this.rotation);
        if (!pair) {
          this.log(`[AUTO-SWAP] No valid pair`, "info");
          break;
        }

        const fromBal = freshBalances[pair.from];
        if (!fromBal || fromBal.float <= 0) continue;

        const amountResult = calculateRandomSwapAmount(pair.from, fromBal.float, autoSwapConfig, decimalsMap[pair.from]);
        if (!amountResult) continue;

        const decimals = decimalsMap[pair.from] ?? TOKEN_DECIMALS[pair.from] ?? 6;
        const amountRaw = ethers.parseUnits(amountResult.amountFloat.toFixed(decimals), decimals);

        if (amountRaw > fromBal.raw * 90n / 100n) continue;
        if (amountRaw > fromBal.raw) continue;

        const route = findRoute(this.routes, pair.fromAddr, pair.toAddr);
        const path = route ? route.path : [pair.fromAddr, pair.toAddr];

        const router = new ethers.Contract(getRouterAddress(), ROUTER_ABI, provider);
        const quote = await router.getAmountsOut(amountRaw, path);
        const expectedOut = quote[quote.length - 1];
        const toDecimals = decimalsMap[pair.to] ?? TOKEN_DECIMALS[pair.to] ?? 6;
        const amountOutMin = applySlippage(expectedOut, BigInt(autoSwapConfig.slippageBps || 50));

        this.log(`[AUTO] SWAPPING ${pair.from} → ${pair.to} [${ethers.formatUnits(amountRaw, decimals)}] hops=${route?.type || "direct"}`, "warn");

        if (dryRun) {
          this.log(`[DRY] Would swap ${amountResult.amountFloat.toFixed(4)} ${pair.from} → ${pair.to}`, "info");
          this.swapJournal.record({ from: pair.from, to: pair.to, amount: amountResult.amountFloat });
          this.rotation.recordSwapPair(pair.from, pair.to);
          this.state.rotation = this.rotation.toJSON();
          saveState(this.state);
          continue;
        }

        const swapResult = await executeSwap({
          wallet, provider,
          fromToken: pair.fromAddr, toToken: pair.toAddr,
          amount: amountRaw, amountOutMin,
          config: this.config, log: this.log.bind(this), txManager: this.txManager, path,
        });

        if (swapResult) {
          this.swapJournal.record({ from: pair.from, to: pair.to, amount: amountResult.amountFloat });
          this.rotation.recordSwapPair(pair.from, pair.to);
          this.state.rotation = this.rotation.toJSON();
          saveState(this.state);
          this.log(`[SWAP] SUCCESS ${pair.from}→${pair.to}`, "success");
        } else {
          this.log(`[SWAP] FAILED ${pair.from}→${pair.to}`, "error");
        }

        if (i < swapCount - 1) {
          await this.sleep(this.randomDelay(5000, 15000));
        }
      } catch (e) {
        this.log(`[AUTO-SWAP] Error: ${e.message?.slice(0, 60)}`, "error");
        this.txManager.resetNonce();
      }
    }
  }

  async closeActivePosition() {
    if (!this.state.activePosition) return false;

    const { provider, wallet } = this.getRuntime();
    const managerAddr = this.state.activePosition?.managerAddr || this.getManagerAddr();
    const dryRun = this.config.dryRun;

    this.setState(STATES.CLOSE);
    this.log(`[AUTO] CLOSING position #${this.state.activePosition.positionId} (${this.state.activePosition.side}) manager=${short(managerAddr)}`, "warn");

    const closeResult = await closePositionFn({
      wallet, provider, managerAddr,
      positionId: this.state.activePosition.positionId,
      config: this.config, log: this.log.bind(this), dryRun, txManager: this.txManager,
    });

    if (closeResult?.failed) {
      this.log(`[CLOSE] Position gone — clearing state`, "warn");
      this.state.activePosition = null;
      this.state.sessionStats.closes++;
      saveState(this.state);
      return true;
    } else if (closeResult) {
      this.log(`[CLOSE] SUCCESS — TX: ${closeResult.txHash || "dry-run"}`, "success");
      this.state.activePosition = null;
      this.state.sessionStats.closes++;
      saveState(this.state);
      return true;
    } else {
      this.log(`[CLOSE] Failed — will retry`, "error");
      return false;
    }
  }

  async prepareAndOpen(side) {
    const { provider, wallet } = this.getRuntime();
    const walletAddr = wallet.address;
    const dryRun = this.config.dryRun;

    await this.ensureMarkets();
    const marketCandidates = await this.planMarketsForSide(side, {
      max: Number(this.config.maxMarketAttemptsPerCycle || 3),
    });
    if (!marketCandidates.length) {
      this.log(`[BLOCKED] No active market supports ${side}`, "error");
      return false;
    }
    const market = marketCandidates[0];
    this.log(`[MARKET] ${market.symbol} manager=${short(market.managerAddr)} coll=${market.collateralSym || "?"} (candidates: ${marketCandidates.map(m => m.symbol).join(", ")})`, "info");

    const collateralToken = market.collateralToken;
    if (!collateralToken) {
      this.log(`[BLOCKED] Market ${market.symbol} has no collateral token for ${side}`, "error");
      return false;
    }
    // decimals/symbol ALWAYS from token contract
    const collateralDecimals = market.decimals ?? await tokenDecimalsOnChain(provider, collateralToken);
    const collateralSym = market.collateralSym ?? await tokenSymbolOnChain(provider, collateralToken);

    const targetStr = collateralTargetStr(this.config, collateralToken);
    const collateralAmount = ethers.parseUnits(targetStr, collateralDecimals);

    const reserveStr = reserveTargetStr(this.config, collateralToken);
    const targetReserve = ethers.parseUnits(reserveStr, collateralDecimals);

    this.log(`[AUTO] OPENING ${side} ${this.config.defaultLeverage}x — collateral: ${collateralSym}`, "warn");

    // Check collateral
    const tokenContract = new ethers.Contract(collateralToken, ERC20_ABI, provider);
    const balance = await tokenContract.balanceOf(walletAddr);

    if (collateralAmount <= 0n) {
      this.log(`[BLOCKED] Invalid collateral`, "error");
      return false;
    }

    const deficit = calculateInventoryDeficit({
      balance, required: collateralAmount, targetReserve,
      decimals: collateralDecimals, sym: collateralSym,
      log: this.log.bind(this),
    });

    if (deficit.action !== "none") {
      this.log(`[AUTO] SWAPPING for ${collateralSym} collateral`, "warn");
      const sources = swapSourcesFor(collateralToken, side, this.tokenList);
      let swapSuccess = false;

      for (const sourceToken of sources) {
        try {
          const sourceContract = new ethers.Contract(sourceToken, ERC20_ABI, provider);
          const sourceBalance = await sourceContract.balanceOf(walletAddr);
          const srcMeta = await tokenMetaOnChain(provider, sourceToken);
          const sourceDecimals = srcMeta.decimals;
          const sourceSym = srcMeta.symbol;

          if (sourceBalance <= 0n) {
            this.log(`[SWAP] ${sourceSym} balance=0 — skip`, "info");
            continue;
          }

          this.log(`[SWAP] ${sourceSym} → ${collateralSym}: balance=${ethers.formatUnits(sourceBalance, sourceDecimals)}`, "info");

          const route = findRoute(this.routes, sourceToken, collateralToken);
          const path = route ? route.path : [sourceToken, collateralToken];
          if (this.routes.length && !route) {
            this.log(`[SWAP] ${sourceSym} → ${collateralSym}: no validated route — skip`, "warn");
            continue;
          }
          const router = new ethers.Contract(getRouterAddress(), ROUTER_ABI, provider);
          const fullQuote = await router.getAmountsOut(sourceBalance, path);
          const expectedOut = fullQuote[fullQuote.length - 1];

          if (expectedOut < deficit.swapAmount) {
            this.log(`[SWAP] ${sourceSym} insufficient: max output < needed`, "warn");
            continue;
          }

          const neededWithBuffer = deficit.swapAmount * 101n / 100n;
          let swapAmount = neededWithBuffer * sourceBalance / expectedOut;
          if (swapAmount > sourceBalance) swapAmount = sourceBalance;
          const amountOutMin = deficit.swapAmount * 98n / 100n;

          this.log(`[AUTO] SWAPPING ${sourceSym} → ${collateralSym}`, "warn");

          if (dryRun) {
            this.log(`[DRY] Would swap ${sourceSym} → ${collateralSym}`, "info");
            swapSuccess = true;
            break;
          }

          const swapResult = await executeSwap({
            wallet, provider, fromToken: sourceToken, toToken: collateralToken,
            amount: swapAmount, amountOutMin, config: this.config,
            log: this.log.bind(this), txManager: this.txManager, path,
          });

          if (swapResult) {
            const newBalance = await tokenContract.balanceOf(walletAddr);
            this.log(`[SWAP] ${collateralSym} balance_after=${ethers.formatUnits(newBalance, collateralDecimals)}`, "info");
            if (newBalance >= collateralAmount) {
              swapSuccess = true;
              break;
            }
          }
        } catch (e) {
          this.log(`[SWAP] source failed: ${e.message?.slice(0, 60)}`, "error");
          this.txManager.resetNonce();
          continue;
        }
      }

      // Last resort: ETH → WETH wrap when collateral is WETH
      if (!swapSuccess && !dryRun && collateralToken.toLowerCase() === WETH.toLowerCase()) {
        try {
          const currentWethBal = await new ethers.Contract(WETH, ERC20_ABI, provider).balanceOf(walletAddr);
          const remainingDeficit = collateralAmount > currentWethBal ? collateralAmount - currentWethBal : 0n;
          if (remainingDeficit > 0n) {
            const ethBalance = await provider.getBalance(walletAddr);
            const gasReserve = ethers.parseEther(String(this.config.ethGuard?.MIN_ETH_GAS_RESERVE ?? 0.003));
            const ethAvail = ethBalance - gasReserve - ethers.parseEther("0.005");
            const wrapAmount = remainingDeficit > ethAvail ? ethAvail : remainingDeficit;
            if (wrapAmount > ethers.parseEther("0.0001")) {
              this.log(`[AUTO] SWAPPING ETH → WETH (wrap ${ethers.formatEther(wrapAmount)})`, "warn");
              const wethContract = new ethers.Contract(WETH, ["function deposit() payable", "function balanceOf(address) view returns (uint256)"], wallet);
              const feeParams = await getFeeParams(provider);
              const r = await this.txManager.sendAndWait({
                wallet, provider, txType: "WETH-WRAP",
                sendFn: (nonce) => wethContract.deposit({ value: wrapAmount, gasLimit: 100000n, ...feeParams, nonce }),
                log: this.log.bind(this),
              });
              if (r && r.status === 1) {
                const wethBal = await new ethers.Contract(WETH, ERC20_ABI, provider).balanceOf(walletAddr);
                if (wethBal >= collateralAmount) swapSuccess = true;
              }
            }
          }
        } catch (e) {
          this.log(`[SWAP] ETH→WETH wrap failed: ${e.message?.slice(0, 60)}`, "error");
        }
      }

      if (!swapSuccess && !dryRun) {
        this.log(`[BLOCKED] No source for ${collateralSym}`, "error");
        return false;
      }
    }

    // Open position — try market candidates in order
    this.setState(STATES.OPEN);
    let openResult = null;
    let openedMarket = null;
    for (const candidate of marketCandidates) {
      this.log(`[OPEN] trying market ${candidate.symbol} manager=${short(candidate.managerAddr)}`, "info");
      const attempt = await openPosition({
        wallet, provider, managerAddr: candidate.managerAddr, poolAddr: candidate.poolAddr,
        side, collateralToken, collateralAmount,
        leverage: this.config.defaultLeverage,
        config: this.config, log: this.log.bind(this), dryRun, txManager: this.txManager,
        paymentToken: candidate.paymentToken,
      });
      openResult = attempt;
      if (attempt) {
        openedMarket = candidate;
        break;
      }
      this._recordDirectionFailure(candidate.symbol, side);
      this.log(`[OPEN] market ${candidate.symbol} failed — trying next candidate`, "warn");
    }
    const marketUsed = openedMarket || market;

    if (openResult?.dryRun) {
      this.log(`[DRY] Open ${side} would execute on ${marketUsed.symbol}`, "info");
      this.state.lastSide = side;
      this.rotation.recordMarketSide(marketUsed.symbol, side);
      this.state.rotation = this.rotation.toJSON();
      saveState(this.state);
      return true;
    } else if (openResult) {
      this._recordDirectionSuccess(marketUsed.symbol, side);
      this.rotation.recordMarketSide(marketUsed.symbol, side);
      this.state.rotation = this.rotation.toJSON();
      this.state.activePosition = {
        positionId: openResult.positionId,
        side, collateralToken,
        collateralAmount: collateralAmount.toString(),
        leverage: this.config.defaultLeverage,
        openedAt: Date.now(),
        txHash: openResult.txHash,
        marketSymbol: marketUsed.symbol,
        managerAddr: marketUsed.managerAddr,
        poolAddr: marketUsed.poolAddr,
      };
      this.state.lastSide = side;
      this.state.sessionStats.opens++;
      saveState(this.state);
      this.log(`[OPEN] SUCCESS — position #${openResult.positionId} (${side} ${marketUsed.symbol})`, "success");
      return true;
    } else {
      this.log(`[BLOCKED] Open failed on all candidate markets`, "error");
      return false;
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export { STATES, DEFAULT_AUTO_CONFIG, openPosition, closePositionFn, resolveTradingMarket, encodeOpenPositionCalldata, TxManager };
export default AutoTrader;
