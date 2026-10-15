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
import { discoverTokens, discoverSwapRoutes, quoteBestPath, routeCandidates, sourcesForTarget, formatRoutesTable, PROBE_LADDER_WHOLE } from "./swapRoutes.js";
import { probeRouteEconomics, normalizeEconomyConfig, checkRateConsistency } from "./swapEconomics.js";
import { RotationMemory } from "./rotation.js";
import {
  SWAP_FAILURE_CODES,
  normalizeSwapConfig,
  reserveRawFor,
  computeSwapAmount,
  gasGweiFrom,
  SwapRouteBackoff,
  runSwapRotationQueue,
} from "./swapEngine.js";
import { TX_STATE, classifyTx, resolveReceipt, createTxJournal } from "./txStatus.js";

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
// Pool-side error that bubbles through the closePosition pre-flight when the
// pool cannot produce the required output for THIS position (verified live on
// position #75: closePosition() reverts with it while previewClosePosition()
// reports MAM_InsufficientLiquidity at every closeBps).
const ERR_POOL_INSUFFICIENT_OUTPUT = "0x27a80cdc"; // Pool_InsufficientOutputAmount()
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

// Bounded receipt wait. Without it `tx.wait()` polls forever on an endpoint
// that never answers with a receipt, and the cycle never finishes.
const TX_WAIT_TIMEOUT_MS = Number(process.env.NEMESIS_TX_WAIT_MS || 90_000);
// Receipt re-check loop after `wait()` failed (defaults: 12 × 5s = 60s).
const TX_POLL_ATTEMPTS = Number(process.env.NEMESIS_TX_POLL_ATTEMPTS || 12);
const TX_POLL_MS = Number(process.env.NEMESIS_TX_POLL_MS || 5_000);

class TxManager {
  constructor({ journal = null, fallbacks = null } = {}) {
    this._mutex = Promise.resolve();
    this._nonce = null;
    this._provider = null;
    this._walletAddr = null;
    // Durable per-hash state journal (PREPARED → … → CONFIRMED/REVERTED/…).
    this.journal = journal || createTxJournal();
    // Extra endpoints consulted when the primary returns no receipt (null = env default).
    this.fallbacks = fallbacks;
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
   * @param {Object} opts - { wallet, provider, sendFn, txType, log, meta }
   *   sendFn(nonce) should return a TransactionResponse.
   *   meta — extra fields persisted into the tx journal PREPARED line (e.g.
   *   { leverage, closeBps, positionId }); forwarded verbatim by TxJournal.
   */
  async sendAndWait({ wallet, provider, sendFn, txType, log, meta = null }) {
    const walletAddr = wallet.address;
    const release = await this.acquire();
    try {
      return await this._sendWithRetry({ wallet, provider, walletAddr, sendFn, txType, log, meta, attempt: 0 });
    } finally {
      release();
    }
  }

  async _sendWithRetry({ wallet, provider, walletAddr, sendFn, txType, log, meta = null, attempt }) {
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
    this.journal?.begin({
      hash: tx.hash, type: txType, nonce, to: tx.to ?? null, wallet: walletAddr,
      ...(meta && typeof meta === "object" ? meta : {}),
    });
    this.journal?.transition(tx.hash, TX_STATE.SUBMITTED);

    // Wait for receipt with timeout (bounded: a receipt-less RPC must not hang the loop)
    let receipt;
    try {
      receipt = await tx.wait(1, TX_WAIT_TIMEOUT_MS);
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
          log(`[TX] ${txType} not yet mined — waiting up to ${Math.round((TX_POLL_ATTEMPTS * TX_POLL_MS) / 1000)}s...`, "warn");
          for (let i = 0; i < TX_POLL_ATTEMPTS; i++) {
            await new Promise(r => setTimeout(r, TX_POLL_MS));
            receipt = await provider.getTransactionReceipt(tx.hash);
            if (receipt) {
              log(`[TX] ${txType} confirmed after ${(i+1) * (TX_POLL_MS / 1000)}s: status=${receipt.status}`, "info");
              break;
            }
          }
        }
      } catch (checkErr) {
        log(`[TX] ${txType} chain check failed: ${checkErr.message?.slice(0, 60)}`, "error");
      }
    }

    // MULTI-SOURCE RECOVERY — one node answering null for a receipt that IS
    // mined must never turn CONFIRMED into "pending". Cross-check fallbacks.
    if (!receipt) {
      const resolved = await resolveReceipt({ provider, hash: tx.hash, fallbacks: this.fallbacks, log });
      if (resolved.receipt) {
        receipt = resolved.receipt;
        log(`[TX] ${txType} receipt recovered from ${resolved.source} (primary returned null)`, "warn");
      }
    }

    if (!receipt) {
      // Distinguish "not mined" from "mined but unprovable" from "replaced".
      let txObj;
      let latestNonce;
      try { txObj = await provider.getTransaction(tx.hash); } catch { txObj = undefined; }
      try { latestNonce = await provider.getTransactionCount(walletAddr, "latest"); } catch { latestNonce = null; }
      const txState = classifyTx({ receipt: null, tx: txObj, nonce, latestNonce });
      this.journal?.transition(tx.hash, txState, { nonce });
      if (txState === TX_STATE.UNKNOWN) {
        log(`[TX] ${txType} UNKNOWN — tx mined in block ${txObj?.blockNumber} but NO endpoint returned a receipt; status not asserted`, "error");
      } else if (txState === TX_STATE.PENDING) {
        log(`[TX] ${txType} PENDING — not mined after extended wait. TX may still confirm later.`, "warn");
      } else if (txState === TX_STATE.DROPPED_OR_REPLACED) {
        log(`[TX] ${txType} DROPPED_OR_REPLACED — no receipt for ${tx.hash} and nonce ${nonce} is spent`, "warn");
      }
      // Invalidate nonce cache since TX might be pending
      this._nonce = null;
      return { hash: tx.hash, status: null, pending: true, txState };
    }

    if (receipt.status !== 1) {
      log(`[TX] ${txType} REVERTED status=0 nonce=${receipt.nonce} gas=${receipt.gasUsed}`, "error");
      // Nonce was consumed by failed TX — invalidate cache
      this._nonce = null;
      this.journal?.transition(tx.hash, TX_STATE.REVERTED, {
        blockNumber: receipt.blockNumber, gasUsed: String(receipt.gasUsed),
      });
      return { hash: tx.hash, status: 0, receipt, txState: TX_STATE.REVERTED };
    }

    log(`[TX] ${txType} CONFIRMED status=1 nonce=${receipt.nonce} block=${receipt.blockNumber} gas=${receipt.gasUsed}`, "success");
    this.journal?.transition(tx.hash, TX_STATE.CONFIRMED, {
      blockNumber: receipt.blockNumber, gasUsed: String(receipt.gasUsed),
    });
    return { hash: tx.hash, status: 1, receipt, txState: TX_STATE.CONFIRMED };
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
  "function partialClose(uint256 positionId, uint256 closeBps, uint256 amountOutMin, uint256 deadline)",
  "function nonces(address user) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function factory() view returns (address)",
  "function getAvailableLiquidity() view returns (uint256)",
  "function LTV_BPS() view returns (uint256)",
  "function PROTOCOL_FEE_BPS() view returns (uint256)",
  // Leverage + risk bounds — verified against the deployed manager impl
  // (MAX/MIN_LEVERAGE_X10 are `pure`, selector probes returned 200/10 on bot
  // manager 0x6562…FD82 and on the site manager alike).
  "function MAX_LEVERAGE_X10() view returns (uint256)",
  "function MIN_LEVERAGE_X10() view returns (uint256)",
  "function MAX_OPEN_LTV_BPS() view returns (uint256)",
  "function MIN_OPEN_HEALTH_BPS() view returns (uint256)",
  "function LIQUIDATION_LTV_BPS() view returns (uint256)",
  // Position status — on-chain truth (borr/collateral/health/PnL inputs)
  "function positions(uint256 positionId) view returns (bool isLong, address user, address collateralToken, uint256 collateralAmount, uint256 debtAmount, uint256 borrowIndex, bool active)",
  "function getPosition(uint256 positionId) view returns (bool isLong, address user, address collateralToken, uint256 collateralAmount, uint256 debtAmount, uint256 currentDebt, uint256 healthFactor)",
  "function getPositionDebt(uint256 positionId) view returns (uint256)",
  "function getHealthFactor(uint256 positionId) view returns (uint256)",
  "function getUserPositions(address user) view returns (uint256[])",
  "function getPositionRisk(uint256 positionId) view returns (tuple(uint256 positionId, bool isActive, bool isLong, address user, address collateralToken, uint256 collateralAmount, uint256 storedDebt, uint256 currentDebt, address debtAsset, uint256 lpTokenPriceToken1X18, uint256 currentDebtValueToken1, uint256 notionalValue, int256 equityValue, uint256 healthBps, uint256 liquidationPrice, bool liquidatable, bool oracleReady))",
  // Preview / preflight — same layout the site frontend uses (verified: 11-word
  // return data on both bot and site managers).
  "function previewOpenPosition(bool isLong, address collateralToken, uint256 collateralAmount, uint256 borrowAmount, uint256 leverageX10) view returns (tuple(uint256 projectedEntryPrice, uint256 projectedDebt, uint256 projectedHealthBps, uint256 projectedLiquidationPrice, uint256 protocolFee, uint256 projectedCollateral, bool projectedLiquidatable, bool oracleReady, uint256 requestedLeverageX10, uint256 realizedLeverageX10, uint256 projectedLtvBps))",
  "function previewMaxOpenBorrow(address collateralToken, uint256 collateralAmount) view returns (uint256 maxBorrowAmount)",
  "function previewClosePosition(uint256 positionId, uint256 closeBps) view returns (tuple(uint256 repayAmount, uint256 collateralReduced, uint256 collateralReturned, uint256 protocolFee, uint256 costBasisReduced, int256 realizedPnl, uint256 closePrice, uint256 projectedHealthBps))",
  "function previewClosePositionDetailed(uint256 positionId, uint256 closeBps) view returns (tuple(uint256 repayAmount, uint256 collateralReduced, uint256 collateralReturned, uint256 otherTokenRefund, uint256 protocolFee, uint256 costBasisReduced, int256 realizedPnl, uint256 closePrice, uint256 projectedHealthBps, uint256 lpRefund))",
  "function previewLiquidation(uint256 positionId) view returns (tuple(uint256 debtToPay, uint256 collateralClaimable, uint256 collateralRefund, uint256 otherTokenRefund, uint256 excessLpRefund, bool fullClose, uint256 liquidationFee, uint256 protocolFee, uint256 liquidatorReward, uint256 collateralBudget, uint256 badDebtShortfall, uint256 effectiveFeeBps, uint256 teamEscrowUsed, uint256 lpReserveUsed, uint256 remainingShortfall, uint256 currentDebt, uint256 safelyRealizableResidual, uint256 debtReimbursement))",
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

/** Slippage floor for amountOutMin. Exported so tests can assert it never
 *  silently becomes 0 for a real quote (guarded by the caller). */
export function applySlippage(amount, slippageBps = 50n) {
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
  // Leverage window enforced by resolveLeverageForOpen(): contract bounds
  // (MIN/MAX_LEVERAGE_X10) ∩ these config bounds ∩ marketLeverage[symbol].
  leverageMin: 1,
  leverageMax: 5,
  // Per-market leverage — { "WETH/UNI": 5 } style integer multipliers.
  marketLeverage: {},
  // When the contract rejects the requested leverage (MAM_OpenExceedsMaxLTV /
  // MAM_InvalidLeverage) step down whole turns before giving up on the market.
  leverageAutoStep: true,
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
  // CLOSE retry guard: identical retries of an unchanged position are backed off
  // exponentially (base → cap). Any ON-CHAIN change of the position resets the
  // backoff immediately, so a newly-closable position is retried right away.
  closeRetryBaseMs: 20_000,
  closeRetryMaxMs: 600_000,
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

// State file path. `NEMESIS_STATE_FILE` lets an isolated E2E runner point the bot
// at a scratch state file so the REAL auto-trader-state.json (and the #75 record
// it holds) is never written, cleared or otherwise touched by a test run.
const STATE_FILE = process.env.NEMESIS_STATE_FILE || "auto-trader-state.json";

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

/**
 * READ-ONLY STATE REGISTRY.
 *
 * A dry-run instance registers the state object it loaded, and `saveState()`
 * then refuses to write that object. This is the LAST line of defence: even if
 * a mutation site below is missed, `node auto.js --dry-run` can never rewrite
 * `auto-trader-state.json`, so its SHA-256 stays byte-identical.
 */
const READONLY_STATES = new WeakSet();

/** Mark a loaded state object as "never persist me" (used by dry-run). */
function markStateReadOnly(state) {
  try { if (state && typeof state === "object") READONLY_STATES.add(state); } catch {}
}

function saveState(state) {
  try {
    if (state && READONLY_STATES.has(state)) return;
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch {}
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
//  LEVERAGE MODULE — contract-derived bounds + per-market overrides
// ═══════════════════════════════════════════════════════════════════════════
//  Semantics recovered from the deployed implementation + real transactions
//  (NOT from argument order):
//    • leverageX10 is the 5th openPosition arg; a4=200 in tx 0xfa397f56… is
//      echoed by event MAM_LoopPositionCreated(positionId,user,leverageX10=200)
//      → tenths of a multiplier (200 = 20.0x).
//    • Only multiples of 10 are accepted (preview with 11/15/25/97 →
//      MAM_InvalidLeverage); MIN_LEVERAGE_X10()/MAX_LEVERAGE_X10() give the
//      on-chain window (10 = 1.0x … 200 = 20.0x on both deployments).
//    • Effective per-market cap is enforced through MAM_OpenExceedsMaxLTV()
//      (MAX_OPEN_LTV_BPS=9700, MIN_OPEN_HEALTH_BPS=10309): WETH/DAI with 12
//      DAI collateral passes at 2.0x and fails at 3.0x, while WETH/UNI passes
//      up to 20.0x → the cap is market/collateral dependent, so it is probed
//      with previewOpenPosition() (read-only) instead of hardcoding.
// ═══════════════════════════════════════════════════════════════════════════

const LEV_ERR_INVALID = "0xc48faa3a"; // MAM_InvalidLeverage()
const LEV_ERR_MAX_LTV = "0xee744528"; // MAM_OpenExceedsMaxLTV()
const LEV_ERR_ORACLE = "0x56e7f09d";  // MAM_OpenOracleDivergence()

/**
 * Read leverage/risk bounds from the manager. Falls back to configuration
 * when a view is missing (older deployment), never throws.
 */
export async function readLeverageBounds(provider, managerAddr, config = {}) {
  const out = {
    minX10: null, maxX10: null, maxOpenLtvBps: null, minHealthBps: null,
    source: "none",
  };
  try {
    const mgr = new ethers.Contract(managerAddr, MANAGER_ABI, provider);
    const [minX10, maxX10, ltv, health] = await Promise.all([
      mgr.MIN_LEVERAGE_X10().catch(() => null),
      mgr.MAX_LEVERAGE_X10().catch(() => null),
      mgr.MAX_OPEN_LTV_BPS().catch(() => null),
      mgr.MIN_OPEN_HEALTH_BPS().catch(() => null),
    ]);
    if (minX10 !== null && maxX10 !== null && maxX10 > 0n) {
      out.minX10 = Number(minX10);
      out.maxX10 = Number(maxX10);
      out.source = "contract";
    }
    if (ltv !== null) out.maxOpenLtvBps = Number(ltv);
    if (health !== null) out.minHealthBps = Number(health);
  } catch {}
  if (out.source === "none") {
    const cfgMin = Number(config.leverageMin ?? 1);
    const cfgMax = Number(config.leverageMax ?? config.maxLeverage ?? 5);
    out.minX10 = Math.max(10, Math.round((Number.isFinite(cfgMin) ? cfgMin : 1) * 10));
    out.maxX10 = Math.round((Number.isFinite(cfgMax) ? cfgMax : 5) * 10);
    out.source = "config";
  }
  return out;
}

function _clampIntLeverage(lev, minL, maxL) {
  let v = Math.trunc(Number(lev));
  if (!Number.isFinite(v)) return null;
  if (v < minL) v = minL;
  if (v > maxL) v = maxL;
  return v;
}

/**
 * Resolve the leverage for one OPEN attempt:
 *   requested → per-market override (config.marketLeverage[SYMBOL]) → clamped
 *   by contract bounds ∩ config bounds → probe previewOpenPosition and step
 *   DOWN (whole integer turns, never above the requested value) while the
 *   contract rejects with MAM_InvalidLeverage / MAM_OpenExceedsMaxLTV.
 *
 * Read-only: only view calls, no transaction. Returns a machine-readable plan
 * so the caller can print what will actually be sent.
 */
export async function resolveLeverageForOpen(provider, {
  managerAddr, marketSymbol = null, isLong, collateralToken = null,
  collateralAmount = null, requestedLeverage = null, config = {}, log = () => {},
} = {}) {
  const requested = Number(
    requestedLeverage ?? config.marketLeverage?.[marketSymbol] ?? config.defaultLeverage ?? 2,
  );
  const bounds = await readLeverageBounds(provider, managerAddr, config);
  const minContract = Math.max(1, Math.ceil(bounds.minX10 / 10));
  const maxContract = Math.max(1, Math.floor(bounds.maxX10 / 10));
  const cfgMin = Number.isFinite(Number(config.leverageMin)) ? Math.max(1, Math.trunc(Number(config.leverageMin))) : 1;
  const cfgMaxRaw = Number(config.leverageMax ?? config.maxLeverage);
  const cfgMax = Number.isFinite(cfgMaxRaw) && cfgMaxRaw > 0 ? Math.trunc(cfgMaxRaw) : maxContract;
  const minL = Math.max(minContract, cfgMin);
  const maxL = Math.min(maxContract, cfgMax);

  const base = {
    requested, marketSymbol, boundsSource: bounds.source,
    contractMin: minContract, contractMax: maxContract,
    configMin: cfgMin, configMax: cfgMax,
    min: minL, max: maxL, maxOpenLtvBps: bounds.maxOpenLtvBps, minHealthBps: bounds.minHealthBps,
  };

  let start = _clampIntLeverage(requested, minL, maxL);
  if (start === null) {
    return { ...base, ok: false, code: "LEVERAGE_UNRESOLVED", reason: `requested=${requested} not a usable leverage` };
  }
  if (start !== Math.trunc(requested)) {
    log(`[LEVERAGE] requested ${requested}x clamped to ${start}x (allowed ${minL}x..${maxL}x, bounds=${bounds.source})`, "warn");
  }

  const previewAt = async (lev) => {
    if (!collateralToken || collateralAmount === null || collateralAmount === undefined) return null;
    try {
      const mgr = new ethers.Contract(managerAddr, MANAGER_ABI, provider);
      const p = await mgr.previewOpenPosition(isLong, collateralToken, BigInt(collateralAmount), 0n, BigInt(lev * 10));
      return {
        ok: true,
        projectedEntryPrice: p.projectedEntryPrice.toString(),
        projectedDebt: p.projectedDebt.toString(),
        projectedHealthBps: Number(p.projectedHealthBps),
        projectedLiquidationPrice: p.projectedLiquidationPrice.toString(),
        protocolFee: p.protocolFee.toString(),
        projectedCollateral: p.projectedCollateral.toString(),
        projectedLiquidatable: !!p.projectedLiquidatable,
        oracleReady: !!p.oracleReady,
        requestedLeverageX10: Number(p.requestedLeverageX10),
        realizedLeverageX10: Number(p.realizedLeverageX10),
        projectedLtvBps: Number(p.projectedLtvBps),
      };
    } catch (e) {
      const sel = revertSelector(e);
      return { ok: false, selector: sel, err: sel === LEV_ERR_INVALID ? "INVALID_LEVERAGE"
        : sel === LEV_ERR_MAX_LTV ? "EXCEEDS_MAX_LTV"
        : sel === LEV_ERR_ORACLE ? "ORACLE_DIVERGENCE"
        : (e?.shortMessage || e?.message || "preview failed").slice(0, 120) };
    }
  };

  const autoStep = config.leverageAutoStep !== false;
  let lev = start;
  let preview = await previewAt(lev);
  let steppedFrom = null;
  while (preview && preview.ok === false &&
    (preview.err === "INVALID_LEVERAGE" || preview.err === "EXCEEDS_MAX_LTV") &&
    autoStep && lev > minL) {
    if (steppedFrom === null) steppedFrom = start;
    lev -= 1;
    log(`[LEVERAGE] ${marketSymbol || "market"} ${lev + 1}x rejected by contract (${preview.err}) — trying ${lev}x`, "warn");
    preview = await previewAt(lev);
  }

  if (preview && preview.ok === false && (preview.err === "INVALID_LEVERAGE" || preview.err === "EXCEEDS_MAX_LTV")) {
    return {
      ...base, ok: false, leverage: lev, leverageX10: lev * 10, requestedStart: start,
      code: preview.err === "INVALID_LEVERAGE" ? "LEVERAGE_INVALID" : "LEVERAGE_EXCEEDS_MAX_LTV",
      reason: `no leverage in ${minL}x..${start}x passes this market/collateral (last: ${preview.err})`,
      preview,
    };
  }

  const result = {
    ...base, ok: true, leverage: lev, leverageX10: lev * 10, requestedStart: start,
    steppedFrom, probed: preview !== null, preview: preview && preview.ok ? preview : null,
  };
  if (preview && preview.ok) {
    if (preview.projectedLiquidatable) {
      result.code = "OPEN_LIQUIDATABLE";
      result.ok = false;
      result.reason = `preview says the position would be liquidatable immediately (health ${preview.projectedHealthBps} bps)`;
    } else if (!preview.oracleReady) {
      // Non-fatal: the OPEN flow runs an oracle checkpoint before sending.
      log(`[LEVERAGE] preview oracleReady=false — checkpoint will run before the open`, "warn");
    }
  }
  log(`[LEVERAGE] resolved ${lev}x for ${marketSymbol || "market"} ${isLong ? "LONG" : "SHORT"} (requested ${requested}x, bounds ${bounds.source} ${minContract}x..${maxContract}x${steppedFrom ? `, stepped down from ${steppedFrom}x` : ""}${result.probed ? `, ltv=${result.preview.projectedLtvBps}bps health=${result.preview.projectedHealthBps}bps` : ""})`, "info");
  return result;
}

// ═══════════════════════════════════════════════════════════════════════════
//  SWAP LOGIC — ETH safety preserved
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Execute a Router swap.
 * @param {string[]} [path] — validated route path (direct [A,B] or multi-hop [A,HUB,B])
 * @param {object} [report] — optional out-param; filled with {ok, code, reason,
 *        allowance, preflight, txHash, blockNumber, gasUsed} so callers can log a
 *        machine-readable [SWAP SKIP] line instead of guessing why it failed.
 *        On success the return value is truthy AND report.ok === true; on failure
 *        the return value is `false` (falsy) and report.code carries the reason.
 */
async function executeSwap({ wallet, provider, fromToken, toToken, amount, amountOutMin, config, log, txManager, path: pathArg = null, report = null, allowApprove = true }) {
  const R = (report && typeof report === "object") ? report : {};
  R.ok = false;
  const fail = (code, reason) => { R.ok = false; R.code = code; R.reason = reason; return false; };

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
  const allowanceOk = allowance >= amount;
  R.allowance = allowanceOk ? "OK" : "REQUIRED";
  log(allowanceOk
    ? `[SWAP] allowance OK ${fromSym}: ${ethers.formatUnits(allowance, srcDecimals)} >= needed ${ethers.formatUnits(amount, srcDecimals)} — no approve`
    : `[SWAP] approve required ${fromSym}: allowance ${ethers.formatUnits(allowance, srcDecimals)} < needed ${ethers.formatUnits(amount, srcDecimals)}`, "info");
  let approveTxHash = null;
  if (allowance < amount) {
    if (!allowApprove) {
      // SINGLE-SWAP contract: exactly ONE transaction. An approval would be a
      // second one, so the operation is refused instead of silently expanded.
      log(`[SWAP] BLOCKED — allowance ${ethers.formatUnits(allowance, srcDecimals)} < needed ${ethers.formatUnits(amount, srcDecimals)} and approvals are not allowed in single-swap mode`, "error");
      return fail("APPROVAL_REQUIRED", `allowance ${ethers.formatUnits(allowance, srcDecimals)} < needed ${ethers.formatUnits(amount, srcDecimals)} (allowApprove=false)`);
    }
    log(`[SWAP] Approve ${fromSym} → Router...`, "info");
    if (txManager) {
      const r = await txManager.sendAndWait({
        wallet, provider, txType: "SWAP-APPROVE",
        sendFn: (nonce) => fromContract.approve(routerAddr, ethers.MaxUint256, { gasLimit: 100000n, nonce }),
        log,
      });
      if (r.status === 0) { log(`[SWAP] Approve REVERTED`, "error"); return fail("INSUFFICIENT_ALLOWANCE", "approve transaction reverted"); }
      approveTxHash = r.hash || null;
    } else {
      const approveTx = await fromContract.approve(routerAddr, ethers.MaxUint256, { gasLimit: 100000n });
      approveTxHash = approveTx.hash;
      await approveTx.wait();
    }
    log(`[SWAP] Approved`, "success");
  }
  R.approveTxHash = approveTxHash;

  const path = (pathArg && pathArg.length >= 2) ? pathArg : [fromToken, toToken];
  const deadline = Math.floor(Date.now() / 1000) + config.deadlineSeconds;
  const calldata = router.interface.encodeFunctionData("swapExactTokensForTokens", [amount, amountOutMin, path, walletAddr, deadline]);

  try { await provider.call({ from: walletAddr, to: routerAddr, data: calldata, value: 0n }); R.preflight = "PASS"; }
  catch (e) { R.preflight = "FAIL"; log(`[SWAP] Pre-flight REVERTED: ${e.message?.slice(0, 60)}`, "error"); return fail("PREFLIGHT_REVERT", String(e?.shortMessage || e?.message || e).slice(0, 120)); }

  let gasEstimate;
  try { gasEstimate = await provider.estimateGas({ from: walletAddr, to: routerAddr, data: calldata, value: 0n }); }
  catch (e) { log(`[SWAP] Gas estimation FAILED`, "error"); return fail("PREFLIGHT_REVERT", `gas estimation failed: ${String(e?.message || e).slice(0, 80)}`); }

  log(`[SWAP-DEBUG] gasEstimate=${gasEstimate}`, "info");

  const ethBalance = await provider.getBalance(walletAddr);
  const feeData = await provider.getFeeData();
  const gasCost = gasEstimate * (feeData.gasPrice || 0n);
  const gasReserve = ethers.parseEther(String(config.ethGuard?.MIN_ETH_GAS_RESERVE ?? 0.003));
  log(`[SWAP-DEBUG] ethBalance=${ethers.formatEther(ethBalance)} gasCost=${ethers.formatEther(gasCost)} gasReserve=${ethers.formatEther(gasReserve)}`, "info");
  if (ethBalance < gasCost + gasReserve) { log(`[SWAP] BLOCKED: ETH < gas reserve`, "error"); return fail("GAS_RESERVE", "ETH balance below the gas reserve"); }

  const gasLimit = gasEstimate + gasEstimate / 5n;
  if (txManager) {
    const r = await txManager.sendAndWait({
      wallet, provider, txType: "SWAP",
      sendFn: (nonce) => router.swapExactTokensForTokens(amount, amountOutMin, path, walletAddr, deadline, { gasLimit, nonce }),
      log,
    });
    if (!r || r.status === 0) { log(`[SWAP] TX FAILED`, "error"); return fail("TX_REVERTED", "receipt.status === 0"); }
    if (r.pending) { log(`[SWAP] TX pending — will confirm later`, "warn"); return { ok: true, pending: true, txHash: r.hash || null, approveTxHash }; }
    log(`[SWAP] SUCCESS gas=${r.receipt.gasUsed}`, "success");
    R.ok = true; R.txHash = r.hash; R.blockNumber = r.receipt?.blockNumber ?? null; R.gasUsed = String(r.receipt?.gasUsed ?? "");
    return { ok: true, txHash: r.hash, blockNumber: r.receipt?.blockNumber ?? null, approveTxHash, path };
  } else {
    log(`[SWAP] TX_SENT`, "warn");
    const swapTx = await router.swapExactTokensForTokens(amount, amountOutMin, path, walletAddr, deadline, { gasLimit });
    log(`[SWAP] TX hash=${swapTx.hash}`, "info");
    const receipt = await swapTx.wait();
    if (receipt.status !== 1) { log(`[SWAP] TX FAILED (status=0)`, "error"); return fail("TX_REVERTED", "receipt.status === 0"); }
    log(`[SWAP] SUCCESS gas=${receipt.gasUsed}`, "success");
    R.ok = true; R.txHash = swapTx.hash; R.blockNumber = receipt.blockNumber; R.gasUsed = String(receipt.gasUsed);
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
      // Journal enrichment — leverage is part of the on-chain evidence for this open.
      meta: {
        side,
        leverage: Number(leverage),
        leverageX10: Number(leverage) * 10,
        manager: managerAddr,
        pool: poolAddr ?? null,
      },
    });
    if (!r || r.status === 0) { log(`[BLOCKED] TX FAILED`, "error"); return null; }
    if (r.pending) {
      log(`[OPEN] TX ${r.txState || "PENDING"} hash=${r.hash} — not confirmed, NOT counted as an open`, "warn");
      return { txHash: r.hash, positionId: null, gasUsed: 0n, blockNumber: null, pending: true, txState: r.txState || TX_STATE.PENDING };
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
    // The receipt says CONFIRMED but the post-confirmation read contradicts it.
    txManager?.journal?.transition(txHash, TX_STATE.CONFIRMED_STATE_MISMATCH, { reason: verify.reason, positionId });
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
  const isLiquidityErr = (e) => e === ERR_INSUFFICIENT_LIQUIDITY || e === ERR_POOL_INSUFFICIENT_OUTPUT;

  const samples = [];
  let seed = null;
  let upperFail = null; // first (higher) ladder sample that failed
  let lastErr = null;
  for (const bps of LADDER) {
    const r = await probe(bps);
    samples.push({ bps, ok: r.ok, err: r.err || null });
    if (r.ok) { seed = bps; break; }
    lastErr = r.err;
    if (r.err === "PROBE_LIMIT") return { ok: false, code: "PROBE_LIMIT", probes };
    upperFail = bps;
  }

  // GAP SEARCH — the ladder is coarse and the feasible window can sit BETWEEN two
  // rungs that fail for DIFFERENT reasons (lower rung: MAM_CloseAmountTooSmall,
  // upper rung: MAM_InsufficientLiquidity / Pool_InsufficientOutputAmount).
  // Inside such a gap the predicate is monotone (too-small → pass → illiquid), so
  // a binary search is sound. Without this pass a genuinely closable position is
  // reported as unclosable and the bot retries an identical close forever.
  if (seed === null) {
    for (let i = 1; i < samples.length; i++) {
      const hiS = samples[i - 1];
      const loS = samples[i];
      if (hiS.ok || loS.ok) continue;
      if (!isLiquidityErr(hiS.err) || loS.err !== ERR_CLOSE_AMOUNT_TOO_SMALL) continue;
      if (hiS.bps - loS.bps <= 1n) continue;
      let lo = loS.bps;
      let hi = hiS.bps;
      while (hi - lo > 1n) {
        if (probes >= maxProbes) break;
        const mid = (lo + hi) / 2n;
        const r = await probe(mid);
        if (r.ok) { seed = mid; upperFail = hi; break; }
        if (r.err === "PROBE_LIMIT") return { ok: false, code: "PROBE_LIMIT", probes };
        if (r.err === ERR_CLOSE_AMOUNT_TOO_SMALL) lo = mid; else hi = mid;
      }
      if (seed !== null) break;
    }
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
async function attemptPartialClose({ wallet, provider, managerAddr, positionId, config, log, txManager, targetCloseBps = null }) {
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
    let closeBps;
    let quote;
    let probes = 0;
    if (targetCloseBps !== null && targetCloseBps !== undefined) {
      // Operator-specified percentage (--single=partial --pct=N): validate the
      // exact closeBps with one read-only preview instead of searching.
      const wanted = BigInt(targetCloseBps);
      if (wanted < 1n || wanted > MAX_PARTIAL_CLOSE_BPS) {
        return {
          failed: true, clearState: false, code: "PARTIAL_BPS_RANGE",
          reason: `closeBps ${wanted} outside 1..${MAX_PARTIAL_CLOSE_BPS} (100% is only possible through closePosition())`,
        };
      }
      const pv = await previewCloseAt(provider, managerAddr, positionId, wanted);
      if (!pv.ok) {
        const sel = pv.err;
        const detail = sel === ERR_CLOSE_AMOUNT_TOO_SMALL
          ? "MAM_CloseAmountTooSmall — requested slice is below the contract minimum"
          : sel === ERR_INSUFFICIENT_LIQUIDITY || sel === ERR_POOL_INSUFFICIENT_OUTPUT
            ? "pool liquidity cannot absorb this slice"
            : `preview revert ${sel || "unknown"}`;
        log(`[BLOCKED] partial ${wanted}bps preview FAILED: ${detail} — keeping state`, "error");
        return { failed: true, clearState: false, code: `TARGET_BPS_${sel || "REVERT"}`, reason: detail };
      }
      closeBps = wanted;
      quote = pv.quote;
      log(`[CLOSE] operator closeBps=${closeBps} accepted by previewClosePosition`, "info");
    } else {
      const found = await findMaxCloseBps(provider, managerAddr, positionId, { log });
      if (!found.ok) {
      // ─── CONTROLLED WAIT (not a failure, not an error, not a clear) ───────
      // No closeBps in 1..9999 satisfies BOTH contract invariants at once:
      //   bps too small → MAM_CloseAmountTooSmall (0x01556191)
      //   bps too large → MAM_InsufficientLiquidity (0xf71ff020)
      // That is a genuine on-chain market condition (degraded pool / thin
      // liquidity), NOT a bot bug. The position is STAYS ACTIVE and STAYS
      // TRACKED; the cycle continues with SWAP/OPEN and re-probes read-only
      // after an exponential backoff. Nothing is cleared, nothing is sent.
      const detail = found.code === "CLOSE_AMOUNT_TOO_SMALL"
        ? "every bps ≥ 1 reverts MAM_CloseAmountTooSmall — position is dust-sized relative to the contract minimum"
        : found.code === "PROBE_LIMIT"
          ? `probe budget exhausted after ${found.probes} eth_calls`
          : `no bps in 1..9999 passes previewClosePosition (${found.probes} read-only probes, last revert=${found.lastErr || "none"}) — pool liquidity cannot absorb even 1% of this position`;
      log(`[WAIT] CLOSE_BPS_NOT_FOUND #${positionId}: ${detail}`, "warn");
      log(`[WAIT] position #${positionId} REMAINS ACTIVE and TRACKED — no state cleared, no TX sent; re-probing read-only after backoff`, "info");
      return {
        failed: true, clearState: false, code: found.code, wait: true,
        reason: `CLOSE_BPS_NOT_FOUND: ${detail}`,
      };
      }

      closeBps = found.closeBps;
      quote = found.quote;
      probes = found.probes;
    }

    const amountOut = quote.collateralReturned;
    const amountOutMin = (amountOut * (BPS_DENOM - slippageBps)) / BPS_DENOM;
    if (!(amountOutMin > 0n)) {
      log(`[BLOCKED] partial close quote returned zero collateral (amountOutMin=0) — keeping state`, "error");
      return { failed: true, clearState: false, code: "ZERO_AMOUNT_OUT_MIN", reason: "partial close quote returned zero collateral" };
    }

    log(`[CLOSE] partialClose closeBps=${closeBps} amountOut=${amountOut} amountOutMin=${amountOutMin} repay=${quote.repayAmount} fee=${quote.protocolFee} realizedPnl=${quote.realizedPnl} (probes=${probes})`, "info");

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
      log(`[BLOCKED] partialClose gas estimation FAILED — keeping state`, "error");
      return { failed: true, clearState: false, code: "PARTIAL_GAS_ESTIMATE", partial: true, reason: "partialClose gas estimation failed" };
    }

    const gasLimit = gasEstimate + gasEstimate / 5n;
    let txHash, receipt;
    if (txManager) {
      const r = await txManager.sendAndWait({
        wallet, provider, txType: "PARTIAL-CLOSE",
        sendFn: (nonce) => wallet.sendTransaction({ to: managerAddr, data: calldata, value: 0n, gasLimit, nonce }),
        log,
        meta: { positionId: String(positionId), closeBps: Number(closeBps) },
      });
      if (!r || r.status === 0) {
        log(`[BLOCKED] partialClose TX FAILED — keeping state`, "error");
        return { failed: true, clearState: false, code: "PARTIAL_TX_FAILED", partial: true, reason: "partialClose TX failed", last };
      }
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
      if (receipt.status !== 1) {
        log(`[BLOCKED] partialClose TX FAILED (status=0) — keeping state`, "error");
        return { failed: true, clearState: false, code: "PARTIAL_TX_FAILED", partial: true, reason: "partialClose TX status=0", txHash, last };
      }
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
    if (sel === ERR_INSUFFICIENT_LIQUIDITY || sel === ERR_POOL_INSUFFICIENT_OUTPUT) {
      log(`[CLOSE] ${sel === ERR_POOL_INSUFFICIENT_OUTPUT ? "Pool_InsufficientOutputAmount" : "MAM_InsufficientLiquidity"} on full close — read-only closeBps search + partialClose fallback`, "warn");
      return attemptPartialClose({ wallet, provider, managerAddr, positionId, config, log, txManager });
    }
    log(`[BLOCKED] Close pre-flight REVERTED ${sel || e.message?.slice(0, 60)} — position KEPT (not clearing state)`, "error");
    return { failed: true, clearState: false, code: `CLOSE_PREFLIGHT_${sel || "UNKNOWN"}`, reason: `pre-flight revert ${sel || e.message?.slice(0, 40)}` };
  }

  let gasEstimate;
  try {
    gasEstimate = await provider.estimateGas({ from: walletAddr, to: managerAddr, data: calldata, value: 0n });
  } catch (e) {
    const selGas = revertSelector(e);
    if (selGas === ERR_INSUFFICIENT_LIQUIDITY || selGas === ERR_POOL_INSUFFICIENT_OUTPUT) {
      log(`[CLOSE] ${selGas} on close gas estimation — read-only closeBps search + partialClose fallback`, "warn");
      return attemptPartialClose({ wallet, provider, managerAddr, positionId, config, log, txManager });
    }
    log(`[BLOCKED] Close gas estimation FAILED (${selGas || "unknown"}) — position KEPT`, "error");
    return { failed: true, clearState: false, code: `CLOSE_GAS_ESTIMATE_${selGas || "UNKNOWN"}`, reason: "close gas estimation failed" };
  }

  const gasLimit = gasEstimate + gasEstimate / 5n;
  let txHash, receipt;
  if (txManager) {
    const r = await txManager.sendAndWait({
      wallet, provider, txType: "CLOSE",
      sendFn: (nonce) => wallet.sendTransaction({ to: managerAddr, data: calldata, value: 0n, gasLimit, nonce }),
      log,
      meta: { positionId: String(positionId) },
    });
    if (!r || r.status === 0) {
      log(`[BLOCKED] Close TX FAILED — position KEPT`, "error");
      return { failed: true, clearState: false, code: "CLOSE_TX_FAILED", reason: "close TX failed" };
    }
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
    if (receipt.status !== 1) {
      log(`[BLOCKED] Close TX FAILED (status=0) — position KEPT`, "error");
      return { failed: true, clearState: false, code: "CLOSE_TX_FAILED", reason: "close TX status=0", txHash };
    }
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
    // ─── DRY-RUN IS READ-ONLY ───────────────────────────────────────────────
    // The loaded state is a SNAPSHOT: a dry run may read it, quote against it
    // and report what it would do, but it must never write it back. Registering
    // the object makes every saveState() call below a no-op for this instance.
    if (this.config.dryRun) markStateReadOnly(this.state);
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

    // SWAP MAINTENANCE ENGINE — runs independently of OPEN/CLOSE.
    // Per-ROUTE backoff (never global) + the timestamp of the last settled swap
    // so the min-interval gate can be enforced between real transactions.
    const swapCfg = normalizeSwapConfig(this.config);
    this.swapBackoff = new SwapRouteBackoff({
      maxConsecutiveFailures: swapCfg.maxConsecutiveFailures,
      baseMs: swapCfg.routeBackoffMs,
      maxMs: swapCfg.routeBackoffMaxMs,
    });
    this._lastSwapTxAt = 0;
    this._lastSwapCycleAt = 0;
    // ONE active swap scheduler per bot instance (see runSwapLoop/start guards).
    this._swapLoopRunning = false;
    this._cycleNo = 0;
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
    if (this._isDry()) {
      this.log(`[DRY] would DISABLE ${key} — ${reason} (state untouched)`, "info");
      return;
    }
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
    if (this._isDry()) {
      this.log(`[DRY] would record direction failure ${key} (state untouched)`, "info");
      return;
    }
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
    if (this._isDry()) {
      this.log(`[DRY] would re-enable ${key} (state untouched)`, "info");
      return;
    }
    if (this.directionDisabled[key]) {
      delete this.directionDisabled[key];
      this.state.directionDisabled = this.directionDisabled;
      saveState(this.state);
      this.log(`[DISCOVERY] RE-ENABLED ${key}`, "success");
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  //  DRY-RUN READ-ONLY GUARD
  //
  //  Every persistent-state mutation below routes through one of these helpers.
  //  In dry-run they log what WOULD happen and return immediately, so neither
  //  the in-memory state nor the state file (see READONLY_STATES) ever changes.
  //  Live runs (`npm start`, `npm run auto`) are completely unaffected.
  // ═════════════════════════════════════════════════════════════════════════

  /** True when this instance runs with `--dry-run` and must not persist anything. */
  _isDry() { return !!this.config.dryRun; }

  /** Persist state (no-op for a dry-run instance — see READONLY_STATES). */
  _save() { saveState(this.state); }

  /** Rotation recency/counts for a SWAP direction — skipped in dry-run. */
  _rotSwapSkip(from, to) {
    if (this._isDry()) return;
    try { this.rotation.recordSwapPairSkip(from, to); } catch { /* best-effort */ }
  }

  /** Rotation recency/counts for a settled SWAP — skipped in dry-run. */
  _rotSwapDone(from, to) {
    if (this._isDry()) return;
    try { this.rotation.recordSwapPair(from, to); } catch { /* best-effort */ }
  }

  /** Rotation recency/counts for a SKIPPED MARKET×SIDE — skipped in dry-run. */
  _rotMarketSkip(symbol, side) {
    if (this._isDry()) return;
    try {
      this.rotation.recordMarketSideSkip(symbol, side);
      this.state.rotation = this.rotation.toJSON();
    } catch { /* best-effort */ }
  }

  /** Rotation recency/counts for a PLANNED MARKET×SIDE — skipped in dry-run. */
  _rotMarketDone(symbol, side) {
    if (this._isDry()) return;
    try {
      this.rotation.recordMarketSide(symbol, side);
      this.state.rotation = this.rotation.toJSON();
    } catch { /* best-effort */ }
  }

  /** Copy rotation into state (and persist) — skipped in dry-run. */
  _syncRotation() {
    if (this._isDry()) return;
    this.state.rotation = this.rotation.toJSON();
    saveState(this.state);
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
  /**
   * Plan up to `max` viable candidates for `side` (rotation-ordered).
   *
   * Every candidate goes through a READ-ONLY viability gate first (collateral
   * context → P2 invariants → quote precheck), so a candidate that could not
   * open anyway never occupies one of the `max` slots and the cycle does not
   * end in "[BLOCKED] Open failed on all candidate markets" while viable
   * markets were still untried. The gate is bounded (max*8 probes) and past the
   * budget a candidate is accepted as-is — planning can never starve the cycle.
   */
  async planMarketsForSide(side, { max = 3 } = {}) {
    await this.ensureMarkets();
    const out = [];
    const exclude = [];
    const { provider, wallet } = this.getRuntime();
    const walletAddr = wallet?.address || null;
    const hardProbes = Math.max(Number(max) * 8, 40);
    let probes = 0;
    while (out.length < max) {
      const m = this.resolveMarket(side, { excludeSymbols: exclude });
      if (!m) break;
      exclude.push(m.symbol);
      if (++probes > hardProbes) { out.push(m); continue; }
      const v = await this._marketSideViable(m, side, { provider, walletAddr });
      if (v.ok) { out.push(m); continue; }
      this.log(`[PLAN] ${m.symbol} ${side} dropped before attempts — ${v.reason} (read-only viability gate)`, "info");
      // Recency-only: rotation moves to the next candidate, coverage counters
      // stay honest (a skip is not an open). Nothing is persisted here.
      this._rotMarketSkip(m.symbol, side);
    }
    return out;
  }

  /**
   * Read-only viability gate for ONE candidate×side — exactly the three checks
   * the OPEN loop performs, so planning and execution agree on "viable".
   * Probe errors are treated as "keep": a flaky RPC must never empty the plan.
   */
  async _marketSideViable(candidate, side, { provider, walletAddr }) {
    try {
      const ctx = await this._candidateContext(candidate, side, { provider, walletAddr });
      if (!ctx) return { ok: false, reason: "no collateral context" };
      const inv = await this._assertCandidateInvariants(candidate, ctx, side, provider);
      if (!inv.ok) return { ok: false, reason: `invariant — ${inv.reason}` };
      const pre = await precheckMarketQuote(provider, {
        pool: ctx.poolAddr, manager: ctx.managerAddr,
        collateralToken: ctx.collateralToken, collateralAmount: ctx.collateralAmount,
        leverageX10: BigInt(Math.round(Number(this.config.marketLeverage?.[candidate.symbol] ?? this.config.defaultLeverage) * 10)),
        isLong: side === "LONG", log: () => {},
      });
      if (!pre.ok) return { ok: false, reason: `quote precheck ${pre.code || "UNUSABLE"}` };
      return { ok: true };
    } catch (e) {
      return { ok: true, reason: `probe error (${String(e?.message || e).slice(0, 40)}) — kept` };
    }
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
        leverageX10: BigInt(Math.round(Number((this.config.marketLeverage?.[candidate?.symbol] ?? this.config.defaultLeverage) || 2) * 10)),
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

      this.log(`[CYCLE] #${++this._cycleNo}`, "warn");
      this.log("[CYCLE] ═══ CYCLE START ═══", "info");

      // Log full token inventory
      await logInventory(provider, walletAddr, this.log.bind(this));

      // Settle any OPEN tx that is still PENDING before anything is decided.
      // Only a receipt may turn a submitted open into a counted open.
      await this._settlePendingOpen();

      // NEXT ACTION prediction for TUI
      if (this.state.activePosition) {
        this.log(`[AUTO] NEXT ACTION: CLOSE position #${this.state.activePosition.positionId}`, "info");
      } else {
        this.log(`[AUTO] NEXT ACTION: SWAP + OPEN ${this.config.defaultLeverage}x`, "info");
      }

      // PHASE 1: If active position → CLOSE (always via the position's OWN manager).
      // closeActivePosition() owns the whole path: on-chain truth first (gone →
      // clear, active → attempt, unreadable → backoff), manager taken from THIS
      // position, retry backoff on an unchanged position.
      //
      // A close that cannot happen right now (pool liquidity / preflight / backoff)
      // is NOT fatal: the position is KEPT, the backoff stands and the cycle keeps
      // running. Only an on-chain-proven close unlocks the OPEN phase.
      //
      // `closeOk` records what PHASE 1 concluded. A DRY RUN never clears
      // `activePosition` (read-only), so PHASE 1.5b below uses this flag instead
      // of `activePosition === null` to decide whether the OPEN phase may run.
      let closeOk = false;
      if (this.state.activePosition) {
        this.setState(STATES.CLOSE);
        const closeOutcome = (await this.closeActivePosition())
          || { ok: false, blocked: true, continueCycle: true, code: "NO_RESULT" };
        closeOk = !!closeOutcome.ok;
        if (closeOutcome.ok) {
          this.setState(STATES.COOLDOWN);
          this.log(`[COOLDOWN] ${this.config.cooldownAfterCloseMs / 1000}s...`, "info");
          await this.sleep(this.config.cooldownAfterCloseMs);
          this.lastCycleAction = "close";
        } else {
          this.lastCycleAction = "close-blocked";
          this.log(`[CLOSE] ${closeOutcome.blocked ? "blocked" : "deferred"} (code=${closeOutcome.code || "?"}) — position KEPT, cycle continues`, "warn");
        }
      }

      // PHASE 1.5 — SWAP MAINTENANCE. Runs after (or instead of) CLOSE and is
      // completely independent of it: a blocked/deferred close never stops the
      // rotation, never parks the engine and never clears activePosition.
      this.setState(STATES.AUTO_SWAP);
      const swapAfterClose = await this.runSwapMaintenanceCycle({ phase: "PHASE-1.5" });
      this.log(`[CYCLE] swap maintenance (after CLOSE): attempted=${swapAfterClose.attempted} verified=${swapAfterClose.verified} skipped=${swapAfterClose.skipped} failed=${swapAfterClose.failed}`, "info");

      // PHASE 1.5b — the tracked position is STILL active on-chain.
      //
      // This bot tracks EXACTLY ONE position: opening a second one would overwrite
      // (and later clear) the record of an active position, so the OPEN phase is
      // skipped while a record is held. The swap engine already ran its own pass
      // above, so liquidity trouble on CLOSE can never stall swaps — the cycle
      // ends cleanly instead of being cut short.
      //
      // DRY-RUN EXCEPTION: the record is held only because dry-CLOSE is
      // read-only. `closeOk` says the close would have succeeded, so the full
      // PHASE 2/3 plan still runs — without a single state write.
      const heldByDryRun = dryRun && closeOk;
      if (this.state.activePosition && !heldByDryRun) {
        const held = this.state.activePosition;
        this.log(`[CYCLE] position #${held.positionId} still active — OPEN skipped (single-position bookkeeping); SWAP engine continued independently`, "warn");
        this.log("[CYCLE] ═══ CYCLE END ═══", "info");
        return;
      }
      if (this.state.activePosition && heldByDryRun) {
        this.log(`[DRY] position #${this.state.activePosition.positionId} record kept (read-only dry-run) — continuing to the OPEN phase`, "info");
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
      let openedLeverage = null;
      for (const candidate of marketCandidates) {
        this.log(`[OPEN] trying market ${candidate.symbol} manager=${short(candidate.managerAddr)}`, "info");

        const ctx = await this._candidateContext(candidate, side, { provider, walletAddr });
        if (!ctx) {
          this.log(`[OPEN] market ${candidate.symbol} skipped (collateral context) — trying next candidate`, "warn");
          this._rotMarketSkip(candidate.symbol, side);
          continue;
        }

        // P2 hard invariants — manager/pool/paymentToken/collateral/decimals must all
        // belong to THIS candidate's market. Any mismatch → SKIP (never open).
        const inv = await this._assertCandidateInvariants(candidate, ctx, side, provider);
        if (!inv.ok) {
          this.log(`[SKIP] ${candidate.symbol} ${side}: invariant failed — ${inv.reason} — trying next candidate`, "warn");
          this._rotMarketSkip(candidate.symbol, side);
          continue;
        }

        // LEVERAGE — contract bounds ∩ config ∩ per-market override, probed with
        // previewOpenPosition (read-only). A market that cannot reach any legal
        // leverage is SKIPPED with an explicit reason, never opened blind.
        const levPlan = await this._resolveOpenLeverage(candidate, side, ctx, provider);
        if (!levPlan.ok) {
          this.log(`[SKIP] ${candidate.symbol} ${side}: leverage unresolved (${levPlan.code}: ${levPlan.reason}) — trying next candidate`, "warn");
          this._rotMarketSkip(candidate.symbol, side);
          continue;
        }

        // READ-ONLY viability pre-check (pool/manager view calls only, no transaction).
        // A candidate whose minimum collateral size is dust for this pool's liquidity is
        // SKIPPED with an explicit reason — it is NOT counted as a direction failure.
        const pre = await precheckMarketQuote(provider, {
          pool: ctx.poolAddr, manager: ctx.managerAddr,
          collateralToken: ctx.collateralToken, collateralAmount: ctx.collateralAmount,
          leverageX10: BigInt(levPlan.leverageX10),
          isLong: side === "LONG", log: this.log.bind(this),
        });
        if (!pre.ok) {
          this.log(`[SKIP] ${candidate.symbol} ${side}: quote not viable (${pre.code || "QUOTE_UNUSABLE"}: ${pre.reason}) — trying next candidate`, "warn");
          this._rotMarketSkip(candidate.symbol, side);
          continue;
        }

        // Collateral top-up derived from scratch for THIS candidate
        const ready = await this._ensureCollateralForCtx(ctx, { provider, wallet, walletAddr, dryRun, allowEthWrap: false });
        if (!ready) {
          this.log(`[SKIP] ${candidate.symbol} ${side}: collateral not ready — trying next candidate`, "warn");
          this._rotMarketSkip(candidate.symbol, side);
          continue;
        }

        this.setState(STATES.OPEN);
        const attempt = await openPosition({
          wallet, provider, managerAddr: ctx.managerAddr, poolAddr: ctx.poolAddr,
          side, collateralToken: ctx.collateralToken, collateralAmount: ctx.collateralAmount,
          leverage: levPlan.leverage,
          config: this.config, log: this.log.bind(this), dryRun, txManager: this.txManager,
          paymentToken: ctx.paymentToken,
        });
        openResult = attempt;
        if (attempt) {
          openedMarket = candidate;
          openedCtx = ctx;
          openedLeverage = levPlan.leverage;
          break;
        }
        this._recordDirectionFailure(candidate.symbol, side);
        this.log(`[OPEN] market ${candidate.symbol} failed — trying next candidate`, "warn");
      }
      const marketUsed = openedMarket || market;
      const ctxUsed = openedCtx;

      if (openResult?.dryRun) {
        // ─── DRY-OPEN: REPORT ONLY ─────────────────────────────────────────
        // lastSide, rotation recency/counts and sessionStats are persistent
        // state — a dry run must leave every one of them byte-identical.
        this.log(`[DRY] Open would execute on ${marketUsed.symbol}`, "info");
        this.log(`[DRY] state untouched — lastSide/rotation/sessionStats unchanged`, "info");
      } else if (openResult?.pending) {
        // SUBMITTED/PENDING is NOT an open. The record is kept (so the cycle can
        // never double-open) but sessionStats.opens is NOT incremented and no
        // success is reported until a receipt proves the position exists.
        this.state.activePosition = {
          positionId: openResult.positionId ?? null,
          side,
          collateralToken: ctxUsed?.collateralToken || marketUsed.collateralToken,
          collateralAmount: String(ctxUsed?.collateralAmount ?? ""),
          paymentToken: ctxUsed?.paymentToken || marketUsed.paymentToken || null,
          leverage: openedLeverage ?? this.config.defaultLeverage,
          openedAt: Date.now(),
          txHash: openResult.txHash,
          marketSymbol: marketUsed.symbol,
          managerAddr: marketUsed.managerAddr,
          poolAddr: marketUsed.poolAddr,
          pendingOpen: true,
        };
        saveState(this.state);

        this.setState(STATES.MONITOR);
        this.log(`[OPEN] PENDING tx=${openResult.txHash} — awaiting confirmation; sessionStats.opens NOT incremented`, "warn");

        this.log(`[COOLDOWN] ${this.config.cooldownAfterOpenMs / 1000}s...`, "info");
        await this.sleep(this.config.cooldownAfterOpenMs);
      } else if (openResult) {
        this._recordDirectionSuccess(marketUsed.symbol, side);
        this._rotMarketDone(marketUsed.symbol, side);
        this.state.activePosition = {
          positionId: openResult.positionId,
          side,
          // All of these come from the SAME candidate that actually opened
          collateralToken: ctxUsed?.collateralToken || marketUsed.collateralToken,
          collateralAmount: String(ctxUsed?.collateralAmount ?? ""),
          paymentToken: ctxUsed?.paymentToken || marketUsed.paymentToken || null,
          leverage: openedLeverage ?? this.config.defaultLeverage,
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

      // PHASE 3 — SWAP MAINTENANCE keeps running regardless of the OPEN outcome.
      // Whether the OPEN succeeded, was deferred or was blocked, the rotation
      // gets its own independent pass here (subject to the min-interval gate).
      this.setState(STATES.AUTO_SWAP);
      const swapAfterOpen = await this.runSwapMaintenanceCycle({ phase: "PHASE-3" });
      this.log(`[CYCLE] swap maintenance (after OPEN): attempted=${swapAfterOpen.attempted} verified=${swapAfterOpen.verified} skipped=${swapAfterOpen.skipped} failed=${swapAfterOpen.failed}`, "info");
      await logInventory(provider, walletAddr, this.log.bind(this));

      this.lastCycleAction = openResult ? "open" : "idle";
      this.log("[CYCLE] ═══ CYCLE END ═══", "info");
    } catch (e) {
      this.log(`[ERROR] Cycle error: ${e.message?.slice(0, 80)}`, "error");
      this.txManager.resetNonce();
    } finally {
      this.cycleRunning = false;
    }
  }

  /**
   * Boot banner — what the swap engine will do in this run. Purely informational:
   * it reads `config.swap` (via normalizeSwapConfig) and starts NOTHING itself.
   */
  _logSwapBoot() {
    const cfg = normalizeSwapConfig(this.config);
    this.log(`[NEMESIS] Bot started${this.config.dryRun ? " (DRY RUN)" : " (LIVE)"}`, "warn");
    this.log(`[SWAP] Engine ${cfg.enabled ? "enabled" : "disabled"}`, cfg.enabled ? "info" : "warn");
    this.log(`[SWAP] Rotation: ${cfg.rotatePairs ? "enabled" : "disabled"}`, "info");
    this.log(`[SWAP] Reverse directions: ${cfg.reverseDirections ? "enabled" : "disabled"}`, "info");
    this.log(`[SWAP] Interval: ${cfg.minIntervalMs}-${cfg.maxIntervalMs}ms · slippageBps=${cfg.slippageBps} · maxGasGwei=${cfg.maxGasGwei} · maxFailures=${cfg.maxConsecutiveFailures}`, "info");
    this.log(`[SWAP] Scheduler: single (one swap engine per bot instance)`, "info");
    this.log(`[LONG] ${this.config.enableLong !== false ? "enabled" : "disabled"}`, "info");
    this.log(`[SHORT] ${this.config.enableShort !== false ? "enabled" : "disabled"}`, "info");
    this.log(`[CLOSE] ${this.config.enableClose !== false ? "enabled" : "disabled"}`, "info");
    this.log(`[STATE] file=${STATE_FILE}`, "info");
  }

  /**
   * `[SWAP] Routes: N` / `[SWAP] Funded routes: K/N` — read-only inventory of the
   * validated directions discovered during RECOVERY (balance > per-token reserve).
   */
  async _logSwapRoutes() {
    try {
      const routes = (this.routes || []).filter(r => r && r.valid && r.fromAddr && r.fromSym);
      if (!routes.length) {
        this.log(`[SWAP] Routes: 0 (no validated direction discovered yet)`, "warn");
        return;
      }
      const cfg = normalizeSwapConfig(this.config);
      const decByAddr = new Map((this.tokenList || []).map(t => [String(t.address).toLowerCase(), Number(t.decimals)]));
      const { provider, wallet } = this.getRuntime();
      const balByAddr = new Map();
      for (const addr of [...new Set(routes.map(r => String(r.fromAddr).toLowerCase()))]) {
        try {
          balByAddr.set(addr, await new ethers.Contract(addr, ERC20_ABI, provider).balanceOf(wallet.address));
        } catch {
          balByAddr.set(addr, 0n);
        }
      }
      let funded = 0;
      for (const r of routes) {
        const addr = String(r.fromAddr).toLowerCase();
        const dec = decByAddr.has(addr) ? decByAddr.get(addr) : 18;
        const reserve = reserveRawFor(r.fromSym, dec, cfg);
        if ((balByAddr.get(addr) || 0n) > reserve) funded++;
      }
      this.log(`[SWAP] Routes: ${routes.length}`, "info");
      this.log(`[SWAP] Funded routes: ${funded}/${routes.length}`, funded === routes.length ? "info" : "warn");
    } catch (e) {
      this.log(`[SWAP] route inventory failed: ${String(e?.message || e).slice(0, 80)}`, "warn");
    }
  }

  async start() {
    if (this.running) { this.log("[AUTO] Already running.", "warn"); return; }
    // ONE swap scheduler per bot instance — never start the maintenance loop
    // while a standalone runSwapLoop() already owns the swap cadence.
    if (this._swapLoopRunning) {
      this.log("[BLOCKED] runSwapLoop() is already running — not starting a second swap engine", "warn");
      return;
    }
    this.running = true;
    this.stopRequested = false;

    try {
      this.log("══════════════════════════════════════════════", "warn");
      this.log("  CONTINUOUS AUTO TRADING STARTED", "warn");
      this.log(`  Leverage: ${this.config.defaultLeverage}x`, "info");
      this.log(`  Dry run: ${this.config.dryRun}`, "info");
      this.log("══════════════════════════════════════════════", "warn");

      // ── boot banner — config-driven, needs no CLI flags (`npm start` only) ──
      this._logSwapBoot();

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
          if (this._isDry()) {
            this.log(`[DRY] would adopt recovered position #${recovered.positionId} — state untouched`, "info");
          } else {
            this.state.activePosition = recovered;
            this.state.sessionStats.opens++;
            saveState(this.state);
          }
        } else if (this.state.activePosition) {
          // The recovery scan above only proves "no manager reported an active
          // position for this wallet"; it never proves THIS stored one is gone.
          // Verify the stored record itself — a failed read must never clear it.
          const found = await this._locateStoredPosition();
          if (found.status === "closed" || found.status === "missing" || found.status === "no-id") {
            this.log(`[RECOVERY] stored position #${this.state.activePosition.positionId} is gone on-chain — clearing`, "warn");
            this._clearActivePosition("recovery: gone on-chain", false);
          } else if (found.status === "active") {
            if (found.located && found.managerAddr && !this.state.activePosition.managerAddr && !this._isDry()) {
              this.state.activePosition.managerAddr = found.managerAddr;
              const mk = (Array.isArray(this.markets) ? this.markets : [])
                .find(m => String(m.managerAddr || "").toLowerCase() === String(found.managerAddr).toLowerCase());
              if (mk) {
                if (!this.state.activePosition.poolAddr) this.state.activePosition.poolAddr = mk.poolAddr;
                if (!this.state.activePosition.marketSymbol) this.state.activePosition.marketSymbol = mk.marketSymbol || mk.symbol;
              }
              saveState(this.state);
            }
            this.log(`[RECOVERY] stored position #${this.state.activePosition.positionId} still ACTIVE on-chain (manager=${short(found.managerAddr)}) — keeping state`, "warn");
          } else {
            this.log(`[RECOVERY] stored position #${this.state.activePosition.positionId} unreadable on-chain — keeping state (never clear on a failed read)`, "warn");
          }
        }
      } catch (re) {
        this.log(`[RECOVERY] failed: ${re.message?.slice(0, 60)}`, "error");
      }

      // Route inventory for the swap engine (markets/routes were just discovered
      // above by the RECOVERY pass) — informational only, sends nothing.
      await this._logSwapRoutes();

      // CONTINUOUS RUNNER — never stops
      while (!this.stopRequested) {
        try {
          // Cycle marker — the log then follows PHASE 1 → 1.5 → 2 → 3.
          this.log(`[CYCLE] #${++this._cycleNo}`, "warn");

          // STEP 1: CLOSE (only when a position record is held). A blocked close
          // logs and keeps the record — it never returns out of the loop, so the
          // swap rotation below always gets its turn.
          if (this.state.activePosition && !this.stopRequested) {
            this.log(`[AUTO] NEXT ACTION: CLOSE position #${this.state.activePosition.positionId}`, "info");
            const closeOutcome = await this.closeActivePosition();
            if (closeOutcome && !closeOutcome.ok) {
              this.log(`[CLOSE] ${closeOutcome.blocked ? "blocked" : "deferred"} (code=${closeOutcome.code || "?"}) — position kept; swap engine continues`, "warn");
              if (closeOutcome.blocked) {
                this.log(`[CLOSE BLOCKED] position=${this.state.activePosition?.positionId ?? "?"} code=${closeOutcome.code || "?"}`, "warn");
                this.log(`[SWAP] continuing maintenance`, "warn");
              }
            }
          }

          // STEP 2: SWAP MAINTENANCE — independent rotation over every validated
          // direction (A→B and B→A are separate queue entries).
          if (!this.stopRequested) {
            this.setState(STATES.AUTO_SWAP);
            await this.runSwapMaintenanceCycle({ phase: "LOOP" });
          }

          // STEP 3: OPEN position if none active — rotation picks MARKET×SIDE
          if (!this.state.activePosition && !this.stopRequested) {
            const planned = await this.nextMarketSide();
            const side = planned?.side || this.nextSide();
            this.log(`[AUTO] NEXT ACTION: OPEN ${side}${planned ? ` on ${planned.marketSymbol || planned.symbol}` : ""}`, "info");
            this.setState(STATES.OPEN);
            await this.prepareAndOpen(side);
          }

          // STEP 4: SWAP MAINTENANCE continues regardless of the OPEN outcome
          // (usually gated by minIntervalMs right after a settlement).
          if (!this.stopRequested) {
            this.setState(STATES.AUTO_SWAP);
            await this.runSwapMaintenanceCycle({ phase: "LOOP-2" });
          }

          // STEP 5: Brief wait between iterations
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

    const swapCount = Number(options.count) > 0
      ? Math.max(1, Math.floor(Number(options.count)))
      : (forcePair ? 1 : 1 + Math.floor(Math.random() * 2));
    this.log(`[AUTO] SWAPPING — ${forcePair ? `forced ${forcePair.from}→${forcePair.to}` : `${swapCount} random swap(s)`} (${this.routes.length} routes)`, "info");

    // Two consecutive failures on the SAME pair end the round — one dead pair
    // can never stall the swap phase.
    let samePairFails = 0;
    let lastFailKey = null;
    let pair = null;

    // A pair that is selected but then rejected MUST advance the rotation.
    // Without this the least-recent picker returns the identical pair on
    // every cycle (deterministic livelock → zero swaps). Returns true when
    // the same pair has now failed twice in a row and the round must stop.
    const rejectPair = () => {
      if (!pair) return false;
      if (!forcePair) this._rotSwapSkip(pair.from, pair.to);
      if (forcePair) return false;
      const k = `${pair.from}>${pair.to}`;
      if (k === lastFailKey) samePairFails += 1; else { samePairFails = 1; lastFailKey = k; }
      if (samePairFails >= 2) {
        this.log(`[AUTO-SWAP] ${k} failed ${samePairFails}× in a row — stopping this swap round`, "warn");
        return true;
      }
      return false;
    };

    for (let i = 0; i < swapCount; i++) {
      if (this.stopRequested) break;
      pair = null;

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

        // A pair that is selected but then rejected is advanced by rejectPair()
        // (defined before the loop so the catch block can use it too).
        const fromBal = freshBalances[pair.from];
        if (!fromBal || fromBal.float <= 0) {
          if (rejectPair()) break;
          if (forcePair) { summary.failed++; summary.results.push({ direction: `${pair.from}→${pair.to}`, ok: false, reason: "ZERO_BALANCE" }); }
          continue;
        }

        const fromDecimals = this._decimalsPrecedence(pair.from, decimalsMap);
        const amountResult = calculateRandomSwapAmount(pair.from, fromBal.float, autoSwapConfig, fromDecimals, this.log.bind(this));
        if (!amountResult) {
          if (rejectPair()) break;
          if (forcePair) { summary.failed++; summary.results.push({ direction: `${pair.from}→${pair.to}`, ok: false, reason: "AMOUNT_TOO_SMALL" }); }
          continue;
        }

        const decimals = amountResult.decimals ?? fromDecimals;
        const amountRaw = ethers.parseUnits(amountResult.amountFloat.toFixed(decimals), decimals);

        if (amountRaw > fromBal.raw * 90n / 100n) {
          if (rejectPair()) break;
          if (forcePair) { summary.failed++; summary.results.push({ direction: `${pair.from}→${pair.to}`, ok: false, reason: "OVER_90_PERCENT" }); }
          continue;
        }
        if (amountRaw > fromBal.raw) {
          if (rejectPair()) break;
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
          if (rejectPair()) break;
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
          if (rejectPair()) break;
          if (forcePair) { summary.failed++; summary.results.push({ direction: `${pair.from}→${pair.to}`, ok: false, reason: "QUOTE_ZERO" }); }
          continue;
        }
        const amountOutMin = applySlippage(expectedOut, BigInt(autoSwapConfig.slippageBps || 50));
        if (!(amountOutMin > 0n)) {
          this.log(`[AUTO-SWAP] ${pair.from} → ${pair.to}: amountOutMin=0 — skipping pair`, "warn");
          if (rejectPair()) break;
          if (forcePair) { summary.failed++; summary.results.push({ direction: `${pair.from}→${pair.to}`, ok: false, reason: "ZERO_AMOUNT_OUT_MIN" }); }
          continue;
        }

        this.log(`[AUTO] SWAPPING ${pair.from} → ${pair.to} [${ethers.formatUnits(amountRaw, decimals)}] hops=${best.type} amountOutMin=${amountOutMin}`, "warn");

        if (dryRun) {
          this.log(`[DRY] Would swap ${amountResult.amountFloat.toFixed(4)} ${pair.from} → ${pair.to}`, "info");
          // DRY-RUN: journal/rotation/persistence all stay untouched.
          samePairFails = 0;
          lastFailKey = null;
          summary.attempted++;
          summary.results.push({ direction: `${pair.from}→${pair.to}`, ok: true, dryRun: true, amountIn: String(amountRaw), amountOutMin: String(amountOutMin), path });
          continue;
        }

        summary.attempted++;
        const execReport = {};
        const swapResult = await executeSwap({
          wallet, provider,
          fromToken: pair.fromAddr, toToken: pair.toAddr,
          amount: amountRaw, amountOutMin,
          config: this.config, log: this.log.bind(this), txManager: this.txManager, path,
          report: execReport,
        });

        if (!swapResult || swapResult.ok === false) {
          this.log(`[SWAP] FAILED ${pair.from}→${pair.to} code=${execReport.code || "EXEC_FAILED"}`, "error");
          summary.failed++;
          summary.results.push({ direction: `${pair.from}→${pair.to}`, ok: false, reason: execReport.code || "EXEC_FAILED", detail: execReport.reason || null, amountIn: String(amountRaw), amountOutMin: String(amountOutMin), path });
          if (rejectPair()) break;
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
          if (rejectPair()) break;
          continue;
        }

        this.swapJournal.record({ from: pair.from, to: pair.to, amount: amountResult.amountFloat });
        this.rotation.recordSwapPair(pair.from, pair.to);
        this.state.rotation = this.rotation.toJSON();
        saveState(this.state);
        samePairFails = 0;
        lastFailKey = null;
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
        // A pair that was selected must still advance the rotation on an exception,
        // otherwise the same pair is re-picked forever.
        if (rejectPair()) break;
      }
    }
    return summary;
  }

  // ═════════════════════════════════════════════════════════════════════════
  //  ROTATING SWAP MAINTENANCE ENGINE — independent of OPEN/CLOSE
  //
  //  Every pass:
  //    1. discover tokens + validated direct routes
  //    2. order them as a rotation queue (least-recent direction first)
  //    3. for each direction: balance → reserve → quote → amountOutMin →
  //       allowance → eth_call preflight → send → wait receipt → verify deltas
  //    4. on success: record the pair, advance rotation, respect minIntervalMs
  //    5. on failure: park ONLY that route (per-route backoff) and continue
  // ═════════════════════════════════════════════════════════════════════════

  /**
   * Build the rotation queue of DIRECTIONS from the validated route set.
   * A→B and B→A are two INDEPENDENT records — the reverse direction is never
   * inferred, it must have passed its own read-only quote during discovery.
   */
  _swapDirections({ from = null, to = null } = {}) {
    const tokens = this.tokenList.length
      ? this.tokenList
      : Object.entries(getAllTokens()).map(([symbol, address]) => ({ symbol, address, decimals: null }));
    const tokenAddrs = {};
    const decimalsMap = {};
    for (const t of tokens) {
      tokenAddrs[t.symbol] = t.address;
      decimalsMap[t.symbol] = (t.decimals === undefined) ? null : t.decimals;
    }

    let directions = (this.routes || [])
      .filter(r => r && r.valid && r.fromSym && r.toSym && r.fromAddr && r.toAddr)
      .filter(r => String(r.fromAddr).toLowerCase() !== String(r.toAddr).toLowerCase())
      .map(r => ({
        from: r.fromSym, to: r.toSym,
        fromAddr: r.fromAddr, toAddr: r.toAddr,
        path: r.path, type: r.type || "direct",
        pool: r.pool || null, pool2: r.pool2 || null,
        key: `${r.fromSym}>${r.toSym}`,
      }));

    if (from && to) {
      const want = directions.filter(d => d.from === from && d.to === to);
      if (want.length) {
        directions = want;
      } else if (tokenAddrs[from] && tokenAddrs[to]) {
        // Forced direction without a validated record — quoteBestPath() still runs
        // a read-only DIRECT probe and rejects it if the route is dead.
        directions = [{
          from, to,
          fromAddr: tokenAddrs[from], toAddr: tokenAddrs[to],
          path: [tokenAddrs[from], tokenAddrs[to]], type: "direct-probe",
          pool: null, pool2: null, key: `${from}>${to}`,
        }];
      } else {
        directions = [];
      }
    }
    return { directions, tokenAddrs, decimalsMap };
  }

  /** Per-route failure → park THAT route only. The engine keeps running. */
  _recordSwapRouteFailure(dir, code) {
    const known = SWAP_FAILURE_CODES.includes(code) ? code : (code || "UNKNOWN");
    // DRY-RUN: report the parking that WOULD happen — never move the backoff.
    if (this._isDry()) {
      this.log(`[DRY] would park route ${dir.key} after ${known} — backoff untouched`, "info");
      return;
    }
    try {
      const entry = this.swapBackoff.recordFailure(dir.key, known);
      const waitS = Math.max(0, Math.round((entry.until - Date.now()) / 1000));
      this.log(`[SWAP] route ${dir.key} failure #${entry.fails} (${known}) — parked ${waitS}s; ${this.routes.length} other route(s) unaffected`, "warn");
    } catch (e) {
      this.log(`[SWAP] backoff update failed for ${dir.key}: ${e.message?.slice(0, 60)}`, "warn");
    }
  }

  /** Success → clear the route backoff and advance the rotation queue. */
  _recordSwapRouteSuccess(dir) {
    // DRY-RUN: never advance rotation recency/counts and never touch backoff —
    // `runSwapRotationQueue()` still sees status "dry" and counts the plan.
    if (this._isDry()) {
      this.log(`[DRY] would record swap ${dir.key} as settled — rotation/backoff untouched`, "info");
      return;
    }
    this.swapBackoff.recordSuccess(dir.key);
    this._rotSwapDone(dir.from, dir.to);
  }

  /** Wait for a settlement — the next swap is never sent before this one lands. */
  async _waitForSwapReceipt(txHash, timeoutMs = 120_000) {
    if (!txHash) return null;
    const { provider } = this.getRuntime();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !this.stopRequested) {
      try {
        // Multi-source: the primary RPC has been observed returning null for
        // receipts that exist, which used to be read as "swap did not happen".
        const r = (await resolveReceipt({ provider, hash: txHash }))?.receipt
          || await provider.getTransactionReceipt(txHash);
        if (r) return r;
      } catch { /* RPC hiccup — keep polling */ }
      await this.sleep(3000);
    }
    return null;
  }

  /**
   * ONE swap-maintenance pass.
   *
   * @param {object}  [options]
   * @param {boolean} [options.force]   bypass the min-interval gate (CLI --confirm)
   * @param {number}  [options.maxSwaps] verified swaps this pass may settle
   * @param {string}  [options.from]    pin the direction
   * @param {string}  [options.to]      pin the direction
   * @param {string}  [options.phase]   label for the log line
   * @returns {Promise<object>} summary — never throws
   */
  async runSwapMaintenanceCycle(options = {}) {
    const cfg = normalizeSwapConfig(this.config);
    const summary = {
      attempted: 0, verified: 0, skipped: 0, failed: 0,
      waiting: 0, blocked: null, total: 0, eligible: 0, results: [],
    };
    const force = options.force === true;
    const phase = options.phase ? `${options.phase} ` : "";
    const filter = (options.from && options.to) ? { from: options.from, to: options.to } : null;
    const maxSwaps = Math.max(1, Number(options.maxSwaps) > 0
      ? Math.floor(Number(options.maxSwaps))
      : cfg.maxSwapsPerCycle);

    if (!cfg.enabled && !force && !filter) {
      summary.blocked = "SWAP_DISABLED";
      return summary;
    }
    if (this.stopRequested) { summary.blocked = "STOP_REQUESTED"; return summary; }

    // Min-interval gate — applies ONLY after a real settlement. It is a rate
    // limit, never a failure backoff: a failed route does not delay the others.
    const now = Date.now();
    if (!force && this._lastSwapTxAt > 0 && (now - this._lastSwapTxAt) < cfg.minIntervalMs) {
      summary.waiting = cfg.minIntervalMs - (now - this._lastSwapTxAt);
      this.log(`[SWAP] ${phase}idle ${summary.waiting}ms until minIntervalMs=${cfg.minIntervalMs} elapses`, "info");
      return summary;
    }

    // 1 + 2. discovery (token inventory + validated routes, refreshed on schedule)
    await this.ensureMarkets();
    const { provider, wallet } = this.getRuntime();
    const walletAddr = wallet.address;
    const { directions, decimalsMap } = this._swapDirections(filter || {});
    summary.total = directions.length;
    if (!directions.length) {
      summary.blocked = "NO_DIRECTIONS";
      this.log(`[SWAP] ${phase}no validated direction available (routes=${this.routes.length})`, "warn");
      return summary;
    }

    // Rotation queue: least-recently-tried direction first → the pair that just
    // ran lands at the END of the queue, so consecutive passes use different
    // directions (both A→B and B→A are separate queue entries).
    const queue = cfg.rotatePairs ? this.rotation.orderSwapPairs(directions) : directions.slice();
    this.log(`[SWAP] ${phase}rotation queue: ${queue.length} direction(s) — ${queue.slice(0, 8).map(d => d.key).join(", ")}${queue.length > 8 ? ", …" : ""}`, "info");

    const ctx = {
      cfg, provider, wallet, walletAddr, decimalsMap,
      dryRun: !!this.config.dryRun, phase,
      slippageBps: BigInt(cfg.slippageBps),
    };

    const res = await runSwapRotationQueue({
      directions: queue,
      maxSwaps,
      attempt: (dir) => this._attemptSwapDirection(dir, ctx),
      canAttempt: (key) => this.swapBackoff.canAttempt(key, Date.now()),
      recordSkip: (dir) => this._rotSwapSkip(dir.from, dir.to),
      recordFailure: (dir, code) => this._recordSwapRouteFailure(dir, code),
      recordSuccess: (dir) => this._recordSwapRouteSuccess(dir),
      stopRequested: () => this.stopRequested,
    });

    summary.eligible = res.eligible;
    summary.attempted = res.attempted;
    summary.verified = res.verified;
    summary.skipped = res.skipped;
    summary.failed = res.failed;
    summary.results = res.results;

    if (summary.verified > 0) {
      this._lastSwapCycleAt = Date.now();
      this._syncRotation();
    }
    return summary;
  }

  /**
   * Attempt exactly ONE direction. Returns a status for runSwapRotationQueue:
   *   ok    — settled + verified on-chain
   *   dry   — planned only (dry-run), rotation still advances
   *   skip  — no transaction (balance / quote / route / preflight), rotate away
   *   fail  — transaction attempted but not verified, per-route backoff
   *   stop  — engine-wide condition (gas ceiling), do not rotate
   */
  async _attemptSwapDirection(dir, ctx) {
    const { cfg, provider, wallet, walletAddr, decimalsMap, dryRun, slippageBps, phase } = ctx;
    // SINGLE-SWAP: an operator-pinned size replaces the random sizing, and an
    // approval is never allowed (the mode is defined as exactly ONE transaction).
    const pinned = ctx.pinned || null;
    const direction = `${dir.from}->${dir.to}`;
    const tag = phase ? `${phase} ` : "";

    const skip = (code, reason, rotate = true) => {
      this.log(`[SWAP SKIP] direction=${direction} code=${code} reason=${reason}`, "warn");
      if (rotate) this._rotSwapSkip(dir.from, dir.to);
      return { status: "skip", code, reason };
    };
    const fail = (code, reason) => {
      this.log(`[SWAP SKIP] direction=${direction} code=${code} reason=${reason}`, "error");
      return { status: "fail", code, reason };
    };

    // Token decimals always come from the chain — a 6-decimal token must never
    // be sized with parseUnits(x, 18).
    let fromDec = decimalsMap[dir.from];
    if (fromDec === null || fromDec === undefined) {
      try { fromDec = await tokenDecimalsOnChain(provider, dir.fromAddr); } catch { fromDec = null; }
      decimalsMap[dir.from] = fromDec;
    }
    let toDec = decimalsMap[dir.to];
    if (toDec === null || toDec === undefined) {
      try { toDec = await tokenDecimalsOnChain(provider, dir.toAddr); } catch { toDec = null; }
      decimalsMap[dir.to] = toDec;
    }
    if (fromDec === null || toDec === null) return skip("TOKEN_DISABLED", `decimals unreadable for ${dir.from}/${dir.to}`);

    // 4. balance + per-token reserve → available
    let balance = 0n;
    let beforeTo = 0n;
    try {
      balance = await new ethers.Contract(dir.fromAddr, ERC20_ABI, provider).balanceOf(walletAddr);
      beforeTo = await new ethers.Contract(dir.toAddr, ERC20_ABI, provider).balanceOf(walletAddr);
    } catch (e) {
      return skip("INSUFFICIENT_BALANCE", `balanceOf reverted: ${String(e?.message || e).slice(0, 60)}`);
    }

    const sized = computeSwapAmount({
      sym: dir.from, balanceRaw: balance, decimals: fromDec, cfg,
      calcAmount: pinned
        ? () => ({ amountFloat: Number(pinned.amount) })
        : (avail) => calculateRandomSwapAmount(dir.from, avail, cfg, fromDec, this.log.bind(this)),
    });
    if (!sized.ok) return skip(sized.code, sized.reason);
    const amountRaw = sized.amountRaw;
    if (pinned) {
      // The operator's decimal string must survive the float bridge byte-exact;
      // otherwise a different amount than the one reviewed would be sent.
      let exact = 0n;
      try { exact = ethers.parseUnits(String(pinned.amount), fromDec); } catch { exact = 0n; }
      if (exact <= 0n || exact !== amountRaw) {
        return skip("PINNED_AMOUNT", `requested ${pinned.amount} does not round-trip to ${amountRaw} at ${fromDec} decimals`);
      }
    }

    // ETH GAS RESERVE — a GLOBAL precondition, checked once the route has a
    // concrete size but BEFORE any quote/economic work. If the wallet cannot
    // pay for gas there is no point spending RPC on reserves or quotes, and the
    // failure must not be attributed to the route (a route is not at fault for
    // an empty gas tank). Read-only: getBalance only, no signing.
    {
      const ethBal = await provider.getBalance(walletAddr).catch(() => 0n);
      const gasReserve = ethers.parseEther(String(cfg.ethGuard?.MIN_ETH_GAS_RESERVE ?? 0.003));
      if (ethBal < gasReserve) {
        return fail("GAS_RESERVE",
          `ETH balance ${ethers.formatEther(ethBal)} below the gas reserve ${ethers.formatEther(gasReserve)}`);
      }
    }

    // Gas ceiling — a global condition, so the pass stops without punishing a route.
    if (cfg.maxGasGwei > 0) {
      const gwei = gasGweiFrom(await provider.getFeeData().catch(() => null));
      if (gwei !== null && gwei > cfg.maxGasGwei) {
        this.log(`[SWAP SKIP] direction=${direction} code=GAS_TOO_HIGH reason=network gas ${gwei.toFixed(2)} gwei > maxGasGwei ${cfg.maxGasGwei}`, "warn");
        return { status: "stop", code: "GAS_TOO_HIGH", reason: `gas ${gwei.toFixed(2)} gwei > ${cfg.maxGasGwei}` };
      }
    }

    // 3. fresh quote for THIS size (never reuse a stale one)
    const best = await quoteBestPath({
      provider, routerAddress: getRouterAddress(), routes: this.routes,
      fromAddr: dir.fromAddr, toAddr: dir.toAddr, amountIn: amountRaw,
      log: this.log.bind(this),
    });
    if (!best) return skip("ROUTE_UNAVAILABLE", "no validated path quotes a non-zero output at this size");
    if (!(best.amountOut > 0n)) return skip("QUOTE_ZERO", "router returned amountOut=0");

    // 5. amountOutMin from the configured slippage — never 0, never hardcoded
    const amountOutMin = applySlippage(best.amountOut, slippageBps);
    if (!(amountOutMin > 0n)) return skip("ZERO_AMOUNT_OUT_MIN", `amountOutMin collapsed to 0 at slippageBps=${cfg.slippageBps}`);

    // 5a. ECONOMIC GATES — a quotable route is not automatically a sane route.
    // Every leg is re-priced against the pool's OWN reserves and fee (1% per leg,
    // so a 2-hop pays it twice) and vetoed when the swap would move the pool by
    // more than maxPoolShareBps / maxPriceImpactBps. Thresholds are configurable
    // and are NEVER loosened automatically; a rejected route is skipped and the
    // rest of the rotation keeps running. Read-only: eth_call/getReserves only.
    const economyCfg = normalizeEconomyConfig(cfg.swapEconomy);
    const econ = await probeRouteEconomics({
      provider, factoryAddress: getFactoryAddress(), path: best.path,
      amountIn: amountRaw, amountOut: best.amountOut, amountOutMin,
      economy: economyCfg, log: this.log.bind(this),
    });
    if (!econ.ok) return skip("ECONOMY_REJECTED", `gates=${econ.gates.join(",")}`);

    // 5a-bis. Cross-direction rate consistency. The reverse direction of this
    // pair is priced by the SAME reserves, so the product of the two implied
    // rates must sit near (1−fee)^(2×legs). A product of 148× or 3.15e5× means
    // the pools contradict each other — do not trade that pair in either
    // direction. Only checked for direct (single-leg) pairs where both
    // directions are quoted in this pass.
    if (best.path.length === 2) {
      const rev = await quoteBestPath({
        provider, routerAddress: getRouterAddress(), routes: this.routes,
        fromAddr: dir.toAddr, toAddr: dir.fromAddr, amountIn: amountRaw,
        log: () => {},
      });
      if (rev && rev.amountOut > 0n) {
        const decInH = Number(ethers.formatUnits(amountRaw, fromDec));
        const rateAB = Number(ethers.formatUnits(best.amountOut, toDec)) / decInH;
        const rateBA = Number(ethers.formatUnits(rev.amountOut, fromDec)) / Number(ethers.formatUnits(amountRaw, toDec));
        const feeFrac = (econ.legs?.[0]?.swapFeeBps ?? 100) / Number(BPS);
        const rc = checkRateConsistency({
          rateAB, rateBA, legs: 1, feeFrac,
          maxDeviation: economyCfg.maxRateDeviation,
        });
        if (!rc.ok) {
          return skip("ECONOMY_REJECTED", `RATE_DEVIATION product=${rc.product.toExponential(3)} expected=${rc.expected.toFixed(6)} deviation=${rc.deviation.toExponential(3)}× (pools contradict each other)`);
        }
      }
    }

    const routerAddr = getRouterAddress();
    const rec = (this.routes || []).find(r => r.valid && Array.isArray(r.path) && r.path.length === best.path.length
      && r.path.every((a, i) => String(a).toLowerCase() === String(best.path[i]).toLowerCase()));
    const pool = rec?.pool || rec?.pool2 || "-";

    // 5b. read-only preflight — nothing is signed before this eth_call succeeds
    const deadline = Math.floor(Date.now() / 1000) + Number(this.config.deadlineSeconds || 1200);
    let calldata;
    try {
      calldata = new ethers.Interface(ROUTER_ABI).encodeFunctionData(
        "swapExactTokensForTokens", [amountRaw, amountOutMin, best.path, walletAddr, deadline]);
      await provider.call({ from: walletAddr, to: routerAddr, data: calldata, value: 0n });
    } catch (e) {
      return skip("PREFLIGHT_REVERT", String(e?.shortMessage || e?.message || e).slice(0, 120));
    }

    this.log(
      `[SWAP] direction=${direction} tokenIn=${dir.fromAddr} tokenOut=${dir.toAddr} ` +
      `amountIn=${ethers.formatUnits(amountRaw, fromDec)} quoteOut=${ethers.formatUnits(best.amountOut, toDec)} ` +
      `amountOutMin=${ethers.formatUnits(amountOutMin, toDec)} router=${routerAddr} pool=${pool} ` +
      `reserve=${ethers.formatUnits(sized.reserve, fromDec)} available=${ethers.formatUnits(sized.availableRaw, fromDec)} ` +
      `hops=${best.type} preflight=PASS`, "warn");

    // 5b-bis. SINGLE-SWAP PLAN — read-only gas + economics snapshot that the
    // operator reviews before anything is signed. estimateGas is an eth_call.
    let plan = null;
    if (pinned) {
      let gasEstimate = null, gasPrice = null;
      try { gasEstimate = await provider.estimateGas({ from: walletAddr, to: routerAddr, data: calldata, value: 0n }); } catch { gasEstimate = null; }
      try { gasPrice = (await provider.getFeeData())?.gasPrice ?? null; } catch { gasPrice = null; }
      const leg0 = econ?.legs?.[0] || null;
      const gasCostWei = (gasEstimate && gasPrice) ? gasEstimate * gasPrice : null;
      plan = {
        direction, from: dir.from, to: dir.to,
        tokenIn: dir.fromAddr, tokenOut: dir.toAddr,
        path: best.path, hops: best.type, pool, router: routerAddr,
        amountIn: String(amountRaw), amountInHuman: ethers.formatUnits(amountRaw, fromDec),
        quoteOut: String(best.amountOut), quoteOutHuman: ethers.formatUnits(best.amountOut, toDec),
        amountOutMin: String(amountOutMin), amountOutMinHuman: ethers.formatUnits(amountOutMin, toDec),
        slippageBps: Number(slippageBps),
        poolSharePct: leg0?.poolShare != null ? Number(leg0.poolShare) * 100 : null,
        priceImpactExFeePct: leg0?.priceImpactExFee != null ? Number(leg0.priceImpactExFee) * 100 : null,
        spot: leg0?.spot ?? null, execRate: leg0?.execRate ?? null,
        economyGates: econ?.gates || [],
        gasEstimate: gasEstimate ? String(gasEstimate) : null,
        gasPriceWei: gasPrice ? String(gasPrice) : null,
        gasCostWei: gasCostWei ? String(gasCostWei) : null,
        gasCostEth: gasCostWei ? ethers.formatEther(gasCostWei) : null,
        deadline, preflight: "PASS", allowApprove: false, txCap: 1,
      };
      this.log(
        `[SINGLE-SWAP] PLAN ${direction} in=${plan.amountInHuman} quoteOut=${plan.quoteOutHuman} ` +
        `amountOutMin=${plan.amountOutMinHuman} (slip=${plan.slippageBps}bps) ` +
        `poolShare=${plan.poolSharePct === null ? "-" : plan.poolSharePct.toFixed(4) + "%"} ` +
        `priceImpactExFee=${plan.priceImpactExFeePct === null ? "-" : plan.priceImpactExFeePct.toFixed(4) + "%"} ` +
        `gas=${plan.gasEstimate ?? "-"} (~${plan.gasCostEth ?? "?"} ETH @ ${plan.gasPriceWei ?? "?"} wei) ` +
        `router=${routerAddr} pool=${pool} path=${best.path.join("→")}`, "warn");
    }

    if (dryRun) {
      this.log(`[DRY] ${tag}would swap ${direction} ${ethers.formatUnits(amountRaw, fromDec)} → min ${ethers.formatUnits(amountOutMin, toDec)}`, "info");
      return { status: "dry", code: "DRY_RUN", reason: pinned ? "plan only — no --confirm, nothing signed" : "dry-run — no transaction sent", amountIn: String(amountRaw), amountOutMin: String(amountOutMin), plan };
    }

    // 6 + 7. allowance (logged) → approve only when needed → send → wait receipt
    const report = {};
    const res = await executeSwap({
      wallet, provider,
      fromToken: dir.fromAddr, toToken: dir.toAddr,
      amount: amountRaw, amountOutMin,
      config: this.config, log: this.log.bind(this), txManager: this.txManager,
      path: best.path, report,
      allowApprove: pinned ? pinned.allowApprove !== false : true,
    });
    if (!res || res.ok === false) return fail(report.code || "TX_REVERTED", report.reason || "swap execution failed");

    if (res.pending) {
      // Never start the next swap before this one is settled.
      const settled = await this._waitForSwapReceipt(res.txHash, 120_000);
      if (!settled) return fail("TX_REVERTED", `no receipt for ${res.txHash} before timeout`);
      if (settled.status !== 1) return fail("TX_REVERTED", `receipt.status=${settled.status}`);
      res.blockNumber = settled.blockNumber;
      res.gasUsed = String(settled.gasUsed);
    }

    // 8 + 9. receipt.status === 1 (guaranteed above) + real ERC20 balance deltas
    const afterFrom = await new ethers.Contract(dir.fromAddr, ERC20_ABI, provider).balanceOf(walletAddr);
    const afterTo = await new ethers.Contract(dir.toAddr, ERC20_ABI, provider).balanceOf(walletAddr);
    const inDelta = balance - afterFrom;
    const outDelta = afterTo - beforeTo;
    const ok = inDelta > 0n && outDelta > 0n && outDelta >= amountOutMin;
    this.log(
      `[SWAP ${ok ? "CONFIRMED" : "MISMATCH"}] direction=${direction} tx=${res.txHash} block=${res.blockNumber ?? "-"} gas=${res.gasUsed ?? "-"} ` +
      `inDelta=${inDelta} outDelta=${outDelta} amountIn=${amountRaw} amountOutMin=${amountOutMin}`,
      ok ? "success" : "error");
    if (!ok) {
      // Receipt is CONFIRMED but the balance deltas contradict the expectation.
      this.txManager?.journal?.transition(res.txHash, TX_STATE.CONFIRMED_STATE_MISMATCH, {
        reason: `inDelta=${inDelta} outDelta=${outDelta} amountOutMin=${amountOutMin}`,
      });
      return fail("VERIFY_FAILED", `inDelta=${inDelta} outDelta=${outDelta} amountOutMin=${amountOutMin}`);
    }
    // 10. record the successful pair — runSwapRotationQueue() then advances the
    // rotation queue, so the NEXT pass starts on a different direction.
    this._lastSwapTxAt = Date.now();
    try { this.swapJournal.record({ from: dir.from, to: dir.to, amount: parseFloat(ethers.formatUnits(amountRaw, fromDec)) }); } catch { /* best-effort */ }

    return {
      status: "ok",
      txHash: res.txHash, blockNumber: res.blockNumber ?? null, gasUsed: res.gasUsed ?? null,
      approveTxHash: res.approveTxHash || null,
      amountIn: String(amountRaw), quoteOut: String(best.amountOut), amountOutMin: String(amountOutMin),
      inDelta: String(inDelta), outDelta: String(outDelta),
      path: best.path, hops: best.type, pool,
      allowance: report.allowance || null, preflight: report.preflight || "PASS",
      plan,
    };
  }

  /**
   * CONTINUOUS ROTATION — `node auto.js --swap-loop --confirm`.
   * Without --confirm nothing is signed: the loop reports and exits.
   */
  async runSwapLoop({ confirm = false, maxCycles = null, from = null, to = null } = {}) {
    if (!confirm) {
      this.log(`[BLOCKED] --swap-loop requires --confirm — no transaction will be signed without it`, "error");
      return { blocked: "CONFIRM_REQUIRED", sent: 0, cycles: 0, verified: 0 };
    }
    // ── SINGLE SCHEDULER GUARD ───────────────────────────────────────────────
    // A bot instance owns exactly ONE active swap scheduler. `start()` (npm start)
    // already runs runSwapMaintenanceCycle() inside its cycle, so a second engine
    // must never be spawned on top of it — and vice versa.
    if (this._swapLoopRunning) {
      this.log(`[BLOCKED] a swap loop is already running on this instance — second engine NOT started`, "warn");
      return { blocked: "SWAP_LOOP_ALREADY_RUNNING", sent: 0, cycles: 0, verified: 0 };
    }
    if (this.running) {
      this.log(`[BLOCKED] the main bot loop (start()) already owns the swap scheduler — --swap-loop NOT started`, "warn");
      return { blocked: "MAIN_LOOP_OWNS_SCHEDULER", sent: 0, cycles: 0, verified: 0 };
    }

    this._swapLoopRunning = true;
    try {
      const cfg = normalizeSwapConfig(this.config);
      this.log(`[SWAP-LOOP] rotation start — minIntervalMs=${cfg.minIntervalMs} maxIntervalMs=${cfg.maxIntervalMs} rotatePairs=${cfg.rotatePairs} reverseDirections=${cfg.reverseDirections} slippageBps=${cfg.slippageBps} maxGasGwei=${cfg.maxGasGwei} maxConsecutiveFailures=${cfg.maxConsecutiveFailures}`, "warn");
      if (this.config.dryRun) this.log(`[SWAP-LOOP] DRY RUN — planning only, no transaction will be sent`, "warn");

      const stats = { blocked: null, cycles: 0, attempted: 0, verified: 0, skipped: 0, failed: 0, sent: 0 };
      const limit = Number(maxCycles) > 0 ? Math.floor(Number(maxCycles)) : null;

      while (!this.stopRequested && (limit === null || stats.cycles < limit)) {
        stats.cycles++;
        let s = null;
        try {
          s = await this.runSwapMaintenanceCycle({ from, to, phase: `LOOP-${stats.cycles}` });
        } catch (e) {
          this.log(`[SWAP-LOOP] cycle error: ${e.message?.slice(0, 80)}`, "error");
          this.txManager.resetNonce();
        }
        if (s) {
          stats.attempted += s.attempted;
          stats.verified += s.verified;
          stats.skipped += s.skipped;
          stats.failed += s.failed;
          if (s.blocked && limit === null && stats.cycles >= 3 && stats.attempted === 0) {
            stats.blocked = s.blocked;
            this.log(`[SWAP-LOOP] nothing executable after ${stats.cycles} passes (blocked=${s.blocked}) — stopping`, "warn");
            break;
          }
        }
        if (this.stopRequested) break;
        // settled → wait a random interval inside [minIntervalMs, maxIntervalMs];
        // nothing settled → try again shortly (failed routes already moved on).
        const waitMs = (s && s.verified > 0)
          ? this.randomDelay(cfg.minIntervalMs, cfg.maxIntervalMs)
          : Math.min(cfg.minIntervalMs, 5000);
        await this.sleep(waitMs);
      }

      this.log(`[SWAP-LOOP] stopped — cycles=${stats.cycles} attempted=${stats.attempted} verified=${stats.verified} skipped=${stats.skipped} failed=${stats.failed}`, "warn");
      return stats;
    } finally {
      this._swapLoopRunning = false;
    }
  }

  /**
   * READ-ONLY SWAP MATRIX — every ordered token pair (7 tokens ⇒ 42 directions).
   *
   * For each direction: on-chain balance, then a probe-ladder quote
   * (1 → 100M whole tokens) over the validated route set — direct path first,
   * then bounded validated 2-hop. Sends no transaction and writes no state, so
   * it can be run at any time to prove that a direction is routable.
   *
   * @returns {{total:number, routable:number, funded:number, rows:Array}}
   */
  async runSwapMatrix() {
    await this.ensureMarkets();
    const { provider, wallet } = this.getRuntime();
    const walletAddr = wallet?.address || null;
    const autoSwapConfig = this.config.autoSwap || {};
    const slippageBps = BigInt(autoSwapConfig.slippageBps || 50);

    const tokens = this.tokenList.length
      ? this.tokenList
      : Object.entries(getAllTokens()).map(([symbol, address]) => ({ symbol, address, decimals: null }));
    const addrs = {};
    const decs = {};
    for (const t of tokens) {
      addrs[t.symbol] = t.address;
      let d = t.decimals;
      if (d === null || d === undefined) {
        try { d = await tokenDecimalsOnChain(provider, t.address); } catch { d = null; }
      }
      decs[t.symbol] = d;
    }

    const symbols = tokens.map(t => t.symbol);
    const rows = [];
    let routable = 0;
    let funded = 0;
    this.log(`[SWAP-MATRIX] checking ${symbols.length} tokens → ${symbols.length * (symbols.length - 1)} directions (read-only)`, "info");

    for (const from of symbols) {
      for (const to of symbols) {
        if (from === to) continue;
        const row = { from, to, status: "SKIP", reason: "no path", hops: "-", probeWhole: null, amountIn: null, amountOutMin: null, balanceOk: null };
        try {
          const balance = walletAddr
            ? await new ethers.Contract(addrs[from], ERC20_ABI, provider).balanceOf(walletAddr)
            : 0n;
          row.balance = balance;
          const dec = decs[from] ?? 18;
          let picked = null;
          for (const whole of PROBE_LADDER_WHOLE) {
            const amountIn = whole * 10n ** BigInt(dec);
            const best = await quoteBestPath({
              provider, routerAddress: getRouterAddress(), routes: this.routes,
              fromAddr: addrs[from], toAddr: addrs[to], amountIn, log: () => {},
            });
            if (best && best.amountOut > 0n) {
              const aom = applySlippage(best.amountOut, slippageBps);
              if (aom > 0n) { picked = { whole, amountIn, best, aom }; break; }
            }
          }
          if (!picked) {
            row.reason = "no viable quote anywhere on the probe ladder";
            rows.push(row);
            continue;
          }
          routable++;
          row.status = "EXECUTE";
          row.hops = picked.best.type;
          row.probeWhole = picked.whole;
          row.amountIn = picked.amountIn;
          row.amountOutMin = picked.aom;
          row.balanceOk = balance >= picked.amountIn;
          row.reason = row.balanceOk
            ? `route ok at probe ${picked.whole} ${from}`
            : `route ok, but balance ${ethers.formatUnits(balance, dec)} ${from} < probe ${picked.whole}`;
          if (row.balanceOk) funded++;
        } catch (e) {
          row.status = "SKIP";
          row.reason = `error: ${String(e?.message || e).slice(0, 60)}`;
        }
        rows.push(row);
      }
    }

    const pad = (s, n) => String(s).padEnd(n);
    this.log(`[SWAP-MATRIX] ${pad("from", 9)}${pad("to", 9)}${pad("status", 9)}${pad("hops", 7)}${pad("probe", 12)}${pad("amountOutMin", 24)}reason`, "info");
    for (const r of rows) {
      this.log(`[SWAP-MATRIX] ${pad(r.from, 9)}${pad(r.to, 9)}${pad(r.status, 9)}${pad(r.hops, 7)}${pad(r.probeWhole ?? "-", 12)}${pad(r.amountOutMin != null ? String(r.amountOutMin) : "-", 24)}${r.reason}`,
        r.status === "EXECUTE" ? "success" : "warn");
    }
    this.log(`[SWAP-MATRIX] ${routable}/${rows.length} directions routable, ${funded}/${rows.length} also funded at the probe size`, routable === rows.length ? "success" : "warn");
    return { total: rows.length, routable, funded, rows };
  }

  /**
   * ONE real swap, only on explicit confirmation.
   *
   * Without `--confirm` nothing is signed or sent: the CLI flag must be passed
   * deliberately (`node auto.js --swap-once --confirm`), and `--from=` / `--to=`
   * can pin the direction.
   *
   * @param {{confirm?:boolean, from?:string|null, to?:string|null, count?:number}} opts
   */
  async runSwapOnce({ confirm = false, from = null, to = null, count = 1 } = {}) {
    if (!confirm) {
      this.log(`[BLOCKED] --swap-once requires --confirm — no transaction will be signed without it`, "error");
      return { sent: 0, blocked: "CONFIRM_REQUIRED" };
    }
    if (this.config.dryRun) {
      this.log(`[SWAP-ONCE] dry-run mode — the swap is planned but not sent`, "warn");
    }
    const forcePair = (from && to) ? { from, to } : null;
    if (forcePair) this.log(`[SWAP-ONCE] confirmed — direction ${forcePair.from} → ${forcePair.to}`, "warn");
    else this.log(`[SWAP-ONCE] confirmed — rotation will pick the direction`, "warn");

    const total = { sent: 0, attempted: 0, verified: 0, skipped: 0, failed: 0, results: [], blocked: null };
    const rounds = Math.max(1, Math.floor(Number(count) || 1));
    const cfg = normalizeSwapConfig(this.config);
    for (let i = 0; i < rounds; i++) {
      if (this.stopRequested) break;
      const s = await this.runSwapMaintenanceCycle({
        force: true, maxSwaps: 1, phase: `ONCE-${i + 1}`,
        from: forcePair?.from ?? null, to: forcePair?.to ?? null,
      });
      total.attempted += s.attempted;
      total.verified += s.verified;
      total.skipped += s.skipped;
      total.failed += s.failed;
      total.results.push(...(s.results || []));
      if (s.blocked) total.blocked = s.blocked;
      if (s.verified === 0) break; // nothing settled — rotating again would just repeat the skips
      if (i < rounds - 1) await this.sleep(this.randomDelay(cfg.minIntervalMs, cfg.maxIntervalMs));
    }
    total.sent = total.verified;
    this.log(`[SWAP-ONCE] done — attempted=${total.attempted} verified=${total.verified} skipped=${total.skipped} failed=${total.failed}`, total.failed ? "warn" : "success");
    return total;
  }

  /**
   * SINGLE SWAP — exactly ONE explicitly-sized swap, then stop.
   *
   * Contract of this mode (hard requirements, not conventions):
   *   • direction is PINNED by the operator (--from/--to) — rotation never picks it
   *   • size is PINNED (--amount) — no random sizing, and the decimal string must
   *     round-trip to the exact raw amount that is sent
   *   • exactly ONE transaction: if the router allowance is short the operation is
   *     REFUSED (APPROVAL_REQUIRED) instead of sending an approve first
   *   • no OPEN / CLOSE: this path never reaches openPosition()/closePosition(),
   *     so an active position (e.g. #75) cannot be mutated by it
   *   • no loop, no rounds, no auto-advance: `_attemptSwapDirection` is called
   *     exactly once and control returns immediately
   *   • without --confirm it is a READ-ONLY plan (quote, amountOutMin, pool share,
   *     price impact, gas, preflight eth_call) — nothing is signed
   *
   * @returns {{mode:string, confirm:boolean, sent:number, verified:number,
   *            blocked:string|null, plan:object|null, result:object|null}}
   */
  async runSingleSwap({ confirm = false, from = null, to = null, amount = null } = {}) {
    const out = { mode: "SINGLE-SWAP", confirm: !!confirm, sent: 0, verified: 0, blocked: null, plan: null, result: null };
    const block = (code, why) => { out.blocked = code; this.log(`[SINGLE-SWAP] BLOCKED ${code}: ${why}`, "error"); return out; };

    if (this.running || this._swapLoopRunning) return block("ENGINE_ALREADY_RUNNING", "the main loop / swap loop already owns the scheduler");
    if (!from || !to) return block("MISSING_PARAMS", "--from= and --to= are required (rotation never picks a direction here)");
    if (String(from).toUpperCase() === String(to).toUpperCase()) return block("SAME_TOKEN", "--from and --to must differ");
    const amt = amount === null || amount === undefined ? "" : String(amount).trim();
    if (!amt || !/^\d+(\.\d+)?$/.test(amt) || !(Number(amt) > 0)) {
      return block("MISSING_AMOUNT", "--amount= must be a plain positive decimal string (no random sizing, no scientific notation)");
    }

    if (!confirm) this.log("[SINGLE-SWAP] no --confirm — READ-ONLY plan: quote / amountOutMin / pool share / price impact / gas / preflight, nothing signed", "warn");
    await this.ensureMarkets();
    const { directions, decimalsMap } = this._swapDirections({ from, to });
    if (!directions.length) return block("NO_ROUTE", `no validated route ${from}→${to} (routes=${(this.routes || []).length})`);
    const dir = directions[0];

    const cfg = normalizeSwapConfig(this.config);
    const { provider, wallet } = this.getRuntime();
    const ctx = {
      cfg, provider, wallet, walletAddr: wallet.address, decimalsMap,
      dryRun: !confirm || !!this.config.dryRun,
      slippageBps: BigInt(cfg.slippageBps),
      phase: "SINGLE-SWAP ",
      pinned: { amount: amt, allowApprove: false },
    };

    this.log(`[SINGLE-SWAP] ONE operation only: ${dir.from}→${dir.to} amount=${amt} confirm=${!!confirm} dryRun=${ctx.dryRun} — no loop, no OPEN/CLOSE, no auto-advance`, "warn");
    const res = await this._attemptSwapDirection(dir, ctx);   // ← exactly one attempt
    out.result = res || null;
    out.plan = res?.plan || null;
    if (res?.status === "ok") { out.sent = 1; out.verified = 1; }
    if (res?.status === "dry") this.log("[SINGLE-SWAP] planned only — re-run with --confirm to send exactly this one transaction", "warn");
    if (res?.status === "skip" || res?.status === "fail") this.log(`[SINGLE-SWAP] not executed (${res.code}) — no retry, no rotation to another pair`, "warn");
    this.log(`[SINGLE-SWAP] done — attempted=${res ? 1 : 0} sent=${out.sent} verified=${out.verified} outcome=${res?.status || "none"} code=${res?.code || "-"}`, out.sent ? "success" : "warn");
    return out;
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
   * Locate `state.activePosition` ON-CHAIN without trusting local identity.
   *
   * Used when the stored record has no resolvable manager (or at startup), so a
   * stale/legacy record can neither block CLOSE forever nor be cleared on a
   * failed read. Only the chain decides:
   *   • resolved manager says active      → {status:"active", managerAddr}
   *   • resolved manager says inactive    → {status:"closed"}   (zombie → clear)
   *   • no identity, some manager has it  → {status:"active", located:true}
   *   • no identity, no manager has it    → {status:"missing"}  (zombie → clear)
   *   • every read failed                 → {status:"unreadable"} (KEEP state)
   */
  async _locateStoredPosition() {
    const pos = this.state.activePosition;
    if (!pos || pos.positionId === null || pos.positionId === undefined) return { status: "no-id", reads: 0 };
    const { provider } = this.getRuntime();
    const walletAddr = (this.deps?.accounts?.[this.deps.selectedWalletIndex]?.address || "").toLowerCase();

    const resolved = this.resolveManagerForPosition(pos);
    if (resolved?.managerAddr) {
      const onChain = await readOnChainPosition(provider, resolved.managerAddr, pos.positionId);
      if (!onChain) return { status: "unreadable", managerAddr: resolved.managerAddr, reads: 1 };
      if (positionIsClosed(onChain)) return { status: "closed", managerAddr: resolved.managerAddr, reads: 1 };
      if (onChain.user && walletAddr && String(onChain.user).toLowerCase() !== walletAddr) {
        return { status: "missing", managerAddr: resolved.managerAddr, reads: 1 };
      }
      return { status: "active", managerAddr: resolved.managerAddr, onChain, located: false, reads: 1 };
    }

    // No usable identity — ask every manager we know about.
    const managers = [];
    const add = (m) => { if (m && !managers.some(x => String(x).toLowerCase() === String(m).toLowerCase())) managers.push(m); };
    for (const m of (Array.isArray(this.markets) ? this.markets : [])) add(m.managerAddr);
    for (const p of Object.values(this.deps?.confirmedPools || {})) add(p?.manager);
    if (!managers.length) return { status: "unreadable", reads: 0 };

    let reads = 0;
    let sawReadable = false;
    for (const mgr of managers) {
      const onChain = await readOnChainPosition(provider, mgr, pos.positionId);
      reads += 1;
      if (!onChain) continue;
      sawReadable = true;
      if (positionIsClosed(onChain)) continue;
      if (onChain.user && walletAddr && String(onChain.user).toLowerCase() !== walletAddr) continue;
      return { status: "active", managerAddr: mgr, onChain, located: true, reads };
    }
    return sawReadable ? { status: "missing", reads } : { status: "unreadable", reads };
  }

  /**
   * Signature of the ON-CHAIN position state a CLOSE attempt depends on.
   *
   * Two attempts with the same signature are literally the same attempt: only
   * those must be backed off instead of repeated forever (the legacy state
   * carried `closeAttempts: 879` with no delay at all — a livelock).
   */
  _closeSig(onChain) {
    if (!onChain) return null;
    return `${onChain.active ? 1 : 0}:${String(onChain.collateralAmount)}:${String(onChain.currentDebt)}`;
  }

  /** Exponential backoff for identical close attempts: base 20s → cap 600s. */
  _closeBackoffMs(attempts) {
    const base = Math.max(1000, Number(this.config.closeRetryBaseMs) || 20000);
    const cap = Math.max(base, Number(this.config.closeRetryMaxMs) || 600000);
    const exp = Math.min(Math.max(0, (Number(attempts) || 1) - 1), 6);
    return Math.min(cap, base * (2 ** exp));
  }

  /**
   * Record a FAILED close attempt and return the ms to wait before the next one.
   * A different on-chain signature (state actually moved) resets the backoff.
   */
  _noteCloseFailure(sig, code) {
    const prev = this.state.closeRetry || {};
    const attempts = (prev.sig && prev.sig === sig ? Number(prev.attempts || 0) : 0) + 1;
    const delay = this._closeBackoffMs(attempts);
    // DRY-RUN: report the backoff that WOULD be scheduled — never write it.
    if (this._isDry()) {
      this.log(`[DRY] would schedule close retry in ${Math.ceil(delay / 1000)}s (code=${code || "?"}) — closeRetry/closeAttempts untouched`, "info");
      return delay;
    }
    const now = Date.now();
    this.state.closeRetry = { attempts, sig: sig || null, code: code || null, lastAttemptAt: now, nextAt: now + delay };
    this.state.closeAttempts = (Number(this.state.closeAttempts) || 0) + 1;
    saveState(this.state);
    return delay;
  }

  /** Clear close retry bookkeeping (position gone / attempt succeeded). */
  _resetCloseRetry() {
    if (this._isDry()) return;
    if (this.state.closeRetry) this.state.closeRetry = null;
    this.state.closeAttempts = 0;
  }

  /**
   * Clear the tracked position record — READ-ONLY in dry-run.
   *
   * Every `activePosition = null` / `sessionStats.closes++` pair in this class
   * goes through here, so a dry run can only ever LOG the clearing it would do.
   *
   * @param {string} reason  why the record is being cleared (for the DRY log)
   * @param {boolean} countClose  bump `sessionStats.closes` (a real close does)
   * @returns {boolean} true when the record was actually cleared
   */
  _clearActivePosition(reason, countClose = true) {
    const id = this.state.activePosition?.positionId ?? "?";
    if (this._isDry()) {
      this.log(`[DRY] Would CLEAR position #${id} (${reason}) — activePosition/sessionStats untouched`, "info");
      return false;
    }
    this.state.activePosition = null;
    if (countClose) this.state.sessionStats.closes++;
    this._resetCloseRetry();
    saveState(this.state);
    return true;
  }

  /**
   * Reconcile the local `activePosition` record with an authoritative on-chain
   * snapshot. The CHAIN is the source of truth; the local record is only a cache.
   *
   * Why this exists: a partial close (or any externally-settled close) reduces
   * on-chain collateral/debt but historically left the local record at its
   * open-time values — on position #75 the local `collateralAmount` was
   * 1721515506 while the chain reported 12007481 (~143× divergence). Any close
   * size computed from the stale local number would be wrong, and the divergence
   * is exactly what makes a bot "stick" on a position it cannot reason about.
   *
   * Rules:
   *  • NEVER called with an unreadable/ambiguous snapshot (callers pass only a
   *    snapshot they just successfully read).
   *  • NEVER clears `activePosition` — only updates its numeric identity fields.
   *    Clearing remains exclusive to `_clearActivePosition` (verified close or
   *    zombie), so an on-chain-confirmed active position can never be forgotten.
   *  • DRY-RUN: logs the divergence but writes nothing.
   *
   * @param {object} onChain  {collateralAmount, currentDebt, debtAmount, isLong, active}
   * @param {object} [opts]   {managerAddr}
   * @returns {{synced:boolean, changed:string[]}}
   */
  _syncActivePositionFromChain(onChain, { managerAddr = null } = {}) {
    const pos = this.state.activePosition;
    if (!pos || !onChain) return { synced: false, changed: [] };

    // Compute the diff FIRST, apply it only if this instance may persist. A dry
    // run must never mutate the live record even transiently.
    const changes = [];
    const plan = (field, next) => {
      const prev = pos[field];
      if (prev === undefined || prev === null) { changes.push([field, next, `∅→${next}`]); return; }
      if (String(prev) !== String(next)) { changes.push([field, next, `${prev}→${next}`]); }
    };

    if (onChain.collateralAmount !== undefined && onChain.collateralAmount !== null) {
      plan("collateralAmount", String(onChain.collateralAmount));
    }
    if (onChain.currentDebt !== undefined && onChain.currentDebt !== null) {
      plan("debtAmount", String(onChain.currentDebt));
    }
    if (onChain.isLong !== undefined && onChain.isLong !== null) {
      const side = onChain.isLong ? "LONG" : "SHORT";
      if (pos.side !== side) changes.push(["side", side, `side→${side}`]);
    }
    if (managerAddr && (!pos.managerAddr || String(pos.managerAddr).toLowerCase() !== String(managerAddr).toLowerCase())) {
      changes.push(["managerAddr", managerAddr, `managerAddr→${managerAddr}`]);
    }

    if (!changes.length) return { synced: false, changed: [] };
    const changed = changes.map(c => c[2]);

    if (this._isDry()) {
      this.log(`[DRY] would sync position #${pos.positionId} from on-chain: ${changed.join(" ")} — state untouched`, "info");
      return { synced: false, changed };
    }
    for (const [field, next] of changes) pos[field] = next;
    this.log(`[SYNC] position #${pos.positionId} local record reconciled with on-chain: ${changed.join(" ")}`, "warn");
    saveState(this.state);
    return { synced: true, changed };
  }

  /**
   * Settle a still-PENDING open transaction.
   *
   * An open only becomes an OPEN when a receipt proves it: `sessionStats.opens`,
   * `lastSide`, the direction-success counters and `[OPEN] … SUCCESS` are all
   * withheld until then. Before this method existed a timeout on the receipt
   * read produced `{pending:true, positionId:null}`, which the cycle then
   * recorded as a successful open — a success the chain (and nemesis.trade)
   * never saw.
   *
   * @returns {Promise<{status:string, done:boolean}>}
   *   `done` — the record no longer needs another settlement pass.
   */
  async _settlePendingOpen() {
    const pos = this.state.activePosition;
    if (!pos?.pendingOpen) return { status: "none", done: true };
    if (this._isDry()) return { status: "none", done: true };

    const hash = pos.txHash || null;
    if (!hash) {
      this.log(`[OPEN] pending open record has no txHash — clearing`, "warn");
      this._clearActivePosition("pending open without txHash", false);
      return { status: "cleared", done: true };
    }

    const { provider } = this.getRuntime();
    const receipt = (await resolveReceipt({ provider, hash }))?.receipt || null;

    if (!receipt) {
      let txObj;
      try { txObj = await provider.getTransaction(hash); } catch { txObj = undefined; }
      const state = classifyTx({ receipt: null, tx: txObj });
      if (state === TX_STATE.DROPPED_OR_REPLACED) {
        this.log(`[OPEN] tx ${hash} DROPPED_OR_REPLACED — no receipt and no longer in the mempool`, "error");
        this._clearActivePosition("pending open dropped/replaced", false);
        return { status: state, done: true };
      }
      if (state === TX_STATE.UNKNOWN) {
        this.log(`[OPEN] tx ${hash} UNKNOWN — mined in block ${txObj?.blockNumber} but no endpoint returned a receipt; status unresolved`, "error");
        return { status: state, done: false };
      }
      this.log(`[OPEN] tx ${hash} still PENDING — not counting it as an open`, "warn");
      return { status: TX_STATE.PENDING, done: false };
    }

    if (Number(receipt.status) !== 1) {
      this.log(`[OPEN] tx ${hash} REVERTED (receipt.status=0) — not an open`, "error");
      this._clearActivePosition("pending open reverted", false);
      return { status: TX_STATE.REVERTED, done: true };
    }

    // CONFIRMED — but only a PositionCreated event identifies WHAT opened.
    let positionId = null;
    for (const logEntry of receipt.logs || []) {
      if (logEntry.topics?.[0] === POSITION_CREATED_TOPIC
        && (!pos.managerAddr || String(logEntry.address).toLowerCase() === String(pos.managerAddr).toLowerCase())) {
        positionId = Number(BigInt(logEntry.topics[2]));
        break;
      }
    }
    if (positionId === null) {
      this.log(`[OPEN] CONFIRMED_STATE_MISMATCH tx=${hash} block=${receipt.blockNumber} — receipt status 1 but no PositionCreated event; not counting it as an open`, "error");
      pos.pendingOpen = false;
      pos.mismatch = true;
      saveState(this.state);
      return { status: TX_STATE.CONFIRMED_STATE_MISMATCH, done: true };
    }

    pos.positionId = positionId;
    pos.pendingOpen = false;
    if (pos.marketSymbol && pos.side) {
      this._recordDirectionSuccess(pos.marketSymbol, pos.side);
      this._rotMarketDone(pos.marketSymbol, pos.side);
    }
    this.state.lastSide = pos.side;
    this.state.sessionStats.opens++;
    saveState(this.state);
    this.log(`[OPEN] CONFIRMED tx=${hash} block=${receipt.blockNumber} — position #${positionId} (${pos.side} ${pos.marketSymbol || "?"}); sessionStats.opens=${this.state.sessionStats.opens}`, "success");
    return { status: TX_STATE.CONFIRMED, done: true };
  }

  /**
   * Apply a closePositionFn() result to `state`.
   *
   * `activePosition` is cleared ONLY when the position is provably gone:
   * a zombie (MAM_InvalidPosition) or an on-chain verified close.
   * Every other outcome — dry run, pending TX, liquidity-blocked partial close,
   * unreadable verification — KEEPS the position and schedules a backoff, so the
   * bot can never orphan an open one and can never spin on an identical failing
   * close. A DRY RUN never mutates anything at all (see `_clearActivePosition`).
   *
   * @param {object|null} closeResult outcome from closePositionFn()
   * @param {string|null} sig on-chain signature captured before the attempt
   * @returns {{ok:boolean, blocked:boolean, continueCycle:boolean, code:string|null, dryRun?:boolean}}
   *   `ok`          — the position is (or would be) gone, so the OPEN phase may run.
   *   `dryRun`      — true when the close was only PLANNED: `ok` is true but the
   *                   record was deliberately kept, so PHASE 1.5b must not treat
   *                   it as a still-open position.
   *   `blocked`     — the position was KEPT and nothing is in flight: the close
   *                   cannot happen right now (liquidity / preflight / still
   *                   active) but the cycle must keep going.
   *   `continueCycle` — ALWAYS true. A failed close never ends the runCycle; it
   *                   only decides whether the OPEN phase is skipped.
   */
  _applyCloseResult(closeResult, sig = null) {
    const CONTINUE = true;
    this.lastCloseTxHash = closeResult?.txHash || null;
    if (!closeResult) {
      const d = this._noteCloseFailure(sig, "CLOSE_NO_RESULT");
      this.log(`[CLOSE] Failed — position KEPT, retry in ${Math.ceil(d / 1000)}s`, "error");
      return { ok: false, blocked: true, continueCycle: CONTINUE, code: "CLOSE_NO_RESULT" };
    }
    if (closeResult.dryRun) {
      // ─── DRY-CLOSE: REPORT ONLY ──────────────────────────────────────────
      // `[DRY] Would CLOSE position #N` was already logged by closePositionFn().
      // The record is KEPT: activePosition, sessionStats.closes and the close
      // backoff all stay byte-identical (requirement 4).
      const id = this.state.activePosition?.positionId ?? "?";
      this.log(`[DRY] Would CLOSE position #${id} — state untouched (activePosition/sessionStats/closeRetry unchanged)`, "info");
      return { ok: true, blocked: false, continueCycle: CONTINUE, code: null, dryRun: true };
    }
    if (closeResult.pending) {
      const d = this._noteCloseFailure(sig, "TX_PENDING");
      this.log(`[CLOSE] TX ${closeResult.txHash || ""} pending — state kept, will verify next cycle (in ${Math.ceil(d / 1000)}s)`, "warn");
      return { ok: false, blocked: false, continueCycle: CONTINUE, code: "TX_PENDING" };
    }
    if (closeResult.failed) {
      if (closeResult.clearState === false) {
        const d = this._noteCloseFailure(sig, closeResult.code || "FAILED");
        this.log(`[CLOSE] blocked (${closeResult.code || closeResult.reason || "?"}) — position KEPT, retry in ${Math.ceil(d / 1000)}s`, "warn");
        return { ok: false, blocked: true, continueCycle: CONTINUE, code: closeResult.code || "FAILED" };
      }
      this.log(`[CLOSE] Position gone (${closeResult.reason || "zombie"}) — clearing state`, "warn");
      this._clearActivePosition(closeResult.reason || "zombie");
      return { ok: true, blocked: false, continueCycle: CONTINUE, code: null };
    }
    if (closeResult.closed === false) {
      const d = this._noteCloseFailure(sig, closeResult.code || "STILL_ACTIVE");
      this.log(`[CLOSE] ${closeResult.code || "not closed"} — position KEPT, retry in ${Math.ceil(d / 1000)}s`, "warn");
      return { ok: false, blocked: true, continueCycle: CONTINUE, code: closeResult.code || "STILL_ACTIVE" };
    }
    const part = closeResult.partial ? ` (partial closeBps=${closeResult.closeBps})` : "";
    this.log(`[CLOSE] SUCCESS TX: ${closeResult.txHash || "dry-run"}${part} — verified on-chain`, "success");
    this._clearActivePosition("verified close");
    return { ok: true, blocked: false, continueCycle: CONTINUE, code: null };
  }

  /**
   * Close `state.activePosition` via ITS OWN manager (`resolveManagerForPosition`).
   *
   * Always returns a structured result so a caller can tell "position gone →
   * OPEN may run" from "position still active → OPEN must be skipped but the
   * cycle (and the swap engine) keeps running". A liquidity-blocked close KEEPS
   * the position, schedules the backoff and never clears on-chain state.
   *
   * @returns {Promise<{ok:boolean, blocked:boolean, continueCycle:boolean, code:string|null}>}
   */
  async closeActivePosition() {
    const DONE = { ok: true, blocked: false, continueCycle: true, code: null };
    if (!this.state.activePosition) return { ...DONE, code: "NO_ACTIVE_POSITION" };
    if (this.state.activePosition.pendingOpen) {
      // A submitted-but-unconfirmed open must never be dropped as a
      // "failed-open leftover" — that would let the next cycle double-open.
      const settle = await this._settlePendingOpen();
      if (!settle.done) {
        this.log(`[CLOSE] open tx ${this.state.activePosition.txHash || "?"} still ${settle.status} — deferring close`, "warn");
        return { ok: false, blocked: false, continueCycle: true, code: `OPEN_${String(settle.status).toUpperCase()}` };
      }
      if (!this.state.activePosition) return { ...DONE, code: "OPEN_NOT_CONFIRMED" };
    }
    if (this.state.activePosition.positionId === null || this.state.activePosition.positionId === undefined) {
      this.log(`[CLOSE] stored record has no positionId (failed-open leftover) — clearing`, "warn");
      this._clearActivePosition("no positionId", false);
      return DONE;
    }

    const { provider, wallet } = this.getRuntime();
    // P7: the manager comes from THIS position's identity — never from a
    // side-derived getManagerAddr() fallback (that can target another market).
    const resolved = this.resolveManagerForPosition(this.state.activePosition);
    const positionId = this.state.activePosition.positionId;
    let managerAddr = resolved?.managerAddr || null;
    let onChain = null;

    if (!managerAddr) {
      // No usable local identity — the CHAIN decides (never a guessed manager).
      const found = await this._locateStoredPosition();
      if (found.status === "active") {
        managerAddr = found.managerAddr;
        onChain = found.onChain;
        if (!this._isDry()) {
          this.state.activePosition.managerAddr = found.managerAddr;
          const mk = (Array.isArray(this.markets) ? this.markets : [])
            .find(m => String(m.managerAddr || "").toLowerCase() === String(found.managerAddr).toLowerCase());
          if (mk) {
            if (!this.state.activePosition.poolAddr) this.state.activePosition.poolAddr = mk.poolAddr;
            if (!this.state.activePosition.marketSymbol) this.state.activePosition.marketSymbol = mk.marketSymbol || mk.symbol;
          }
          saveState(this.state);
        }
        this.log(`[CLOSE] position #${positionId} located on-chain on manager ${short(found.managerAddr)} — identity recorded`, "warn");
      } else if (found.status === "closed" || found.status === "missing") {
        this.log(`[CLOSE] position #${positionId} not active on any known manager (id never reported) — clearing zombie state`, "warn");
        this._clearActivePosition("zombie (never reported)");
        return DONE;
      } else if (found.status === "no-id") {
        // A record without positionId is a failed-OPEN leftover — no on-chain
        // position can exist for it, so it must not block the OPEN phase.
        this.log(`[CLOSE] stored record has no positionId (failed-open leftover) — clearing`, "warn");
        this._clearActivePosition("no positionId", false);
        return DONE;
      } else {
        const d = this._noteCloseFailure(null, "POSITION_UNRESOLVED");
        this.log(`[CLOSE] position #${positionId} identity unresolved and chain unreadable — position KEPT, retry in ${Math.ceil(d / 1000)}s`, "warn");
        return { ok: false, blocked: true, continueCycle: true, code: "POSITION_UNRESOLVED" };
      }
    } else if (!onChain) {
      // ON-CHAIN TRUTH FIRST — one read decides everything before any attempt:
      // gone → clear local state; active → close (with backoff); unreadable → backoff.
      onChain = await readOnChainPosition(provider, managerAddr, positionId);
    }

    if (onChain && positionIsClosed(onChain)) {
      this.log(`[CLOSE] position #${positionId} already inactive on-chain — clearing local state`, "success");
      this._clearActivePosition("already inactive on-chain");
      return DONE;
    }
    if (!onChain) {
      const d = this._noteCloseFailure(null, "POSITION_UNREADABLE");
      this.log(`[CLOSE] positions(${positionId}) unreadable on ${short(managerAddr)} — position KEPT, retry in ${Math.ceil(d / 1000)}s`, "warn");
      return { ok: false, blocked: true, continueCycle: true, code: "POSITION_UNREADABLE" };
    }
    const sig = this._closeSig(onChain);

    // LOCAL/ON-CHAIN DIVERGENCE GUARD — the chain is authoritative. A stale
    // local record (e.g. collateralAmount left over from the open size after a
    // partial close, as on #75: local 1721515506 vs chain 12007481) would make
    // every locally-computed close size wrong. Reconcile BEFORE attempting so
    // the attempt uses real numbers; never the other way round.
    this._syncActivePositionFromChain(onChain, { managerAddr });

    // Identical attempt inside the backoff window → do not touch the chain,
    // let SWAP maintenance continue this cycle and come back later.
    const retry = this.state.closeRetry || null;
    if (retry && retry.sig === sig && Number(retry.nextAt || 0) > Date.now()) {
      const waitS = Math.ceil((Number(retry.nextAt) - Date.now()) / 1000);
      this.log(`[CLOSE] backoff ${waitS}s — attempt ${retry.attempts} on unchanged position (code=${retry.code || "?"}); SWAP/OPEN cycle continues`, "info");
      return { ok: false, blocked: true, continueCycle: true, code: retry.code || "BACKOFF" };
    }

    const dryRun = this.config.dryRun;
    this.setState(STATES.CLOSE);
    this.log(`[AUTO] CLOSING position #${positionId} (${this.state.activePosition.side}) market=${this.state.activePosition.marketSymbol || resolved?.marketSymbol || "?"} manager=${short(managerAddr)} src=${resolved?.source || "chain"} attempt=${retry && retry.sig === sig ? Number(retry.attempts) + 1 : 1}`, "warn");

    const closeResult = await closePositionFn({
      wallet, provider, managerAddr, positionId,
      config: this.config, log: this.log.bind(this), dryRun, txManager: this.txManager,
    });

    return this._applyCloseResult(closeResult, sig);
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

    // REQUIRED COLLATERAL IS ALREADY THERE — a top-up swap would be an extra TX
    // that can fail for no reason. Reserve top-up is maintenance, never a
    // precondition for OPEN: only a real deficit (balance < required) blocks it.
    if (balance >= collateralAmount) {
      this.log(`[INVENTORY] ${collateralSym} balance ${ethers.formatUnits(balance, collateralDecimals)} >= required ${ethers.formatUnits(collateralAmount, collateralDecimals)} — no top-up swap needed`, "success");
      return true;
    }

    const deficit = calculateInventoryDeficit({
      balance, required: collateralAmount, targetReserve,
      decimals: collateralDecimals, sym: collateralSym,
      log: this.log.bind(this),
    });

    if (deficit.action === "none") {
      if (balance < collateralAmount) {
        // calculateInventoryDeficit() only compares against targetReserve — a
        // reserve below the required collateral must NEVER read as "ready",
        // or the OPEN would be attempted with too little collateral.
        this.log(`[INVENTORY] ${collateralSym} reserve target met but balance ${ethers.formatUnits(balance, collateralDecimals)} < required ${ethers.formatUnits(collateralAmount, collateralDecimals)} — treating as a critical deficit`, "warn");
        deficit.action = "critical";
        deficit.swapAmount = collateralAmount - balance;
        deficit.reason = `${collateralSym} critical deficit: have ${ethers.formatUnits(balance, collateralDecimals)}, need ${ethers.formatUnits(collateralAmount, collateralDecimals)}`;
      } else {
        this.log(`[INVENTORY] RESERVE OK — ${collateralSym} ${ethers.formatUnits(balance, collateralDecimals)} >= target ${ethers.formatUnits(targetReserve, collateralDecimals)}`, "success");
        return true;
      }
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

        if (!swapResult || swapResult.ok === false) {
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

  /**
   * Contract-aware leverage resolution for ONE candidate (see resolveLeverageForOpen).
   * Per-market override: config.marketLeverage["SYMBOL"] > config.defaultLeverage.
   */
  async _resolveOpenLeverage(candidate, side, ctx, provider, overrideLeverage = null) {
    return resolveLeverageForOpen(provider, {
      managerAddr: ctx.managerAddr,
      marketSymbol: candidate?.symbol || null,
      isLong: side === "LONG",
      collateralToken: ctx.collateralToken ?? null,
      collateralAmount: ctx.collateralAmount ?? null,
      requestedLeverage: overrideLeverage
        ?? this.config.marketLeverage?.[candidate?.symbol]
        ?? this.config.defaultLeverage,
      config: this.config,
      log: this.log.bind(this),
    });
  }

  async prepareAndOpen(side, opts = {}) {
    const { provider, wallet } = this.getRuntime();
    const walletAddr = wallet.address;
    const dryRun = this.config.dryRun;

    await this.ensureMarkets();
    let marketCandidates = await this.planMarketsForSide(side, {
      max: Number(this.config.maxMarketAttemptsPerCycle || 3),
    });
    if (opts.marketSymbol) {
      const want = String(opts.marketSymbol).toLowerCase();
      const only = marketCandidates.filter(
        m => String(m.marketSymbol || m.symbol || "").toLowerCase() === want,
      );
      if (!only.length) {
        const known = marketCandidates.map(m => m.marketSymbol || m.symbol).join(", ") || "none";
        this.log(`[BLOCKED] requested market ${opts.marketSymbol} not available for ${side} (candidates: ${known})`, "error");
        return false;
      }
      marketCandidates = only;
    }
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
    const shownLev = opts.leverage
      ?? this.config.marketLeverage?.[market.marketSymbol || market.symbol]
      ?? this.config.defaultLeverage;
    this.log(`[AUTO] OPENING ${side} ${shownLev}x${opts.marketSymbol ? ` (pinned market ${opts.marketSymbol})` : ""}`, "warn");
    this.setState(STATES.OPEN);
    let openResult = null;
    let openedMarket = null;
    let openedCtx = null;
    let openedLeverage = null;
    for (const candidate of marketCandidates) {
      this.log(`[OPEN] trying market ${candidate.symbol} manager=${short(candidate.managerAddr)}`, "info");

      const ctx = await this._candidateContext(candidate, side, { provider, walletAddr });
      if (!ctx) {
        this.log(`[OPEN] market ${candidate.symbol} skipped (collateral context) — trying next candidate`, "warn");
        this._rotMarketSkip(candidate.symbol, side);
        continue;
      }

      // P2 hard invariants — everything market-specific must belong to THIS candidate.
      const inv = await this._assertCandidateInvariants(candidate, ctx, side, provider);
      if (!inv.ok) {
        this.log(`[SKIP] ${candidate.symbol} ${side}: invariant failed — ${inv.reason} — trying next candidate`, "warn");
        this._rotMarketSkip(candidate.symbol, side);
        continue;
      }

      // LEVERAGE — contract bounds ∩ config ∩ per-market override, probed with
      // previewOpenPosition (read-only). Unresolvable → next candidate.
      const levPlan = await this._resolveOpenLeverage(candidate, side, ctx, provider, opts.leverage ?? null);
      if (!levPlan.ok) {
        this.log(`[SKIP] ${candidate.symbol} ${side}: leverage unresolved (${levPlan.code}: ${levPlan.reason}) — trying next candidate`, "warn");
        this._rotMarketSkip(candidate.symbol, side);
        continue;
      }

      // READ-ONLY viability pre-check (view calls only, no transaction).
      // Minimum-size/dust candidates are SKIPPED with a reason, never counted
      // as a direction failure (see P4).
      const pre = await precheckMarketQuote(provider, {
        pool: ctx.poolAddr, manager: ctx.managerAddr,
        collateralToken: ctx.collateralToken, collateralAmount: ctx.collateralAmount,
        leverageX10: BigInt(levPlan.leverageX10),
        isLong: side === "LONG", log: this.log.bind(this),
      });
      if (!pre.ok) {
        this.log(`[SKIP] ${candidate.symbol} ${side}: quote not viable (${pre.code || "QUOTE_UNUSABLE"}: ${pre.reason}) — trying next candidate`, "warn");
        this._rotMarketSkip(candidate.symbol, side);
        continue;
      }

      // Collateral top-up derived from scratch for THIS candidate (ETH→WETH wrap allowed)
      const ready = await this._ensureCollateralForCtx(ctx, {
        provider, wallet, walletAddr, dryRun, allowEthWrap: true, resetNonceOnError: true,
      });
      if (!ready) {
        this._rotMarketSkip(candidate.symbol, side);
        continue;
      }

      const attempt = await openPosition({
        wallet, provider, managerAddr: ctx.managerAddr, poolAddr: ctx.poolAddr,
        side, collateralToken: ctx.collateralToken, collateralAmount: ctx.collateralAmount,
        leverage: levPlan.leverage,
        config: this.config, log: this.log.bind(this), dryRun, txManager: this.txManager,
        paymentToken: ctx.paymentToken,
      });
      openResult = attempt;
      if (attempt) {
        openedMarket = candidate;
        openedCtx = ctx;
        openedLeverage = levPlan.leverage;
        break;
      }
      this._recordDirectionFailure(candidate.symbol, side);
      this.log(`[OPEN] market ${candidate.symbol} failed — trying next candidate`, "warn");
    }
    const marketUsed = openedMarket || market;
    const ctxUsed = openedCtx;

    if (openResult?.dryRun) {
      // DRY-OPEN: report only — lastSide / rotation / sessionStats stay untouched.
      this.log(`[DRY] Open ${side} would execute on ${marketUsed.symbol}`, "info");
      this.log(`[DRY] state untouched — lastSide/rotation/sessionStats unchanged`, "info");
      return true;
    } else if (openResult?.pending) {
      // SUBMITTED/PENDING is NOT an open — kept only to block a second OPEN.
      // sessionStats.opens stays untouched until _settlePendingOpen() proves it.
      this.state.activePosition = {
        positionId: openResult.positionId ?? null,
        side,
        collateralToken: ctxUsed?.collateralToken || marketUsed.collateralToken,
        collateralAmount: String(ctxUsed?.collateralAmount ?? ""),
        paymentToken: ctxUsed?.paymentToken || marketUsed.paymentToken || null,
        leverage: openedLeverage ?? this.config.defaultLeverage,
        openedAt: Date.now(),
        txHash: openResult.txHash,
        marketSymbol: marketUsed.symbol,
        managerAddr: marketUsed.managerAddr,
        poolAddr: marketUsed.poolAddr,
        pendingOpen: true,
      };
      saveState(this.state);
      this.log(`[OPEN] PENDING tx=${openResult.txHash} — awaiting confirmation; sessionStats.opens NOT incremented`, "warn");
      return true;
    } else if (openResult) {
      this._recordDirectionSuccess(marketUsed.symbol, side);
      this._rotMarketDone(marketUsed.symbol, side);
      this.state.activePosition = {
        positionId: openResult.positionId,
        side,
        // All of these come from the SAME candidate that actually opened
        collateralToken: ctxUsed?.collateralToken || marketUsed.collateralToken,
        collateralAmount: String(ctxUsed?.collateralAmount ?? ""),
        paymentToken: ctxUsed?.paymentToken || marketUsed.paymentToken || null,
        leverage: openedLeverage ?? this.config.defaultLeverage,
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

  // ═════════════════════════════════════════════════════════════════════════
  //  POSITION STATUS — on-chain truth (read-only, never sends a TX)
  // ═════════════════════════════════════════════════════════════════════════

  /**
   * Full status report for ONE position: getPositionRisk (17-field) + positions
   * (+getHealthFactor) + a full-close preview — everything from view calls.
   *
   * @param positionId {string|number|bigint}
   * @param managerAddr {string|null} explicit manager; falls back to the stored
   *        position identity (resolveManagerForPosition) when the id matches it.
   * @returns structured report (bigints as decimal strings) or {ok:false,code}
   */
  async describePosition(positionId, managerAddr = null) {
    const { provider, wallet } = this.getRuntime();
    const walletAddr = String(wallet?.address || "").toLowerCase();
    const idStr = String(positionId);
    let id;
    try { id = BigInt(positionId); } catch { return { ok: false, code: "BAD_ID", positionId: idStr, reason: "positionId is not a number" }; }

    let mgrAddr = managerAddr || null;
    const stored = this.state.activePosition;
    if (!mgrAddr && stored && String(stored.positionId ?? "") === idStr) {
      mgrAddr = this.resolveManagerForPosition(stored)?.managerAddr || stored.managerAddr || null;
    }
    if (!mgrAddr && stored?.managerAddr && !managerAddr) mgrAddr = stored.managerAddr;
    if (!mgrAddr) {
      return {
        ok: false, code: "NO_MANAGER", positionId: idStr,
        reason: "no manager address known for this position — pass --manager=0x…",
      };
    }

    const mgr = new ethers.Contract(mgrAddr, MANAGER_ABI, provider);
    let risk = null; let riskErr = null;
    let pos = null; let posErr = null;
    let hf = null;
    let closeFull = null;
    let closeFullBps = null;

    try { risk = await mgr.getPositionRisk(id); } catch (e) { riskErr = revertSelector(e) || String(e?.message || e).slice(0, 60); }
    try { pos = await mgr.positions(id); } catch (e) { posErr = revertSelector(e) || String(e?.message || e).slice(0, 60); }
    try { hf = await mgr.getHealthFactor(id); } catch { hf = null; }

    const active = risk ? !!risk.isActive : (pos ? !!pos.active : null);
    if (risk && active) {
      try {
        closeFull = await mgr.previewClosePosition(id, 10000n);
        closeFullBps = 10000;
      } catch (e1) {
        try {
          closeFull = await mgr.previewClosePosition(id, 9999n);
          closeFullBps = 9999;
        } catch (e2) { closeFull = { err: revertSelector(e2) || revertSelector(e1) || "revert" }; }
      }
    }

    const found = !!(risk || pos);
    if (!found && (riskErr === ERR_INVALID_POSITION || posErr === ERR_INVALID_POSITION)) {
      return {
        ok: true, found: false, active: false, positionId: idStr, managerAddr: mgrAddr,
        status: "NOT_FOUND", reason: "MAM_InvalidPosition — the manager has no such position",
      };
    }

    const isLong = risk ? !!risk.isLong : pos ? !!pos.isLong : null;
    const collateralToken = risk ? risk.collateralToken : pos ? pos.collateralToken : null;
    const debtAsset = risk?.debtAsset ?? null;
    let collateralSym = null; let collateralDec = null;
    let debtSym = null; let debtDec = null;
    try {
      if (collateralToken) {
        const m = await tokenMetaOnChain(provider, collateralToken);
        collateralSym = m.symbol; collateralDec = m.decimals;
      }
    } catch { /* keep null */ }
    try {
      if (debtAsset) {
        const m = await tokenMetaOnChain(provider, debtAsset);
        debtSym = m.symbol; debtDec = m.decimals;
      }
    } catch { /* keep null */ }

    const equity = risk ? BigInt(risk.equityValue) : null;
    const debtValueT1 = risk ? BigInt(risk.currentDebtValueToken1) : null;
    const notional = risk ? BigInt(risk.notionalValue) : null;
    let estimatedLeverageX10 = null;
    if (equity !== null && debtValueT1 !== null && notional !== null) {
      const collateralValueT1 = debtValueT1 + equity; // value = equity + debt, token1 units
      if (collateralValueT1 > 0n && notional > 0n) {
        const x10 = (notional * 10n) / collateralValueT1;
        if (x10 >= 10n && x10 <= 1000n) estimatedLeverageX10 = Number(x10);
      }
    }

    let status;
    if (!found) status = "NOT_FOUND";
    else if (active === false) status = "CLOSED";
    else if (risk?.liquidatable) status = "LIQUIDATION_RISK";
    else if (hf !== null && Number(hf) === 0) status = "AT_RISK";
    else status = "ACTIVE";

    const report = {
      ok: true, found, active, positionId: idStr, managerAddr: mgrAddr, status,
      isLong, side: isLong === null ? null : isLong ? "LONG" : "SHORT",
      user: risk?.user || pos?.user || null,
      ours: String(risk?.user || pos?.user || "").toLowerCase() === walletAddr && !!walletAddr,
      collateralToken, collateralSym, collateralDecimals: collateralDec,
      collateralAmount: String(risk?.collateralAmount ?? pos?.collateralAmount ?? 0n),
      collateralAmountHuman: collateralDec !== null && risk
        ? ethers.formatUnits(risk.collateralAmount, collateralDec) : null,
      debtAsset, debtSym, debtDecimals: debtDec,
      storedDebt: risk ? String(risk.storedDebt) : null,
      currentDebt: risk ? String(risk.currentDebt) : null,
      currentDebtHuman: debtDec !== null && risk ? ethers.formatUnits(risk.currentDebt, debtDec) : null,
      currentDebtValueToken1: risk ? String(risk.currentDebtValueToken1) : null,
      notionalValue: notional !== null ? String(notional) : null,
      equityValue: equity !== null ? String(equity) : null, // PnL in token1 units (int, can be < 0)
      equityValueHuman: debtDec !== null && equity !== null ? ethers.formatUnits(equity, debtDec) : null,
      healthBps: risk ? Number(risk.healthBps) : null,
      healthFactor: hf !== null ? String(hf) : null,
      liquidationPrice: risk ? String(risk.liquidationPrice) : null,
      liquidatable: risk ? !!risk.liquidatable : null,
      oracleReady: risk ? !!risk.oracleReady : null,
      estimatedLeverageX10, // heuristic: notional / (debt + equity), NULL when meaningless
      leverageFromState: stored && String(stored.positionId ?? "") === idStr ? stored.leverage ?? null : null,
      closeFull: active && closeFull && !closeFull.err
        ? {
            closeBps: closeFullBps,
            repayAmount: String(closeFull.repayAmount),
            collateralReturned: String(closeFull.collateralReturned),
            realizedPnl: String(closeFull.realizedPnl),
            realizedPnlHuman: debtDec !== null ? ethers.formatUnits(closeFull.realizedPnl, debtDec) : null,
            closePrice: String(closeFull.closePrice),
            projectedHealthBps: Number(closeFull.projectedHealthBps),
          }
        : active && closeFull?.err
          ? { ok: false, err: closeFull.err }
          : null,
      readErrors: { risk: riskErr, positions: posErr },
    };
    return report;
  }

  _logPositionReport(rep) {
    if (!rep || rep.ok === false) {
      this.log(`[STATUS] FAILED ${rep?.code || "?"} — ${rep?.reason || "unknown"}`, "error");
      return;
    }
    if (!rep.found) {
      this.log(`[STATUS] #${rep.positionId}: ${rep.status} (${rep.reason || "manager has no such position"})`, "warn");
      return;
    }
    if (rep.active === false) {
      this.log(`[STATUS] #${rep.positionId}: CLOSED on-chain (last state: ${rep.side || "?"} ${rep.collateralSym || "?"})`, "success");
      return;
    }
    const parts = [
      `#${rep.positionId} ${rep.side} ${rep.ours ? "(ours)" : `(not ours: ${short(rep.user)})`}`,
      `collateral=${rep.collateralAmountHuman ?? rep.collateralAmount} ${rep.collateralSym || "?"}`,
      `debt=${rep.currentDebtHuman ?? rep.currentDebt ?? "?"} ${rep.debtSym || ""}`,
      `healthBps=${rep.healthBps ?? "?"}`,
      `equity(PnL)=${rep.equityValueHuman ?? rep.equityValue ?? "?"} ${rep.debtSym || ""}`,
      `leverage≈${rep.estimatedLeverageX10 !== null ? rep.estimatedLeverageX10 / 10 + "x" : "?"}` +
        (rep.leverageFromState !== null && rep.leverageFromState !== undefined ? ` (state ${rep.leverageFromState}x)` : ""),
      `liqPrice=${rep.liquidationPrice ?? "?"}`,
      `liquidatable=${rep.liquidatable}`,
      `status=${rep.status}`,
    ];
    this.log(`[STATUS] ${parts.join(" | ")}`, rep.status === "LIQUIDATION_RISK" ? "error" : "info");
    if (rep.closeFull && rep.closeFull.closeBps) {
      this.log(`[STATUS] full-close preview: recv=${rep.closeFull.collateralReturned} repay=${rep.closeFull.repayAmount} pnl=${rep.closeFull.realizedPnlHuman ?? rep.closeFull.realizedPnl} closePrice=${rep.closeFull.closePrice} (closeBps=${rep.closeFull.closeBps})`, "info");
    } else if (rep.closeFull?.ok === false) {
      this.log(`[STATUS] full-close preview REVERTED ${rep.closeFull.err} — close would need partialClose ladder`, "warn");
    }
    if (rep.status === "LIQUIDATION_RISK") {
      this.log(`[STATUS] #${rep.positionId} is LIQUIDATABLE on-chain — consider closing (see active writes later)`, "error");
    }
  }

  /**
   * Status listing: explicit id → that position; otherwise our active position
   * plus a read-only getUserPositions() scan over known managers.
   */
  async runPositionStatus({ positionId = null, managerAddr = null } = {}) {
    const { provider, wallet } = this.getRuntime();
    if (positionId !== null && positionId !== undefined && `${positionId}` !== "") {
      const rep = await this.describePosition(positionId, managerAddr);
      this._logPositionReport(rep);
      return { ok: rep.ok !== false, action: "status", reports: [rep] };
    }

    const mgrs = new Map();
    const add = (a) => { if (a && typeof a === "string" && a.startsWith("0x")) mgrs.set(a.toLowerCase(), a); };
    add(this.state.activePosition?.managerAddr);
    if (this.state.activePosition) add(this.resolveManagerForPosition(this.state.activePosition)?.managerAddr);
    for (const m of (this.markets || [])) add(m.managerAddr);
    const list = [...mgrs.values()].slice(0, 12);

    const reports = [];
    for (const a of list) {
      let ids = [];
      try {
        const c = new ethers.Contract(a, MANAGER_ABI, provider);
        ids = (await c.getUserPositions(wallet.address)) || [];
      } catch (e) {
        this.log(`[STATUS] getUserPositions failed on ${short(a)}: ${revertSelector(e) || String(e?.message || e).slice(0, 50)}`, "warn");
        continue;
      }
      for (const pid of ids) {
        const rep = await this.describePosition(pid, a);
        reports.push(rep);
        this._logPositionReport(rep);
      }
    }
    if (!reports.length) {
      this.log(`[STATUS] no open positions for ${wallet.address} (scanned ${list.length} manager(s))`, "info");
    }
    return { ok: true, action: "status", reports };
  }

  // ═════════════════════════════════════════════════════════════════════════
  //  SINGLE ACTION DISPATCH — open | close | partial | status | swap
  // ═════════════════════════════════════════════════════════════════════════

  /**
   * ONE operator action. Dry-run is the default: TX writes require BOTH
   * `confirm` and config.dryRun=false. Never loops, never rotates silently.
   *
   * @param opts.action {"open"|"close"|"partial"|"status"|"swap"}
   * @param opts.confirm {boolean} allow the write path (still gated by config.dryRun)
   * @param opts.side {"LONG"|"SHORT"}            (open)
   * @param opts.marketSymbol {string|null}       (open) pin one market
   * @param opts.leverage {number|null}           (open) per-position leverage override
   * @param opts.positionId {number|string|null}  (close/partial/status)
   * @param opts.pct {number|null}                (partial) 1..99 percent
   * @param opts.manager {string|null}            explicit manager override
   * @param opts.from/.to/.amount                 (swap, passed through to runSingleSwap)
   */
  async runSingleAction(opts = {}) {
    const action = String(opts.action || "").toLowerCase();
    const confirm = !!opts.confirm;
    const dryRun = !confirm || !!this.config.dryRun;
    const base = { ok: false, action, dryRun };

    if (action === "status") {
      return this.runPositionStatus({ positionId: opts.positionId ?? null, managerAddr: opts.manager ?? null });
    }

    if (action === "swap") {
      const out = await this.runSingleSwap({
        confirm, from: opts.from, to: opts.to, amount: opts.amount,
      });
      const ok = !!(out?.sent && out?.verified) || out?.result?.status === "dry";
      const code = out?.blocked ? out.blocked
        : out?.sent && out?.verified ? "SWAP_OK"
        : out?.result?.status === "dry" ? "DRY"
        : out?.result?.code || (out?.sent ? "UNCONFIRMED" : "NOT_SENT");
      return { ...base, ...out, ok, code, dryRun: out?.sent ? false : dryRun };
    }

    if (action === "open") {
      const side = String(opts.side || "").toUpperCase();
      if (side !== "LONG" && side !== "SHORT") {
        this.log(`[BLOCKED] --single=open requires --side=LONG or --side=SHORT (got "${opts.side || ""}")`, "error");
        return { ...base, code: "BAD_SIDE" };
      }
      const lev = opts.leverage !== null && opts.leverage !== undefined && `${opts.leverage}` !== ""
        ? Number(opts.leverage) : null;
      if (lev !== null && (!Number.isInteger(lev) || lev < 1)) {
        this.log(`[BLOCKED] --leverage must be an integer ≥1 (got ${opts.leverage})`, "error");
        return { ...base, code: "BAD_LEVERAGE" };
      }
      this.log(`[SINGLE] OPEN ${side}${opts.marketSymbol ? ` on ${opts.marketSymbol}` : ""}${lev !== null ? ` @ ${lev}x` : ""} confirm=${confirm} dryRun=${dryRun}`, "warn");
      const ok = await this.prepareAndOpen(side, { marketSymbol: opts.marketSymbol || null, leverage: lev });
      const ap = this.state.activePosition;
      return {
        ...base, ok: !!ok, code: ok ? (dryRun ? "OPEN_PLANNED" : "OPENED") : "OPEN_BLOCKED", dryRun,
        opened: ok ? ap : null,
        // dry-run: the leverage/market plan was logged by _resolveOpenLeverage
      };
    }

    if (action === "close" || action === "partial") {
      const idRaw = opts.positionId ?? this.state.activePosition?.positionId ?? null;
      if (idRaw === null || idRaw === undefined || `${idRaw}` === "") {
        this.log(`[BLOCKED] --id=<positionId> required (no tracked active position to fall back to)`, "error");
        return { ...base, code: "NO_POSITION_ID" };
      }
      const idStr = String(idRaw);

      let mgrAddr = opts.manager || null;
      const stored = this.state.activePosition;
      if (!mgrAddr && stored && String(stored.positionId ?? "") === idStr) {
        mgrAddr = this.resolveManagerForPosition(stored)?.managerAddr || stored.managerAddr || null;
      }
      if (!mgrAddr) {
        this.log(`[BLOCKED] no manager for position #${idStr} — pass --manager=0x…`, "error");
        return { ...base, code: "NO_MANAGER", positionId: idStr };
      }

      const { provider, wallet } = this.getRuntime();
      const report = await this.describePosition(idStr, mgrAddr);
      this._logPositionReport(report);
      if (!report.found) return { ...base, code: "NOT_FOUND", report };
      if (report.active === false) return { ok: true, ...base, code: "ALREADY_CLOSED", report };

      if (action === "close") {
        if (dryRun) {
          this.log(`[DRY] would closePosition #${idStr} on ${short(mgrAddr)} — re-run with --confirm to send`, "warn");
          if (report.closeFull?.closeBps) {
            this.log(`[DRY] expected: recv ${report.closeFull.collateralReturned} collateral, repay ${report.closeFull.repayAmount}, pnl ${report.closeFull.realizedPnlHuman ?? report.closeFull.realizedPnl}`, "info");
          } else if (report.closeFull?.ok === false) {
            this.log(`[DRY] full close previews REVERT (${report.closeFull.err}) — live close would fall back to partialClose ladder`, "warn");
          }
          return { ...base, ok: true, code: "DRY", report };
        }
        const res = await closePositionFn({
          wallet, provider, managerAddr: mgrAddr, positionId: BigInt(idStr),
          config: this.config, log: this.log.bind(this), dryRun: false, txManager: this.txManager,
        });
        const after = await this.describePosition(idStr, mgrAddr);
        this._logPositionReport(after);
        const verifiedClosed = res?.ok && after.found && after.active === false;
        if (verifiedClosed) this.log(`[VERIFY] close CONFIRMED on-chain: #${idStr} is closed`, "success");
        else if (res && !res.ok && !res.failed) { /* dry or pending */ }
        return { ...base, ok: !!verifiedClosed, result: res, report: after };
      }

      // partial
      const pct = opts.pct !== null && opts.pct !== undefined && `${opts.pct}` !== ""
        ? Number(opts.pct) : null;
      if (pct === null || !(pct > 0) || pct >= 100) {
        this.log(`[BLOCKED] --single=partial requires --pct in 1..99 (got ${opts.pct ?? "none"}); 100% is --single=close`, "error");
        return { ...base, code: "BAD_PCT" };
      }
      const closeBps = BigInt(Math.round(pct * 100));
      if (closeBps < 1n || closeBps > MAX_PARTIAL_CLOSE_BPS) {
        this.log(`[BLOCKED] closeBps ${closeBps} outside 1..9999`, "error");
        return { ...base, code: "BAD_PCT" };
      }

      const pv = await previewCloseAt(provider, mgrAddr, BigInt(idStr), closeBps);
      if (pv.ok) {
        this.log(`[PLAN] partial #${idStr} ${closeBps}bps (${pct}%): recv=${pv.quote.collateralReturned} repay=${pv.quote.repayAmount} pnl=${pv.quote.realizedPnl} fee=${pv.quote.protocolFee}`, "info");
      } else {
        this.log(`[BLOCKED] partial ${closeBps}bps preview REVERTED ${pv.err} — nothing will be sent`, "error");
        return { ...base, code: `PARTIAL_PREVIEW_${pv.err || "REVERT"}`, report };
      }

      if (dryRun) {
        this.log(`[DRY] would partialClose #${idStr} closeBps=${closeBps} — re-run with --confirm to send`, "warn");
        return { ...base, ok: true, code: "DRY", closeBps: Number(closeBps), preview: pv.quote ? {
          collateralReturned: String(pv.quote.collateralReturned),
          repayAmount: String(pv.quote.repayAmount),
          realizedPnl: String(pv.quote.realizedPnl),
        } : null, report };
      }

      const res = await attemptPartialClose({
        wallet, provider, managerAddr: mgrAddr, positionId: BigInt(idStr),
        config: this.config, log: this.log.bind(this), txManager: this.txManager,
        targetCloseBps: closeBps,
      });
      const after = await this.describePosition(idStr, mgrAddr);
      this._logPositionReport(after);
      if (res?.ok && after.found && after.active === false) {
        this.log(`[VERIFY] partial #${idStr} drove the position to CLOSED on-chain`, "success");
      } else if (res?.ok) {
        this.log(`[VERIFY] partial #${idStr} confirmed on-chain (position still active, reduced)`, "success");
      }
      return { ...base, ok: !!res?.ok, result: res, report: after };
    }

    this.log(`[BLOCKED] unknown action "${opts.action}" — use open|close|partial|status|swap`, "error");
    return { ...base, code: "UNKNOWN_ACTION" };
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
