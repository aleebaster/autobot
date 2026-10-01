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
  isDirectionEntryDisabled,
  marketKey,
  normalizeSymbolKey,
  enumerateMarketSides,
  formatMarketsTable,
  formatCoverageTable,
} from "./marketDiscovery.js";
import { discoverTokens, discoverSwapRoutes, quoteBestPath, routeCandidates, sourcesForTarget, formatRoutesTable } from "./swapRoutes.js";
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

// On-chain custom error selectors — computed from the DEPLOYED source (never
// guessed): MAMActionBase.sol / IMarginAccountManger.sol. They are used to
// classify read-only close previews so a liquidity-blocked close is retried with
// a partial close instead of clearing state.
const ERR_INSUFFICIENT_LIQUIDITY = "0xf71ff020"; // MAM_InsufficientLiquidity()
const ERR_CLOSE_AMOUNT_TOO_SMALL = "0x01556191"; // MAM_CloseAmountTooSmall()
const ERR_INVALID_CLOSE_BPS      = "0xa782ca90"; // MAM_InvalidCloseBps()
const ERR_INVALID_POSITION       = "0xa5732d32"; // MAM_InvalidPosition()
// partialClose() rejects closeBps == 10000 (MAM_InvalidCloseBps) — a full close
// only ever happens through closePosition().
const MAX_PARTIAL_CLOSE_BPS = 9999n;
const BPS_DENOM = 10000n;

const CLOSE_VIEW_ABI = [
  "function previewClosePosition(uint256 positionId, uint256 closeBps) view returns (tuple(uint256 repayAmount, uint256 collateralReduced, uint256 collateralReturned, uint256 protocolFee, uint256 costBasisReduced, int256 realizedPnl, uint256 closePrice, uint256 projectedHealthBps))",
  "function positions(uint256) view returns (bool isLong, address user, address collateralToken, uint256 collateralAmount, uint256 debtAmount, uint256 currentDebt, bool active)",
];
const CLOSE_WRITE_ABI = [
  "function closePosition(uint256 positionId, uint256 amountOutMin, uint256 deadline)",
  "function partialClose(uint256 positionId, uint256 closeBps, uint256 amountOutMin, uint256 deadline)",
];

/**
 * Extract the 4-byte custom-error selector from an ethers revert. Handles both
 * the raw-string and the `{data}`-object shapes ethers v6 produces.
 */
function revertSelector(e) {
  const grab = (v) => {
    if (typeof v === "string" && v.startsWith("0x") && v.length >= 10) return v.slice(0, 10);
    if (v && typeof v === "object" && typeof v.data === "string" && v.data.startsWith("0x")) return v.data.slice(0, 10);
    return "";
  };
  const direct = grab(e?.data) || grab(e?.info?.error?.data) || grab(e?.cause?.data) || grab(e?.cause?.info?.error?.data);
  if (direct) return direct;
  const m = (e?.shortMessage || e?.message || "").match(/0x[0-9a-fA-F]{8}/);
  return m ? m[0].toLowerCase() : "";
}

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
  // Exact rational form (no intermediate truncation):
  //   value(token1 units) = reserve0*oraclePrice0/q112 + reserve1
  //   lp                  = collateralValue * totalSupply / poolValue
  // Written as a single BigInt expression so a small collateral can never floor to 0
  // in a partial product while the true LP value is still >= 1.
  const denominator = reserve0 * oraclePrice0 + reserve1 * q112;
  if (denominator === 0n) return 0n;
  const collateralIsToken0 = collateralToken.toLowerCase() === token0.toLowerCase();
  return collateralIsToken0
    ? collateralAmount * oraclePrice0 * totalSupply / denominator
    : collateralAmount * totalSupply * q112 / denominator;
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

// ═══════════════════════════════════════════════════════════════════════════
//  SHORT COLLATERAL SIZING — configured target ∩ measured pool minimum ∩ cap
//  Read-only: view calls + pure BigInt maths. Never builds or sends a TX.
// ═══════════════════════════════════════════════════════════════════════════

/** One batch of view calls — every input the quote maths needs for one pool. */
async function readPoolQuoteState(provider, { pool, manager }) {
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
  return {
    reserve0: BigInt(reserves[0]),
    reserve1: BigInt(reserves[1]),
    totalSupply: BigInt(totalSupply),
    token0: String(token0),
    oraclePrice0: BigInt(oraclePrice[0]),
    swapFeeBps: BigInt(swapFeeBps),
    availableLiquidity: BigInt(availableLiquidity),
    ltvBps: BigInt(ltvBps),
    protocolFeeBps: BigInt(protocolFeeBps),
  };
}

/**
 * The EXACT quote chain (feeAdjusted → collateralAsLp → LTV/liquidity caps →
 * lpBorrowToExpectedOut → applySlippage) evaluated on an already-read state.
 * Same functions, same order, same 2% slippage as quoteLeveragedAmountOutMin(),
 * so a size measured here cannot disagree with the precheck that follows it.
 *
 * @returns {{ok:true, borrowAmount:bigint, amountOutMin:bigint} | {ok:false, code:string, borrowAmount:bigint, amountOutMin:bigint}}
 */
function evaluateQuoteOnState(state, { collateralToken, collateralAmount, leverageX10 }) {
  const lev = Number(leverageX10) / 10;
  if (!Number.isFinite(lev) || lev <= 1) {
    return { ok: false, code: "INVALID_LEVERAGE", borrowAmount: 0n, amountOutMin: 0n };
  }
  const noLiquidity = state.reserve0 === 0n || state.reserve1 === 0n || state.totalSupply === 0n || state.oraclePrice0 === 0n;
  const effectiveCollateral = feeAdjusted(collateralAmount, state.protocolFeeBps);
  const collateralLp = collateralAsLp({
    collateralToken, collateralAmount: effectiveCollateral,
    reserve0: state.reserve0, reserve1: state.reserve1, totalSupply: state.totalSupply,
    token0: state.token0, oraclePrice0: state.oraclePrice0,
  });
  if (collateralLp === 0n) {
    return { ok: false, code: noLiquidity ? "ZERO_LP" : "QUOTE_ZERO", borrowAmount: 0n, amountOutMin: 0n };
  }
  let lpBorrowAmount = collateralLp * BigInt(Math.floor(10000 * Math.max(0, lev - 1))) / BPS;
  const maxByLtv = state.ltvBps >= BPS ? lpBorrowAmount : collateralLp * state.ltvBps / (BPS - state.ltvBps);
  if (lpBorrowAmount > maxByLtv) lpBorrowAmount = maxByLtv;
  if (lpBorrowAmount > state.availableLiquidity) lpBorrowAmount = state.availableLiquidity;
  const amountOutMinRaw = lpBorrowToExpectedOut({
    lpBorrowAmount, collateralToken,
    reserve0: state.reserve0, reserve1: state.reserve1, totalSupply: state.totalSupply,
    token0: state.token0, swapFeeBps: state.swapFeeBps,
  });
  const amountOutMinFinal = applySlippage(amountOutMinRaw, 200n);
  if (lpBorrowAmount === 0n || amountOutMinRaw <= 0n || amountOutMinFinal <= 0n) {
    return { ok: false, code: "ZERO_AMOUNT_OUT_MIN", borrowAmount: lpBorrowAmount, amountOutMin: amountOutMinFinal };
  }
  return { ok: true, borrowAmount: lpBorrowAmount, amountOutMin: amountOutMinFinal };
}

const POOL_MIN_SEARCH_MAX_STEPS = 512;
const POOL_MIN_SEARCH_HARD_MAX = 10n ** 60n;

/**
 * Smallest raw collateral amount ONE pool can quote at all.
 *
 * Doubling ladder + binary refinement over evaluateQuoteOnState() — pure BigInt
 * maths on a single state snapshot, so the whole search costs one batch of view
 * calls. The dust window of a pool spans many octaves, so the ladder lands inside
 * it; if it somehow does not, we return POOL_MIN_NOT_FOUND and the caller falls
 * back to the configured target (never an inflated amount).
 *
 * @returns {Promise<{amount: bigint|null, code: string|null, state: object}>}
 */
async function measureMinCollateralForPool(provider, { pool, manager, collateralToken, leverageX10 }) {
  let state;
  try {
    state = await readPoolQuoteState(provider, { pool, manager });
  } catch (e) {
    return { amount: null, code: "POOL_STATE_READ_ERROR", state: null, error: e?.message || String(e) };
  }
  const ev = (amount) => evaluateQuoteOnState(state, { collateralToken, collateralAmount: amount, leverageX10 });
  let steps = 0;
  let lastBad = 0n;
  let found = null;
  for (let x = 1n; x <= POOL_MIN_SEARCH_HARD_MAX; x *= 2n) {
    if (++steps > POOL_MIN_SEARCH_MAX_STEPS) break;
    if (ev(x).ok) { found = x; break; }
    lastBad = x;
  }
  if (found === null) return { amount: null, code: "POOL_MIN_NOT_FOUND", state };
  let lo = lastBad + 1n;
  let hi = found;
  while (lo < hi) {
    if (++steps > POOL_MIN_SEARCH_MAX_STEPS) break;
    const mid = (lo + hi) / 2n;
    if (mid < lo) break;
    if (ev(mid).ok) hi = mid;
    else lo = mid + 1n;
  }
  return { amount: lo, code: null, state };
}

/**
 * SHORT-only collateral sizing.
 *
 *   collateralAmount = max(configuredTarget, measuredPoolMinimum)
 *   collateralAmount <= cap  (config.maxCollateralTargetShort, same decimals)
 *
 * A pool whose measured minimum sits above the cap is NEVER inflated — it is
 * rejected with the machine-readable code POOL_MIN_EXCEEDS_CAP so the caller
 * skips that candidate. LONG never calls this function.
 *
 * Measurement failures do not inflate either: `fallbackToConfigured` tells the
 * caller to keep the configured target and let the unchanged precheck report
 * QUOTE_ZERO / ZERO_AMOUNT_OUT_MIN for it.
 *
 * @returns {Promise<{ok:true, amount:bigint, configured:bigint, poolMin:bigint, cap:bigint} |
 *                   {ok:false, code:string, reason:string, poolMin:bigint|null, cap:bigint|null, configured:bigint, fallbackToConfigured?:boolean}>}
 */
export async function resolveShortCollateralAmount(provider, { pool, manager, collateralToken, configuredRaw, capRaw, leverageX10 }) {
  const input = { pool, manager, collateralToken, configuredRaw, capRaw };
  for (const [k, v] of Object.entries(input)) {
    if (v === null || v === undefined || v === "") {
      return { ok: false, code: "SIZING_INPUT_MISSING", reason: `SIZING_INPUT_MISSING: ${k} required for SHORT sizing`, poolMin: null, cap: null, configured: configuredRaw ?? 0n };
    }
  }
  if (!(configuredRaw > 0n)) {
    return { ok: false, code: "INVALID_COLLATERAL_TARGET", reason: `INVALID_COLLATERAL_TARGET: configured=${configuredRaw}`, poolMin: null, cap: capRaw, configured: configuredRaw };
  }
  if (!(capRaw > 0n)) {
    return { ok: false, code: "INVALID_COLLATERAL_CAP", reason: `INVALID_COLLATERAL_CAP: maxCollateralTargetShort=${capRaw}`, poolMin: null, cap: capRaw, configured: configuredRaw };
  }

  const measured = await measureMinCollateralForPool(provider, { pool, manager, collateralToken, leverageX10 });
  if (measured.amount === null) {
    return {
      ok: false, code: measured.code || "POOL_MIN_NOT_FOUND",
      reason: `${measured.code || "POOL_MIN_NOT_FOUND"}: could not measure pool minimum for pool=${pool}`,
      poolMin: null, cap: capRaw, configured: configuredRaw, fallbackToConfigured: true,
    };
  }

  const poolMin = measured.amount;
  if (poolMin > capRaw) {
    return {
      ok: false, code: "POOL_MIN_EXCEEDS_CAP",
      reason: `POOL_MIN_EXCEEDS_CAP: poolMinimum=${poolMin} > maxCollateralTargetShort=${capRaw} (configured=${configuredRaw})`,
      poolMin, cap: capRaw, configured: configuredRaw,
    };
  }

  const amount = poolMin > configuredRaw ? poolMin : configuredRaw;
  if (amount > capRaw) {
    return {
      ok: false, code: "COLLATERAL_EXCEEDS_CAP",
      reason: `COLLATERAL_EXCEEDS_CAP: configured=${configuredRaw} > maxCollateralTargetShort=${capRaw}`,
      poolMin, cap: capRaw, configured: configuredRaw,
    };
  }
  return { ok: true, amount, configured: configuredRaw, poolMin, cap: capRaw };
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
  // SHORT-only ceiling, in THIS candidate's collateral token decimals.
  // SHORT sizing = max(configuredTarget, measuredPoolMinimum), but never above this:
  // a pool whose minimum is higher is SKIPPED (never inflated) with POOL_MIN_EXCEEDS_CAP.
  maxCollateralTargetShort: "10000",
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
  // How many partialClose TXs a single close attempt may send before giving up
  // (the position is then KEPT in state — never cleared).
  maxPartialCloseAttempts: 3,
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

/**
 * Normalise the persisted direction kill-switch map WITHOUT losing data.
 *
 * Backward compatibility: an older auto-trader-state.json stores soft counters as
 * `{ fails: 1 }` (and hard disables as `{ since, reason }`). Those soft counters used
 * to be read as "truthy ⇒ disabled", which locked every MARKET×SIDE after one failure.
 * Here each entry keeps all of its fields and gains an explicit `disabled` boolean;
 * only an explicit hard-disable hides a direction.
 *
 * @returns {Object} normalised map (also assigned onto state.directionDisabled)
 */
function normalizeDirectionDisabled(state) {
  if (!state || typeof state !== "object") return {};
  const src = state.directionDisabled;
  if (!src || typeof src !== "object") {
    state.directionDisabled = {};
    return state.directionDisabled;
  }
  const out = {};
  for (const [key, entry] of Object.entries(src)) {
    if (entry === null || entry === undefined) continue;
    if (entry === true) {
      out[key] = { disabled: true, since: null, reason: "legacy boolean entry", fails: 0 };
      continue;
    }
    if (typeof entry !== "object") continue;
    const disabled = entry.disabled === true || (entry.since !== undefined && entry.since !== null);
    const fails = Number.isFinite(Number(entry.fails)) ? Number(entry.fails) : 0;
    out[key] = { ...entry, disabled, fails, since: entry.since ?? null };
  }
  state.directionDisabled = out;
  return out;
}

function loadState() {
  let state = null;
  try {
    if (fs.existsSync(STATE_FILE)) state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {}
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    state = { activePosition: null, sessionStats: { opens: 0, closes: 0 }, lastCycleTime: 0, lastSide: null };
  }
  if (!state.sessionStats) state.sessionStats = { opens: 0, closes: 0 };
  normalizeDirectionDisabled(state);
  return state;
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
    // On-chain truth for side/collateral: positions(positionId) — NEVER hardcoded
    // (was: side:"LONG", collateralToken: USDT).
    let pos = null;
    try {
      const mgr = new ethers.Contract(managerAddr, [
        "function positions(uint256) view returns (bool isLong, address user, address collateralToken, uint256 collateralAmount, uint256 debtAmount, uint256 currentDebt)"
      ], provider);
      pos = await mgr.positions(positionId);
    } catch (e) {
      log(`[RECOVERY] AMBIGUITY: cannot read position #${positionId} on-chain (${e.message?.slice(0, 40)}) — refusing to guess side/collateral`, "warn");
      return null;
    }
    if (!pos || pos.user === undefined) {
      log(`[RECOVERY] AMBIGUITY: position #${positionId} returned no on-chain data — refusing to guess side/collateral`, "warn");
      return null;
    }
    // Check for zombie position (zeroed collateral/debt on-chain)
    if (pos.collateralAmount === 0n && pos.currentDebt === 0n) {
      log(`[RECOVERY] position #${positionId} is zombie (zero collateral+debt) — clearing`, "warn");
      return null;
    }
    if (pos.collateralAmount === 0n && pos.currentDebt > 0n) {
      log(`[RECOVERY] position #${positionId} is zombie (zero collateral, debt=${pos.currentDebt}) — clearing`, "warn");
      return null;
    }
    if (!pos.collateralToken || pos.collateralToken === ethers.ZeroAddress) {
      log(`[RECOVERY] AMBIGUITY: position #${positionId} has no collateral token on-chain — refusing to guess`, "warn");
      return null;
    }
    const recoveredSide = pos.isLong ? "LONG" : "SHORT";
    log(`[RECOVERY] found active position #${positionId} (chain: ${recoveredSide}, collateral=${short(pos.collateralToken)}, amount=${ethers.formatUnits(pos.collateralAmount, 18)} raw=${pos.collateralAmount})`, "warn");
    return {
      positionId,
      side: recoveredSide,
      collateralToken: pos.collateralToken,
      collateralAmount: pos.collateralAmount.toString(),
      currentDebt: pos.currentDebt?.toString?.() ?? String(pos.currentDebt ?? 0),
      openedAt: lastOpen.blockNumber,
      managerAddr,
    };
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

  if (collateralLp === 0n) {
    // Distinguish "market temporarily unquotable" from a fatal bot error (P4):
    //   ZERO_LP   — the pool itself has no usable liquidity
    //   QUOTE_ZERO — liquidity exists but this collateral size truncates to 0 LP
    const noLiquidity = reserve0 === 0n || reserve1 === 0n || totalSupply === 0n || BigInt(oraclePrice[0]) === 0n;
    const err = new Error(noLiquidity
      ? "ZERO_LP: pool has no usable liquidity (reserves/totalSupply/oracle=0)"
      : "QUOTE_ZERO: collateral size converts to 0 LP for this pool");
    err.code = noLiquidity ? "ZERO_LP" : "QUOTE_ZERO";
    throw err;
  }

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
  if (amountOutMinRaw <= 0n || amountOutMinFinal <= 0n) {
    const err = new Error("ZERO_AMOUNT_OUT_MIN: borrow LP yields 0 amountOut after integer math (dust liquidity)");
    err.code = "ZERO_AMOUNT_OUT_MIN";
    throw err;
  }

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

/**
 * READ-ONLY viability check for one MARKET×SIDE candidate (eth_call-style reads only:
 * getReserves / totalSupply / token0 / getOraclePrice / swapFeeBps / manager views).
 *
 * Returns { ok:true, borrowAmount, amountOutMin } or { ok:false, reason }.
 *
 * Used BEFORE the open flow so a candidate whose minimum collateral size is dust for
 * the pool's liquidity (zero LP / zero amountOutMin) is SKIPPED with a clear reason
 * instead of being counted as a direction failure — a liquidity skip must never
 * disable a MARKET×SIDE. No transaction is built or sent here.
 */
export async function precheckMarketQuote(provider, { pool, manager, collateralToken, collateralAmount, leverageX10, isLong, log = () => {} }) {
  try {
    const q = await quoteLeveragedAmountOutMin(provider, {
      pool, manager, collateralToken, collateralAmount, leverageX10, isLong, log,
    });
    if (!q || q.borrowAmount <= 0n) {
      return { ok: false, code: "QUOTE_ZERO", reason: "borrowAmount is zero for minimum collateral size" };
    }
    if (q.amountOutMinFinal <= 0n) {
      return { ok: false, code: "ZERO_AMOUNT_OUT_MIN", reason: "zero amountOutMin for minimum collateral size" };
    }
    return { ok: true, borrowAmount: q.borrowAmount, amountOutMin: q.amountOutMinFinal };
  } catch (e) {
    // QUOTE_ZERO / ZERO_LP / ZERO_AMOUNT_OUT_MIN = "market temporarily unquotable"
    // (skip the candidate); anything else is reported as a real quote error.
    const code = e?.code || (/zero/i.test(String(e?.message || "")) ? "QUOTE_ZERO" : "QUOTE_ERROR");
    return { ok: false, code, reason: e?.message || String(e) };
  }
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

    // P6: validated direct (or read-only probed direct) → validated 2-hop → SKIP.
    // No invented paths, never a quote of 0.
    const best = await quoteBestPath({
      provider, routerAddress: routerAddr, routes: activeRoutes,
      fromAddr: sourceToken, toAddr: collateralToken, amountIn: sourceBalance, log,
    });
    if (!best) {
      log(`[SWAP] ${sourceSym} → ${sym}: no viable route (direct/2-hop quote zero) — skip`, "warn");
      continue;
    }
    const path = best.path;

    try {
      const expectedOut = best.amountOut;
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
  let approveTxHash = null;
  if (allowance < amount) {
    log(`[SWAP] Approve ${fromSym} → Router...`, "info");
    if (txManager) {
      const r = await txManager.sendAndWait({
        wallet, provider, txType: "SWAP-APPROVE",
        sendFn: (nonce) => fromContract.approve(routerAddr, ethers.MaxUint256, { gasLimit: 100000n, nonce }),
        log,
      });
      if (r.status === 0) { log(`[SWAP] Approve REVERTED`, "error"); return false; }
      approveTxHash = r.hash || null;
    } else {
      const approveTx = await fromContract.approve(routerAddr, ethers.MaxUint256, { gasLimit: 100000n });
      approveTxHash = approveTx.hash;
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
    if (r.pending) { log(`[SWAP] TX pending — will confirm later`, "warn"); return { ok: true, pending: true, txHash: r.hash || null, approveTxHash }; }
    log(`[SWAP] SUCCESS gas=${r.receipt.gasUsed}`, "success");
    return { ok: true, txHash: r.hash, blockNumber: r.receipt?.blockNumber ?? null, approveTxHash, path };
  } else {
    log(`[SWAP] TX_SENT`, "warn");
    const swapTx = await router.swapExactTokensForTokens(amount, amountOutMin, path, walletAddr, deadline, { gasLimit });
    log(`[SWAP] TX hash=${swapTx.hash}`, "info");
    const receipt = await swapTx.wait();
    if (receipt.status !== 1) { log(`[SWAP] TX FAILED (status=0)`, "error"); return false; }
    log(`[SWAP] SUCCESS gas=${receipt.gasUsed}`, "success");
    return { ok: true, txHash: swapTx.hash, blockNumber: receipt.blockNumber, approveTxHash, path };
  }
}

/**
 * POST-SWAP ON-CHAIN VERIFICATION (read-only).
 *
 * A mined TX only proves the router was called; the wallet's balances prove the
 * swap actually moved value in the requested direction. Works identically for
 * A→B and B→A — nothing here is direction-specific.
 *
 * @returns {Promise<{ok:boolean, inDelta:bigint, outDelta:bigint}>}
 */
async function verifySwapBalances({ provider, walletAddr, pair, beforeFrom, beforeTo, amountIn, amountOutMin, log = () => {} }) {
  const afterFrom = await new ethers.Contract(pair.fromAddr, ERC20_ABI, provider).balanceOf(walletAddr);
  const afterTo = await new ethers.Contract(pair.toAddr, ERC20_ABI, provider).balanceOf(walletAddr);
  const inDelta = beforeFrom - afterFrom;
  const outDelta = afterTo - beforeTo;
  const minOk = amountOutMin === null || amountOutMin === undefined ? true : outDelta >= amountOutMin;
  const ok = inDelta > 0n && outDelta > 0n && minOk;
  log(
    `[VERIFY-SWAP] ${pair.from}→${pair.to} inDelta=${inDelta} (amountIn=${amountIn}) outDelta=${outDelta} (amountOutMin=${amountOutMin}) => ${ok ? "PASS" : "FAIL"}`,
    ok ? "success" : "error",
  );
  return { ok, inDelta, outDelta, afterFrom, afterTo };
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
  // Read-only mode must never send a TX: checkpointOracle() is a real transaction,
  // so it is skipped entirely when dryRun is on (the quote below still runs).
  if (dryRun) {
    log(`[DRY] skipping oracle checkpoint TX (read-only mode)`, "info");
  } else {
    try {
      await ensureOracleReady(wallet, poolAddr, side, provider, log, txManager);
    } catch (e) {
      log(`[BLOCKED] Oracle checkpoint failed: ${e.message?.slice(0, 80)}`, "error");
      return null;
    }
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

  // POST-OPEN ON-CHAIN VERIFICATION (read-only): the receipt says the TX mined,
  // but only `positions(positionId)` proves WHO opened WHAT, with WHICH collateral.
  const verify = await verifyOpenedPosition(provider, managerAddr, positionId, walletAddr, {
    side, collateralToken, collateralAmount, log,
  });
  if (!verify.ok) {
    log(`[VERIFY] OPEN #${positionId} MISMATCH — ${verify.reason} (position stays tracked so it can be closed)`, "error");
  }

  return { txHash, positionId, gasUsed: receipt.gasUsed, blockNumber: receipt.blockNumber, verify };
}

/**
 * Read-only post-OPEN proof: `positions(positionId)` on the manager that actually
 * executed the TX. Checks owner, direction, collateral token and collateral size
 * against what THIS open requested — never against a hardcoded market.
 */
async function verifyOpenedPosition(provider, managerAddr, positionId, walletAddr, { side, collateralToken, collateralAmount, log = () => {} }) {
  let pos = null;
  try {
    const mgr = new ethers.Contract(managerAddr, CLOSE_VIEW_ABI, provider);
    pos = await mgr.positions(positionId);
  } catch (e) {
    return { ok: false, reason: `cannot read positions(${positionId}) (${e.message?.slice(0, 60)})`, pos: null };
  }
  if (!pos) return { ok: false, reason: `positions(${positionId}) returned nothing`, pos: null };

  const eq = (a, b) => String(a || "").toLowerCase() === String(b || "").toLowerCase();
  const expectLong = side === "LONG";
  const checks = [
    ["owner", eq(pos.user, walletAddr), `${pos.user}`],
    ["isLong", pos.isLong === expectLong, `${pos.isLong} (expected ${expectLong})`],
    ["collateralToken", eq(pos.collateralToken, collateralToken), `${pos.collateralToken}`],
    ["active", pos.active === true, `${pos.active}`],
    ["collateralAmount>0", pos.collateralAmount > 0n, `${pos.collateralAmount}`],
  ];
  const failed = checks.filter(([, ok]) => !ok);
  // Size is reported but a 0-difference is not required for the position to be
  // usable — the token/owner/direction checks are the hard ones.
  const sizeMatch = pos.collateralAmount === BigInt(collateralAmount ?? -1n);

  log(`[VERIFY] OPEN #${positionId} on-chain: isLong=${pos.isLong} user=${short(pos.user)} coll=${short(pos.collateralToken)} amount=${pos.collateralAmount} expected=${collateralAmount} active=${pos.active} sizeMatch=${sizeMatch}`, failed.length ? "error" : "success");
  for (const [name, ok, got] of failed) log(`[VERIFY] OPEN #${positionId} check ${name} FAILED: got ${got}`, "error");

  return {
    ok: failed.length === 0,
    sizeMatch,
    pos: {
      isLong: pos.isLong, user: pos.user, collateralToken: pos.collateralToken,
      collateralAmount: pos.collateralAmount, debtAmount: pos.debtAmount,
      currentDebt: pos.currentDebt, active: pos.active,
    },
    reason: failed.length ? `failed checks: ${failed.map(([n]) => n).join(",")}` : null,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
//  CLOSE POSITION — full close first, then read-only closeBps search + partialClose
// ═══════════════════════════════════════════════════════════════════════════

/** Read-only `positions(positionId)` snapshot; null when unreadable. */
async function readOnChainPosition(provider, managerAddr, positionId) {
  try {
    const mgr = new ethers.Contract(managerAddr, CLOSE_VIEW_ABI, provider);
    const p = await mgr.positions(positionId);
    return {
      isLong: p.isLong, user: p.user, collateralToken: p.collateralToken,
      collateralAmount: p.collateralAmount, debtAmount: p.debtAmount,
      currentDebt: p.currentDebt, active: p.active,
    };
  } catch (e) {
    return null;
  }
}

/** True only when the manager itself says the position is no longer active. */
function positionIsClosed(pos) {
  return !!pos && pos.active === false;
}

/** Read-only `previewClosePosition(positionId, closeBps)`. Never sends a TX. */
async function previewCloseAt(provider, managerAddr, positionId, bps) {
  try {
    const mgr = new ethers.Contract(managerAddr, CLOSE_VIEW_ABI, provider);
    const r = await mgr.previewClosePosition(positionId, bps);
    return { ok: true, quote: r };
  } catch (e) {
    return { ok: false, err: revertSelector(e) };
  }
}

/**
 * Largest `closeBps` that `previewClosePosition` accepts — pure view calls.
 *
 * The predicate is NOT globally monotone: too small a close reverts with
 * MAM_CloseAmountTooSmall / MAM_InsufficientLiquidity, the middle band passes,
 * and too large a close reverts with MAM_InsufficientLiquidity again
 * (`_getAmountOut` is integer-quantised inside `_simulateAddLiquidity`), so a
 * single binary search would land outside the window. Strategy: descending
 * ladder to bracket a passing seed with the failing sample directly above it,
 * then binary refinement inside that bracket, then a final verifying view call.
 *
 * @returns {Promise<{ok:true, closeBps:bigint, quote:object, probes:number} |
 *                    {ok:false, code:string, probes:number}>}
 */
async function findMaxCloseBps(provider, managerAddr, positionId, { log = () => {}, maxProbes = 48 } = {}) {
  const LADDER = [
    9999n, 9750n, 9500n, 9250n, 9000n, 8750n, 8500n, 8000n, 7500n, 7000n,
    6000n, 5000n, 4000n, 3000n, 2000n, 1500n, 1000n, 750n, 500n, 250n, 100n,
    50n, 20n, 10n, 5n, 2n, 1n,
  ];
  let probes = 0;
  const probe = async (bps) => {
    if (probes >= maxProbes) return { ok: false, err: "PROBE_LIMIT" };
    probes++;
    return previewCloseAt(provider, managerAddr, positionId, bps);
  };

  let seed = null;
  let upperFail = null; // first (higher) ladder sample that failed
  let lastErr = null;
  for (const bps of LADDER) {
    const r = await probe(bps);
    if (r.ok) { seed = bps; break; }
    lastErr = r.err;
    if (r.err === "PROBE_LIMIT") return { ok: false, code: "PROBE_LIMIT", probes };
    upperFail = bps;
  }
  if (seed === null) {
    return { ok: false, code: lastErr === ERR_CLOSE_AMOUNT_TOO_SMALL ? "CLOSE_AMOUNT_TOO_SMALL" : "CLOSE_BPS_NOT_FOUND", probes, lastErr };
  }

  // Bracket: lo passes, hi (if any) fails — refine to the highest passing bps.
  let lo = seed;
  let hi = upperFail; // null when even 9999 passes
  while (hi !== null && lo + 1n < hi) {
    if (probes >= maxProbes) break;
    const mid = (lo + hi + 1n) / 2n;
    const r = await probe(mid);
    if (r.ok) lo = mid; else hi = mid;
  }

  const final = await probe(lo);
  if (!final.ok) return { ok: false, code: "CLOSE_BPS_VERIFY_FAILED", probes, lastErr: final.err };

  log(`[CLOSE] closeBps window: seed=${seed} upperFail=${upperFail ?? "n/a"} → chosen=${lo} (probes=${probes})`, "info");
  return { ok: true, closeBps: lo, quote: final.quote, probes };
}

/**
 * Fallback for a full close blocked by MAM_InsufficientLiquidity:
 * read-only search for the maximum feasible closeBps, then partialClose().
 *
 * Never guesses a closeBps, never sends amountOutMin=0, and never clears state —
 * a position that is still active afterwards is reported as such so the caller
 * keeps tracking it. Rounds are capped by config.maxPartialCloseAttempts.
 */
async function attemptPartialClose({ wallet, provider, managerAddr, positionId, config, log, txManager }) {
  const walletAddr = wallet.address;
  const maxRounds = Math.max(1, Number(config.maxPartialCloseAttempts || 3));
  const slippageBps = BigInt(config.slippageBps || 50);
  const iface = new ethers.Interface(CLOSE_WRITE_ABI);
  let last = null;

  for (let round = 1; round <= maxRounds; round++) {
    const before = await readOnChainPosition(provider, managerAddr, positionId);
    if (!before) {
      log(`[CLOSE] positions(${positionId}) unreadable — cannot verify, keeping state`, "error");
      return { failed: true, clearState: false, code: "POSITION_UNREADABLE", reason: `positions(${positionId}) unreadable` };
    }
    if (positionIsClosed(before)) {
      log(`[VERIFY] position #${positionId} already closed on-chain`, "success");
      return { ok: true, closed: true, partial: true, rounds: round - 1, verified: true, onChain: before };
    }

    log(`[CLOSE] round ${round}/${maxRounds} #${positionId}: collateral=${before.collateralAmount} debt=${before.currentDebt} — searching closeBps (read-only)`, "warn");
    const found = await findMaxCloseBps(provider, managerAddr, positionId, { log });
    if (!found.ok) {
      log(`[BLOCKED] closeBps search failed (${found.code}) — keeping state, NOT clearing`, "error");
      return { failed: true, clearState: false, code: found.code, reason: `closeBps search failed: ${found.code}` };
    }

    const closeBps = found.closeBps;
    const quote = found.quote;
    const amountOut = quote.collateralReturned;
    const amountOutMin = (amountOut * (BPS_DENOM - slippageBps)) / BPS_DENOM;
    if (!(amountOutMin > 0n)) {
      log(`[BLOCKED] partial close quote returned zero collateral (amountOutMin=0) — keeping state`, "error");
      return { failed: true, clearState: false, code: "ZERO_AMOUNT_OUT_MIN", reason: "partial close quote returned zero collateral" };
    }

    log(`[CLOSE] partialClose closeBps=${closeBps} amountOut=${amountOut} amountOutMin=${amountOutMin} repay=${quote.repayAmount} fee=${quote.protocolFee} realizedPnl=${quote.realizedPnl} (probes=${found.probes})`, "info");

    const deadline = Math.floor(Date.now() / 1000) + config.deadlineSeconds;
    const calldata = iface.encodeFunctionData("partialClose", [positionId, closeBps, amountOutMin, BigInt(deadline)]);

    // Selector sanity: partialClose(uint256,uint256,uint256,uint256) = 0xdc439ba7
    if (calldata.slice(0, 10) !== "0xdc439ba7") {
      log(`[BLOCKED] unexpected partialClose selector ${calldata.slice(0, 10)} — refusing to send`, "error");
      return { failed: true, clearState: false, code: "BAD_PARTIAL_SELECTOR", reason: calldata.slice(0, 10) };
    }

    try {
      await provider.call({ from: walletAddr, to: managerAddr, data: calldata, value: 0n });
      log(`[CLOSE] partialClose pre-flight OK`, "info");
    } catch (e) {
      const sel = revertSelector(e);
      log(`[BLOCKED] partialClose pre-flight REVERTED ${sel || e.message?.slice(0, 60)} — keeping state`, "error");
      return { failed: true, clearState: false, code: `PARTIAL_PREFLIGHT_${sel || "UNKNOWN"}`, reason: `partialClose pre-flight revert ${sel}` };
    }

    let gasEstimate;
    try {
      gasEstimate = await provider.estimateGas({ from: walletAddr, to: managerAddr, data: calldata, value: 0n });
    } catch (e) {
      log(`[BLOCKED] partialClose gas estimation FAILED`, "error");
      return null;
    }

    const gasLimit = gasEstimate + gasEstimate / 5n;
    let txHash, receipt;
    if (txManager) {
      const r = await txManager.sendAndWait({
        wallet, provider, txType: "PARTIAL-CLOSE",
        sendFn: (nonce) => wallet.sendTransaction({ to: managerAddr, data: calldata, value: 0n, gasLimit, nonce }),
        log,
      });
      if (!r || r.status === 0) { log(`[BLOCKED] partialClose TX FAILED`, "error"); return null; }
      if (r.pending) {
        log(`[CLOSE] partialClose TX pending — will confirm later`, "warn");
        return { txHash: r.hash, gasUsed: 0n, blockNumber: null, pending: true, partial: true, closeBps, clearState: false };
      }
      txHash = r.hash;
      receipt = r.receipt;
    } else {
      log(`[CLOSE] Sending partialClose(closeBps=${closeBps}) TX...`, "warn");
      const tx = await wallet.sendTransaction({ to: managerAddr, data: calldata, value: 0n, gasLimit });
      txHash = tx.hash;
      log(`[CLOSE] TX: ${tx.hash}`, "info");
      receipt = await tx.wait();
      if (receipt.status !== 1) { log(`[BLOCKED] partialClose TX FAILED (status=0)`, "error"); return null; }
    }

    last = { round, closeBps, amountOut, amountOutMin, txHash };
    log(`[CLOSE] partialClose round ${round} SUCCESS gas=${receipt.gasUsed} tx=${txHash}`, "success");

    const after = await readOnChainPosition(provider, managerAddr, positionId);
    if (!after) {
      log(`[CLOSE] post-TX positions(${positionId}) unreadable — keeping state`, "error");
      return { failed: true, clearState: false, code: "VERIFY_READ_FAILED", txHash, partial: true, reason: "post-close read failed" };
    }
    if (positionIsClosed(after)) {
      log(`[VERIFY] position #${positionId} CLOSED on-chain after ${round} partial close(s)`, "success");
      return {
        ok: true, closed: true, partial: true, rounds: round, verified: true,
        txHash, gasUsed: receipt.gasUsed, blockNumber: receipt.blockNumber,
        closeBps, amountOut, onChain: after,
      };
    }
    log(`[VERIFY] position #${positionId} STILL ACTIVE after partial close: collateral=${after.collateralAmount} debt=${after.currentDebt} (round ${round}/${maxRounds})`, "warn");
    last.residual = { collateralAmount: String(after.collateralAmount), currentDebt: String(after.currentDebt) };
  }

  log(`[BLOCKED] position #${positionId} still active after ${maxRounds} partial close round(s) — keeping state (NOT clearing)`, "error");
  return {
    failed: true, clearState: false, code: "PARTIAL_CLOSE_LIMIT", partial: true,
    reason: `position still active after ${maxRounds} partial close round(s)`, last,
  };
}

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
    const sel = revertSelector(e);
    // MAM_InvalidPosition (0xa5732d32) — the position really does not exist
    if (sel === ERR_INVALID_POSITION) {
      log(`[CLOSE] MAM_InvalidPosition — zombie position detected, clearing state`, "warn");
      return { failed: true, clearState: true, reason: "zombie" };
    }
    // MAM_InsufficientLiquidity (0xf71ff020) — position EXISTS, it is just not
    // fully closable right now. Never clear state: search a feasible closeBps
    // read-only and fall back to partialClose.
    if (sel === ERR_INSUFFICIENT_LIQUIDITY) {
      log(`[CLOSE] MAM_InsufficientLiquidity on full close — read-only closeBps search + partialClose fallback`, "warn");
      return attemptPartialClose({ wallet, provider, managerAddr, positionId, config, log, txManager });
    }
    log(`[BLOCKED] Close pre-flight REVERTED ${sel || e.message?.slice(0, 60)} — position KEPT (not clearing state)`, "error");
    return { failed: true, clearState: false, code: `CLOSE_PREFLIGHT_${sel || "UNKNOWN"}`, reason: `pre-flight revert ${sel || e.message?.slice(0, 40)}` };
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
      return { txHash: r.hash, gasUsed: 0n, blockNumber: null, pending: true, clearState: false };
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

  // POST-CLOSE ON-CHAIN VERIFICATION — a mined TX is not proof of a closed
  // position; only positions(positionId).active === false is.
  const after = await readOnChainPosition(provider, managerAddr, positionId);
  if (!after) {
    log(`[VERIFY] post-close positions(${positionId}) unreadable — keeping state, will re-verify`, "error");
    return { failed: true, clearState: false, code: "VERIFY_READ_FAILED", txHash, gasUsed: receipt.gasUsed, blockNumber: receipt.blockNumber, reason: "post-close read failed" };
  }
  if (!positionIsClosed(after)) {
    log(`[VERIFY] CLOSE TX mined but position #${positionId} STILL ACTIVE (collateral=${after.collateralAmount} debt=${after.currentDebt}) — keeping state`, "error");
    return { failed: true, clearState: false, closed: false, code: "STILL_ACTIVE", txHash, gasUsed: receipt.gasUsed, blockNumber: receipt.blockNumber, onChain: after, reason: "position still active after close TX" };
  }
  log(`[VERIFY] position #${positionId} CLOSED on-chain (active=false) gas=${receipt.gasUsed}`, "success");
  return {
    ok: true, closed: true, verified: true, onChain: after,
    txHash, gasUsed: receipt.gasUsed, blockNumber: receipt.blockNumber,
  };
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
    // MARKET×SIDE runtime kill-switch:
    //   { "SYMBOL|SIDE": { fails: n, disabled: false } }  → soft counter, still selectable
    //   { "SYMBOL|SIDE": { disabled: true, since, reason } } → hard-disabled
    this.directionDisabled = normalizeDirectionDisabled(this.state);
    // Enforce the threshold on load too (soft counters below it stay selectable).
    const maxFailsOnLoad = Number(this.config.maxDirectionFailures || 2);
    for (const entry of Object.values(this.directionDisabled)) {
      if (entry && typeof entry === "object" && entry.disabled !== true && Number(entry.fails || 0) >= maxFailsOnLoad) {
        entry.disabled = true;
        entry.since = entry.since ?? Date.now();
        entry.reason = entry.reason || `${entry.fails} consecutive preflight/open failures`;
      }
    }
    this.state.directionDisabled = this.directionDisabled;
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
    if (isDirectionEntryDisabled(this.directionDisabled[this._directionKey(marketSymbol, side)])) return true;
    const m = this.markets.find(x => (x.marketSymbol || x.symbol) === marketSymbol);
    return m ? !supportsSide(m, side) : false;
  }

  _disableDirection(marketSymbol, side, reason = "") {
    const key = this._directionKey(marketSymbol, side);
    const prev = this.directionDisabled[key];
    if (isDirectionEntryDisabled(prev)) return;
    // An expired hard-disable must be re-armed with a FRESH `since`, otherwise the
    // stale timestamp keeps it expired and the kill-switch can never fire again.
    const expiredHard = prev && typeof prev === "object" && (prev.disabled === true || prev.since != null);
    this.directionDisabled[key] = {
      ...(prev && typeof prev === "object" && !expiredHard ? prev : {}),
      disabled: true,
      since: Date.now(),
      reason: reason || "",
    };
    this.state.directionDisabled = this.directionDisabled;
    saveState(this.state);
    this.log(`[DISCOVERY] DISABLED ${key} — ${reason}`, "warn");
  }

  /**
   * Soft failure counter. Reaching maxDirectionFailures is what disables a direction —
   * a counter below the threshold keeps the direction fully selectable.
   */
  _recordDirectionFailure(marketSymbol, side) {
    const key = this._directionKey(marketSymbol, side);
    const prev = this.directionDisabled[key];
    if (isDirectionEntryDisabled(prev)) return;

    // Expired hard-disable → start a fresh attempt window instead of inheriting
    // the old counter/`since` (which would keep the entry expired forever).
    const expiredHard = prev && typeof prev === "object" && (prev.disabled === true || prev.since != null);
    const entry = expiredHard ? {} : { ...(prev && typeof prev === "object" ? prev : {}), disabled: false };
    entry.fails = Number(entry.fails || 0) + 1;
    const maxFails = Number(this.config.maxDirectionFailures || 2);

    if (entry.fails >= maxFails) {
      entry.disabled = true;
      entry.since = Date.now();
      entry.reason = `${entry.fails} consecutive preflight/open failures`;
      this.log(`[DISCOVERY] DISABLED ${key} — ${entry.reason}`, "warn");
    } else {
      entry.disabled = false;
      entry.since = null;
      this.log(`[DISCOVERY] direction ${key} failure ${entry.fails}/${maxFails} — still selectable`, "warn");
    }

    this.directionDisabled[key] = entry;
    this.state.directionDisabled = this.directionDisabled;
    saveState(this.state);
  }

  /** Success (confirmed OPEN) resets the counter and clears any hard-disable. */
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
   *
   * SHORT candidates are pre-filtered by the SAME sizing rule `_candidateContext`
   * applies (pool minimum <= maxCollateralTargetShort). A candidate that would
   * deterministically return null there is dead on arrival, so it is dropped here
   * WITHOUT consuming one of the `max` open attempts. Previously the LRU pick could
   * hand back 3 consecutive unusable pools and the cycle ended with
   * `[BLOCKED] Open failed on all candidate markets` even though other eligible
   * SHORT markets could quote. Measurement is read-only (one batched view call per
   * probe) and never inflates, never approves, never sends.
   */
  async planMarketsForSide(side, { max = 3 } = {}) {
    await this.ensureMarkets();
    const out = [];
    let exclude = [];
    if (side !== "SHORT") {
      for (let i = 0; i < max; i++) {
        const m = this.resolveMarket(side, { excludeSymbols: exclude });
        if (!m) break;
        out.push(m);
        exclude.push(m.symbol);
      }
      return out;
    }

    const { provider } = this.getRuntime();
    const hardProbes = Math.max(Number(max) * 8, 40);
    let probes = 0;
    while (out.length < max) {
      const m = this.resolveMarket(side, { excludeSymbols: exclude });
      if (!m) break;
      exclude.push(m.symbol);
      if (++probes > hardProbes) { out.push(m); continue; }
      if (await this._shortSizingViable(m, provider)) { out.push(m); continue; }
      this.log(`[PLAN] ${m.symbol} SHORT dropped before attempts — pool minimum exceeds maxCollateralTargetShort (measured read-only)`, "info");
    }
    return out;
  }

  /**
   * Read-only SHORT sizing gate. Returns true when `_candidateContext()` would be
   * able to build a context for this candidate (ok, or measurement failure which
   * falls back to the configured target). Only a hard `POOL_MIN_EXCEEDS_CAP` /
   * `COLLATERAL_EXCEEDS_CAP` is rejected. Any error ⇒ true (never block on a probe).
   */
  async _shortSizingViable(candidate, provider) {
    try {
      const poolAddr = candidate?.poolAddr || null;
      const managerAddr = candidate?.managerAddr || null;
      const collateralToken = candidate?.collateralToken || null;
      const decimals = candidate?.decimals;
      if (!poolAddr || !managerAddr || !collateralToken || !Number.isFinite(Number(decimals)) || Number(decimals) <= 0) return true;
      const capStr = String(this.config.maxCollateralTargetShort || DEFAULT_AUTO_CONFIG.maxCollateralTargetShort);
      let capRaw, configuredRaw;
      try {
        capRaw = ethers.parseUnits(capStr, decimals);
        configuredRaw = ethers.parseUnits(collateralTargetStr(this.config, collateralToken), decimals);
      } catch { return true; }
      if (!(capRaw > 0n) || !(configuredRaw > 0n)) return true;
      const s = await resolveShortCollateralAmount(provider, {
        pool: poolAddr, manager: managerAddr, collateralToken,
        configuredRaw, capRaw,
        leverageX10: BigInt(Math.round(Number(this.config.defaultLeverage || 2) * 10)),
      });
      return s.ok || !!s.fallbackToConfigured;
    } catch {
      return true;
    }
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
    // P8: last-resort default (market-agnostic). Loudly visible — never use it to
    // target/close a specific position.
    const fallbackManager = this.deps.confirmedPools?.["NEMESIS/USDT"]?.manager || null;
    if (fallbackManager) {
      this.log(`[FALLBACK] manager from confirmedPools["NEMESIS/USDT"]=${short(fallbackManager)} — NOT market-specific, verify before any action`, "warn");
    }
    return fallbackManager;
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
    // P8: last-resort default (market-agnostic) — loudly visible on purpose.
    const fallbackPool = this.deps.confirmedPools?.["NEMESIS/USDT"]?.pool || null;
    if (fallbackPool) {
      this.log(`[FALLBACK] pool from confirmedPools["NEMESIS/USDT"]=${short(fallbackPool)} — NOT market-specific, verify before any action`, "warn");
    }
    return fallbackPool;
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
      // NOTE: no cycle-level default manager/pool is carried into CLOSE/OPEN —
      // every target is resolved per position/candidate (P2/P7).

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

        // Dynamic token map: discovered tokens (on-chain decimals) ∪ deployment tokens.
        // P8 precedence: deployment fallback starts as null so the on-chain read wins;
        // TOKEN_DECIMALS is only used (with a warning) if the RPC read fails.
        const tokenAddrs = {};
        const tokenDecimalsMap = {};
        for (const t of (this.tokenList.length ? this.tokenList : Object.entries(getAllTokens()).map(([symbol, address]) => ({ symbol, address, decimals: null })))) {
          tokenAddrs[t.symbol] = t.address;
          tokenDecimalsMap[t.symbol] = t.decimals;
        }

        this.log(`[AUTO-SWAP] Phase started (max ${maxSwaps} swaps per cycle, ${this.routes.length} routes)`, "info");

        // Refresh inventory for auto-swap decisions
        const inventoryTokenMap = {};
        for (const [sym, addr] of Object.entries(tokenAddrs)) {
          inventoryTokenMap[sym] = { address: addr, decimals: this._decimalsPrecedence(sym, tokenDecimalsMap) };
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

            const fromDecimals = this._decimalsPrecedence(pair.from, tokenDecimalsMap);
            const amountResult = calculateRandomSwapAmount(pair.from, fromBal.float, autoSwapConfig, fromDecimals, this.log.bind(this));
            if (!amountResult) {
              this.log(`[AUTO-SWAP] Amount too small for ${pair.from} — skip`, "info");
              continue;
            }

            // Convert float amount to raw BigInt (same decimals source as the balance read)
            const decimals = amountResult.decimals ?? fromDecimals;
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

            // P6: validated routes only — direct first, then bounded validated 2-hop.
            // Never invent a path, never swap with amountOut = 0.
            const best = await quoteBestPath({
              provider, routerAddress: getRouterAddress(), routes: this.routes,
              fromAddr: pair.fromAddr, toAddr: pair.toAddr, amountIn: amountRaw,
              log: this.log.bind(this),
            });
            if (!best) {
              this.log(`[AUTO-SWAP] ${pair.from} → ${pair.to}: no viable route (direct/2-hop quote zero) — skipping pair`, "warn");
              continue;
            }
            const path = best.path;
            const expectedOut = best.amountOut;
            const toDecimals = this._decimalsPrecedence(pair.to, tokenDecimalsMap);
            // Read-only guard: a zero-output quote would produce amountOutMin=0 and a
            // guaranteed-loss (or reverting) swap — skip this pair, try another one.
            if (expectedOut <= 0n) {
              this.log(`[AUTO-SWAP] ${pair.from} → ${pair.to}: quote returned zero output — skipping pair`, "warn");
              continue;
            }
            const amountOutMin = applySlippage(expectedOut, BigInt(autoSwapConfig.slippageBps || 50));

            // Log pre-swap details
            this.log(`[SWAP] pair=${pair.from}→${pair.to} hops=${best.type}`, "warn");
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

            // POST-SWAP ON-CHAIN VERIFICATION — token deltas, not just a mined TX
            const v = await verifySwapBalances({
              provider, walletAddr, pair,
              beforeFrom: freshBalances[pair.from].raw,
              beforeTo: freshBalances[pair.to].raw,
              amountIn: amountRaw, amountOutMin, log: this.log.bind(this),
            });

            this.log(`[SWAP] SUCCESS ${pair.from}→${pair.to}`, "success");
            this.log(`[SWAP] actualOut≈${ethers.formatUnits(expectedOut, toDecimals)} ${pair.to}`, "success");
            this.log(`[SWAP] balanceAfter: ${pair.from}=${ethers.formatUnits(v.afterFrom, decimals)} ${pair.to}=${ethers.formatUnits(v.afterTo, toDecimals)}`, "success");

            if (!v.ok) {
              this.log(`[SWAP] ${pair.from}→${pair.to} VERIFICATION FAILED — not recording as a successful swap`, "error");
              continue;
            }

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

      // PHASE 1: If active position → CLOSE (always via the position's OWN manager)
      if (this.state.activePosition) {
        this.setState(STATES.CLOSE);
        const resolved = this.resolveManagerForPosition(this.state.activePosition);
        if (!resolved || !resolved.managerAddr) {
          this.log(`[CLOSE] cannot resolve manager for position #${this.state.activePosition.positionId} — NOT closing, NOT clearing (retry after discovery)`, "warn");
          this.lastCycleAction = "close";
          this.log("[CYCLE] ═══ CYCLE END ═══", "info");
          return;
        }
        const activeManager = resolved.managerAddr;
        this.log(`[CLOSE] position #${this.state.activePosition.positionId} (${this.state.activePosition.side}) market=${this.state.activePosition.marketSymbol || resolved.marketSymbol || "?"} manager=${short(activeManager)} src=${resolved.source}`, "warn");

        const closeResult = await closePositionFn({
          wallet, provider, managerAddr: activeManager,
          positionId: this.state.activePosition.positionId,
          config: this.config, log: this.log.bind(this), dryRun, txManager: this.txManager,
        });

        const closedOk = this._applyCloseResult(closeResult);
        if (closedOk) {
          this.setState(STATES.COOLDOWN);
          this.log(`[COOLDOWN] ${this.config.cooldownAfterCloseMs / 1000}s...`, "info");
          await this.sleep(this.config.cooldownAfterCloseMs);
        } else {
          this.log(`[CLOSE] not finished — will retry next cycle`, "warn");
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

      // PHASE 3: plan market candidates for the chosen side (rotation-aware)
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
      // PHASE 3+4: per-candidate preparation + OPEN. Every candidate gets its OWN
      // isolated collateral context (token, decimals, amount, paymentToken, quote)
      // via _candidateContext() / _ensureCollateralForCtx() — nothing market-specific
      // is carried over from a candidate that already failed quote/balance/preflight.
      this.log(`[OPEN] ${side} ${this.config.defaultLeverage}x...`, "warn");

      let openResult = null;
      let openedMarket = null;
      let openedCtx = null;
      for (const candidate of marketCandidates) {
        this.log(`[OPEN] trying market ${candidate.symbol} manager=${short(candidate.managerAddr)}`, "info");

        const ctx = await this._candidateContext(candidate, side, { provider, walletAddr });
        if (!ctx) continue;

        // P2 hard invariants — manager/pool/paymentToken/collateral/decimals must all
        // belong to THIS candidate's market. Any mismatch → SKIP (never open).
        const inv = await this._assertCandidateInvariants(candidate, ctx, side, provider);
        if (!inv.ok) {
          this.log(`[SKIP] ${candidate.symbol} ${side}: invariant failed — ${inv.reason} — trying next candidate`, "warn");
          this.rotation.recordMarketSideSkip(candidate.symbol, side);
          this.state.rotation = this.rotation.toJSON();
          continue;
        }

        // READ-ONLY viability pre-check (pool/manager view calls only, no transaction).
        // A candidate whose minimum collateral size is dust for this pool's liquidity is
        // SKIPPED with an explicit reason — it is NOT counted as a direction failure.
        const pre = await precheckMarketQuote(provider, {
          pool: ctx.poolAddr, manager: ctx.managerAddr,
          collateralToken: ctx.collateralToken, collateralAmount: ctx.collateralAmount,
          leverageX10: BigInt(Math.round(Number(this.config.defaultLeverage) * 10)),
          isLong: side === "LONG", log: this.log.bind(this),
        });
        if (!pre.ok) {
          this.log(`[SKIP] ${candidate.symbol} ${side}: quote not viable (${pre.code || "QUOTE_UNUSABLE"}: ${pre.reason}) — trying next candidate`, "warn");
          this.rotation.recordMarketSideSkip(candidate.symbol, side);
          this.state.rotation = this.rotation.toJSON();
          continue;
        }

        // Collateral top-up derived from scratch for THIS candidate
        const ready = await this._ensureCollateralForCtx(ctx, { provider, wallet, walletAddr, dryRun, allowEthWrap: false });
        if (!ready) continue;

        this.setState(STATES.OPEN);
        const attempt = await openPosition({
          wallet, provider, managerAddr: ctx.managerAddr, poolAddr: ctx.poolAddr,
          side, collateralToken: ctx.collateralToken, collateralAmount: ctx.collateralAmount,
          leverage: this.config.defaultLeverage,
          config: this.config, log: this.log.bind(this), dryRun, txManager: this.txManager,
          paymentToken: ctx.paymentToken,
        });
        openResult = attempt;
        if (attempt) {
          openedMarket = candidate;
          openedCtx = ctx;
          break;
        }
        this._recordDirectionFailure(candidate.symbol, side);
        this.log(`[OPEN] market ${candidate.symbol} failed — trying next candidate`, "warn");
      }
      const marketUsed = openedMarket || market;
      const ctxUsed = openedCtx;

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
          // All of these come from the SAME candidate that actually opened
          collateralToken: ctxUsed?.collateralToken || marketUsed.collateralToken,
          collateralAmount: String(ctxUsed?.collateralAmount ?? ""),
          paymentToken: ctxUsed?.paymentToken || marketUsed.paymentToken || null,
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
              recovered.paymentToken = mk.paymentToken || paymentTokenForMarket(mk);
            } else {
              const sym = Object.entries(this.deps.confirmedPools || {})
                .find(([, p]) => p?.manager?.toLowerCase() === mgr.toLowerCase())?.[0];
              if (sym) {
                recovered.marketSymbol = sym;
                recovered.poolAddr = this.deps.confirmedPools?.[sym]?.pool;
                recovered.paymentToken = this.deps.confirmedPools?.[sym]?.paymentToken || null;
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

  /**
   * Build a pair object for a FORCED direction (both legs of a market are
   * exercised separately: A→B and B→A are independent quotes/executions).
   * Returns null when the direction cannot be resolved to two distinct known
   * token addresses — the caller then skips with a reason instead of guessing.
   */
  _resolveForcedPair(forcePair, tokenAddrs) {
    const from = forcePair?.from || null;
    const to = forcePair?.to || null;
    const fromAddr = forcePair?.fromAddr || (from ? tokenAddrs[from] : null);
    const toAddr = forcePair?.toAddr || (to ? tokenAddrs[to] : null);
    if (!from || !to || !fromAddr || !toAddr) return null;
    if (String(fromAddr).toLowerCase() === String(toAddr).toLowerCase()) return null;
    return { from, to, fromAddr, toAddr, key: `${from}>${to}`, type: "direct", forced: true };
  }

  /**
   * Random (or FORCED-direction) swaps.
   *
   * @param {object} [options]
   * @param {{from:string,to:string,fromAddr?:string,toAddr?:string}} [options.forcePair]
   *        Execute exactly this direction once — used to prove BOTH directions of
   *        a market work. Journal cooldowns do not apply to a forced direction.
   * @returns {Promise<{attempted:number, verified:number, failed:number, results:object[]}>}
   */
  async doRandomSwaps(options = {}) {
    const autoSwapConfig = this.config.autoSwap || {};
    const forcePair = options.forcePair || null;
    const summary = { attempted: 0, verified: 0, failed: 0, results: [] };
    if (!autoSwapConfig.enabled && !forcePair) return summary;

    await this.ensureMarkets();
    const { provider, wallet } = this.getRuntime();
    const walletAddr = wallet.address;
    const dryRun = this.config.dryRun;

    // Dynamic token map from discovery (on-chain decimals; P8: hardcoded only as a
    // warned fallback if the RPC read fails — never silently preferred)
    const tokenAddrs = {};
    const decimalsMap = {};
    for (const t of (this.tokenList.length ? this.tokenList : Object.entries(getAllTokens()).map(([symbol, address]) => ({ symbol, address, decimals: null })))) {
      tokenAddrs[t.symbol] = t.address;
      decimalsMap[t.symbol] = t.decimals;
    }

    const swapCount = forcePair ? 1 : 1 + Math.floor(Math.random() * 2);
    this.log(`[AUTO] SWAPPING — ${forcePair ? `forced ${forcePair.from}→${forcePair.to}` : `${swapCount} random swap(s)`} (${this.routes.length} routes)`, "info");

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

        let pair;
        if (forcePair) {
          pair = this._resolveForcedPair(forcePair, tokenAddrs);
          if (!pair) {
            this.log(`[AUTO-SWAP] forced direction ${forcePair?.from}→${forcePair?.to}: unknown/duplicate token addresses — SKIP`, "warn");
            summary.failed++;
            summary.results.push({ direction: `${forcePair?.from}→${forcePair?.to}`, ok: false, reason: "UNKNOWN_TOKEN" });
            break;
          }
          this.log(`[AUTO-SWAP] forced direction ${pair.from} → ${pair.to}`, "info");
        } else {
          pair = selectRandomSwapPair(this.swapJournal, freshBalances, autoSwapConfig, tokenAddrs, this.log.bind(this), this.routes, this.rotation);
        }
        if (!pair) {
          this.log(`[AUTO-SWAP] No valid pair`, "info");
          if (forcePair) { summary.failed++; summary.results.push({ direction: `${forcePair.from}→${forcePair.to}`, ok: false, reason: "NO_PAIR" }); }
          break;
        }

        const fromBal = freshBalances[pair.from];
        if (!fromBal || fromBal.float <= 0) {
          if (forcePair) { summary.failed++; summary.results.push({ direction: `${pair.from}→${pair.to}`, ok: false, reason: "ZERO_BALANCE" }); }
          continue;
        }

        const fromDecimals = this._decimalsPrecedence(pair.from, decimalsMap);
        const amountResult = calculateRandomSwapAmount(pair.from, fromBal.float, autoSwapConfig, fromDecimals, this.log.bind(this));
        if (!amountResult) {
          if (forcePair) { summary.failed++; summary.results.push({ direction: `${pair.from}→${pair.to}`, ok: false, reason: "AMOUNT_TOO_SMALL" }); }
          continue;
        }

        const decimals = amountResult.decimals ?? fromDecimals;
        const amountRaw = ethers.parseUnits(amountResult.amountFloat.toFixed(decimals), decimals);

        if (amountRaw > fromBal.raw * 90n / 100n) {
          if (forcePair) { summary.failed++; summary.results.push({ direction: `${pair.from}→${pair.to}`, ok: false, reason: "OVER_90_PERCENT" }); }
          continue;
        }
        if (amountRaw > fromBal.raw) {
          if (forcePair) { summary.failed++; summary.results.push({ direction: `${pair.from}→${pair.to}`, ok: false, reason: "INSUFFICIENT_BALANCE" }); }
          continue;
        }

        // P6: validated routes only — direct first, then bounded validated 2-hop.
        // Never invent a path, never swap with amountOut = 0. The same quote
        // machinery is used for BOTH directions.
        const best = await quoteBestPath({
          provider, routerAddress: getRouterAddress(), routes: this.routes,
          fromAddr: pair.fromAddr, toAddr: pair.toAddr, amountIn: amountRaw,
          log: this.log.bind(this),
        });
        if (!best) {
          this.log(`[AUTO-SWAP] ${pair.from} → ${pair.to}: no viable route (direct/2-hop quote zero) — skipping pair`, "warn");
          if (forcePair) { summary.failed++; summary.results.push({ direction: `${pair.from}→${pair.to}`, ok: false, reason: "NO_ROUTE" }); }
          continue;
        }
        const path = best.path;
        const expectedOut = best.amountOut;
        const toDecimals = this._decimalsPrecedence(pair.to, decimalsMap);
        // Read-only guard: a zero-output quote would produce amountOutMin=0 and a
        // guaranteed-loss (or reverting) swap — skip this pair, try another one.
        if (expectedOut <= 0n) {
          this.log(`[AUTO-SWAP] ${pair.from} → ${pair.to}: quote returned zero output — skipping pair`, "warn");
          if (forcePair) { summary.failed++; summary.results.push({ direction: `${pair.from}→${pair.to}`, ok: false, reason: "QUOTE_ZERO" }); }
          continue;
        }
        const amountOutMin = applySlippage(expectedOut, BigInt(autoSwapConfig.slippageBps || 50));
        if (!(amountOutMin > 0n)) {
          this.log(`[AUTO-SWAP] ${pair.from} → ${pair.to}: amountOutMin=0 — skipping pair`, "warn");
          if (forcePair) { summary.failed++; summary.results.push({ direction: `${pair.from}→${pair.to}`, ok: false, reason: "ZERO_AMOUNT_OUT_MIN" }); }
          continue;
        }

        this.log(`[AUTO] SWAPPING ${pair.from} → ${pair.to} [${ethers.formatUnits(amountRaw, decimals)}] hops=${best.type} amountOutMin=${amountOutMin}`, "warn");

        if (dryRun) {
          this.log(`[DRY] Would swap ${amountResult.amountFloat.toFixed(4)} ${pair.from} → ${pair.to}`, "info");
          this.swapJournal.record({ from: pair.from, to: pair.to, amount: amountResult.amountFloat });
          this.rotation.recordSwapPair(pair.from, pair.to);
          this.state.rotation = this.rotation.toJSON();
          saveState(this.state);
          summary.attempted++;
          summary.results.push({ direction: `${pair.from}→${pair.to}`, ok: true, dryRun: true, amountIn: String(amountRaw), amountOutMin: String(amountOutMin), path });
          continue;
        }

        summary.attempted++;
        const swapResult = await executeSwap({
          wallet, provider,
          fromToken: pair.fromAddr, toToken: pair.toAddr,
          amount: amountRaw, amountOutMin,
          config: this.config, log: this.log.bind(this), txManager: this.txManager, path,
        });

        if (!swapResult) {
          this.log(`[SWAP] FAILED ${pair.from}→${pair.to}`, "error");
          summary.failed++;
          summary.results.push({ direction: `${pair.from}→${pair.to}`, ok: false, reason: "EXEC_FAILED", amountIn: String(amountRaw), amountOutMin: String(amountOutMin), path });
          continue;
        }

        // POST-SWAP ON-CHAIN VERIFICATION (both directions use the same check)
        const v = await verifySwapBalances({
          provider, walletAddr, pair,
          beforeFrom: freshBalances[pair.from].raw,
          beforeTo: freshBalances[pair.to].raw,
          amountIn: amountRaw, amountOutMin, log: this.log.bind(this),
        });
        if (!v.ok) {
          this.log(`[SWAP] ${pair.from}→${pair.to} VERIFICATION FAILED — not recording`, "error");
          summary.failed++;
          summary.results.push({ direction: `${pair.from}→${pair.to}`, ok: false, reason: "VERIFY_FAILED", amountIn: String(amountRaw), amountOutMin: String(amountOutMin), path, inDelta: String(v.inDelta), outDelta: String(v.outDelta) });
          continue;
        }

        this.swapJournal.record({ from: pair.from, to: pair.to, amount: amountResult.amountFloat });
        this.rotation.recordSwapPair(pair.from, pair.to);
        this.state.rotation = this.rotation.toJSON();
        saveState(this.state);
        summary.verified++;
        summary.results.push({ direction: `${pair.from}→${pair.to}`, ok: true, txHash: swapResult.txHash || null, approveTxHash: swapResult.approveTxHash || null, amountIn: String(amountRaw), expectedOut: String(expectedOut), amountOutMin: String(amountOutMin), inDelta: String(v.inDelta), outDelta: String(v.outDelta), path, hops: best.type });
        this.log(`[SWAP] SUCCESS ${pair.from}→${pair.to}`, "success");

        if (i < swapCount - 1) {
          await this.sleep(this.randomDelay(5000, 15000));
        }
      } catch (e) {
        this.log(`[AUTO-SWAP] Error: ${e.message?.slice(0, 60)}`, "error");
        this.txManager.resetNonce();
        summary.failed++;
      }
    }
    return summary;
  }

  /**
   * Resolve manager/pool/paymentToken for a stored position WITHOUT ever falling
   * back to a side-derived manager (P7: the fallback could target ANOTHER market's
   * manager, i.e. close the wrong contract).
   *
   * Match order: poolAddr → marketSymbol → managerAddr, then the identity recorded
   * at OPEN time. Never uses getManagerAddr(side).
   *
   * @returns {object|null} {resolved, managerAddr, poolAddr, marketSymbol, paymentToken, source}
   *          or null when the position carries no usable identity → caller MUST NOT
   *          close or clear the position.
   */
  resolveManagerForPosition(pos) {
    if (!pos || typeof pos !== "object") return null;
    const markets = Array.isArray(this.markets) ? this.markets : [];
    const confirmed = this.deps?.confirmedPools || {};
    const poolAddr = pos.poolAddr || null;
    const storedManager = pos.managerAddr || null;

    let mk = null;
    if (poolAddr) {
      mk = markets.find(m => m.poolAddr && m.poolAddr.toLowerCase() === poolAddr.toLowerCase()) || null;
    }
    if (!mk && pos.marketSymbol) {
      const want = String(pos.marketSymbol).toLowerCase();
      mk = markets.find(m => String(m.marketSymbol || m.symbol || "").toLowerCase() === want) || null;
    }
    if (!mk && storedManager) {
      mk = markets.find(m => m.managerAddr && m.managerAddr.toLowerCase() === storedManager.toLowerCase()) || null;
    }

    if (mk) {
      const discoveredManager = mk.managerAddr;
      if (storedManager && discoveredManager && storedManager.toLowerCase() !== discoveredManager.toLowerCase()) {
        this.log(`[CLOSE] manager mismatch for position #${pos.positionId}: state=${short(storedManager)} discovery=${short(discoveredManager)} — using discovery for pool ${short(mk.poolAddr)}`, "warn");
      }
      return {
        resolved: true,
        managerAddr: discoveredManager,
        poolAddr: mk.poolAddr || poolAddr,
        marketSymbol: mk.marketSymbol || mk.symbol || pos.marketSymbol || null,
        paymentToken: mk.paymentToken || paymentTokenForMarket(mk),
        source: "discovery",
      };
    }

    // Not in current discovery — keep the identity recorded at OPEN time
    if (storedManager) {
      const sym = Object.entries(confirmed)
        .find(([, p]) => p?.manager && p.manager.toLowerCase() === storedManager.toLowerCase())?.[0]
        || pos.marketSymbol || null;
      const cp = sym ? confirmed[sym] : null;
      return {
        resolved: true,
        managerAddr: storedManager,
        poolAddr: poolAddr || cp?.pool || null,
        marketSymbol: sym,
        paymentToken: pos.paymentToken || cp?.paymentToken || null,
        source: "state",
      };
    }
    return null;
  }

  /**
   * Apply a closePositionFn() result to `state`.
   *
   * `activePosition` is cleared ONLY when the position is provably gone:
   * a dry run, a zombie (MAM_InvalidPosition), or an on-chain verified close.
   * Every other outcome — pending TX, liquidity-blocked partial close, unreadable
   * verification — KEEPS the position so the bot can never orphan an open one.
   *
   * @returns {boolean} true when state was cleared (position gone)
   */
  _applyCloseResult(closeResult) {
    this.lastCloseTxHash = closeResult?.txHash || null;
    if (!closeResult) {
      this.log(`[CLOSE] Failed — will retry (state kept)`, "error");
      return false;
    }
    if (closeResult.dryRun) {
      this.state.activePosition = null;
      this.state.sessionStats.closes++;
      saveState(this.state);
      return true;
    }
    if (closeResult.pending) {
      this.log(`[CLOSE] TX ${closeResult.txHash || ""} pending — state kept, will verify next cycle`, "warn");
      return false;
    }
    if (closeResult.failed) {
      if (closeResult.clearState === false) {
        this.log(`[CLOSE] blocked (${closeResult.code || closeResult.reason || "?"}) — position KEPT, will retry`, "warn");
        this.state.closeAttempts = (Number(this.state.closeAttempts) || 0) + 1;
        saveState(this.state);
        return false;
      }
      this.log(`[CLOSE] Position gone (${closeResult.reason || "zombie"}) — clearing state`, "warn");
      this.state.activePosition = null;
      this.state.sessionStats.closes++;
      this.state.closeAttempts = 0;
      saveState(this.state);
      return true;
    }
    if (closeResult.closed === false) {
      this.log(`[CLOSE] ${closeResult.code || "not closed"} — position KEPT, will retry`, "warn");
      this.state.closeAttempts = (Number(this.state.closeAttempts) || 0) + 1;
      saveState(this.state);
      return false;
    }
    const part = closeResult.partial ? ` (partial closeBps=${closeResult.closeBps})` : "";
    this.log(`[CLOSE] SUCCESS TX: ${closeResult.txHash || "dry-run"}${part} — verified on-chain`, "success");
    this.state.activePosition = null;
    this.state.sessionStats.closes++;
    this.state.closeAttempts = 0;
    saveState(this.state);
    return true;
  }

  async closeActivePosition() {
    if (!this.state.activePosition) return false;

    const { provider, wallet } = this.getRuntime();
    // P7: the manager comes from THIS position's identity — never from a
    // side-derived getManagerAddr() fallback (that can target another market).
    const resolved = this.resolveManagerForPosition(this.state.activePosition);
    if (!resolved || !resolved.managerAddr) {
      this.log(`[CLOSE] cannot resolve manager for position #${this.state.activePosition.positionId} — NOT closing, NOT clearing (retry after discovery)`, "warn");
      return false;
    }
    const managerAddr = resolved.managerAddr;
    const dryRun = this.config.dryRun;

    this.setState(STATES.CLOSE);
    this.log(`[AUTO] CLOSING position #${this.state.activePosition.positionId} (${this.state.activePosition.side}) market=${this.state.activePosition.marketSymbol || resolved.marketSymbol || "?"} manager=${short(managerAddr)} src=${resolved.source}`, "warn");

    const closeResult = await closePositionFn({
      wallet, provider, managerAddr,
      positionId: this.state.activePosition.positionId,
      config: this.config, log: this.log.bind(this), dryRun, txManager: this.txManager,
    });

    return this._applyCloseResult(closeResult);
  }

  /**
   * Isolated collateral context for ONE market candidate.
   *
   * Everything market-specific is derived from this candidate alone — token, decimals,
   * amount and paymentToken are never reused from a previously tried candidate, so a
   * fallback candidate can never open on manager B with candidate A's collateral.
   *
   * Validates the contract rule LONG → token0 / SHORT → token1.
   *
   * @returns {Promise<object|null>} ctx, or null when the candidate is unusable (skipped)
   */
  async _candidateContext(candidate, side, { provider, walletAddr }) {
    const market = candidate?.market || null;
    const symbol = candidate?.symbol || market?.marketSymbol || market?.symbol || "?";

    const ruleToken = market ? collateralForSide(market, side) : null;
    const collateralToken = candidate.collateralToken || ruleToken;
    if (!collateralToken) {
      this.log(`[SKIP] ${symbol} ${side}: no collateral token for this side`, "warn");
      return null;
    }
    if (ruleToken && ruleToken.toLowerCase() !== collateralToken.toLowerCase()) {
      this.log(`[SKIP] ${symbol} ${side}: collateral mismatch candidate=${short(collateralToken)} rule=${short(ruleToken)}`, "warn");
      return null;
    }
    if (market?.token0 && market?.token1) {
      const expectedLeg = side === "LONG" ? market.token0 : market.token1;
      const legName = side === "LONG" ? "token0" : "token1";
      if (expectedLeg && expectedLeg.toLowerCase() !== collateralToken.toLowerCase()) {
        this.log(`[SKIP] ${symbol} ${side}: collateral is not the ${legName} leg`, "warn");
        return null;
      }
    }

    let collateralDecimals, collateralSym;
    try {
      // decimals/symbol ALWAYS from the token contract (never hardcoded)
      collateralDecimals = candidate.decimals ?? await tokenDecimalsOnChain(provider, collateralToken);
      collateralSym = candidate.collateralSym ?? await tokenSymbolOnChain(provider, collateralToken);
    } catch (e) {
      this.log(`[SKIP] ${symbol} ${side}: token meta failed (${e.message?.slice(0, 40)})`, "warn");
      return null;
    }

    const configuredTargetStr = collateralTargetStr(this.config, collateralToken);
    let collateralAmount = ethers.parseUnits(configuredTargetStr, collateralDecimals);
    const targetReserve = ethers.parseUnits(reserveTargetStr(this.config, collateralToken), collateralDecimals);
    if (collateralAmount <= 0n) {
      this.log(`[SKIP] ${symbol} ${side}: invalid collateral target`, "warn");
      return null;
    }

    // SHORT-only candidate-specific sizing: this candidate's OWN pool decides how
    // much collateral it can actually quote, never a value inherited from another
    // candidate and never the unconditional generic target:
    //     collateralAmount = max(configuredTarget, measuredPoolMinimum) <= cap
    // A pool whose minimum is above the cap is SKIPPED with a machine-readable code
    // instead of being inflated. LONG keeps its configured target, unchanged.
    let sizing = { mode: "configured", configured: configuredTargetStr, poolMin: null, cap: null };
    if (side === "SHORT") {
      const capStr = this.config.maxCollateralTargetShort || DEFAULT_AUTO_CONFIG.maxCollateralTargetShort;
      const poolAddr = candidate.poolAddr || market?.poolAddr || null;
      const managerAddr = candidate.managerAddr || market?.managerAddr || null;
      let capRaw = null;
      try { capRaw = ethers.parseUnits(String(capStr), collateralDecimals); } catch { capRaw = null; }
      if (!poolAddr || !managerAddr || !capRaw || capRaw <= 0n) {
        this.log(`[SIZING] ${symbol} SHORT: no pool/manager/cap for candidate sizing — keeping configured target ${configuredTargetStr} ${collateralSym}`, "warn");
      } else {
        const s = await resolveShortCollateralAmount(provider, {
          pool: poolAddr, manager: managerAddr, collateralToken,
          configuredRaw: collateralAmount, capRaw,
          leverageX10: BigInt(Math.round(Number(this.config.defaultLeverage || 2) * 10)),
        });
        if (s.ok) {
          if (s.amount !== collateralAmount) {
            this.log(`[SIZING] ${symbol} SHORT: configured=${configuredTargetStr} poolMin=${ethers.formatUnits(s.poolMin, collateralDecimals)} ${collateralSym} → collateral=${ethers.formatUnits(s.amount, collateralDecimals)} ${collateralSym} (cap=${capStr})`, "info");
          }
          collateralAmount = s.amount;
          sizing = { mode: "pool-min", configured: configuredTargetStr, poolMin: ethers.formatUnits(s.poolMin, collateralDecimals), cap: String(capStr) };
        } else if (s.fallbackToConfigured) {
          // Measurement failed — fall back WITHOUT inflating; the unchanged precheck
          // below still reports QUOTE_ZERO / ZERO_AMOUNT_OUT_MIN for this size.
          this.log(`[SIZING] ${symbol} SHORT: ${s.code} — keeping configured target ${configuredTargetStr} ${collateralSym} (precheck decides)`, "warn");
          sizing = { mode: "configured-fallback", configured: configuredTargetStr, poolMin: null, cap: String(capStr), code: s.code };
        } else {
          this.log(`[SKIP] ${symbol} ${side}: ${s.reason} (code=${s.code}) — collateral not inflated`, "warn");
          return null;
        }
      }
    }

    if (collateralAmount <= 0n) {
      this.log(`[SKIP] ${symbol} ${side}: invalid collateral target`, "warn");
      return null;
    }

    return {
      candidate, side,
      marketSymbol: symbol,
      managerAddr: candidate.managerAddr,
      poolAddr: candidate.poolAddr,
      paymentToken: candidate.paymentToken || (market ? paymentTokenForMarket(market) : null),
      token0: candidate.token0 || market?.token0 || null,
      token1: candidate.token1 || market?.token1 || null,
      leverage: this.config.defaultLeverage,
      collateralToken, collateralDecimals, collateralSym, collateralAmount, targetReserve, sizing,
      tokenContract: new ethers.Contract(collateralToken, ERC20_ABI, provider),
      balance: 0n,
    };
  }

  /**
   * Hard invariant checks run immediately before openPosition (P2).
   * Every market-specific value MUST belong to THIS candidate's market — a candidate
   * that inherited candidate[0]'s collateral/manager/pool/paymentToken/decimals is
   * skipped instead of opened.
   *
   * @returns {Promise<{ok:true}|{ok:false, reason:string}>}
   */
  async _assertCandidateInvariants(candidate, ctx, side, provider) {
    const eq = (a, b) => String(a || "").toLowerCase() === String(b || "").toLowerCase();
    const fail = (reason) => ({ ok: false, reason });
    if (!ctx) return fail("no collateral context");
    const market = candidate?.market || null;
    const label = candidate?.symbol || ctx.marketSymbol || "?";

    // 1) market identity
    if (candidate?.marketSymbol && ctx.marketSymbol && candidate.marketSymbol !== ctx.marketSymbol) {
      return fail(`marketSymbol mismatch candidate=${candidate.marketSymbol} ctx=${ctx.marketSymbol}`);
    }
    if (candidate?.managerAddr && !eq(candidate.managerAddr, ctx.managerAddr)) {
      return fail(`managerAddr not candidate's (candidate=${short(candidate.managerAddr)} ctx=${short(ctx.managerAddr)})`);
    }
    if (candidate?.poolAddr && !eq(candidate.poolAddr, ctx.poolAddr)) {
      return fail(`poolAddr not candidate's (candidate=${short(candidate.poolAddr)} ctx=${short(ctx.poolAddr)})`);
    }
    if (market?.managerAddr && !eq(market.managerAddr, ctx.managerAddr)) {
      return fail(`managerAddr not from market record (market=${short(market.managerAddr)} ctx=${short(ctx.managerAddr)})`);
    }
    if (market?.poolAddr && !eq(market.poolAddr, ctx.poolAddr)) {
      return fail(`poolAddr not from market record (market=${short(market.poolAddr)} ctx=${short(ctx.poolAddr)})`);
    }

    // 2) collateral belongs to this market's legs (LONG→token0 / SHORT→token1)
    const legs = [market?.token0, market?.token1, candidate?.token0, candidate?.token1]
      .filter(Boolean).map((a) => String(a).toLowerCase());
    if (legs.length && !legs.includes(String(ctx.collateralToken).toLowerCase())) {
      return fail(`collateralToken ${short(ctx.collateralToken)} is not a leg of ${label}`);
    }
    const rule = market ? collateralForSide(market, side) : null;
    if (rule && !eq(rule, ctx.collateralToken)) {
      return fail(`collateralToken violates ${side === "LONG" ? "LONG→token0" : "SHORT→token1"} rule for ${label}`);
    }

    // 3) paymentToken belongs to this market (explicit market record value only —
    //    a derived "risky token" can legitimately differ from the declared one)
    if (candidate?.paymentToken && ctx.paymentToken && !eq(candidate.paymentToken, ctx.paymentToken)) {
      return fail(`paymentToken not candidate's (candidate=${short(candidate.paymentToken)} ctx=${short(ctx.paymentToken)})`);
    }
    if (market?.paymentToken && ctx.paymentToken && !eq(market.paymentToken, ctx.paymentToken)) {
      return fail(`paymentToken not market's (market=${short(market.paymentToken)} ctx=${short(ctx.paymentToken)})`);
    }

    // 4) collateral decimals must correspond to the collateral token (on-chain truth)
    let onChainDecimals = null;
    try {
      onChainDecimals = await tokenDecimalsOnChain(provider, ctx.collateralToken);
    } catch (e) {
      return fail(`cannot verify collateral decimals for ${short(ctx.collateralToken)} (${e.message?.slice(0, 40)})`);
    }
    if (Number(onChainDecimals) !== Number(ctx.collateralDecimals)) {
      return fail(`collateral decimals ${ctx.collateralDecimals} != on-chain ${onChainDecimals} for ${short(ctx.collateralToken)}`);
    }
    return { ok: true };
  }

  /**
   * Decimals precedence (P8): on-chain > runtime/discovered metadata > hardcoded
   * TOKEN_DECIMALS fallback — and the fallback ALWAYS emits a diagnostic warning.
   */
  _decimalsPrecedence(sym, map) {
    const v = map?.[sym];
    if (v !== null && v !== undefined) return v;
    const fb = TOKEN_DECIMALS[String(sym).toUpperCase()];
    if (fb !== null && fb !== undefined) {
      this.log(`[DECIMALS] ${sym}: no on-chain/runtime decimals — using hardcoded fallback ${fb} (diagnostic)`, "warn");
      return fb;
    }
    this.log(`[DECIMALS] ${sym}: no on-chain/runtime/hardcoded decimals — assuming 6 (diagnostic)`, "warn");
    return 6;
  }

  /**
   * Make sure THIS candidate's collateral is available (inventory-aware top-up).
   * Balance/deficit are re-derived from ctx from scratch for every candidate.
   *
   * @returns {Promise<boolean>} true when balance >= ctx.collateralAmount
   */
  async _ensureCollateralForCtx(ctx, { provider, wallet, walletAddr, dryRun, allowEthWrap = false, resetNonceOnError = false }) {
    const { collateralToken, collateralDecimals, collateralSym, collateralAmount, targetReserve, tokenContract, side, marketSymbol } = ctx;

    const balance = await tokenContract.balanceOf(walletAddr);
    ctx.balance = balance;

    this.log(`[INVENTORY] ═══ COLLATERAL CHECK (${marketSymbol} ${side}) ═══`, "info");
    this.log(`[INVENTORY] ${collateralSym} balance=${ethers.formatUnits(balance, collateralDecimals)}`, "info");
    this.log(`[INVENTORY] ${collateralSym} required=${ethers.formatUnits(collateralAmount, collateralDecimals)} (position open)`, "info");
    this.log(`[INVENTORY] ${collateralSym} targetReserve=${ethers.formatUnits(targetReserve, collateralDecimals)} (inventory target)`, "info");

    if (collateralAmount <= 0n) {
      this.log(`[BLOCKED] Invalid collateral target`, "error");
      return false;
    }

    const deficit = calculateInventoryDeficit({
      balance, required: collateralAmount, targetReserve,
      decimals: collateralDecimals, sym: collateralSym,
      log: this.log.bind(this),
    });

    if (deficit.action === "none") {
      this.log(`[INVENTORY] RESERVE OK — ${collateralSym} ${ethers.formatUnits(balance, collateralDecimals)} >= target ${ethers.formatUnits(targetReserve, collateralDecimals)}`, "success");
      return true;
    }

    this.setState(STATES.SWAP);
    this.log(`[SWAP] ${deficit.reason}`, "warn");
    this.log(`[SWAP] searching inventory for source tokens...`, "warn");

    // Source tokens come from the discovered inventory + validated routes only
    const sources = swapSourcesFor(collateralToken, side, this.tokenList);
    let swapSuccess = false;

    for (const sourceToken of sources) {
      try {
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

        // P6: direct (validated or read-only probed) → validated 2-hop → SKIP.
        const best = await quoteBestPath({
          provider, routerAddress: getRouterAddress(), routes: this.routes,
          fromAddr: sourceToken, toAddr: collateralToken, amountIn: sourceBalance,
          log: this.log.bind(this),
        });
        if (!best) {
          this.log(`[SWAP] ${sourceSym} → ${collateralSym}: no viable route (direct/2-hop quote zero) — skip`, "warn");
          continue;
        }
        const path = best.path;
        const expectedOut = best.amountOut;

        // Never swap into a zero/insufficient quote — skip this source, try the next
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

        const swapResult = await executeSwap({
          wallet, provider, fromToken: sourceToken, toToken: collateralToken,
          amount: swapAmount, amountOutMin, config: this.config,
          log: this.log.bind(this), txManager: this.txManager, path,
        });

        if (!swapResult) {
          this.log(`[SWAP] ${sourceSym} → ${collateralSym} FAILED — trying next source`, "error");
          continue;
        }

        const newBalance = await tokenContract.balanceOf(walletAddr);
        ctx.balance = newBalance;
        this.log(`[SWAP] ${collateralSym} balance_after=${ethers.formatUnits(newBalance, collateralDecimals)} (target=${ethers.formatUnits(targetReserve, collateralDecimals)})`, "info");

        if (newBalance >= collateralAmount) {
          this.log(`[SWAP] CONFIRMED — ${collateralSym} sufficient after swap`, "success");
          swapSuccess = true;
          break;
        } else {
          this.log(`[SWAP] ${collateralSym} still below required after swap: ${ethers.formatUnits(newBalance, collateralDecimals)} < ${ethers.formatUnits(collateralAmount, collateralDecimals)}`, "warn");
        }
      } catch (e) {
        this.log(`[SWAP] ${short(sourceToken)} → ${collateralSym} failed: ${e.message?.slice(0, 80)}`, "error");
        if (resetNonceOnError) this.txManager.resetNonce();
        continue;
      }
    }

    // The OPEN itself is already funded. A reserve top-up that no source can
    // cover must NOT reject the candidate: previously `!swapSuccess` returned
    // false for `topup` even though balance >= collateralAmount, so a perfectly
    // openable position was skipped because the inventory reserve could not be
    // topped up. The top-up stays best-effort; only a CRITICAL deficit
    // (balance < collateralAmount) is allowed to block.
    if (balance >= collateralAmount) {
      if (!swapSuccess) {
        this.log(`[SWAP] ${deficit.action} not sourced — ${collateralSym} balance ${ethers.formatUnits(balance, collateralDecimals)} already covers required ${ethers.formatUnits(collateralAmount, collateralDecimals)}; proceeding without reserve top-up`, "warn");
      }
      this.log(`[INVENTORY] PRE-SWAP ${collateralSym}=${ethers.formatUnits(balance, collateralDecimals)} — ready for OPEN`, "success");
      return true;
    }

    if (!swapSuccess && !dryRun) {
      this.log(`[BLOCKED] No source token could cover ${collateralSym} deficit for ${marketSymbol} — trying next candidate`, "error");
      return false;
    }

    // Last resort: ETH → WETH wrap when the candidate's collateral is WETH
    if (!swapSuccess && !dryRun && allowEthWrap && collateralToken.toLowerCase() === WETH.toLowerCase()) {
      try {
        const currentWethBal = await tokenContract.balanceOf(walletAddr);
        const remainingDeficit = collateralAmount > currentWethBal ? collateralAmount - currentWethBal : 0n;
        if (remainingDeficit > 0n) {
          const ethBalance = await provider.getBalance(walletAddr);
          const gasReserve = ethers.parseEther(String(this.config.ethGuard?.MIN_ETH_GAS_RESERVE ?? 0.003));
          const ethAvail = ethBalance - gasReserve - ethers.parseEther("0.005");
          const wrapAmount = remainingDeficit > ethAvail ? ethAvail : remainingDeficit;
          if (wrapAmount > ethers.parseEther("0.0001")) {
            this.log(`[SWAP] ETH → WETH (wrap ${ethers.formatEther(wrapAmount)})`, "warn");
            const wethContract = new ethers.Contract(WETH, ["function deposit() payable", "function balanceOf(address) view returns (uint256)"], wallet);
            const feeParams = await getFeeParams(provider);
            const r = await this.txManager.sendAndWait({
              wallet, provider, txType: "WETH-WRAP",
              sendFn: (nonce) => wethContract.deposit({ value: wrapAmount, gasLimit: 100000n, ...feeParams, nonce }),
              log: this.log.bind(this),
            });
            if (r && r.status === 1) {
              const wethBal = await tokenContract.balanceOf(walletAddr);
              ctx.balance = wethBal;
              if (wethBal >= collateralAmount) swapSuccess = true;
            }
          }
        }
      } catch (e) {
        this.log(`[SWAP] ETH→WETH wrap failed: ${e.message?.slice(0, 60)}`, "error");
      }
    }

    const finalBalance = await tokenContract.balanceOf(walletAddr);
    ctx.balance = finalBalance;
    if (!dryRun && finalBalance < collateralAmount) {
      this.log(`[BLOCKED] ${collateralSym} still insufficient after all swaps: ${ethers.formatUnits(finalBalance, collateralDecimals)} < ${ethers.formatUnits(collateralAmount, collateralDecimals)} — trying next candidate`, "error");
      return false;
    }
    if (dryRun) {
      this.log(`[DRY] ${collateralSym}=${ethers.formatUnits(finalBalance, collateralDecimals)} (required ${ethers.formatUnits(collateralAmount, collateralDecimals)})`, "info");
      // CRITICAL deficit (balance < collateralAmount): a dry run must not claim
      // readiness when no source token can cover the swap — that hid real
      // blockers. `swapSuccess` is true only when a source was actually found.
      return swapSuccess;
    }
    this.log(`[INVENTORY] POST-SWAP ${collateralSym}=${ethers.formatUnits(finalBalance, collateralDecimals)} — ready for OPEN`, "success");
    return true;
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

    // Per-candidate isolation: collateral context + top-up are built inside the OPEN
    // loop below (_candidateContext / _ensureCollateralForCtx), each candidate gets its
    // own read-only quote precheck — a fallback candidate never inherits candidate[0]'s
    // token/decimals/amount/paymentToken.
    this.log(`[AUTO] OPENING ${side} ${this.config.defaultLeverage}x`, "warn");
    this.setState(STATES.OPEN);
    let openResult = null;
    let openedMarket = null;
    let openedCtx = null;
    for (const candidate of marketCandidates) {
      this.log(`[OPEN] trying market ${candidate.symbol} manager=${short(candidate.managerAddr)}`, "info");

      const ctx = await this._candidateContext(candidate, side, { provider, walletAddr });
      if (!ctx) {
        this.log(`[OPEN] market ${candidate.symbol} skipped (collateral context) — trying next candidate`, "warn");
        continue;
      }

      // P2 hard invariants — everything market-specific must belong to THIS candidate.
      const inv = await this._assertCandidateInvariants(candidate, ctx, side, provider);
      if (!inv.ok) {
        this.log(`[SKIP] ${candidate.symbol} ${side}: invariant failed — ${inv.reason} — trying next candidate`, "warn");
        this.rotation.recordMarketSideSkip(candidate.symbol, side);
        this.state.rotation = this.rotation.toJSON();
        continue;
      }

      // READ-ONLY viability pre-check (view calls only, no transaction).
      // Minimum-size/dust candidates are SKIPPED with a reason, never counted
      // as a direction failure (see P4).
      const pre = await precheckMarketQuote(provider, {
        pool: ctx.poolAddr, manager: ctx.managerAddr,
        collateralToken: ctx.collateralToken, collateralAmount: ctx.collateralAmount,
        leverageX10: BigInt(Math.round(Number(this.config.defaultLeverage) * 10)),
        isLong: side === "LONG", log: this.log.bind(this),
      });
      if (!pre.ok) {
        this.log(`[SKIP] ${candidate.symbol} ${side}: quote not viable (${pre.code || "QUOTE_UNUSABLE"}: ${pre.reason}) — trying next candidate`, "warn");
        this.rotation.recordMarketSideSkip(candidate.symbol, side);
        this.state.rotation = this.rotation.toJSON();
        continue;
      }

      // Collateral top-up derived from scratch for THIS candidate (ETH→WETH wrap allowed)
      const ready = await this._ensureCollateralForCtx(ctx, {
        provider, wallet, walletAddr, dryRun, allowEthWrap: true, resetNonceOnError: true,
      });
      if (!ready) {
        this.rotation.recordMarketSideSkip(candidate.symbol, side);
        this.state.rotation = this.rotation.toJSON();
        continue;
      }

      const attempt = await openPosition({
        wallet, provider, managerAddr: ctx.managerAddr, poolAddr: ctx.poolAddr,
        side, collateralToken: ctx.collateralToken, collateralAmount: ctx.collateralAmount,
        leverage: this.config.defaultLeverage,
        config: this.config, log: this.log.bind(this), dryRun, txManager: this.txManager,
        paymentToken: ctx.paymentToken,
      });
      openResult = attempt;
      if (attempt) {
        openedMarket = candidate;
        openedCtx = ctx;
        break;
      }
      this._recordDirectionFailure(candidate.symbol, side);
      this.log(`[OPEN] market ${candidate.symbol} failed — trying next candidate`, "warn");
    }
    const marketUsed = openedMarket || market;
    const ctxUsed = openedCtx;

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
        side,
        // All of these come from the SAME candidate that actually opened
        collateralToken: ctxUsed?.collateralToken || marketUsed.collateralToken,
        collateralAmount: String(ctxUsed?.collateralAmount ?? ""),
        paymentToken: ctxUsed?.paymentToken || marketUsed.paymentToken || null,
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

export {
  STATES, DEFAULT_AUTO_CONFIG, openPosition, closePositionFn, resolveTradingMarket,
  encodeOpenPositionCalldata, TxManager, normalizeDirectionDisabled, recoverPosition,
  // Read-only helpers (view calls only — safe to use from tests)
  readOnChainPosition, previewCloseAt, findMaxCloseBps, positionIsClosed,
  revertSelector, verifyOpenedPosition, verifySwapBalances,
};
export default AutoTrader;
