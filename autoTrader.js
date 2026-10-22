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
import { probeRouteEconomics, normalizeEconomyConfig, checkRateConsistency, poolShareCapAmountIn, shrinkToFitEconomy } from "./swapEconomics.js";
import { RotationMemory } from "./rotation.js";
import {
  SWAP_FAILURE_CODES,
  SWAP_DIRECTION_STATES,
  swapReasonMeta,
  classifySwapRevert,
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
  // Field 6 is the borrow INDEX (1e18-scaled), NOT a debt amount — misnaming it
  // `currentDebt` poisoned state.debtAmount with 1.0003e18 on #134. The real
  // current debt comes from getPositionDebt() (verified: #134 debt=2379 wei,
  // #101 debt=4060439166).
  "function positions(uint256) view returns (bool isLong, address user, address collateralToken, uint256 collateralAmount, uint256 debtAmount, uint256 borrowIndex, bool active)",
  "function getPositionDebt(uint256 positionId) view returns (uint256)",
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
  constructor({ journal = null, fallbacks = null, onReverted = null } = {}) {
    this._mutex = Promise.resolve();
    this._nonce = null;
    this._provider = null;
    this._walletAddr = null;
    // Durable per-hash state journal (PREPARED → … → CONFIRMED/REVERTED/…).
    this.journal = journal || createTxJournal();
    // Extra endpoints consulted when the primary returns no receipt (null = env default).
    this.fallbacks = fallbacks;
    // Optional hook: called with (receipt, txType) for EVERY reverted tx so the
    // owner can accumulate a failed-attempt gas budget (never throws upward).
    this.onReverted = onReverted || null;
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
      try { this.onReverted?.(receipt, txType); } catch { /* budget hook must never break the tx path */ }
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

// WETH is the SAME contract on v2 and v5 (canonical Sepolia WETH) — the only
// address allowed to stay hardcoded. USDT/USDC come EXCLUSIVELY from the active
// deployment profile: the old v2 constants (USDT 0x5f2E83cC…, USDC 0x5dcf1Db1…)
// must never be reachable as fallbacks while v5 is active (no-mix guarantee).
const WETH = "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// MAM_PositionCreated(uint256 indexed positionId, address indexed user, bool, …)
// — the authoritative "a position was opened" event. positionId = topics[1],
// user = topics[2] (verified against live v5 reference TX 0x2c08bdcc…61a3e,
// where these topics resolved to positionId=101 / wallet 0x315E5193…).
const MAM_POSITION_CREATED_TOPIC = "0x23738081446e33f8965d406c81c9f20028aaea1de091dcd1b756dda92c04ed55";
// MAM_MarginFeeAssessed(address indexed manager, uint256 indexed positionId,
// uint8 indexed action, …) — action 0 = OPEN. positionId = topics[2].
// (Historically this topic was named POSITION_CREATED_TOPIC in this file; the
// topics[2] extraction was correct BECAUSE of this event's layout.)
const MARGIN_FEE_ASSESSED_TOPIC = "0x2e462fabb57854af0ee2383faf948da3dc380bd08e582513c3e8e1177478c64a";

/**
 * Extract the positionId of an OPEN from a receipt/log list, on-chain truth only.
 *
 * Primary: MAM_PositionCreated (positionId at topics[1], filtered by manager).
 * Fallback: MAM_MarginFeeAssessed with action=OPEN (positionId at topics[2]).
 * Never guesses: returns null when no matching event exists.
 *
 * @param {Array} logs          receipt.logs (or getLogs result)
 * @param {string|null} managerAddr  restrict to this emitting manager
 * @returns {number|null}
 */
function extractPositionIdFromLogs(logs, managerAddr = null) {
  const mgr = managerAddr ? String(managerAddr).toLowerCase() : null;
  for (const l of logs || []) {
    const t = l?.topics;
    if (!t?.[0]) continue;
    const from = String(l.address || "").toLowerCase();
    if (t[0] === MAM_POSITION_CREATED_TOPIC && (!mgr || from === mgr)) {
      try { return Number(BigInt(t[1])); } catch { /* keep looking */ }
    }
  }
  for (const l of logs || []) {
    const t = l?.topics;
    if (!t?.[0] || t[0] !== MARGIN_FEE_ASSESSED_TOPIC) continue;
    if (mgr && String(l.address || "").toLowerCase() !== mgr) continue;
    try {
      if (t[3] !== undefined && BigInt(t[3]) === 0n) return Number(BigInt(t[2]));
    } catch { /* keep looking */ }
  }
  return null;
}

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

function collateralTargetStr(config, collateralToken, side = null) {
  // PER-SIDE OVERRIDE — config.targetCollateralLong / targetCollateralShort (human
  // units in the collateral token the contract actually accepts) win when set;
  // otherwise the historical per-token targets apply unchanged (2x behaviour).
  const sideKey = side === "LONG" ? "targetCollateralLong"
    : side === "SHORT" ? "targetCollateralShort" : null;
  if (sideKey && config[sideKey] != null && String(config[sideKey]).trim() !== "") {
    return String(config[sideKey]);
  }
  const t = (collateralToken || "").toLowerCase();
  const dep = getActiveDeployment?.().tokens || {};
  if (t === (dep.WETH || dep.ETH || WETH).toLowerCase()) return config.targetCollateralWETH || "0.002";
  if (dep.USDT && t === dep.USDT.toLowerCase()) return config.targetCollateralUSDT || "10";
  return config.targetCollateralGeneric || "10";
}

function reserveTargetStr(config, collateralToken) {
  const t = (collateralToken || "").toLowerCase();
  const dep = getActiveDeployment?.().tokens || {};
  if (t === (dep.WETH || dep.ETH || WETH).toLowerCase()) return config.targetReserveWETH || "0.004";
  if (dep.USDT && t === dep.USDT.toLowerCase()) return config.targetReserveUSDT || "20";
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
  // Per-SIDE collateral override — human units in the collateral token the
  // contract actually accepts. When set (non-empty string) it wins for that
  // side; null / "" keeps the historical per-token targets above unchanged.
  targetCollateralLong: null,
  targetCollateralShort: null,
  // Risk cap: sum of collateralAmount (raw) across tracked positions that
  // share the NEW position's collateralToken, plus the new amount, must not
  // exceed this. Parsed in THAT token's decimals (no cross-token valuation).
  // "0" = disabled. Mixed-token books are checked per token independently.
  maxTotalCollateral: "0",
  // Risk cap: cumulative negative realizedPnl from verified closes within the
  // current UTC day (stable USDT/USDC collateral only, 6-decimal units) must
  // not exceed this. "0" = disabled. Non-stable realized losses are logged
  // but not counted (no reliable USD conversion is available).
  maxDailyLoss: "0",
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
  // Per-pair allow-list for OPEN/rotation — empty = every discovered eligible
  // market may be traded. Entries are market symbols ("ETH/USDT", …).
  enabledMarkets: [],
  // No preferred/single market: rotation covers every active MARKET × SIDE
  preferredMarket: null,
  // How many distinct markets to try per cycle when collateral can't be sourced
  maxMarketAttemptsPerCycle: 3,
  // Runtime direction kill-switch: disable a MARKET×SIDE after N consecutive open failures
  maxDirectionFailures: 2,
  marketRefreshMs: 120_000,
  // ─── HOLD WINDOW — deferred auto-close ────────────────────────────────────
  // After a CONFIRMED open the position is not auto-closed before `holdUntil`
  // (= openedAt + rand(min..max hold)). Both defaults 0 = hold disabled, so
  // every existing behavior/tests stay byte-identical unless a run opts in.
  minHoldSeconds: 0,
  maxHoldSeconds: 0,
  // Emergency override: when the on-chain risk probe says `liquidatable` or
  // `healthBps <= emergencyCloseHealthBps`, the hold is IGNORED (close runs).
  // A failed probe always keeps the hold — never close on unknown risk.
  emergencyCloseEnabled: false,
  emergencyCloseHealthBps: 10500,
  // Confirmed OPENs allowed per process run (0 = unlimited). A position that
  // is still open is NEVER abandoned by this cap — only new OPENs stop.
  maxTradesPerRun: 0,
  // LONG/SHORT selection ratio (never picks a disabled side).
  longPercent: 50,
  shortPercent: 50,
  // ─── CONTINUOUS TRADING CYCLE: OPEN → N confirmed SWAPs → CLOSE → repeat ──
  // When enabled, start() runs ONE position at a time (effective
  // maxOpenPositions=1), executes exactly `swapsPerPosition` balance-verified
  // SWAPs, then lets the normal CLOSE machinery close it, then starts the next
  // cycle. Legacy close-blocked positions keep being retried for close but do
  // not occupy an open slot. Cycle state persists in state.continuousCycle and
  // resumes after a restart (recorded swap txs re-verified on-chain).
  continuousTradingEnabled: false,
  swapsPerPosition: 10,
  // Attempt budget per cycle (sent swaps: confirmed OR failed). Hitting it
  // without reaching the quota closes the position instead of looping forever
  // on an unavailable market. (Cycle-level halt threshold reuses
  // swap.maxConsecutiveFailures — no duplicate config key.)
  maxSwapAttemptsPerCycle: 40,
  // ─── CONTINUOUS RETRY CONTROLS (a failed OPEN/CLOSE never stops trading) ──
  // Delay before a failed OPEN is retried (rate limit). The loop keeps running
  // SWAP maintenance meanwhile. CLOSE retries use the existing exponential
  // closeRetryBaseMs → closeRetryMaxMs backoff per position.
  openRetryIntervalMs: 60_000,
  // Cumulative gas-cost budget (wei) for REVERTED transactions before the
  // cycle's swap-quota attempts pause (closes keep retrying). Resets after each
  // successful cycle. "0" = unlimited.
  maxFailedAttemptCostWei: "50000000000000000", // 0.05 ETH
  // Pre-OPEN exit-viability probe — BOTH pool legs must hold at least this
  // many whole token units (per symbol; number = same floor for every token).
  // A market whose pool cannot absorb a future close is SKIPPED, never opened.
  minExitReserveWhole: { USDT: 200, USDC: 200, DAI: 200, WETH: 0.05, ETH: 0.05, LINK: 50, UNI: 50, NEMESIS: 50 },
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

/**
 * Migrate a legacy single-position state to the multi-position shape.
 *
 * OLD: { activePosition: {...}|null, closeRetry, closeAttempts, … }
 * NEW: { activePositions: [ {…, closeRetry, closeAttempts} ], … }
 *
 * The legacy global closeRetry/closeAttempts move onto the single record they
 * belonged to (they always described THAT position's on-chain signature).
 * Idempotent: a state that already has activePositions[] is left untouched.
 */
function migrateStateShape(state) {
  if (Array.isArray(state.activePositions)) return state;
  state.activePositions = [];
  const legacy = state.activePosition;
  if (legacy && typeof legacy === "object" && !Array.isArray(legacy)) {
    if (state.closeRetry) legacy.closeRetry = state.closeRetry;
    if (Number.isFinite(Number(state.closeAttempts))) legacy.closeAttempts = Number(state.closeAttempts);
    state.activePositions.push(legacy);
  }
  delete state.activePosition;
  delete state.closeRetry;
  delete state.closeAttempts;
  return state;
}

function loadState() {
  let state = null;
  try {
    if (fs.existsSync(STATE_FILE)) state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {}
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    state = { activePositions: [], sessionStats: { opens: 0, closes: 0, dailyLoss: null }, lastCycleTime: 0, lastSide: null };
  }
  migrateStateShape(state);
  if (!state.sessionStats) state.sessionStats = { opens: 0, closes: 0, dailyLoss: null };
  if (state.sessionStats && !("dailyLoss" in state.sessionStats)) state.sessionStats.dailyLoss = null;
  for (const p of state.activePositions) {
    if (p && typeof p === "object" && p.closeAttempts === undefined) p.closeAttempts = 0;
  }
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
    // Address-only scan. On v5 NO manager event carries the wallet as
    // topics[1] (MAM_PositionCreated: topics[1]=positionId, topics[2]=user),
    // so the old [null, walletTopic] filter matched nothing and recovery
    // always returned null. Every manager log is also needed below to detect
    // closePosition transactions.
    const logs = await provider.getLogs({ address: managerAddr, fromBlock, toBlock: latestBlock });
    const walletTopic = "0x000000000000000000000000" + String(walletAddr).slice(2).toLowerCase();
    const positionCreatedLogs = logs.filter(
      l => l.topics?.[0] === MAM_POSITION_CREATED_TOPIC && l.topics?.[2] === walletTopic,
    );
    if (positionCreatedLogs.length === 0) return null;
    const lastOpen = positionCreatedLogs[positionCreatedLogs.length - 1];
    const positionId = Number(BigInt(lastOpen.topics[1])); // positionId is topics[1]
    const allTxHashes = [...new Set(logs.map(l => l.transactionHash))];
    let positionClosed = false;
    for (const txHash of allTxHashes) {
      try {
        const tx = await provider.getTransaction(txHash);
        if (tx && tx.data && tx.data.startsWith(CLOSE_POSITION_SELECTOR)) {
          // closePosition(uint256 positionId, …) — positionId is ABI word 0.
          const closePosId = Number(BigInt("0x" + tx.data.slice(4, 68)));
          if (closePosId === positionId) { positionClosed = true; break; }
        }
        // partialClose(0xdc439ba7) may also have ended the position — the
        // on-chain `active` check below is the authority either way.
      } catch {}
    }
    if (positionClosed) {
      log(`[RECOVERY] position #${positionId} was already closed`, "info");
      return null;
    }
    // On-chain truth for side/collateral/active: positions(positionId) — NEVER hardcoded
    // (was: side:"LONG", collateralToken: USDT).
    let pos = null;
    try {
      const mgr = new ethers.Contract(managerAddr, [
        // Field 6 = borrowIndex (NOT a debt amount) — see CLOSE_VIEW_ABI note.
        "function positions(uint256) view returns (bool isLong, address user, address collateralToken, uint256 collateralAmount, uint256 debtAmount, uint256 borrowIndex, bool active)",
        "function getPositionDebt(uint256 positionId) view returns (uint256)",
      ], provider);
      pos = await mgr.positions(positionId);
      // Real current debt (index-adjusted); borrowIndex must never be used as debt.
      if (pos?.active) {
        try { pos.currentDebt = await mgr.getPositionDebt(positionId); }
        catch { pos.currentDebt = pos.debtAmount; }
      } else if (pos) {
        pos.currentDebt = pos.debtAmount;
      }
    } catch (e) {
      log(`[RECOVERY] AMBIGUITY: cannot read position #${positionId} on-chain (${e.message?.slice(0, 40)}) — refusing to guess side/collateral`, "warn");
      return null;
    }
    if (!pos || pos.user === undefined) {
      log(`[RECOVERY] AMBIGUITY: position #${positionId} returned no on-chain data — refusing to guess side/collateral`, "warn");
      return null;
    }
    // Closed on-chain (active=false) is NEVER recovered — collateral/debt
    // words are retained by the contract after a close, so a nonzero read
    // alone cannot prove the position is open (#101: active=true vs #37: false).
    if (pos.active === false) {
      log(`[RECOVERY] position #${positionId} is CLOSED on-chain (active=false) — not recovered`, "info");
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
  // result.preview is null when the preview ran but failed non-stepably (e.g.
  // ORACLE_DIVERGENCE): the resolution is still valid (the OPEN flow runs the
  // checkpoint itself), but there are no ltv/health numbers to print — the log
  // must never dereference the null preview (it crashed the whole dry cycle).
  log(`[LEVERAGE] resolved ${lev}x for ${marketSymbol || "market"} ${isLong ? "LONG" : "SHORT"} (requested ${requested}x, bounds ${bounds.source} ${minContract}x..${maxContract}x${steppedFrom ? `, stepped down from ${steppedFrom}x` : ""}${result.preview ? `, ltv=${result.preview.projectedLtvBps}bps health=${result.preview.projectedHealthBps}bps` : ""})`, "info");
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
    // GAS: this deployment's approve needs ~129k (cold proxy storage); a
    // hardcoded 100k limit OOGs. Estimate +25%; estimation failure → do not send.
    let approveGas;
    try {
      const est = await provider.estimateGas({
        from: walletAddr, to: fromToken,
        data: fromContract.interface.encodeFunctionData("approve", [routerAddr, ethers.MaxUint256]),
      });
      approveGas = est + est / 4n;
    } catch (e) {
      return fail("INSUFFICIENT_ALLOWANCE", `approve estimation failed: ${String(e?.shortMessage || e?.message || e).slice(0, 100)}`);
    }
    if (txManager) {
      const r = await txManager.sendAndWait({
        wallet, provider, txType: "SWAP-APPROVE",
        sendFn: (nonce) => fromContract.approve(routerAddr, ethers.MaxUint256, { gasLimit: approveGas, nonce }),
        log,
      });
      if (r.status === 0) { log(`[SWAP] Approve REVERTED`, "error"); return fail("INSUFFICIENT_ALLOWANCE", "approve transaction reverted"); }
      approveTxHash = r.hash || null;
    } else {
      const approveTx = await fromContract.approve(routerAddr, ethers.MaxUint256, { gasLimit: approveGas });
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
  // Validate leverage FIRST — cheapest, no RPC. A leverage the operator never
  // asked to raise (config.maxLeverage) must be refused before any token meta
  // read, oracle probe, or calldata is built, so the TX can never carry a
  // leverage the menu/config did not authorize.
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
  // decimals + symbol ALWAYS read from the collateral token contract — done
  // AFTER the leverage ceiling so an over-max request never touches the chain.
  const collateralMeta = await tokenMetaOnChain(provider, collateralToken);
  const decimals = collateralMeta.decimals;
  const collSym = collateralMeta.symbol;
  const leverageX10 = BigInt(leverage * 10);

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
    // GAS: a hardcoded 100_000 burned 41/41 OPEN-APPROVEs — some deploys (USDT)
    // need ~129k for approve(). Estimate +25%; NEVER send when the estimate
    // itself fails (that would burn gas on a guaranteed OOG/revert).
    const approveCalldata = token.interface.encodeFunctionData("approve", [managerAddr, ethers.MaxUint256]);
    let approveGas;
    try {
      const est = await provider.estimateGas({ from: walletAddr, to: collateralToken, data: approveCalldata, value: 0n });
      approveGas = est + est / 4n;
      log(`[OPEN] approve gas estimate=${est} → limit=${approveGas}`, "info");
    } catch (e) {
      log(`[BLOCKED] approve estimate FAILED (${revertSelector(e) || e.message?.slice(0, 60)}) — NOT sending`, "error");
      return null;
    }
    if (txManager) {
      const r = await txManager.sendAndWait({
        wallet, provider, txType: "OPEN-APPROVE",
        sendFn: (nonce) => token.approve(managerAddr, ethers.MaxUint256, { gasLimit: approveGas, nonce }),
        log,
      });
      if (!r || r.status === 0) { log(`[OPEN] Approve REVERTED`, "error"); return null; }
      if (r.pending) { log(`[OPEN] Approve still PENDING — not proceeding to open`, "warn"); return null; }
    } else {
      try {
        const approveTx = await token.approve(managerAddr, ethers.MaxUint256, { gasLimit: approveGas });
        await approveTx.wait();
      } catch (e) {
        log(`[OPEN] Approve failed (${e.message?.slice(0, 60)})`, "error");
        return null;
      }
    }
    // Receipt is not proof the allowance changed — re-read it before opening.
    const allowanceAfter = await token.allowance(walletAddr, managerAddr);
    if (allowanceAfter < collateralAmount) {
      log(`[BLOCKED] allowance still ${allowanceAfter} < ${collateralAmount} after approve receipt — NOT opening`, "error");
      return null;
    }
    log(`[OPEN] Approved (allowance=${allowanceAfter})`, "success");
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

  // Extract positionId from on-chain events (MAM_PositionCreated primary,
  // MAM_MarginFeeAssessed[action=OPEN] fallback — both manager-filtered).
  const positionId = extractPositionIdFromLogs(receipt.logs, managerAddr);

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
      borrowIndex: pos.borrowIndex, currentDebt: pos.debtAmount, active: pos.active,
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
    // currentDebt = REAL current debt (getPositionDebt, index-adjusted).
    // p.borrowIndex is the 1e18-scaled index and must never be treated as debt.
    let currentDebt = p.debtAmount;
    if (p.active) {
      try { currentDebt = await mgr.getPositionDebt(positionId); } catch {}
    }
    return {
      isLong: p.isLong, user: p.user, collateralToken: p.collateralToken,
      collateralAmount: p.collateralAmount, debtAmount: p.debtAmount,
      borrowIndex: p.borrowIndex, currentDebt, active: p.active,
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
  const probed = new Map(); // bps → err|null — EVERY probe (ladder + gap + refine)
  const probe = async (bps) => {
    if (probes >= maxProbes) return { ok: false, err: "PROBE_LIMIT" };
    probes++;
    const r = await previewCloseAt(provider, managerAddr, positionId, bps);
    probed.set(bps, r.ok ? null : (r.err || "UNKNOWN"));
    return r;
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
    // Precise classification from the FULL probe map — the old single-field
    // `lastErr` check misreported "no feasible window" as dust: on #134
    // bps 1..4 revert MAM_CloseAmountTooSmall while bps ≥5 revert
    // MAM_InsufficientLiquidity, i.e. NO bps passes at all, and the position
    // (16.8 USDT collateral) is anything but dust.
    const tooSmall = [...probed.entries()].filter(([, e]) => e === ERR_CLOSE_AMOUNT_TOO_SMALL).map(([b]) => b).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const illiquid = [...probed.entries()].filter(([, e]) => isLiquidityErr(e)).map(([b]) => b).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const other = [...probed.entries()].filter(([, e]) => e && e !== ERR_CLOSE_AMOUNT_TOO_SMALL && !isLiquidityErr(e));
    const band = {
      tooSmallMin: tooSmall.length ? tooSmall[0] : null,
      tooSmallMax: tooSmall.length ? tooSmall[tooSmall.length - 1] : null,
      illiquidMin: illiquid.length ? illiquid[0] : null,
      illiquidMax: illiquid.length ? illiquid[illiquid.length - 1] : null,
      otherErrs: [...new Set(other.map(([, e]) => e))],
    };
    let code;
    if (tooSmall.length && illiquid.length) code = "CLOSE_NO_FEASIBLE_WINDOW";
    else if (tooSmall.length) code = "CLOSE_AMOUNT_TOO_SMALL";
    else if (other.length && other.every(([, e]) => e === "PROBE_LIMIT")) code = "PROBE_LIMIT";
    else code = "CLOSE_BPS_NOT_FOUND";
    return { ok: false, code, probes, lastErr, band };
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
      const b = found.band || null;
      const detail = found.code === "CLOSE_NO_FEASIBLE_WINDOW"
        ? `no feasible window: bps ${b?.tooSmallMin ?? "?"}..${b?.tooSmallMax ?? "?"} → MAM_CloseAmountTooSmall (contract minimum), bps ${b?.illiquidMin ?? "?"}..${b?.illiquidMax ?? "?"} → MAM_InsufficientLiquidity (pool cannot absorb) — pool liquidity below the minimum closeable slice`
        : found.code === "CLOSE_AMOUNT_TOO_SMALL"
        ? `every probed bps (≤${b?.tooSmallMax ?? "?"}) reverts MAM_CloseAmountTooSmall — position slice below the contract minimum`
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
        realizedPnl: quote?.realizedPnl !== undefined ? String(quote.realizedPnl) : null,
      };
    }
    if (targetCloseBps !== null && targetCloseBps !== undefined) {
      // Operator-specified slice executed EXACTLY once and verified: the
      // position is still active (by design — pct was 1..99). Never ladder
      // the same pct over remaining size: that would overshoot the requested
      // close and end in a spurious PARTIAL_CLOSE_LIMIT.
      log(`[VERIFY] position #${positionId} partial target ${closeBps}bps DONE on-chain: collateral=${after.collateralAmount} debt=${after.currentDebt} (still active)`, "success");
      return {
        ok: true, closed: false, targetDone: true, partial: true, rounds: round, verified: true,
        txHash, gasUsed: receipt.gasUsed, blockNumber: receipt.blockNumber,
        closeBps, amountOut, onChain: after,
        realizedPnl: quote?.realizedPnl !== undefined ? String(quote.realizedPnl) : null,
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

  // ── GUARD 1: chain / deployment identity ──────────────────────────────────
  // The send must target the ACTIVE deployment profile's chainId (and, when
  // configured, config.chainId must agree with it). A profile switch or a
  // config edit can silently retarget the send — refuse BEFORE pricing/signing.
  let expectedChain;
  try { expectedChain = Number(getActiveDeployment()?.chainId ?? 0) || null; } catch { expectedChain = null; }
  if (!expectedChain) expectedChain = Number(config.chainId || 11155111);
  if (config.chainId && Number(config.chainId) !== expectedChain) {
    log(`[BLOCKED] close: config.chainId ${config.chainId} != active deployment chainId ${expectedChain} — refusing (deployment/config drift)`, "error");
    return { failed: true, clearState: false, code: "CLOSE_CHAIN_ID_MISMATCH", reason: `config chainId ${config.chainId} != deployment ${expectedChain}` };
  }
  let netChain = null;
  try {
    netChain = Number((await provider.getNetwork()).chainId);
  } catch (e) {
    log(`[BLOCKED] close: RPC chainId unreadable (${e?.shortMessage || e?.message || e}) — refusing to send`, "error");
    return { failed: true, clearState: false, code: "CLOSE_CHAIN_ID_MISMATCH", reason: "RPC network unreadable" };
  }
  if (netChain !== expectedChain) {
    log(`[BLOCKED] close: RPC chainId ${netChain} != expected ${expectedChain} — refusing (wrong network/deployment)`, "error");
    return { failed: true, clearState: false, code: "CLOSE_CHAIN_ID_MISMATCH", reason: `chainId ${netChain} != ${expectedChain}` };
  }

  // ── GUARD 2: the manager must be a contract on THIS chain ─────────────────
  // Catches a stale/wrong --manager address (no code after a deployment
  // change, or a mistyped address) before any view call or signature.
  const mgrCode = await provider.getCode(managerAddr).catch(() => null);
  if (!mgrCode || mgrCode === "0x") {
    log(`[BLOCKED] close: manager ${managerAddr} has NO CODE on chain ${netChain} — refusing to send`, "error");
    return { failed: true, clearState: false, code: "CLOSE_MANAGER_NO_CODE", reason: `no code at ${managerAddr}` };
  }

  // ── REFERENCE PREVIEW (read-only, mandatory) ──────────────────────────────
  // The close is priced BEFORE any calldata exists. amountOutMin is derived
  // from the same preview field the production partialClose path has always
  // used (quote.collateralReturned − slippage), against the verified ABI
  // arg[1] of closePosition(uint256 positionId, uint256 amountOutMin,
  // uint256 deadline) — selector 0xb35648d7 (never hand-rolled calldata).
  const ref = await previewCloseAt(provider, managerAddr, positionId, BPS_DENOM);
  if (!ref.ok) {
    if (ref.err === ERR_INVALID_POSITION) {
      log(`[CLOSE] MAM_InvalidPosition — zombie position detected, clearing state`, "warn");
      return { failed: true, clearState: true, reason: "zombie" };
    }
    if (ref.err === ERR_INSUFFICIENT_LIQUIDITY || ref.err === ERR_POOL_INSUFFICIENT_OUTPUT) {
      log(`[CLOSE] ${ref.err === ERR_POOL_INSUFFICIENT_OUTPUT ? "Pool_InsufficientOutputAmount" : "MAM_InsufficientLiquidity"} on full-close preview — read-only closeBps search + partialClose fallback`, "warn");
      return attemptPartialClose({ wallet, provider, managerAddr, positionId, config, log, txManager });
    }
    log(`[BLOCKED] close: reference previewClosePosition REVERTED ${ref.err || "unknown"} — nothing signed`, "error");
    return { failed: true, clearState: false, code: `CLOSE_PREVIEW_${ref.err || "REVERT"}`, reason: `full-close preview revert ${ref.err || "unknown"}` };
  }

  const slippageBps = BigInt(config.slippageBps || 50);
  const refOut = BigInt(ref.quote.collateralReturned);
  if (!(refOut > 0n)) {
    log(`[BLOCKED] close: preview returned zero collateral — refusing (a zero floor is never sent)`, "error");
    return { failed: true, clearState: false, code: "ZERO_AMOUNT_OUT_MIN", reason: "full close quote returned zero collateral" };
  }
  const amountOutMin = (refOut * (BPS_DENOM - slippageBps)) / BPS_DENOM;
  if (!(amountOutMin > 0n)) {
    log(`[BLOCKED] close: amountOutMin floor is zero (${slippageBps} bps of ${refOut}) — refusing`, "error");
    return { failed: true, clearState: false, code: "ZERO_AMOUNT_OUT_MIN", reason: "amountOutMin floor is zero after slippage" };
  }
  log(`[CLOSE] plan: preview collateralReturned=${refOut} amountOutMin=${amountOutMin} (max slippage ${slippageBps} bps)`, "info");

  const deadline = Math.floor(Date.now() / 1000) + config.deadlineSeconds;
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const params = coder.encode(["uint256", "uint256", "uint256"], [positionId, amountOutMin, BigInt(deadline)]);
  const calldata = CLOSE_POSITION_SELECTOR + params.slice(2);
  if (calldata.slice(0, 10) !== CLOSE_POSITION_SELECTOR) {
    log(`[BLOCKED] unexpected close selector ${calldata.slice(0, 10)} — refusing to send`, "error");
    return { failed: true, clearState: false, code: "BAD_CLOSE_SELECTOR", reason: calldata.slice(0, 10) };
  }

  // Pre-flight — the EXACT calldata that would be signed, amountOutMin included
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

  // ── GUARD 3: FRESH preview immediately before signing ─────────────────────
  // The reference preview may already be stale by now. Compare the CURRENT
  // closable output against the minimum acceptable result (amountOutMin =
  // reference − slippageBps): if it deteriorated beyond the threshold —
  // REFUSE the TX WITHOUT signing. (The same amountOutMin in the calldata is
  // the contract-side floor for the mined execution.)
  const fresh = await previewCloseAt(provider, managerAddr, positionId, BPS_DENOM);
  if (!fresh.ok) {
    log(`[BLOCKED] close: fresh preview REVERTED ${fresh.err || "unknown"} right before signing — refusing WITHOUT signing`, "error");
    return { failed: true, clearState: false, code: `CLOSE_SLIPPAGE_FRESH_${fresh.err || "REVERT"}`, reason: `fresh preview revert ${fresh.err || "unknown"}` };
  }
  const freshOut = BigInt(fresh.quote.collateralReturned);
  if (freshOut < amountOutMin) {
    log(`[BLOCKED] close: preview deteriorated ${refOut} → ${freshOut} (< amountOutMin ${amountOutMin}, allowed ${slippageBps} bps) — refusing WITHOUT signing`, "error");
    return {
      failed: true, clearState: false, code: "CLOSE_SLIPPAGE_REFUSED",
      reason: `collateralReturned ${freshOut} < min ${amountOutMin} (ref ${refOut}, maxSlippage ${slippageBps} bps)`,
    };
  }
  log(`[CLOSE] fresh preview OK: collateralReturned=${freshOut} ≥ amountOutMin=${amountOutMin}`, "info");

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
    // Realized PnL from the FRESH pre-sign preview (collateral-token units) —
    // feeds maxDailyLoss accounting. Preview-based (not post-exec oracle) on
    // purpose: the position is gone after the close, no authoritative re-read.
    realizedPnl: fresh.quote?.realizedPnl !== undefined ? String(fresh.quote.realizedPnl) : null,
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
    this.txManager = new TxManager({
      onReverted: (receipt, txType) => this._noteFailedTxCost(receipt, txType),
    });
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
    // Confirmed OPENs in THIS process — maxTradesPerRun cap (never a restart-
    // persistent counter: the cap is per run by definition). A verified CLOSE
    // of a record THIS process opened returns its slot (see _clearPosition),
    // so a continuous run keeps trading after each round-trip instead of
    // going OPEN-dead after the first open.
    this._opensThisRun = 0;
    // Records that consumed a trade slot in THIS process (WeakSet — identity
    // only, never persisted). Only clearing one of THESE frees a slot.
    this._capConsumers = new WeakSet();
    // CONTINUOUS CYCLE — completed OPEN→swaps→CLOSE round-trips in THIS run
    // (bounded by start({maxTradingCycles}); cycle STATE itself persists in
    // state.continuousCycle and survives restarts).
    this._tradingCyclesDone = 0;
    // Throttled emergency-risk probe cache for the hold window (see _emergencyCloseDue).
    this._holdProbe = null;
    // Record created by the most recent successful/pending OPEN (result extraction).
    this._lastOpenedRecord = null;
  }

  // ═════════════════════════════════════════════════════════════════════════
  //  MULTI-POSITION BOOKKEEPING — state.activePositions[]
  // ═════════════════════════════════════════════════════════════════════════

  /** The tracked positions array (never null — created on demand). */
  _positions() {
    if (!Array.isArray(this.state.activePositions)) this.state.activePositions = [];
    return this.state.activePositions;
  }

  /** First tracked record (display fallbacks only — never a trading target). */
  _primaryPosition() {
    const ps = this._positions();
    return ps[0] || null;
  }

  _activeCount() {
    return this._positions().length;
  }

  _findPosition(positionId) {
    if (positionId === null || positionId === undefined) return null;
    const want = String(positionId);
    return this._positions().find(p => String(p?.positionId) === want) || null;
  }

  _findPositionByTx(txHash) {
    if (!txHash) return null;
    const want = String(txHash).toLowerCase();
    return this._positions().find(p => String(p?.txHash || "").toLowerCase() === want) || null;
  }

  /** Bookkeeping key for a position record — pool first, then manager, then symbol. */
  _marketKeyOf(rec) {
    return String(rec?.poolAddr || rec?.managerAddr || rec?.marketSymbol || rec?.marketSymbol || "").toLowerCase();
  }

  /** Bookkeeping key for a market candidate/plan entry. */
  _marketKeyOfCandidate(mk) {
    return String(mk?.poolAddr || mk?.managerAddr || mk?.marketSymbol || mk?.symbol || "").toLowerCase();
  }

  /**
   * Per-MARKET slot: another tracked position (active or pending) already
   * occupies this market. One position per market is a market limit — never a
   * global one.
   */
  _marketHasPosition(market, { excludeRec = null } = {}) {
    const key = this._marketKeyOfCandidate(market);
    if (!key) return false;
    return this._positions().some(p =>
      p !== excludeRec && this._marketKeyOf(p) === key);
  }

  /**
   * The ONE gate every OPEN path consults (runCycle PHASE 3, prepareAndOpen,
   * --single=open). Global cap + pending-open serialization + per-market slot.
   *
   * @param opts.market    market candidate to additionally check for a slot
   * @param opts.effectiveCount  override the record count (dry-run planning:
   *        records that "would close" this cycle may be treated as free slots)
   * @returns {{ok:boolean, code?:string, max?:number, count?:number}}
   */
  _canOpenNew({ market = null, effectiveCount = null, log = true } = {}) {
    // CONTINUOUS HALT — consecutive cycle failures trip a sticky safe-stop:
    // no new OPEN until an operator reviews and restarts with --reset-halt.
    const continuous = this._continuousEnabled?.() === true;
    const halt = continuous ? this._haltInfo?.() : null;
    if (halt) {
      if (log) this.log(`[LIMIT] continuous trading HALTED (reason=${halt.reason}) — OPEN skipped; review the log then restart with --reset-halt`, "error");
      return { ok: false, code: "TRADING_HALTED", count: this._activeCount() };
    }
    if (this._tradeCapReached()) {
      if (log) this.log(`[LIMIT] maxTradesPerRun=${Number(this.config.maxTradesPerRun || 0)} reached (opens this run=${this._opensThisRun}) — OPEN skipped`, "warn");
      return { ok: false, code: "TRADE_CAP", count: this._activeCount() };
    }
    if (this._dailyLossExceeded()) {
      if (log) this.log(`[LIMIT] maxDailyLoss=${this.config.maxDailyLoss} USDT reached today (${this.state.sessionStats?.dailyLoss?.lossRaw || "0"} raw) — OPEN skipped until UTC day rolls`, "error");
      return { ok: false, code: "DAILY_LOSS_CAP", count: this._activeCount() };
    }
    // CONTINUOUS MODE — sequential by definition: one open slot. A position
    // whose CLOSE is currently blocked (pool cannot absorb any safe exit)
    // does NOT occupy that slot: the six permanently-uncloseable dust positions
    // on the three dead NLP pools (verified on-chain: all active/healthy, but
    // previewClosePosition reverts MAM_CloseAmountTooSmall at low bps and
    // MAM_InsufficientLiquidity at every bps >= 5) would otherwise deadlock
    // EVERY market forever. Blocked positions remain TRACKED and still
    // re-attempted for close each cycle; the per-market slot check below
    // (_marketHasPosition) independently prevents any new position from
    // stacking on the same blocked pool — so healthy markets stay tradable
    // while blocked ones stay blocked.
    const liveCount = this._positions().filter(p => !p?.closeBlocked).length;
    const count = Number.isFinite(effectiveCount) ? effectiveCount
      : continuous ? liveCount : this._activeCount();
    const max = continuous ? 1 : Math.max(1, Number(this.config.maxOpenPositions) || 1);
    if (count >= max) {
      if (log) this.log(`[LIMIT] maxOpenPositions=${max} reached (tracked=${this._activeCount()}${count !== this._activeCount() ? ` effective=${count}` : ""}) — OPEN skipped`, "warn");
      return { ok: false, code: "MAX_OPEN_POSITIONS", max, count: this._activeCount() };
    }
    const pending = this._positions().find(p => p?.pendingOpen);
    if (pending) {
      if (log) this.log(`[LIMIT] open tx ${pending.txHash || "?"} still pending (position #${pending.positionId ?? "?"}) — no new OPEN until it settles`, "warn");
      return { ok: false, code: "OPEN_PENDING", count: this._activeCount() };
    }
    if (market && this._marketHasPosition(market)) {
      if (log) this.log(`[LIMIT] market ${market.marketSymbol || market.symbol || "?"} already has a tracked position — per-market slot busy`, "warn");
      return { ok: false, code: "MARKET_BUSY", count: this._activeCount() };
    }
    return { ok: true, count };
  }

  /** Effective global open-slot cap (continuous mode is sequential = 1). */
  _effectiveMaxOpen() {
    return this._continuousEnabled?.() === true
      ? 1
      : Math.max(1, Number(this.config.maxOpenPositions) || 1);
  }

  /**
   * Track a verified close's realized PnL toward the daily-loss budget.
   * Only NEGATIVE realizedPnl (a loss) accumulates; only stable-collateral
   * positions (USDT/USDC, 6 decimals ≈ USD) count toward the USD cap —
   * non-stable losses are logged and skipped (no reliable conversion).
   * The bucket resets automatically when the UTC day rolls over.
   */
  _noteRealizedPnl(closeResult, pos = null) {
    try {
      const pnl = closeResult?.realizedPnl;
      if (pnl === null || pnl === undefined || pnl === "") return;
      let pnlRaw;
      try { pnlRaw = BigInt(pnl); } catch { return; }
      if (!(pnlRaw < 0n)) return; // profits / zero never count
      const depTokens = getActiveDeployment?.().tokens || {};
      const t = String(pos?.collateralToken || "").toLowerCase();
      const stables = [depTokens.USDT, depTokens.USDC].filter(Boolean)
        .map(a => String(a).toLowerCase());
      if (!stables.includes(t)) {
        this.log(`[RISK] close #${pos?.positionId ?? "?"} realizedPnl=${pnlRaw} in non-stable collateral ${t} — NOT counted toward maxDailyLoss (USD-peg only)`, "info");
        return;
      }
      const today = new Date().toISOString().slice(0, 10);
      if (!this.state.sessionStats.dailyLoss || this.state.sessionStats.dailyLoss.day !== today) {
        this.state.sessionStats.dailyLoss = { day: today, lossRaw: "0" };
      }
      const prev = BigInt(this.state.sessionStats.dailyLoss.lossRaw || "0");
      const next = prev + (-pnlRaw);
      this.state.sessionStats.dailyLoss.lossRaw = String(next);
      this.log(`[RISK] realized loss ${ethers.formatUnits(-pnlRaw, 6)} USDT → dailyLoss ${ethers.formatUnits(next, 6)} (maxDailyLoss=${this.config.maxDailyLoss || "0"})`, "warn");
      saveState(this.state);
    } catch (e) {
      this.log(`[RISK] daily-loss tracking failed: ${String(e?.message || e).slice(0, 120)}`, "warn");
    }
  }

  /** True when today's accumulated stable realized losses ≥ maxDailyLoss. */
  _dailyLossExceeded() {
    const capStr = String(this.config.maxDailyLoss ?? "0").trim();
    if (!capStr || capStr === "0") return false;
    let capRaw;
    try { capRaw = ethers.parseUnits(capStr, 6); } catch { return false; }
    if (!(capRaw > 0n)) return false;
    const dl = this.state.sessionStats?.dailyLoss;
    if (!dl) return false;
    const today = new Date().toISOString().slice(0, 10);
    if (dl.day !== today) return false;
    let loss;
    try { loss = BigInt(dl.lossRaw || "0"); } catch { return false; }
    return loss >= capRaw;
  }

  /**
   * Per-token exposure gate: sum tracked positions that share the NEW
   * position's collateralToken (raw collateralAmount) + the new amount,
   * compared against maxTotalCollateral parsed in THAT token's decimals.
   * No cross-token valuation is invented; mixed books are checked per token.
   */
  _exposureGate(ctx) {
    const capStr = String(this.config.maxTotalCollateral ?? "0").trim();
    if (!capStr || capStr === "0") return { ok: true };
    let capRaw;
    try { capRaw = ethers.parseUnits(capStr, ctx.collateralDecimals); } catch { return { ok: true }; }
    if (!(capRaw > 0n)) return { ok: true };
    const key = String(ctx.collateralToken).toLowerCase();
    let used = 0n;
    for (const p of this._positions()) {
      if (!p || p.pendingOpen) continue;
      if (String(p.collateralToken || "").toLowerCase() !== key) continue;
      try { used += BigInt(p.collateralAmount || "0"); } catch {}
    }
    let newAmt;
    try { newAmt = BigInt(ctx.collateralAmount); } catch { return { ok: true }; }
    const total = used + newAmt;
    if (total > capRaw) {
      return {
        ok: false, code: "MAX_TOTAL_COLLATERAL",
        reason: `total ${ctx.collateralSym || "collateral"} exposure ${ethers.formatUnits(total, ctx.collateralDecimals)} > cap ${capStr} (open ${ethers.formatUnits(used, ctx.collateralDecimals)} + new ${ethers.formatUnits(newAmt, ctx.collateralDecimals)})`,
      };
    }
    return { ok: true };
  }

  /**
   * Create a tracked record for a position and persist it.
   * Confirmed opens also bump lastSide/sessionStats/hold — pending ones do not
   * (only a receipt may count an open). Adopted records (`adopted:true`) never
   * count toward the per-run trade cap (they were opened in an earlier run).
   */
  _trackOpenedPosition(fields, { pending = false, adopted = false } = {}) {
    const rec = {
      positionId: fields.positionId ?? null,
      side: fields.side,
      collateralToken: fields.collateralToken,
      collateralAmount: String(fields.collateralAmount ?? ""),
      paymentToken: fields.paymentToken || null,
      leverage: fields.leverage ?? this.config.defaultLeverage,
      openedAt: fields.openedAt ?? Date.now(),
      txHash: fields.txHash || null,
      marketSymbol: fields.marketSymbol || null,
      managerAddr: fields.managerAddr || null,
      poolAddr: fields.poolAddr || null,
      closeRetry: null,
      closeAttempts: 0,
    };
    if (pending) rec.pendingOpen = true;
    if (adopted) rec.adoptedFromChain = true;
    this._positions().push(rec);
    if (!pending) {
      // HOLD WINDOW: deferred close for THIS confirmed open (absolute ms —
      // persisted, so a restart keeps the hold).
      this._ensureHoldScheduled(rec);
      if (!adopted) {
        this.state.lastSide = rec.side;
        this.state.sessionStats.opens++;
        this._opensThisRun++;
        this._capConsumers?.add(rec);
        this._onPositionOpened?.(rec); // continuous cycle binds here (no-op when off)
      }
    }
    saveState(this.state);
    this._lastOpenedRecord = rec;
    return rec;
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
    // Per-pair allow-list: empty/missing = every discovered market is eligible.
    const enabledList = Array.isArray(this.config.enabledMarkets)
      ? this.config.enabledMarkets.map(s => String(s).toLowerCase())
      : [];

    const candidates = discovered && discovered.length ? discovered : null;
    if (!candidates) {
      return resolveTradingMarket({
        side, confirmedPools, availableMarkets, preferSymbol, excludeSymbols,
        recentMarkets: rotation ? rotation.recentMarkets : [],
      });
    }

    const enabled = candidates.filter(m => {
      const sym = m.marketSymbol || m.symbol;
      if (!sym) return false;
      if (enabledList.length && !enabledList.includes(String(sym).toLowerCase())) return false;
      return supportsSide(m, side) &&
        !this._isDirectionDisabled(sym, side) &&
        !excludeSymbols.includes(sym) &&
        m.isActive !== false;
    });
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
        configuredRaw = ethers.parseUnits(collateralTargetStr(this.config, collateralToken, "SHORT"), decimals);
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
    const primary = this._primaryPosition();
    if (primary?.managerAddr) return primary.managerAddr;
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
    const primary = this._primaryPosition();
    if (primary?.poolAddr) return primary.poolAddr;
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

      // Settle any OPEN txs that are still PENDING before anything is decided.
      // Only a receipt may turn a submitted open into a counted open.
      await this._settleAllPendingOpens();

      // NEXT ACTION prediction for TUI
      const trackedNow = [...this._positions()];
      if (trackedNow.length) {
        this.log(`[AUTO] NEXT ACTION: CLOSE position(s) #${trackedNow.map(p => p.positionId ?? "?").join(", #")}`, "info");
      } else {
        this.log(`[AUTO] NEXT ACTION: SWAP + OPEN ${this.config.defaultLeverage}x`, "info");
      }

      // PHASE 1: EVERY tracked position gets its OWN close attempt (always via
      // that position's OWN manager). closeActivePosition() owns the whole path
      // per record: on-chain truth first (gone → clear, active → attempt,
      // unreadable → backoff), manager taken from THAT position, retry backoff
      // on an unchanged position.
      //
      // A close that cannot happen right now (pool liquidity / preflight /
      // backoff / hold) is NOT fatal: that record is KEPT, its own backoff
      // stands, and the loop continues with the NEXT position. One stuck
      // position can never block closing (or opening) the others.
      //
      // `closesOk` counts verified closes this cycle; `dryWouldClose` counts
      // dry-run "would close" outcomes (their records stay — planning only).
      let closesOk = 0;
      let dryWouldClose = 0;
      for (const rec of trackedNow) {
        if (!this._positions().includes(rec)) continue; // already cleared by a sibling
        const closeOutcome = (await this.closeActivePosition(rec))
          || { ok: false, blocked: true, continueCycle: true, code: "NO_RESULT" };
        if (closeOutcome.ok && closeOutcome.dryRun) dryWouldClose++;
        else if (closeOutcome.ok) closesOk++;
        else {
          this.log(`[CLOSE] #${rec.positionId ?? "?"} ${closeOutcome.blocked ? "blocked" : "deferred"} (code=${closeOutcome.code || "?"}) — position KEPT, other positions unaffected`, "warn");
        }
      }
      if (closesOk > 0) {
        this.setState(STATES.COOLDOWN);
        this.log(`[COOLDOWN] ${closesOk} position(s) closed — ${this.config.cooldownAfterCloseMs / 1000}s...`, "info");
        await this.sleep(this.config.cooldownAfterCloseMs);
        this.lastCycleAction = "close";
      } else if (trackedNow.length) {
        this.lastCycleAction = "close-blocked";
      }

      // PHASE 1.5 — SWAP MAINTENANCE. Runs after (or instead of) CLOSE and is
      // completely independent of it: a blocked/deferred close never stops the
      // rotation and never clears any record.
      this.setState(STATES.AUTO_SWAP);
      const swapAfterClose = await this.runSwapMaintenanceCycle({ phase: "PHASE-1.5" });
      this.log(`[CYCLE] swap maintenance (after CLOSE): attempted=${swapAfterClose.attempted} verified=${swapAfterClose.verified} skipped=${swapAfterClose.skipped} failed=${swapAfterClose.failed}`, "info");

      // PHASE 1.5b — OPEN gates. Multi-position: the OPEN phase runs whenever
      // the global cap has room (per-market slots are checked per candidate in
      // the loop below). A still-open position NEVER globally blocks OPEN —
      // only maxOpenPositions, a pending open, or the trade cap can.
      //
      // DRY-RUN EXCEPTION: dry closes are read-only, so their records stay in
      // the array; `dryWouldClose` lets the planner treat those slots as free
      // for the plan-only PHASE 2/3 (no state is written either way).
      const gate = this._canOpenNew({
        effectiveCount: dryRun ? this._activeCount() - dryWouldClose : null,
      });
      if (!gate.ok) {
        const maxOpen = Math.max(1, Number(this.config.maxOpenPositions) || 1);
        if (gate.code === "TRADE_CAP") {
          this.log(`[AUTO] OPEN_SKIPPED reason=TRADE_CAP phase=PHASE-1.5b tracked=${this._activeCount()}/${maxOpen} opensThisRun=${this._opensThisRun}/${Number(this.config.maxTradesPerRun || 0)} — next: wait for a verified close of a position opened this run (returns its trade slot)`, "warn");
          this.lastCycleAction = "idle";
          this.log("[CYCLE] ═══ CYCLE END ═══", "info");
          return;
        }
        this.log(`[AUTO] OPEN_SKIPPED reason=${gate.code} phase=PHASE-1.5b tracked=${this._activeCount()}/${maxOpen} — next: SWAP engine continues independently`, "warn");
        this.log("[CYCLE] ═══ CYCLE END ═══", "info");
        return;
      }

      // PHASE 2: SELECT DIRECTION + MARKET — the configured ratio decides SIDE
      // (an RSI signal may bias it; a disabled side is NEVER picked), rotation
      // keeps planning the MARKET×SIDE candidate for market selection.
      this.setState(STATES.SIGNAL);
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

      const planned = await this.nextMarketSide();
      const side = this._pickOpenSide(preferredSideFromSignal, planned?.side || null);
      if (!side) {
        this.log(`[AUTO] OPEN_SKIPPED reason=SIDE_DISABLED phase=PHASE-2 enableLong=${this.config.enableLong !== false} enableShort=${this.config.enableShort !== false} — next: enable a side in config`, "error");
        this.lastCycleAction = "idle";
        this.log("[CYCLE] ═══ CYCLE END ═══", "info");
        return;
      }
      this.log(`[DIRECTION] ${side}${planned ? ` (rotated candidate: ${planned.marketSymbol || planned.symbol}×${planned.side})` : ""}${preferredSideFromSignal ? ` (RSI bias: ${preferredSideFromSignal})` : ""}`, "warn");

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

        // PER-MARKET SLOT — another tracked position (active or pending) already
        // occupies this market. One position per market is a MARKET limit, never
        // a global one: other markets stay fully tradable.
        if (this._marketHasPosition(candidate)) {
          this.log(`[SKIP] ${candidate.symbol} ${side}: market already has a tracked position — trying next candidate`, "warn");
          this._rotMarketSkip(candidate.symbol, side);
          continue;
        }

        // EXPOSURE CAP — sum of same-collateralToken tracked collateral + the
        // new amount must stay within maxTotalCollateral (per-token, no
        // cross-token valuation). Over cap → SKIPPED with reason.
        const exp = this._exposureGate(ctx);
        if (!exp.ok) {
          this.log(`[SKIP] ${candidate.symbol} ${side}: ${exp.code} — ${exp.reason} — trying next candidate`, "warn");
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
        this._trackOpenedPosition({
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
        }, { pending: true });
        saveState(this.state);

        this.setState(STATES.MONITOR);
        this.log(`[OPEN] PENDING tx=${openResult.txHash} — awaiting confirmation; sessionStats.opens NOT incremented`, "warn");

        this.log(`[COOLDOWN] ${this.config.cooldownAfterOpenMs / 1000}s...`, "info");
        await this.sleep(this.config.cooldownAfterOpenMs);
      } else if (openResult) {
        this._recordDirectionSuccess(marketUsed.symbol, side);
        this._rotMarketDone(marketUsed.symbol, side);
        const rec = this._trackOpenedPosition({
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
        });

        this.setState(STATES.MONITOR);
        this.log(`[MONITOR] position #${rec.positionId} (${rec.side} ${marketUsed.symbol}) — ${this._activeCount()} position(s) tracked`, "success");

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

  /**
   * CONTINUOUS RUNNER.
   *
   * @param {object} [opts]
   * @param {number|null} [opts.maxCycles] stop after N loop iterations
   *        (undefined/0/NaN/≤0 → unlimited). Counter is `this._cycleNo`, the
   *        same one that prints `[CYCLE] #N`.
   */
  async start(opts = {}) {
    if (this.running) { this.log("[AUTO] Already running.", "warn"); return; }
    // ONE swap scheduler per bot instance — never start the maintenance loop
    // while a standalone runSwapLoop() already owns the swap cadence.
    if (this._swapLoopRunning) {
      this.log("[BLOCKED] runSwapLoop() is already running — not starting a second swap engine", "warn");
      return;
    }
    const maxCyclesRaw = Number(opts.maxCycles);
    const maxCycles = Number.isFinite(maxCyclesRaw) && maxCyclesRaw > 0 ? Math.floor(maxCyclesRaw) : null;
    // CONTINUOUS-BOUNDED RUN — `--max-trading-cycles=N` bounds COMPLETED
    // OPEN→SWAPs→CLOSE cycles (unlike --max-cycles which bounds loop passes).
    const maxTradingRaw = Number(opts.maxTradingCycles);
    const maxTradingCycles = Number.isFinite(maxTradingRaw) && maxTradingRaw > 0 ? Math.floor(maxTradingRaw) : null;
    // OPERATOR HALT CLEAR — `--reset-halt` (must happen before any cycle logic).
    if (opts.resetHalt) this._clearContinuousHalt();
    this.running = true;
    this.stopRequested = false;

    try {
      this.log("══════════════════════════════════════════════", "warn");
      this.log("  CONTINUOUS AUTO TRADING STARTED", "warn");
      this.log(`  Leverage: ${this.config.defaultLeverage}x`, "info");
      this.log(`  Dry run: ${this.config.dryRun}`, "info");
      if (maxCycles !== null) this.log(`  Max cycles: ${maxCycles}`, "info");
      this.log("══════════════════════════════════════════════", "warn");

      // ── boot banner — config-driven, needs no CLI flags (`npm start` only) ──
      this._logSwapBoot();

      // Recovery — reconcile EVERY local record with the chain and adopt EVERY
      // on-chain position of this wallet (all managers, not just one slot).
      try {
        this.log("[RECOVERY] scanning on-chain...", "info");
        await this.ensureMarkets({ force: true });
        await this._syncAllPositions();
        const tracked = this._positions();
        if (tracked.length) {
          this.log(`[RECOVERY] tracking ${tracked.length} position(s): #${tracked.map(p => p.positionId ?? "?").join(", #")} — each closes independently on its own manager`, "warn");
        } else {
          this.log("[RECOVERY] no active positions tracked", "info");
        }
      } catch (re) {
        this.log(`[RECOVERY] failed: ${re.message?.slice(0, 60)}`, "error");
      }

      // Route inventory for the swap engine (markets/routes were just discovered
      // above by the RECOVERY pass) — informational only, sends nothing.
      await this._logSwapRoutes();

      // CONTINUOUS CYCLE — resume the persisted cycle (state + on-chain truth)
      // and announce the operating parameters.
      if (this._continuousEnabled()) {
        try { await this._recoverContinuousCycle(); } catch (e) {
          this.log(`[CONTINUOUS] cycle recovery failed: ${e.message?.slice(0, 60)}`, "error");
        }
        const halt = this._haltInfo();
        this.log(`[CONTINUOUS] cycle mode ON — swapsPerPosition=${this._cycleQuota()} attemptCap=${this._cycleAttemptCap()} effectiveMaxOpen=1 haltThreshold=${this._cycleHaltThreshold()}${halt ? ` HALTED(${halt.reason})` : ""}`, "warn");
      }

      // CONTINUOUS RUNNER — never stops on its own; `maxCycles` (when given)
      // bounds the number of iterations via the shared `this._cycleNo` counter;
      // `maxTradingCycles` bounds COMPLETED trading cycles, and a bounded run
      // also exits once the halt safe-stop engages (an unbounded operator run
      // keeps retrying closes and waits for --reset-halt).
      while (!this.stopRequested && (maxCycles === null || this._cycleNo < maxCycles)
             && (maxTradingCycles === null || this._tradingCyclesDone < maxTradingCycles)
             && !(maxTradingCycles !== null && this._haltInfo())) {
        try {
          // Cycle marker — the log then follows PHASE 1 → 1.5 → 2 → 3.
          this.log(`[CYCLE] #${++this._cycleNo}`, "warn");

          // STEP 1: CLOSE — every tracked position gets its OWN attempt. A
          // blocked close logs and keeps THAT record — it never returns out of
          // the loop, so sibling positions and the swap rotation always get
          // their turn.
          if (this._continuousEnabled()) this._checkCycleStall();
          const loopPositions = [...this._positions()];
          if (loopPositions.length && !this.stopRequested) {
            this.log(`[AUTO] NEXT ACTION: CLOSE position(s) #${loopPositions.map(p => p.positionId ?? "?").join(", #")}`, "info");
            for (const rec of loopPositions) {
              if (!this._positions().includes(rec)) continue;
              if (this.stopRequested) break;
              // CONTINUOUS QUOTA GUARD — a HOLDING cycle position is closed
              // only after its swap quota (or the emergency override fires).
              if (await this._continuousBlocksClose(rec)) {
                const c = this._getCycle();
                this.log(`[CYCLE] #${c.cycleId} close of #${rec.positionId ?? "?"} deferred — swap quota ${(c.confirmedSwaps || []).length}/${c.swapsTarget} not met yet`, "info");
                continue;
              }
              const closeOutcome = await this.closeActivePosition(rec);
              if (closeOutcome && !closeOutcome.ok) {
                this.log(`[CLOSE] #${rec.positionId ?? "?"} ${closeOutcome.blocked ? "blocked" : "deferred"} (code=${closeOutcome.code || "?"}) — position kept; other positions and swap engine continue`, "warn");
              }
            }
          }

          // STEP 2: SWAP MAINTENANCE — independent rotation over every validated
          // direction (A→B and B→A are separate queue entries). In continuous
          // mode the pass is quota-limited to the cycle's remaining SWAPs and
          // its results are ingested (only balance-verified swaps count).
          if (!this.stopRequested) {
            const swapOpts = this._swapRunOpts("LOOP");
            if (swapOpts) {
              this.setState(STATES.AUTO_SWAP);
              const sumLoop = await this.runSwapMaintenanceCycle(swapOpts);
              this._ingestSwapSummary(sumLoop);
            }
          }

          // STEP 3: OPEN — allowed whenever the global cap has room (per-market
          // slots are checked per candidate inside prepareAndOpen). A stuck
          // position on one market never blocks OPEN on the others.
          if (!this.stopRequested) {
            const gate = this._canOpenNew({ log: false });
            if (!gate.ok) {
              if (gate.code === "TRADE_CAP" && this._activeCount() === 0) {
                // Cap reached with NO open position → stop the run cleanly. A
                // position still open is never abandoned (STEP 1 keeps closing it).
                this.log(`[LIMIT] maxTradesPerRun=${Number(this.config.maxTradesPerRun || 0)} reached (opens this run=${this._opensThisRun}) and no position is open — stopping the run`, "warn");
                this.stopRequested = true;
              } else {
                const maxOpen = this._effectiveMaxOpen();
                const nextAction = gate.code === "TRADE_CAP"
                  ? `wait for a verified close of a position opened this run (returns its trade slot)`
                  : gate.code === "TRADING_HALTED"
                    ? `safe-stop active — closes keep retrying; operator must restart with --reset-halt`
                    : gate.code === "MAX_OPEN_POSITIONS" || gate.code === "OPEN_PENDING" || gate.code === "MARKET_BUSY"
                      ? `wait for a slot to free`
                      : `swap engine continues independently`;
                this.log(`[AUTO] OPEN_SKIPPED reason=${gate.code} phase=STEP3 tracked=${this._activeCount()}/${maxOpen} opensThisRun=${this._opensThisRun}/${Number(this.config.maxTradesPerRun || 0)} — next: ${nextAction}`, "warn");
              }
            } else {
              // OPEN RETRY RATE-LIMIT — a failed OPEN is retried after
              // openRetryIntervalMs; meanwhile the loop keeps SWAPing.
              const retryAt = this._continuousEnabled() ? this._openRetryPending() : 0;
              if (retryAt > Date.now()) {
                this.log(`[AUTO] OPEN_SKIPPED reason=OPEN_RETRY_WAIT phase=STEP3 — last OPEN failed (${this.state.openRetryReason || "?"}); next retry at ${new Date(retryAt).toISOString()} (${Math.ceil((retryAt - Date.now()) / 1000)}s); SWAP engine continues`, "info");
              } else {
                const planned = await this.nextMarketSide();
                const side = this._pickOpenSide(null, planned?.side || null);
                if (!side) {
                  this.log(`[AUTO] OPEN_SKIPPED reason=SIDE_DISABLED phase=STEP3 enableLong=${this.config.enableLong !== false} enableShort=${this.config.enableShort !== false} — next: enable a side in config`, "error");
                } else {
                  this.log(`[AUTO] NEXT ACTION: OPEN ${side}${planned ? ` on ${planned.marketSymbol || planned.symbol}` : ""} (${this._activeCount()}/${this._effectiveMaxOpen()} slots used)`, "info");
                  this.setState(STATES.OPEN);
                  const opened = await this.prepareAndOpen(side);
                  // CONTINUOUS FAILURE ACCOUNTING — a failed OPEN is RATE-LIMITED
                  // and retried, never a safe-stop (the loop keeps SWAPing and
                  // retries OPEN on a suitable market; see _noteOpenFailure).
                  if (this._continuousEnabled()) {
                    if (opened === false) {
                      this._noteOpenFailure(side, "all candidate markets failed");
                    } else {
                      this._clearOpenRetry(); // submitted / dry / pending — window over
                    }
                  }
                }
              }
            }
          }

          // STEP 4: SWAP MAINTENANCE continues regardless of the OPEN outcome
          // (usually gated by minIntervalMs right after a settlement).
          if (!this.stopRequested) {
            const swapOpts2 = this._swapRunOpts("LOOP-2");
            if (swapOpts2) {
              this.setState(STATES.AUTO_SWAP);
              const sumLoop2 = await this.runSwapMaintenanceCycle(swapOpts2);
              this._ingestSwapSummary(sumLoop2);
            }
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
      skippedByReason: {}, pendingByState: {}, executable: [],
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
    const { directions: rawDirections, decimalsMap } = this._swapDirections(filter || {});
    // PROTECTED POOLS — a tracked position's own pool is never swapped through
    // (the swap could drain the exit liquidity the position needs to close).
    let directions = rawDirections;
    if (options.protectedPools && options.protectedPools.length) {
      const before = directions.length;
      directions = this._filterProtectedDirections(directions, options.protectedPools);
      const skipped = before - directions.length;
      if (skipped > 0) {
        this.log(`[SWAP] ${phase}${skipped} direction(s) skipped — route touches a tracked position's pool (protected)`, "info");
      }
    }
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

    // Structured diagnostics: per-reasonCode counts + per-state counts + the
    // concrete list of directions that are actually executable (dry or live).
    // Directions the queue never reached (maxSwapsPerCycle=1 → early break)
    // stay READY — they are re-evaluated on the next pass.
    summary.skippedByReason = {};
    summary.pendingByState = {};
    summary.executable = [];
    for (const r of res.results) {
      const code = r?.code || "UNKNOWN";
      if (r?.status === "skip" || r?.status === "fail") {
        summary.skippedByReason[code] = (summary.skippedByReason[code] || 0) + 1;
      }
      const st = r?.state || (r?.status === "ok" ? SWAP_DIRECTION_STATES.CONFIRMED
        : r?.status === "dry" ? SWAP_DIRECTION_STATES.EXECUTABLE : SWAP_DIRECTION_STATES.READY);
      summary.pendingByState[st] = (summary.pendingByState[st] || 0) + 1;
      if (st === SWAP_DIRECTION_STATES.EXECUTABLE || st === SWAP_DIRECTION_STATES.CONFIRMED) {
        summary.executable.push(r?.direction || `${r?.from || "?"}->${r?.to || "?"}`);
      }
    }
    const unevaluated = Math.max(0, summary.total - res.results.length);
    if (unevaluated > 0) {
      summary.pendingByState[SWAP_DIRECTION_STATES.READY] = (summary.pendingByState[SWAP_DIRECTION_STATES.READY] || 0) + unevaluated;
    }
    if (res.results.length) {
      this.log(
        `[SWAP DIAG] ${phase}summary attempted=${summary.attempted} confirmed=${summary.verified} ` +
        `skipped=${summary.skipped} failed=${summary.failed} skippedByReason=${JSON.stringify(summary.skippedByReason)} ` +
        `states=${JSON.stringify(summary.pendingByState)} executable=${summary.executable.join(",") || "(none)"}`, "warn");
    }

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

    // Every skip/fail carries { state, recoverable, recommendedAction } — no
    // anonymous SKIPs. WAITING_* directions re-enter the queue next pass and
    // only re-check their precondition (balance/allowance/quote — cheap);
    // FAILED routes hit the per-route backoff.
    const skip = (code, reason, extra = {}, rotate = true) => {
      const m = swapReasonMeta(code);
      const state = extra.state || m.state;
      const recoverable = extra.recoverable ?? m.recoverable;
      const recommendedAction = extra.recommendedAction || m.recommendedAction;
      this.log(`[SWAP SKIP] direction=${direction} code=${code} state=${state} reason=${reason}`, "warn");
      this.log(`[SWAP DIAG] direction=${direction} state=${state} reasonCode=${code} recoverable=${recoverable} action=${recommendedAction}`, "info");
      if (rotate) this._rotSwapSkip(dir.from, dir.to);
      return { status: "skip", code, reason, state, recoverable, recommendedAction, direction };
    };
    const fail = (code, reason, extra = {}) => {
      const m = swapReasonMeta(code);
      const state = extra.state || m.state || SWAP_DIRECTION_STATES.FAILED;
      const recoverable = extra.recoverable ?? m.recoverable;
      const recommendedAction = extra.recommendedAction || m.recommendedAction;
      this.log(`[SWAP SKIP] direction=${direction} code=${code} state=${state} reason=${reason}`, "error");
      this.log(`[SWAP DIAG] direction=${direction} state=${state} reasonCode=${code} recoverable=${recoverable} action=${recommendedAction}`, "info");
      return { status: "fail", code, reason, state, recoverable, recommendedAction, direction };
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

    // Smallest raw amount still worth swapping for the SOURCE token — the
    // shrink-and-retry floor (never chase an economic gate below dust).
    const minSwapRawFor = () => {
      const s = cfg["minSwapAmount" + dir.from];
      if (s === undefined || s === null || s === "") return 0n;
      try { return ethers.parseUnits(String(s), fromDec); } catch { return 0n; }
    };

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
        this.log(`[SWAP SKIP] direction=${direction} code=GAS_TOO_HIGH state=FAILED reason=network gas ${gwei.toFixed(2)} gwei > maxGasGwei ${cfg.maxGasGwei}`, "warn");
        this.log(`[SWAP DIAG] direction=${direction} state=FAILED reasonCode=GAS_TOO_HIGH recoverable=true action=network gas above the ceiling — wait`, "info");
        return { status: "stop", code: "GAS_TOO_HIGH", direction, reason: `gas ${gwei.toFixed(2)} gwei > ${cfg.maxGasGwei}`, state: SWAP_DIRECTION_STATES.FAILED, recoverable: true, recommendedAction: "network gas above the ceiling — wait" };
      }
    }

    // 3. fresh quote for THIS size (never reuse a stale one)
    const quoteAt = (amt) => quoteBestPath({
      provider, routerAddress: getRouterAddress(), routes: this.routes,
      fromAddr: dir.fromAddr, toAddr: dir.toAddr, amountIn: amt,
      log: this.log.bind(this),
    });
    let best = await quoteAt(amountRaw);
    if (!best) return skip("ROUTE_UNAVAILABLE", "no validated path quotes a non-zero output at this size");
    if (!(best.amountOut > 0n)) return skip("QUOTE_ZERO", "router returned amountOut=0");

    // 5. amountOutMin from the configured slippage — never 0, never hardcoded
    let amountOutMin = applySlippage(best.amountOut, slippageBps);
    if (!(amountOutMin > 0n)) return skip("ZERO_AMOUNT_OUT_MIN", `amountOutMin collapsed to 0 at slippageBps=${cfg.slippageBps}`);

    // 5a. ECONOMIC GATES — a quotable route is not automatically a sane route.
    // Every leg is re-priced against the pool's OWN reserves and fee (1% per leg,
    // so a 2-hop pays it twice) and vetoed when the swap would move the pool by
    // more than maxPoolShareBps / maxPriceImpactBps. Thresholds are configurable
    // and are NEVER loosened automatically. When the failure is size-driven
    // (POOL_SHARE_HIGH / PRICE_IMPACT_HIGH) the input is SHRUNK — pool-share cap
    // first, then halvings — and re-quoted through the router each time. Read-only.
    const economyCfg = normalizeEconomyConfig(cfg.swapEconomy);
    let econ = await probeRouteEconomics({
      provider, factoryAddress: getFactoryAddress(), path: best.path,
      amountIn: amountRaw, amountOut: best.amountOut, amountOutMin,
      economy: economyCfg, log: this.log.bind(this),
    });
    let finalAmountRaw = amountRaw;
    let shrunk = null;
    if (!econ.ok) {
      const sizeGates = (econ.gates || []).filter(g => g === "POOL_SHARE_HIGH" || g === "PRICE_IMPACT_HIGH");
      if (sizeGates.length && !pinned) {
        const minRaw = minSwapRawFor() > 0n ? minSwapRawFor() : 1n;
        let start = finalAmountRaw;
        const caps = (econ.legs || [])
          .filter(l => l.reserveIn != null)
          .map(l => poolShareCapAmountIn({ reserveIn: l.reserveIn, maxPoolShareBps: economyCfg.maxPoolShareBps }))
          .filter(c => c > 0n);
        if (caps.length) {
          const cap = caps.reduce((a, b) => (b < a ? b : a));
          if (cap > 0n && cap < start) start = cap;
        }
        let lastQuote = null;
        const probe = async (amt) => {
          const q = await quoteAt(amt);
          if (!q || !(q.amountOut > 0n)) { lastQuote = null; return { ok: false, gates: ["QUOTE_ZERO"] }; }
          const aom = applySlippage(q.amountOut, slippageBps);
          lastQuote = q;
          if (!(aom > 0n)) return { ok: false, gates: ["ZERO_AMOUNT_OUT_MIN"] };
          return probeRouteEconomics({
            provider, factoryAddress: getFactoryAddress(), path: q.path,
            amountIn: amt, amountOut: q.amountOut, amountOutMin: aom,
            economy: economyCfg, log: () => {},
          });
        };
        const shr = await shrinkToFitEconomy({ amountIn: start, minAmountIn: minRaw, maxHalvings: 4, probe });
        if (shr.ok && lastQuote) {
          shrunk = { from: String(finalAmountRaw), to: String(shr.amountIn), halvings: shr.halvings };
          finalAmountRaw = shr.amountIn;
          best = lastQuote;
          amountOutMin = applySlippage(best.amountOut, slippageBps);
          econ = shr.probe;
          this.log(
            `[SWAP] shrink-and-retry ${direction}: amountIn ${ethers.formatUnits(BigInt(shrunk.from), fromDec)} → ` +
            `${ethers.formatUnits(finalAmountRaw, fromDec)} (${shr.halvings} halving(s); previous gates=${sizeGates.join(",")}; thresholds unchanged)`, "warn");
        } else {
          return skip("WAITING_FOR_PRICE",
            `economy gates ${econ.gates.join(",")} not fixed by shrinking to the min ${ethers.formatUnits(minRaw, fromDec)} (${shr.reason}) — deferred until the book deepens (thresholds unchanged)`);
        }
      } else {
        // Non-size gates (ZERO_RESERVE / RESERVE_UNREADABLE / ZERO_QUOTE …)
        // map to liquidity; everything else waits for a better book.
        const liqGates = (econ.gates || []).some(g => g === "ZERO_RESERVE" || g === "RESERVE_UNREADABLE" || g === "ZERO_QUOTE");
        return skip("ECONOMY_REJECTED", `gates=${econ.gates.join(",")}`,
          liqGates ? { state: SWAP_DIRECTION_STATES.WAITING_FOR_LIQUIDITY } : {});
      }
    }

    // 5a-bis. SYMMETRIC ROUND-TRIP rate check (direct pairs only).
    // Forward quote gives us Y for X. We then ask the SAME reversed path what
    // it pays for exactly Y — the amount the pool just handed us. For an
    // honest CPMM the product rateAB×rateBA sits at (1−fee)^2 no matter how
    // unbalanced the book is; the old check re-quoted a DIFFERENT size on a
    // possibly DIFFERENT route and false-positived on thin books.
    if (best.path.length === 2) {
      let rtOut = null;
      let rtRevert = null;
      try {
        const routerForRt = new ethers.Contract(getRouterAddress(), ROUTER_ABI, provider);
        const amounts = await routerForRt.getAmountsOut(best.amountOut, [best.path[1], best.path[0]]);
        rtOut = BigInt(amounts[amounts.length - 1]);
      } catch (e) {
        rtRevert = String(e?.shortMessage || e?.message || e).slice(0, 100);
      }
      if (rtRevert || !(rtOut > 0n)) {
        return skip("RATE_DEVIATION_UNVERIFIED",
          `symmetric round-trip quote unavailable (path ${best.path[1]}→${best.path[0]} amountIn=${ethers.formatUnits(best.amountOut, toDec)}): ${rtRevert || "amountOut=0"} — swap BLOCKED until a consistent reverse quote exists`);
      }
      const fwdH = Number(ethers.formatUnits(finalAmountRaw, fromDec));
      const midH = Number(ethers.formatUnits(best.amountOut, toDec));
      const rateAB = midH / fwdH;
      const rateBA = Number(ethers.formatUnits(rtOut, fromDec)) / midH;
      const feeFrac = (econ.legs?.[0]?.swapFeeBps ?? 100) / Number(BPS);
      const rc = checkRateConsistency({
        rateAB, rateBA, legs: 1, feeFrac,
        maxDeviation: economyCfg.maxRateDeviation,
      });
      const fmt = (x) => (Number.isFinite(x) ? x.toExponential(4) : String(x));
      this.log(
        `[SWAP RATE] direction=${direction} path=${best.path.join("→")} roundTripOut=${ethers.formatUnits(rtOut, fromDec)} ` +
        `amountIn=${fwdH} forwardOut=${midH} rateAB=${fmt(rateAB)} rateBA=${fmt(rateBA)} ` +
        `product=${fmt(rc.product)} expected=${rc.expected} deviation=${fmt(rc.deviation)} ` +
        `maxDeviation=${economyCfg.maxRateDeviation} feeBps=${econ.legs?.[0]?.swapFeeBps ?? 100}`, "info");
      if (!rc.ok) {
        return skip("RATE_DEVIATION",
          `round-trip product=${fmt(rc.product)} expected=${rc.expected.toFixed(6)} deviation=${fmt(rc.deviation)}× > max ${economyCfg.maxRateDeviation} — pools quote inconsistently, swap BLOCKED`);
      }
    }

    const routerAddr = getRouterAddress();
    const rec = (this.routes || []).find(r => r.valid && Array.isArray(r.path) && r.path.length === best.path.length
      && r.path.every((a, i) => String(a).toLowerCase() === String(best.path[i]).toLowerCase()));
    const pool = rec?.pool || rec?.pool2 || "-";

    // 5b. ALLOWANCE — approve-FIRST for the automatic maintenance mode. The
    // router preflight below reverts TransferHelper: TRANSFER_FROM_FAILED when
    // the v5 Router allowance is missing, so this check MUST run before the
    // eth_call — otherwise every un-approved direction died behind a generic
    // PREFLIGHT_REVERT and the approve branch was never reached. Approve is
    // MaxUint256 (once per token per router), AWAITED, and allowance is then
    // RE-READ: the swap is only sent once the chain itself agrees the
    // allowance covers the amount. No second approve while one still suffices.
    const fromRead = new ethers.Contract(dir.fromAddr, ERC20_ABI, provider);
    let allowanceNow = await fromRead.allowance(walletAddr, routerAddr).catch(() => null);
    let approveTxHash = null;
    const allowApprove = pinned ? pinned.allowApprove !== false : true;
    if (allowanceNow === null) {
      return fail("PREFLIGHT_REVERT", "allowance() view reverted — RPC/token issue");
    }
    if (allowanceNow < finalAmountRaw) {
      if (!allowApprove) {
        return skip("APPROVAL_REQUIRED",
          `allowance ${ethers.formatUnits(allowanceNow, fromDec)} < needed ${ethers.formatUnits(finalAmountRaw, fromDec)} (allowApprove=false)`);
      }
      if (dryRun) {
        return skip("WAITING_FOR_ALLOWANCE",
          `allowance ${ethers.formatUnits(allowanceNow, fromDec)} < needed ${ethers.formatUnits(finalAmountRaw, fromDec)} — live mode would approve the v5 Router once, re-check allowance, then swap`);
      }
      this.log(`[SWAP] approve required ${dir.from}: allowance ${ethers.formatUnits(allowanceNow, fromDec)} < needed ${ethers.formatUnits(finalAmountRaw, fromDec)} — approving v5 Router ${routerAddr} once`, "warn");
      const fromSigner = new ethers.Contract(dir.fromAddr, ERC20_ABI, wallet);
      // GAS: this deployment's DAI/LINK/UNI/WETH/USDC approve needs ~129k gas
      // (cold proxy storage), so a hardcoded 100k limit OOGs — measured on-chain,
      // 30 reverted SWAP-APPROVE txs burned real gas before this fix. Estimate
      // per token (+25%); if estimation itself fails the approve WOULD revert,
      // so never send it (no wasted gas, explicit failure instead).
      let approveGas;
      try {
        const est = await provider.estimateGas({
          from: walletAddr, to: dir.fromAddr,
          data: fromSigner.interface.encodeFunctionData("approve", [routerAddr, ethers.MaxUint256]),
        });
        approveGas = est + est / 4n;
      } catch (e) {
        return fail("INSUFFICIENT_ALLOWANCE",
          `approve estimation failed for ${dir.from} — not sending: ${String(e?.shortMessage || e?.message || e).slice(0, 100)}`);
      }
      if (this.txManager) {
        const r = await this.txManager.sendAndWait({
          wallet, provider, txType: "SWAP-APPROVE",
          sendFn: (nonce) => fromSigner.approve(routerAddr, ethers.MaxUint256, { gasLimit: approveGas, nonce }),
          log: this.log.bind(this),
        });
        if (!r || r.status === 0) return fail("INSUFFICIENT_ALLOWANCE", `approve transaction reverted for ${dir.from}`);
        approveTxHash = r.hash || r.txHash || null;
      } else {
        const approveTx = await fromSigner.approve(routerAddr, ethers.MaxUint256, { gasLimit: approveGas });
        approveTxHash = approveTx.hash;
        await approveTx.wait();
      }
      allowanceNow = await fromRead.allowance(walletAddr, routerAddr).catch(() => 0n);
      if (allowanceNow < finalAmountRaw) {
        return fail("INSUFFICIENT_ALLOWANCE",
          `allowance ${ethers.formatUnits(allowanceNow, fromDec)} still < needed ${ethers.formatUnits(finalAmountRaw, fromDec)} after approve ${approveTxHash || "?"}`);
      }
      this.log(`[SWAP] allowance re-check OK ${dir.from}: ${ethers.formatUnits(allowanceNow, fromDec)} >= ${ethers.formatUnits(finalAmountRaw, fromDec)} (approve ${approveTxHash})`, "success");
    }

    // 5c. read-only preflight — nothing is signed before this eth_call succeeds
    // (allowance is now guaranteed, so TRANSFER_FROM_FAILED here is a real bug,
    // not a missing approval).
    const deadline = Math.floor(Date.now() / 1000) + Number(this.config.deadlineSeconds || 1200);
    let calldata;
    try {
      calldata = new ethers.Interface(ROUTER_ABI).encodeFunctionData(
        "swapExactTokensForTokens", [finalAmountRaw, amountOutMin, best.path, walletAddr, deadline]);
      await provider.call({ from: walletAddr, to: routerAddr, data: calldata, value: 0n });
    } catch (e) {
      const msg = String(e?.shortMessage || e?.message || e);
      const cls = classifySwapRevert(msg);
      if (cls) return skip(cls.code, cls.detail);
      return skip("PREFLIGHT_REVERT", msg.slice(0, 120));
    }

    this.log(
      `[SWAP] direction=${direction} tokenIn=${dir.fromAddr} tokenOut=${dir.toAddr} ` +
      `amountIn=${ethers.formatUnits(finalAmountRaw, fromDec)} quoteOut=${ethers.formatUnits(best.amountOut, toDec)} ` +
      `amountOutMin=${ethers.formatUnits(amountOutMin, toDec)} router=${routerAddr} pool=${pool} ` +
      `reserve=${ethers.formatUnits(sized.reserve, fromDec)} available=${ethers.formatUnits(sized.availableRaw, fromDec)} ` +
      `hops=${best.type} preflight=PASS${shrunk ? ` shrunk=${shrunk.from}→${shrunk.to}` : ""}`, "warn");

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
        amountIn: String(finalAmountRaw), amountInHuman: ethers.formatUnits(finalAmountRaw, fromDec),
        quoteOut: String(best.amountOut), quoteOutHuman: ethers.formatUnits(best.amountOut, toDec),
        amountOutMin: String(amountOutMin), amountOutMinHuman: ethers.formatUnits(amountOutMin, toDec),
        slippageBps: Number(slippageBps),
        poolSharePct: leg0?.poolShare != null ? Number(leg0.poolShare) * 100 : null,
        priceImpactExFeePct: leg0?.priceImpactExFee != null ? Number(leg0.priceImpactExFee) * 100 : null,
        spot: leg0?.spot ?? null, execRate: leg0?.execRate ?? null,
        economyGates: econ?.gates || [],
        shrunk: shrunk || null,
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
      this.log(`[DRY] ${tag}would swap ${direction} ${ethers.formatUnits(finalAmountRaw, fromDec)} → min ${ethers.formatUnits(amountOutMin, toDec)}`, "info");
      return {
        status: "dry", code: "DRY_RUN", direction,
        reason: pinned ? "plan only — no --confirm, nothing signed" : "dry-run — no transaction sent",
        state: SWAP_DIRECTION_STATES.EXECUTABLE, recoverable: true,
        recommendedAction: "ready — live mode would execute this swap (allowance + preflight + economy all passed)",
        amountIn: String(finalAmountRaw), amountOutMin: String(amountOutMin), plan,
        approveTxHash, shrunk,
      };
    }

    // 6 + 7. allowance already guaranteed above → send → wait receipt
    const report = {};
    const res = await executeSwap({
      wallet, provider,
      fromToken: dir.fromAddr, toToken: dir.toAddr,
      amount: finalAmountRaw, amountOutMin,
      config: this.config, log: this.log.bind(this), txManager: this.txManager,
      path: best.path, report,
      allowApprove,
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
      `inDelta=${inDelta} outDelta=${outDelta} amountIn=${finalAmountRaw} amountOutMin=${amountOutMin}`,
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
    try { this.swapJournal.record({ from: dir.from, to: dir.to, amount: parseFloat(ethers.formatUnits(finalAmountRaw, fromDec)) }); } catch { /* best-effort */ }

    return {
      status: "ok",
      direction,
      state: SWAP_DIRECTION_STATES.CONFIRMED, recoverable: false,
      recommendedAction: "none — swap confirmed and verified",
      txHash: res.txHash, blockNumber: res.blockNumber ?? null, gasUsed: res.gasUsed ?? null,
      approveTxHash: res.approveTxHash || approveTxHash || null,
      amountIn: String(finalAmountRaw), quoteOut: String(best.amountOut), amountOutMin: String(amountOutMin),
      inDelta: String(inDelta), outDelta: String(outDelta),
      path: best.path, hops: best.type, pool,
      allowance: report.allowance || null, preflight: report.preflight || "PASS",
      plan, shrunk,
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
   * Locate a tracked position record ON-CHAIN without trusting local identity.
   *
   * Used when the stored record has no resolvable manager (or at startup), so a
   * stale/legacy record can neither block CLOSE forever nor be cleared on a
   * failed read. Only the chain decides:
   *   • resolved manager says active      → {status:"active", managerAddr}
   *   • resolved manager says inactive    → {status:"closed"}   (zombie → clear)
   *   • no identity, some manager has it  → {status:"active", located:true}
   *   • no identity, no manager has it    → {status:"missing"}  (zombie → clear)
   *   • every read failed                 → {status:"unreadable"} (KEEP state)
   *
   * @param pos the tracked record to locate
   */
  async _locateStoredPosition(pos) {
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
   * Adopt EVERY on-chain active position of this wallet that is not already
   * tracked — across ALL known managers. The chain, not the local file,
   * decides what must be closed; one adopted record never overwrites another.
   *
   * Without this, positions the bot never tracked (e.g. #103/#104/#106 opened
   * before a restart or by an earlier run) could never be closed: nothing
   * else ever filled the array with them.
   *
   * @returns {Promise<number>} how many records were adopted
   */
  async _adoptAllFromChain() {
    if (this._isDry()) return 0;
    const { provider, wallet } = this.getRuntime();
    const walletAddr = (wallet?.address || "").toLowerCase();

    const managers = new Set();
    const add = (m) => { if (m && typeof m === "string" && m.startsWith("0x")) managers.add(m); };
    for (const mk of (Array.isArray(this.markets) ? this.markets : [])) add(mk.managerAddr);
    for (const p of Object.values(this.deps?.confirmedPools || {})) add(p?.manager);
    if (!managers.size) return 0;

    const already = new Set(this._positions().map(p =>
      `${String(p?.managerAddr || "").toLowerCase()}:${String(p?.positionId)}`));

    const candidates = [];
    for (const mgrAddr of managers) {
      let ids = [];
      try {
        const c = new ethers.Contract(mgrAddr, MANAGER_ABI, provider);
        ids = (await c.getUserPositions(wallet.address)) || [];
      } catch { continue; }
      for (const pid of ids) {
        const key = `${mgrAddr.toLowerCase()}:${Number(pid)}`;
        if (already.has(key)) continue;
        const onChain = await readOnChainPosition(provider, mgrAddr, pid);
        if (!onChain || positionIsClosed(onChain)) continue;
        if (onChain.user && String(onChain.user).toLowerCase() !== walletAddr) continue;
        candidates.push({ mgrAddr, pid: Number(pid), onChain });
      }
    }
    if (!candidates.length) return 0;

    let adopted = 0;
    for (const cand of candidates) {
      const mk = (Array.isArray(this.markets) ? this.markets : [])
        .find(m => String(m.managerAddr || "").toLowerCase() === String(cand.mgrAddr).toLowerCase());
      const sym = mk?.marketSymbol || mk?.symbol
        || Object.entries(this.deps?.confirmedPools || {})
          .find(([, p]) => p?.manager?.toLowerCase() === cand.mgrAddr.toLowerCase())?.[0]
        || null;
      const rec = this._trackOpenedPosition({
        positionId: cand.pid,
        side: cand.onChain.isLong ? "LONG" : "SHORT",
        collateralToken: cand.onChain.collateralToken,
        collateralAmount: String(cand.onChain.collateralAmount),
        paymentToken: mk?.paymentToken || null,
        leverage: this.config.defaultLeverage,
        openedAt: Date.now(),
        txHash: null,
        marketSymbol: sym,
        managerAddr: cand.mgrAddr,
        poolAddr: mk?.poolAddr || null,
      }, { adopted: true });
      // HOLD WINDOW for an adopted record: openedAt is the adoption instant
      // (plausible epoch ms) — the hold starts here, ≤ maxHoldSeconds.
      rec.currentDebt = String(cand.onChain.currentDebt ?? cand.onChain.debtAmount ?? "0");
      rec.debtAmount = rec.currentDebt;
      saveState(this.state);
      adopted++;
      this.log(`[ADOPT] ON-CHAIN active position #${rec.positionId} ${rec.side}${sym ? ` ${sym}` : ""} manager=${short(cand.mgrAddr)} — ${this._activeCount()} position(s) now tracked`, "warn");
    }
    return adopted;
  }

  /**
   * Reconcile ALL local records with the chain and adopt any missing on-chain
   * positions. Called at startup (recovery) and before planning an OPEN.
   *
   * Rules (per record):
   *  • verified closed on-chain / not ours / no id → zombie cleared
   *    (countClose=false — the bot did not perform that close)
   *  • active on-chain                            → identity fields synced
   *  • unreadable                                 → KEPT (never clear on a
   *    failed read)
   */
  async _syncAllPositions() {
    const { provider } = this.getRuntime();
    const walletAddr = (this.deps?.accounts?.[this.deps.selectedWalletIndex]?.address || "").toLowerCase();

    for (const rec of [...this._positions()]) {
      if (rec?.pendingOpen) continue; // settlement owns pending records
      if (!rec || rec.positionId === null || rec.positionId === undefined) {
        this._clearPosition(rec, "no positionId", false);
        continue;
      }
      const resolved = this.resolveManagerForPosition(rec);
      let mgr = resolved?.managerAddr || rec.managerAddr || null;
      let onChain = mgr ? await readOnChainPosition(provider, mgr, rec.positionId) : null;

      if (!onChain) {
        // Missing/unreadable on the known manager — ask the chain which
        // manager (if any) still reports this id as active for this wallet.
        const found = await this._locateStoredPosition(rec);
        if (found.status === "active") {
          mgr = found.managerAddr;
          onChain = found.onChain;
          if (!this._isDry()) {
            rec.managerAddr = found.managerAddr;
            const mk = (Array.isArray(this.markets) ? this.markets : [])
              .find(m => String(m.managerAddr || "").toLowerCase() === String(found.managerAddr).toLowerCase());
            if (mk) {
              if (!rec.poolAddr) rec.poolAddr = mk.poolAddr;
              if (!rec.marketSymbol) rec.marketSymbol = mk.marketSymbol || mk.symbol;
            }
            saveState(this.state);
          }
          this.log(`[SYNC] #${rec.positionId} located on-chain on manager ${short(found.managerAddr)}`, "warn");
        } else if (found.status === "closed" || found.status === "missing" || found.status === "no-id") {
          this.log(`[SYNC] #${rec.positionId} not active on any known manager — clearing zombie record`, "warn");
          this._clearPosition(rec, "recovery: gone on-chain", false);
        } else {
          this.log(`[SYNC] #${rec.positionId} unreadable on-chain — keeping record (never clear on a failed read)`, "warn");
        }
        continue;
      }

      if (positionIsClosed(onChain)) {
        this.log(`[SYNC] #${rec.positionId} already inactive on-chain — clearing stale record`, "warn");
        this._clearPosition(rec, "recovery: gone on-chain", false);
        continue;
      }
      if (onChain.user && walletAddr && String(onChain.user).toLowerCase() !== walletAddr) {
        this.log(`[SYNC] #${rec.positionId} belongs to ${short(onChain.user)} on-chain, not this wallet — clearing`, "warn");
        this._clearPosition(rec, "recovery: not ours", false);
        continue;
      }
      this._syncActivePositionFromChain(rec, onChain, { managerAddr: mgr });
    }

    // Any on-chain position of this wallet that is not tracked yet must enter
    // the array too (it occupies a risk slot and must eventually be closed).
    await this._adoptAllFromChain();
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
   * Record a FAILED close attempt for ONE position and return the ms to wait
   * before its next attempt. A different on-chain signature (state actually
   * moved) resets the backoff. Backoff state lives on the record — one stuck
   * position's backoff never delays a sibling's close.
   */
  _noteCloseFailure(pos, sig, code) {
    const prev = (pos && typeof pos === "object" ? pos.closeRetry : null) || {};
    const attempts = (prev.sig && prev.sig === sig ? Number(prev.attempts || 0) : 0) + 1;
    const delay = this._closeBackoffMs(attempts);
    // DRY-RUN: report the backoff that WOULD be scheduled — never write it.
    if (this._isDry()) {
      this.log(`[DRY] would schedule close retry for #${pos?.positionId ?? "?"} in ${Math.ceil(delay / 1000)}s (code=${code || "?"}) — closeRetry/closeAttempts untouched`, "info");
      return delay;
    }
    const now = Date.now();
    if (pos && typeof pos === "object") {
      pos.closeRetry = { attempts, sig: sig || null, code: code || null, lastAttemptAt: now, nextAt: now + delay };
      pos.closeAttempts = (Number(pos.closeAttempts) || 0) + 1;
    }
    saveState(this.state);
    return delay;
  }

  /** Clear ONE position's close retry bookkeeping (position gone / attempt succeeded). */
  _resetCloseRetry(pos) {
    if (this._isDry()) return;
    if (pos && typeof pos === "object") {
      if (pos.closeRetry) pos.closeRetry = null;
      pos.closeAttempts = 0;
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  //  HOLD WINDOW — deferred auto-close (min..max hold after a confirmed open)
  // ═════════════════════════════════════════════════════════════════════════

  /**
   * Hold length in ms for a fresh open: uniform rand(min..max hold), clamped
   * so `max >= min`. `0` = hold disabled (both defaults are 0 → back-compat:
   * nothing changes for runs that never configured a hold).
   */
  _holdWindowMs() {
    let minS = Number(this.config.minHoldSeconds);
    let maxS = Number(this.config.maxHoldSeconds);
    if (!Number.isFinite(minS) || minS < 0) minS = 0;
    if (!Number.isFinite(maxS) || maxS < 0) maxS = 0;
    if (minS <= 0 && maxS <= 0) return 0;
    if (maxS < minS) maxS = minS; // clamp: max never below min
    const span = maxS - minS;
    const pickS = span > 0 ? minS + Math.random() * span : minS;
    return Math.round(pickS * 1000);
  }

  /**
   * True only for a plausible epoch-MILLISECONDS open timestamp. Seconds-era
   * values (e.g. legacy `openedAt`) and future clocks are never trusted — the
   * hold must never be invented from a time we cannot believe.
   */
  _isPlausibleOpenedAt(ts, now = Date.now()) {
    const t = Number(ts);
    if (!Number.isFinite(t) || t <= 0) return false;
    if (t < 1e12) return false;          // ≪ epoch-ms (seconds / blockNumber)
    if (t > now + 60_000) return false;  // in the future → clock skew, not an open time
    return true;
  }

  /**
   * Ensure `pos.holdUntil` (absolute epoch ms — restart-safe) exists.
   *
   *  • already set        → returned untouched (a persisted hold survives restarts)
   *  • hold disabled (0/0)→ 0, record untouched (back-compat: no new field)
   *  • dry-run            → 0, record untouched (dry runs never mutate state)
   *  • openedAt implausible→ holdUntil = 0 (closeable now — never invent time)
   *  • otherwise          → openedAt + rand(min..max hold), persisted
   *
   * @returns {number} holdUntil epoch ms; 0 = no hold (closeable now)
   */
  _ensureHoldScheduled(pos) {
    if (!pos || typeof pos !== "object") return 0;
    if (pos.holdUntil !== undefined && pos.holdUntil !== null && Number.isFinite(Number(pos.holdUntil))) {
      return Number(pos.holdUntil);
    }
    const windowMs = this._holdWindowMs();
    if (windowMs <= 0 || this._isDry()) return 0;
    const now = Date.now();
    const openedAt = Number(pos.openedAt);
    if (!this._isPlausibleOpenedAt(openedAt, now)) {
      pos.holdUntil = 0;
      saveState(this.state);
      this.log(`[HOLD] #${pos.positionId ?? "?"} open time unknown (openedAt=${pos.openedAt ?? "∅"}) — no hold, closeable now`, "warn");
      return 0;
    }
    pos.holdUntil = openedAt + windowMs;
    saveState(this.state);
    this.log(`[HOLD] #${pos.positionId ?? "?"} auto-close deferred until ${new Date(pos.holdUntil).toISOString()} (+${Math.round(windowMs / 1000)}s from open)`, "info");
    return pos.holdUntil;
  }

  /**
   * Emergency-risk probe — ONE throttled (15s) `getPositionRisk` read decides
   * whether the hold must be ignored right now.
   *
   * Any read failure KEEPS the hold (never close on unknown risk) and is
   * throttled with the same cache so a dead RPC cannot be hammered every cycle.
   *
   * @returns {Promise<boolean>} true → close now despite the hold
   */
  async _emergencyCloseDue({ provider, managerAddr, positionId }) {
    if (!this.config.emergencyCloseEnabled) return false;
    const now = Date.now();
    const key = `${String(managerAddr || "").toLowerCase()}:${String(positionId)}`;
    const cached = this._holdProbe;
    if (cached && cached.key === key && (now - cached.at) < 15_000) return cached.due;

    let threshold = Number(this.config.emergencyCloseHealthBps);
    if (!Number.isFinite(threshold)) threshold = 10500;
    let due = false;
    try {
      const mgr = new ethers.Contract(managerAddr, MANAGER_ABI, provider);
      const risk = await mgr.getPositionRisk(BigInt(positionId));
      const healthBps = Number(risk.healthBps);
      due = !!risk.liquidatable || (Number.isFinite(healthBps) && healthBps <= threshold);
      this.log(`[HOLD] risk probe #${positionId}: healthBps=${risk.healthBps} liquidatable=${!!risk.liquidatable} threshold=${threshold} → ${due ? "EMERGENCY CLOSE DUE" : "hold stands"}`, due ? "error" : "info");
    } catch (e) {
      due = false;
      this.log(`[HOLD] risk probe #${positionId} failed (${revertSelector(e) || String(e?.message || e).slice(0, 40)}) — hold stands`, "warn");
    }
    this._holdProbe = { key, at: now, due };
    return due;
  }

  /**
   * maxTradesPerRun gate — true when THIS run may not open any new position.
   * Counts confirmed OPENs of THIS process whose records are still tracked
   * (pending/dry/adoption never increment; a verified close of a record this
   * process opened returns its slot — see _clearPosition). The cap therefore
   * bounds opens running AHEAD of closes; a continuous loop keeps working
   * after each open→close round-trip instead of going OPEN-dead forever.
   */
  _tradeCapReached() {
    const max = Number(this.config.maxTradesPerRun || 0);
    return max > 0 && this._opensThisRun >= max;
  }

  // ═════════════════════════════════════════════════════════════════════════
  //  CONTINUOUS TRADING CYCLE — OPEN → swapsPerPosition SWAPs → CLOSE → next
  //
  //  State machine (persisted in state.continuousCycle, resumes on restart):
  //    HOLDING            position open, counting balance-verified SWAPs
  //    READY_TO_CLOSE     quota met — close on the next hold-gate pass
  //    SWAP_QUOTA_EXHAUSTED attempt/stall budget spent under quota — close anyway
  //    DONE               verified close — the next STEP 3 OPEN starts a new cycle
  //  Only CONFIRMED swaps whose ERC20 balance deltas passed verification count
  //  (status=1 alone never does — they arrive from runSwapMaintenanceCycle
  //  results with status:"ok"). state.continuousHalt is the sticky safe-stop
  //  tripped after swap.maxConsecutiveFailures consecutive failed cycles.
  // ═════════════════════════════════════════════════════════════════════════

  _continuousEnabled() { return this.config.continuousTradingEnabled === true; }
  _cycleQuota() { return Math.max(1, Number(this.config.swapsPerPosition) || 10); }
  _cycleAttemptCap() { return Math.max(1, Number(this.config.maxSwapAttemptsPerCycle) || 40); }
  /** Consecutive-failure halt threshold — the ALREADY-AGREED swap.maxConsecutiveFailures (no duplicate key). */
  _cycleHaltThreshold() {
    try { return normalizeSwapConfig(this.config).maxConsecutiveFailures; } catch { return 3; }
  }
  _getCycle() { return this.state.continuousCycle || null; }
  _putCycle(c) { this.state.continuousCycle = c; this._save(); }
  _haltInfo() { return this.state.continuousHalt || null; }

  _newCycle(rec) {
    const seq = Number(this.state.continuousSeq || 0) + 1;
    this.state.continuousSeq = seq;
    return {
      cycleId: seq,
      startedAt: Date.now(),
      lastProgressAt: Date.now(),
      positionId: rec?.positionId ?? null,
      openTxHash: rec?.txHash || null,
      side: rec?.side || null,
      marketSymbol: rec?.marketSymbol || null,
      managerAddr: rec?.managerAddr || null,
      poolAddr: rec?.poolAddr || null,
      swapsTarget: this._cycleQuota(),
      confirmedSwaps: [],
      attempts: 0,
      status: "HOLDING",
      errors: [],
    };
  }

  /** A confirmed OPEN bound a fresh cycle (continuous mode only). */
  _onPositionOpened(rec) {
    if (!this._continuousEnabled() || this._isDry()) return;
    this._clearOpenRetry(); // a confirmed OPEN ends any failed-open retry window
    if (this._haltInfo()) return;
    const cyc = this._getCycle();
    if (cyc && cyc.status !== "DONE" && cyc.positionId != null) {
      if (String(cyc.positionId) === String(rec?.positionId ?? "")) return; // already bound
      this.log(`[CONTINUOUS] cycle #${cyc.cycleId} already bound to #${cyc.positionId} — position #${rec?.positionId ?? "?"} not re-bound`, "warn");
      return;
    }
    const c = this._newCycle(rec);
    this._putCycle(c);
    this.log(`[CONTINUOUS] cycle #${c.cycleId} START — ${c.side} ${c.marketSymbol} position #${c.positionId} — target ${c.swapsTarget} verified SWAPs, then CLOSE`, "warn");
  }

  /**
   * A tracked record was removed — the matching cycle completes. Runs for BOTH
   * verified closes (countClose=true → completion counted, failures reset when
   * the quota was met) and recovery/zombie clears (countClose=false → the cycle
   * is closed out but never counted, so a restart cannot fake a success).
   */
  _onPositionClosed(rec, countClose = true) {
    const cyc = this._getCycle();
    if (!cyc || cyc.status === "DONE") return;
    if (rec && cyc.positionId != null && String(cyc.positionId) !== String(rec?.positionId)) return;
    const confirmed = (cyc.confirmedSwaps || []).length;
    const met = confirmed >= cyc.swapsTarget;
    cyc.status = "DONE";
    cyc.closedAt = Date.now();
    if (countClose) this._tradingCyclesDone++;
    if (countClose && met) {
      this.state.continuousFailures = 0;
      // SUCCESSFUL CYCLE — reset the failed-attempt gas budget so a later
      // failure streak gets a fresh allowance.
      delete this.state.failedGasCostWei;
      this.log(`[CONTINUOUS] cycle #${cyc.cycleId} COMPLETE — ${confirmed}/${cyc.swapsTarget} verified SWAPs, position #${cyc.positionId} closed, cyclesDone=${this._tradingCyclesDone}`, "success");
      this.log(`[NEXT_CYCLE] cycle #${cyc.cycleId + 1} will start on the next loop pass — failed-attempt gas budget reset`, "info");
    } else if (countClose) {
      this.log(`[CONTINUOUS] cycle #${cyc.cycleId} ENDED under quota — ${confirmed}/${cyc.swapsTarget} verified SWAPs before close, cyclesDone=${this._tradingCyclesDone}`, "warn");
      this._noteCycleFailure("CLOSED_UNDER_QUOTA", `confirmed=${confirmed}/${cyc.swapsTarget}`);
      this.log(`[NEXT_CYCLE] cycle #${cyc.cycleId + 1} will start on the next loop pass`, "info");
    } else {
      this.log(`[CONTINUOUS] cycle #${cyc.cycleId} closed out without a verified close (record removed: ${rec?.positionId ?? "?"}) — restart resumes from a fresh OPEN`, "warn");
      this.log(`[NEXT_CYCLE] cycle #${cyc.cycleId + 1} will start on the next loop pass`, "info");
    }
    this._save();
  }

  _noteCycleFailure(kind, detail = "") {
    this.state.continuousFailures = Number(this.state.continuousFailures || 0) + 1;
    const thr = this._cycleHaltThreshold();
    this.log(`[CONTINUOUS] cycle failure ${this.state.continuousFailures}/${thr} (${kind}${detail ? `: ${detail}` : ""})`, "warn");
    if (this.state.continuousFailures >= thr && !this._haltInfo()) {
      this.state.continuousHalt = {
        reason: kind, failures: this.state.continuousFailures,
        since: Date.now(), detail: String(detail).slice(0, 200),
      };
      this.log(`[CONTINUOUS] TRADING HALTED after ${this.state.continuousFailures} consecutive cycle failures (${kind}) — no new OPEN; position closes keep being retried; restart with --reset-halt after review`, "error");
    }
    this._save();
  }

  _clearContinuousHalt() {
    if (!this.state.continuousHalt) return false;
    const was = this.state.continuousHalt;
    delete this.state.continuousHalt;
    this.state.continuousFailures = 0;
    this._save();
    this.log(`[CONTINUOUS] halt cleared by operator (was: ${was.reason} @ ${new Date(was.since || Date.now()).toISOString()}) — OPEN allowed again`, "warn");
    return true;
  }

  // ═════════════════════════════════════════════════════════════════════════
  //  CONTINUOUS RETRY CONTROLS — a failed OPEN/CLOSE never stops trading
  // ═════════════════════════════════════════════════════════════════════════

  /** Config: delay before retrying a failed OPEN (ms). */
  _openRetryIntervalMs() {
    const v = Number(this.config.openRetryIntervalMs);
    return Number.isFinite(v) && v > 0 ? v : 60_000;
  }

  /** Config: cumulative failed-attempt gas budget (wei). 0n = unlimited. */
  _failedAttemptBudgetWei() {
    const v = this.config.maxFailedAttemptCostWei;
    if (v === 0 || v === "0" || v === "0n") return 0n;
    try { return BigInt(v ?? "50000000000000000"); } catch { return 50000000000000000n; }
  }

  /**
   * Record the gas cost of ONE reverted tx (hooked via TxManager.onReverted).
   * Accumulates state.failedGasCostWei; warns once the budget is reached.
   */
  _noteFailedTxCost(receipt, txType = "?") {
    try {
      const gasUsed = BigInt(receipt?.gasUsed ?? 0);
      const price = BigInt(receipt?.effectiveGasPrice ?? receipt?.gasPrice ?? 0);
      const cost = gasUsed * price;
      if (cost <= 0n) return;
      const prev = BigInt(this.state.failedGasCostWei || "0");
      const next = prev + cost;
      this.state.failedGasCostWei = String(next);
      const budget = this._failedAttemptBudgetWei();
      if (budget > 0n && next >= budget) {
        this.log(`[BUDGET] failed-attempt gas cost ${ethers.formatEther(next)} ETH reached the cap ${ethers.formatEther(budget)} ETH (${txType} reverted) — swap-quota attempts pause; closes keep retrying; budget resets after the next successful cycle`, "error");
      }
      this._save();
    } catch { /* budget tracking must never break a tx path */ }
  }

  /** True when the failed-attempt gas budget is exhausted (cycle swaps pause). */
  _failedAttemptBudgetExceeded() {
    const budget = this._failedAttemptBudgetWei();
    if (budget <= 0n) return false;
    try { return BigInt(this.state.failedGasCostWei || "0") >= budget; } catch { return false; }
  }

  /**
   * A failed OPEN — rate-limits the next attempt (openRetryIntervalMs) and
   * logs OPEN_RETRY. NEVER trips the cycle halt: a failed OPEN must not stop
   * trading — the loop keeps SWAPing and retries OPEN later on a suitable
   * market (requirement: record the reason, do not hang or halt).
   */
  _noteOpenFailure(side, reason = "") {
    if (this._isDry()) return;
    const now = Date.now();
    this.state.openRetryAt = now + this._openRetryIntervalMs();
    this.state.openRetryReason = String(reason || "").slice(0, 120);
    this.state.openRetrySide = side || null;
    this.state.openFailures = Number(this.state.openFailures || 0) + 1;
    this.log(`[OPEN_RETRY] OPEN ${side || "?"} failed (${reason || "unknown"}) — retrying in ${Math.round(this._openRetryIntervalMs() / 1000)}s; SWAP engine continues meanwhile (failures=${this.state.openFailures})`, "warn");
    this._save();
  }

  /** Future timestamp (ms) while a failed OPEN's rate-limit is active, else 0. */
  _openRetryPending() {
    const at = Number(this.state.openRetryAt || 0);
    return at > Date.now() ? at : 0;
  }

  /** Clear the OPEN retry rate-limit (a submitted/confirmed OPEN resets it). */
  _clearOpenRetry() {
    if (!this.state.openRetryAt && !this.state.openFailures) return;
    delete this.state.openRetryAt;
    delete this.state.openRetryReason;
    delete this.state.openRetrySide;
    this.state.openFailures = 0;
    this._save();
  }

  /** Pool addresses (lowercased) of every tracked position — never swapped through. */
  _protectedPools() {
    const set = new Set();
    for (const p of this._positions()) {
      const a = p?.poolAddr;
      if (a) set.add(String(a).toLowerCase());
    }
    return set;
  }

  /**
   * Drop any direction whose route pool (pool or pool2) is a tracked
   * position's own pool — a swap through it could drain the exit liquidity
   * the position needs to close (requirement: pause the DANGEROUS operations,
   * keep the safe ones).
   */
  _filterProtectedDirections(directions, protectedPools) {
    if (!protectedPools || !protectedPools.size) return directions;
    const prot = protectedPools instanceof Set ? protectedPools : new Set(protectedPools);
    return directions.filter(d => {
      const p1 = d?.pool ? String(d.pool).toLowerCase() : null;
      const p2 = d?.pool2 ? String(d.pool2).toLowerCase() : null;
      return !(p1 && prot.has(p1)) && !(p2 && prot.has(p2));
    });
  }

  /** Verified SWAPs still missing from the current cycle's quota. */
  _cycleSwapRemaining() {
    const c = this._getCycle();
    if (!c || c.status !== "HOLDING") return 0;
    return Math.max(0, (c.swapsTarget || this._cycleQuota()) - (c.confirmedSwaps || []).length);
  }

  /**
   * Ingest ONE runSwapMaintenanceCycle summary into the active cycle.
   * Counts ONLY `status:"ok"` results (balance-delta-verified swaps) toward the
   * quota — `fail` results count as ATTEMPTS (budget), skips count as neither.
   * Duplicate tx hashes are never counted twice (restart + re-ingest safe).
   */
  _ingestSwapSummary(summary) {
    if (!this._continuousEnabled() || !summary) return;
    const cyc = this._getCycle();
    if (!cyc || cyc.status !== "HOLDING") return; // quota counting only while HOLDING — READY_TO_CLOSE / DONE maintenance swaps are not cycle swaps
    for (const r of (summary.results || [])) {
      if (r?.status === "ok" && r.txHash) {
        cyc.attempts = Number(cyc.attempts || 0) + 1;
        cyc.lastProgressAt = Date.now();
        const h = String(r.txHash).toLowerCase();
        cyc.confirmedSwaps = cyc.confirmedSwaps || [];
        if (!cyc.confirmedSwaps.some(s => String(s.txHash).toLowerCase() === h)) {
          cyc.confirmedSwaps.push({
            txHash: r.txHash, direction: r.direction || null,
            inDelta: r.inDelta ?? null, outDelta: r.outDelta ?? null,
            blockNumber: r.blockNumber ?? null, ts: Date.now(),
          });
          this.log(`[SWAP_SUCCESS] cycle #${cyc.cycleId} ${cyc.confirmedSwaps.length}/${cyc.swapsTarget} verified — tx=${r.txHash} ${r.direction || ""}`, "success");
        }
      } else if (r?.status === "fail") {
        cyc.attempts = Number(cyc.attempts || 0) + 1;
        cyc.lastProgressAt = Date.now();
        cyc.errors = cyc.errors || [];
        cyc.errors.push({ code: r.code || "FAIL", direction: r.direction || null, ts: Date.now() });
        if (cyc.errors.length > 20) cyc.errors.splice(0, cyc.errors.length - 20);
        this.log(`[SWAP_FAILED] cycle #${cyc.cycleId} ${r.direction || "?"} code=${r.code || "FAIL"} — not counted toward quota (attempts=${cyc.attempts}/${this._cycleAttemptCap()})`, "warn");
      }
    }
    if (cyc.status === "HOLDING") {
      if ((cyc.confirmedSwaps || []).length >= cyc.swapsTarget) {
        cyc.status = "READY_TO_CLOSE";
        this.log(`[CYCLE] #${cyc.cycleId} swap quota met (${cyc.confirmedSwaps.length}/${cyc.swapsTarget}) — position #${cyc.positionId} will close on the next hold-gate pass`, "warn");
      } else if (Number(cyc.attempts || 0) >= this._cycleAttemptCap()) {
        cyc.status = "SWAP_QUOTA_EXHAUSTED";
        this.log(`[CYCLE] #${cyc.cycleId} attempt cap reached (${cyc.attempts}/${this._cycleAttemptCap()}) with only ${cyc.confirmedSwaps?.length || 0}/${cyc.swapsTarget} verified — closing position; no new OPEN until it is closed`, "error");
        this._noteCycleFailure("SWAP_QUOTA_EXHAUSTED", `attempts=${cyc.attempts} verified=${cyc.confirmedSwaps?.length || 0}`);
      }
    }
    this._save();
  }

  /** No swap progress for too long under quota → close instead of holding forever. */
  _checkCycleStall() {
    if (!this._continuousEnabled()) return;
    const c = this._getCycle();
    if (!c || c.status !== "HOLDING") return;
    const last = c.lastProgressAt || c.startedAt || 0;
    const stallMs = Math.max(600_000, this._cycleAttemptCap() * 15_000);
    if (Date.now() - last > stallMs) {
      c.status = "SWAP_QUOTA_EXHAUSTED";
      this.log(`[CYCLE] #${c.cycleId} STALLED — no verified SWAP progress for ${Math.round((Date.now() - last) / 60000)}m (${c.confirmedSwaps?.length || 0}/${c.swapsTarget}) — closing position`, "error");
      this._noteCycleFailure("CYCLE_STALLED", `verified=${c.confirmedSwaps?.length || 0}/${c.swapsTarget}`);
      this._save();
    }
  }

  /**
   * Swap-phase options for start(): quota-limited while the cycle counts
   * SWAPs, fully skipped once the quota is met (never overshoot), plain
   * maintenance when no cycle is live or the mode is off.
   */
  _swapRunOpts(phase) {
    if (!this._continuousEnabled()) return { phase };
    const protectedPools = [...this._protectedPools()];
    // FAILED-ATTEMPT BUDGET — once reverted txs burn the configured gas cap,
    // ALL swap attempts pause (quota + maintenance); closes keep retrying.
    if (this._failedAttemptBudgetExceeded()) {
      if (!this._budgetSwapPauseLogged) {
        this._budgetSwapPauseLogged = true;
        this.log(`[BUDGET] failed-attempt gas budget exhausted (${ethers.formatEther(this.state.failedGasCostWei || "0")} ETH) — all swap attempts paused; closes keep retrying; budget resets after the next successful cycle`, "error");
      }
      return null;
    }
    const c = this._getCycle();
    if (!c || c.status === "DONE") return { phase, protectedPools }; // between cycles: safe maintenance only
    if (c.status !== "HOLDING") {
      // READY_TO_CLOSE / EXHAUSTED — quota swaps are over, but SAFE maintenance
      // continues (filtered by protected pools) while close keeps retrying.
      return { phase, protectedPools };
    }
    const rem = this._cycleSwapRemaining();
    return rem > 0 ? { phase, maxSwaps: rem, protectedPools } : { phase, protectedPools };
  }

  /**
   * start() STEP 1 guard: in continuous mode a HOLDING cycle position is never
   * closed before its swap quota is met — UNLESS the on-chain emergency probe
   * says risk is imminent (the hold machinery's own override, preserved).
   */
  async _continuousBlocksClose(rec) {
    if (!this._continuousEnabled() || !rec) return false;
    const c = this._getCycle();
    if (!c || c.status !== "HOLDING" || c.positionId == null) return false;
    if (String(c.positionId) !== String(rec?.positionId)) return false;
    if ((c.confirmedSwaps || []).length >= c.swapsTarget) return false;
    try {
      const { provider } = this.getRuntime();
      if (await this._emergencyCloseDue({ provider, managerAddr: rec.managerAddr, positionId: rec.positionId })) return false;
    } catch { return false; } // probe failure → keep the quota guard (hold-like semantics)
    return true;
  }

  /**
   * Restart recovery — resume the persisted cycle from state + chain.
   * Recorded swap txs must still exist with receipt.status=1 or they are
   * dropped from the quota (never re-run, never double-counted).
   */
  async _recoverContinuousCycle() {
    // MIGRATION — OPEN_FAILED no longer trips the halt (failed OPENs are now
    // rate-limited retries, not safe-stops). Auto-clear a stale halt from an
    // older build so the bot resumes instead of waiting for --reset-halt.
    const staleHalt = this.state.continuousHalt;
    if (staleHalt && staleHalt.reason === "OPEN_FAILED") {
      this.log(`[CONTINUOUS] clearing stale halt (reason=OPEN_FAILED) — failed OPENs are now rate-limited retries, not safe-stops`, "warn");
      this._clearContinuousHalt();
    }
    const cyc = this._getCycle();
    if (!cyc || cyc.status === "DONE") return;
    const rec = this._findPosition(cyc.positionId);
    if (!rec) {
      cyc.status = "DONE";
      cyc.note = "position not tracked after on-chain recovery";
      this.log(`[CONTINUOUS] cycle #${cyc.cycleId}: position #${cyc.positionId} is not active after on-chain recovery — cycle closed; next OPEN starts fresh`, "warn");
      this._save();
      return;
    }
    const { provider } = this.getRuntime();
    const kept = [];
    for (const s of (cyc.confirmedSwaps || [])) {
      let okSwap = false;
      try {
        const rc = await provider.getTransactionReceipt(s.txHash);
        okSwap = !!(rc && Number(rc.status) === 1);
      } catch { okSwap = false; }
      if (okSwap) kept.push(s);
      else this.log(`[CONTINUOUS] cycle #${cyc.cycleId}: recorded SWAP ${s.txHash} not verified on restart — dropped from the quota (never re-sent)`, "warn");
    }
    cyc.confirmedSwaps = kept;
    if (cyc.status === "HOLDING" && kept.length >= cyc.swapsTarget) cyc.status = "READY_TO_CLOSE";
    this.log(`[CONTINUOUS] cycle #${cyc.cycleId} RESUMED — ${cyc.side} ${cyc.marketSymbol} position #${cyc.positionId}, verified SWAPs ${kept.length}/${cyc.swapsTarget}, status=${cyc.status}`, "warn");
    this._save();
  }

  /** Per-symbol whole-token floor for the pre-OPEN exit-viability probe. */
  _exitReserveNeedWhole(sym) {
    const cfgMap = this.config.minExitReserveWhole;
    if (typeof cfgMap === "number" && Number.isFinite(cfgMap)) return cfgMap;
    if (cfgMap && typeof cfgMap === "object" && Number.isFinite(Number(cfgMap[sym]))) return Number(cfgMap[sym]);
    const def = { USDT: 200, USDC: 200, DAI: 200, WETH: 0.05, ETH: 0.05, LINK: 50, UNI: 50, NEMESIS: 50 };
    return def[sym] ?? 50;
  }

  /**
   * Pre-OPEN exit-viability probe (read-only): BOTH pool legs must hold at
   * least their whole-token floor, so a position is never opened where the
   * pool cannot absorb a future close (the NEMESIS thin-pool trap). Pure
   * evaluation is split out for tests.
   */
  _evaluateExitReserves({ reserve0, reserve1, token0, token1, collateralToken, paymentToken, dec0, dec1, collSym, paySym }) {
    const need0 = this._exitReserveNeedWhole(collSym);
    const need1 = this._exitReserveNeedWhole(paySym);
    const whole0 = Number(ethers.formatUnits(BigInt(reserve0), Number(dec0)));
    const whole1 = Number(ethers.formatUnits(BigInt(reserve1), Number(dec1)));
    const legs = [
      { token: token0, whole: whole0, need: need0, sym: collSym },
      { token: token1, whole: whole1, need: need1, sym: paySym },
    ];
    for (const leg of legs) {
      if (!(leg.whole >= leg.need)) {
        return { ok: false, code: "EXIT_NOT_FEASIBLE", reason: `pool ${leg.sym} reserve ${leg.whole} < required ${leg.need} whole units — a close could not be absorbed` };
      }
    }
    return { ok: true, whole0, whole1 };
  }

  async _probeMarketExitFeasible(market, ctx) {
    try {
      const pool = ctx?.poolAddr || market?.poolAddr || null;
      if (!pool) return { ok: false, code: "EXIT_PROBE_FAILED", reason: "no pool address for exit probe" };
      const { provider } = this.getRuntime();
      const pc = new ethers.Contract(pool, POOL_ABI, provider);
      const [reserves, t0] = await Promise.all([pc.getReserves(), pc.token0()]);
      const token0 = String(t0);
      const ctxLegs = [ctx?.token0, ctx?.token1].filter(Boolean).map(a => String(a));
      const token1 = ctxLegs.find(a => a.toLowerCase() !== token0.toLowerCase()) || null;
      if (!token1) return { ok: false, code: "EXIT_PROBE_FAILED", reason: "cannot resolve pool token1 for exit probe" };
      const meta = (addr) => {
        const hit = (this.tokenList || []).find(t => String(t.address).toLowerCase() === String(addr).toLowerCase());
        return hit || null;
      };
      const collAddr = String(ctx?.collateralToken || market?.collateralToken || "");
      const payAddr = String(ctx?.paymentToken || market?.paymentToken || "");
      const isColl0 = token0.toLowerCase() === collAddr.toLowerCase();
      const dec0 = ctx?.collateralDecimals ?? meta(token0)?.decimals ?? null;
      const dec1 = meta(token1)?.decimals ?? null;
      if (dec0 === null || dec1 === null || dec0 === undefined || dec1 === undefined) {
        return { ok: false, code: "EXIT_PROBE_FAILED", reason: "token decimals unreadable for exit probe" };
      }
      const collSym = ctx?.collateralSym || meta(collAddr)?.symbol || "?";
      const paySym = meta(payAddr)?.symbol || "?";
      const reserve0 = BigInt(reserves[0]);
      const reserve1 = BigInt(reserves[1]);
      // Map so legs[0] is always the COLLATERAL token side.
      const ev = isColl0
        ? this._evaluateExitReserves({ reserve0, reserve1, token0, token1, collateralToken: collAddr, paymentToken: payAddr, dec0, dec1, collSym, paySym })
        : this._evaluateExitReserves({ reserve0: reserve1, reserve1: reserve0, token0: token1, token1: token0, collateralToken: collAddr, paymentToken: payAddr, dec0: dec1, dec1: dec0, collSym, paySym });
      return ev;
    } catch (e) {
      return { ok: false, code: "EXIT_PROBE_FAILED", reason: `exit probe failed: ${String(e?.message || e).slice(0, 60)}` };
    }
  }

  /**
   * HOLD GATE — evaluated from `closeActivePosition` AFTER on-chain truth and
   * BEFORE the backoff/attempt, so every automatic close path (runCycle PHASE 1,
   * start() STEP 1) inherits it. Operator single-action closes bypass it.
   *
   * A held close is NOT a failure: no backoff is scheduled, no retry counter
   * moves — the cycle simply continues with THIS record kept (sibling
   * positions and the OPEN phase are unaffected).
   *
   * @returns {Promise<null|{ok:false, blocked:boolean, continueCycle:boolean,
   *                         code:"HOLD_UNTIL", holdUntil:number}>}
   *   null → the close may proceed; object → return it from closeActivePosition.
   */
  async _evaluateHoldGate(pos, { provider, managerAddr, positionId }) {
    if (!pos) return null;
    const holdUntil = this._ensureHoldScheduled(pos);
    const now = Date.now();
    if (!(holdUntil > now)) return null;
    if (await this._emergencyCloseDue({ provider, managerAddr, positionId })) {
      this.log(`[HOLD] EMERGENCY override — position #${positionId} at on-chain risk; ignoring the remaining ${Math.ceil((holdUntil - now) / 1000)}s of hold`, "error");
      return null;
    }
    const remainS = Math.ceil((holdUntil - now) / 1000);
    this.log(`[HOLD] position #${positionId} inside hold window — auto-close deferred ${remainS}s (until ${new Date(holdUntil).toISOString()}); OPEN stays skipped`, "info");
    return { ok: false, blocked: false, continueCycle: true, code: "HOLD_UNTIL", holdUntil };
  }

  // ═════════════════════════════════════════════════════════════════════════
  //  SIDE SELECTION — configured ratio, NEVER a disabled side
  // ═════════════════════════════════════════════════════════════════════════

  /**
   * Pick the side for the next OPEN. Fallback chain:
   *   1) RSI hint (only when that side is enabled)
   *   2) configured ratio longPercent/shortPercent (weights both 0 → below)
   *   3) rotation-planned side → 4) alternation
   * With one side disabled that side wins unconditionally; with BOTH disabled
   * there is no legal side → null (the caller skips the OPEN with a reason).
   *
   * @param {string|null} hint    RSI signal ("LONG"/"SHORT")
   * @param {string|null} planned rotation-planned side (market planning stays
   *        rotation-driven either way — only SIDE is decided here)
   * @returns {"LONG"|"SHORT"|null}
   */
  _pickOpenSide(hint = null, planned = null) {
    const enabled = [];
    if (this.config.enableLong !== false) enabled.push("LONG");
    if (this.config.enableShort !== false) enabled.push("SHORT");
    if (!enabled.length) return null;
    if (enabled.length === 1) return enabled[0];
    const legal = (s) => (s === "LONG" || s === "SHORT") ? s : null;

    const hinted = legal(hint);
    if (hinted) return hinted;

    let lw = Number(this.config.longPercent);
    let sw = Number(this.config.shortPercent);
    if (!Number.isFinite(lw) || lw < 0) lw = 0;
    if (!Number.isFinite(sw) || sw < 0) sw = 0;
    if (lw > 0 || sw > 0) {
      const r = Math.random() * (lw + sw);
      return r < lw ? "LONG" : "SHORT";
    }
    return legal(planned) || this.nextSide();
  }

  /**
   * Remove ONE tracked position record — READ-ONLY in dry-run.
   *
   * Every record removal in this class goes through here, so a dry run can
   * only ever LOG the clearing it would do. Removing a record frees its
   * per-market slot and its share of the global cap.
   *
   * @param {object|null} pos  the record to remove
   * @param {string} reason    why it is being cleared (for the DRY log)
   * @param {boolean} countClose  bump `sessionStats.closes` (a real close does)
   * @returns {boolean} true when the record was actually removed
   */
  _clearPosition(pos, reason, countClose = true) {
    const id = pos?.positionId ?? "?";
    if (this._isDry()) {
      this.log(`[DRY] Would CLEAR position #${id} (${reason}) — activePositions/sessionStats untouched`, "info");
      return false;
    }
    const arr = this._positions();
    const idx = arr.indexOf(pos);
    if (idx >= 0) arr.splice(idx, 1);
    else {
      // Same id, different object identity (defensive) — remove by id.
      const byId = arr.findIndex(p => String(p?.positionId) === String(id));
      if (byId >= 0) arr.splice(byId, 1);
    }
    if (countClose) this.state.sessionStats.closes++;
    // TRADE-CAP SLOT RETURN — a confirmed open by THIS process consumed one
    // maxTradesPerRun slot; when its record is finally removed (verified close
    // or zombie) that slot is returned, so a continuous run may open again
    // after the round-trip. Records that never consumed a slot (adopted
    // from chain, pending/reverted opens, positions from a previous process)
    // are not in the WeakSet and never free one — the cap still bounds how
    // many opens may run AHEAD of closes. Floor at 0 across restarts.
    if (countClose && this._capConsumers?.delete(pos)) {
      this._opensThisRun = Math.max(0, this._opensThisRun - 1);
    }
    this._onPositionClosed?.(pos, countClose); // continuous cycle completes here (no-op when off)
    this._resetCloseRetry(pos);
    saveState(this.state);
    return true;
  }

  /**
   * Reconcile ONE local position record with an authoritative on-chain
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
   *  • NEVER removes the record — removal remains exclusive to
   *    `_clearPosition` (verified close or zombie), so an on-chain-confirmed
   *    active position can never be forgotten.
   *  • DRY-RUN: logs the divergence but writes nothing.
   *
   * @param {object} pos      the tracked record to reconcile
   * @param {object} onChain  {collateralAmount, currentDebt, debtAmount, isLong, active}
   * @param {object} [opts]   {managerAddr}
   * @returns {{synced:boolean, changed:string[]}}
   */
  _syncActivePositionFromChain(pos, onChain, { managerAddr = null } = {}) {
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
      // onChain.currentDebt = getPositionDebt() (real, index-adjusted) — never
      // the borrowIndex (the pre-fix mapping poisoned debtAmount with 1.0003e18).
      plan("debtAmount", String(onChain.currentDebt));
      plan("currentDebt", String(onChain.currentDebt));
    }
    if (onChain.debtAmount !== undefined && onChain.debtAmount !== null) {
      plan("storedDebt", String(onChain.debtAmount));
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
   * Settle EVERY still-PENDING open transaction in the array.
   */
  async _settleAllPendingOpens() {
    for (const rec of [...this._positions()]) {
      if (rec?.pendingOpen) await this._settlePendingOpen(rec);
    }
  }

  /**
   * Settle ONE still-PENDING open transaction.
   *
   * An open only becomes an OPEN when a receipt proves it: `sessionStats.opens`,
   * `lastSide`, the direction-success counters and `[OPEN] … SUCCESS` are all
   * withheld until then. Before this method existed a timeout on the receipt
   * read produced `{pending:true, positionId:null}`, which the cycle then
   * recorded as a successful open — a success the chain (and nemesis.trade)
   * never saw.
   *
   * @param {object} pos the pending record to settle
   * @returns {Promise<{status:string, done:boolean}>}
   *   `done` — the record no longer needs another settlement pass.
   */
  async _settlePendingOpen(pos) {
    if (!pos?.pendingOpen) return { status: "none", done: true };
    if (this._isDry()) return { status: "none", done: true };

    const hash = pos.txHash || null;
    if (!hash) {
      this.log(`[OPEN] pending open record #${pos.positionId ?? "?"} has no txHash — clearing`, "warn");
      this._clearPosition(pos, "pending open without txHash", false);
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
        this._clearPosition(pos, "pending open dropped/replaced", false);
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
      this._clearPosition(pos, "pending open reverted", false);
      return { status: TX_STATE.REVERTED, done: true };
    }

    // CONFIRMED — but only the open events identify WHAT opened.
    const positionId = extractPositionIdFromLogs(receipt.logs || [], pos.managerAddr || null);
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
    // HOLD WINDOW starts from the CONFIRMED open (openedAt = submission time,
    // well within the window) — a restart between submit and receipt still
    // derives the same hold because the clock input is persisted.
    this._ensureHoldScheduled(pos);
    this.state.lastSide = pos.side;
    this.state.sessionStats.opens++;
    this._opensThisRun++;
    this._capConsumers?.add(pos);
    this._onPositionOpened?.(pos); // continuous cycle binds here (no-op when off)
    saveState(this.state);
    this.log(`[OPEN] CONFIRMED tx=${hash} block=${receipt.blockNumber} — position #${positionId} (${pos.side} ${pos.marketSymbol || "?"}); sessionStats.opens=${this.state.sessionStats.opens}`, "success");
    return { status: TX_STATE.CONFIRMED, done: true };
  }

  /**
   * Apply a closePositionFn() result to ONE tracked record.
   *
   * The record is removed ONLY when the position is provably gone:
   * a zombie (MAM_InvalidPosition) or an on-chain verified close.
   * Every other outcome — dry run, pending TX, liquidity-blocked partial close,
   * unreadable verification — KEEPS the record and schedules ITS OWN backoff, so
   * the bot can never orphan an open one and can never spin on an identical
   * failing close. A DRY RUN never mutates anything at all (see `_clearPosition`).
   *
   * @param {object|null} pos         the tracked record this result belongs to
   * @param {object|null} closeResult outcome from closePositionFn()
   * @param {string|null} sig on-chain signature captured before the attempt
   * @returns {{ok:boolean, blocked:boolean, continueCycle:boolean, code:string|null, dryRun?:boolean}}
   *   `ok`          — the position is (or would be) gone.
   *   `dryRun`      — true when the close was only PLANNED: `ok` is true but the
   *                   record was deliberately kept.
   *   `blocked`     — the position was KEPT and nothing is in flight: the close
   *                   cannot happen right now (liquidity / preflight / still
   *                   active) but the cycle must keep going.
   *   `continueCycle` — ALWAYS true. A failed close never ends the runCycle; it
   *                   only affects THIS position.
   */
  _applyCloseResult(pos, closeResult, sig = null) {
    const CONTINUE = true;
    const id = pos?.positionId ?? "?";
    this.lastCloseTxHash = closeResult?.txHash || null;
    if (!closeResult) {
      const d = this._noteCloseFailure(pos, sig, "CLOSE_NO_RESULT");
      this.log(`[CLOSE_RETRY] #${id} Failed (no result) — position KEPT, retry in ${Math.ceil(d / 1000)}s`, "error");
      return { ok: false, blocked: true, continueCycle: CONTINUE, code: "CLOSE_NO_RESULT" };
    }
    if (closeResult.dryRun) {
      // ─── DRY-CLOSE: REPORT ONLY ──────────────────────────────────────────
      // `[DRY] Would CLOSE position #N` was already logged by closePositionFn().
      // The record is KEPT: activePositions, sessionStats.closes and the close
      // backoff all stay byte-identical (requirement 4).
      this.log(`[DRY] Would CLOSE position #${id} — state untouched (activePositions/sessionStats/closeRetry unchanged)`, "info");
      return { ok: true, blocked: false, continueCycle: CONTINUE, code: null, dryRun: true };
    }
    if (closeResult.pending) {
      const d = this._noteCloseFailure(pos, sig, "TX_PENDING");
      this.log(`[CLOSE_RETRY] #${id} TX ${closeResult.txHash || ""} pending — state kept, will verify next cycle (in ${Math.ceil(d / 1000)}s)`, "warn");
      return { ok: false, blocked: false, continueCycle: CONTINUE, code: "TX_PENDING" };
    }
    if (closeResult.failed) {
      if (closeResult.clearState === false) {
        const d = this._noteCloseFailure(pos, sig, closeResult.code || "FAILED");
        // CLOSE-EXIT BLOCKED — the pool cannot absorb any safe exit slice. The
        // position stays tracked and retried every cycle; the per-market slot
        // (_marketHasPosition) prevents any new OPEN on the SAME pool, while
        // the global sequential slot ignores closeBlocked so healthy markets
        // stay tradable. Only safe SWAPs (protected-pool filtered) continue
        // meanwhile.
        const INFEASIBLE = ["CLOSE_NO_FEASIBLE_WINDOW", "CLOSE_BPS_NOT_FOUND", "CLOSE_AMOUNT_TOO_SMALL"];
        if (pos && INFEASIBLE.includes(closeResult.code)) {
          if (!pos.closeBlocked) {
            pos.closeBlocked = true;
            this.log(`[POSITION_BLOCKED] #${id} marked closeBlocked (exit window infeasible — pool cannot absorb a safe slice) — kept tracked, retried each cycle, own market stays busy, global slot stays free`, "warn");
          }
        } else if (pos?.closeBlocked) {
          pos.closeBlocked = false;
          this.log(`[CLOSE] #${id} closeBlocked cleared (failure mode changed: ${closeResult.code || "?"})`, "info");
        }
        this.log(`[CLOSE_RETRY] #${id} blocked (${closeResult.code || closeResult.reason || "?"}) — position KEPT, retry in ${Math.ceil(d / 1000)}s`, "warn");
        return { ok: false, blocked: true, continueCycle: CONTINUE, code: closeResult.code || "FAILED" };
      }
      this.log(`[CLOSE] #${id} Position gone (${closeResult.reason || "zombie"}) — clearing state`, "warn");
      this._clearPosition(pos, closeResult.reason || "zombie");
      return { ok: true, blocked: false, continueCycle: CONTINUE, code: null };
    }
    // Operator partial (--single=partial --pct): the REQUESTED slice executed
    // and was verified. The position legitimately stays active — this is a
    // success, not a blocked close, and the record must be kept (reconciled
    // by the caller via _syncActivePositionFromChain).
    if (closeResult.ok && closeResult.targetDone && closeResult.closed === false) {
      this.log(`[CLOSE] partial target done — position #${id} reduced on-chain, record KEPT`, "success");
      this._noteRealizedPnl(closeResult, pos);
      return { ok: true, blocked: false, continueCycle: CONTINUE, code: null, targetDone: true };
    }
    if (closeResult.closed === false) {
      const d = this._noteCloseFailure(pos, sig, closeResult.code || "STILL_ACTIVE");
      this.log(`[CLOSE_RETRY] #${id} ${closeResult.code || "not closed"} — position KEPT, retry in ${Math.ceil(d / 1000)}s`, "warn");
      return { ok: false, blocked: true, continueCycle: CONTINUE, code: closeResult.code || "STILL_ACTIVE" };
    }
    const part = closeResult.partial ? ` (partial closeBps=${closeResult.closeBps})` : "";
    this.log(`[CLOSE] #${id} SUCCESS TX: ${closeResult.txHash || "dry-run"}${part} — verified on-chain`, "success");
    this._noteRealizedPnl(closeResult, pos);
    this._clearPosition(pos, "verified close");
    return { ok: true, blocked: false, continueCycle: CONTINUE, code: null };
  }

  /**
   * Close ONE tracked position via ITS OWN manager (`resolveManagerForPosition`).
   *
   * Always returns a structured result so a caller can tell "position gone"
   * from "position still active → this cycle moves on, siblings unaffected".
   * A liquidity-blocked close KEEPS the record, schedules ITS backoff and never
   * clears on-chain state.
   *
   * @param {object} pos the tracked record to close
   * @returns {Promise<{ok:boolean, blocked:boolean, continueCycle:boolean, code:string|null}>}
   */
  async closeActivePosition(pos) {
    const DONE = { ok: true, blocked: false, continueCycle: true, code: null };
    if (!pos || !this._positions().includes(pos)) {
      return { ...DONE, code: "NO_ACTIVE_POSITION" };
    }
    if (pos.pendingOpen) {
      // A submitted-but-unconfirmed open must never be dropped as a
      // "failed-open leftover" — that would let the next cycle double-open.
      const settle = await this._settlePendingOpen(pos);
      if (!settle.done) {
        this.log(`[CLOSE] open tx ${pos.txHash || "?"} still ${settle.status} — deferring close`, "warn");
        return { ok: false, blocked: false, continueCycle: true, code: `OPEN_${String(settle.status).toUpperCase()}` };
      }
      if (!this._positions().includes(pos)) return { ...DONE, code: "OPEN_NOT_CONFIRMED" };
    }
    if (pos.positionId === null || pos.positionId === undefined) {
      this.log(`[CLOSE] stored record has no positionId (failed-open leftover) — clearing`, "warn");
      this._clearPosition(pos, "no positionId", false);
      return DONE;
    }

    const { provider, wallet } = this.getRuntime();
    // P7: the manager comes from THIS position's identity — never from a
    // side-derived getManagerAddr() fallback (that can target another market).
    const resolved = this.resolveManagerForPosition(pos);
    const positionId = pos.positionId;
    let managerAddr = resolved?.managerAddr || null;
    let onChain = null;

    if (!managerAddr) {
      // No usable local identity — the CHAIN decides (never a guessed manager).
      const found = await this._locateStoredPosition(pos);
      if (found.status === "active") {
        managerAddr = found.managerAddr;
        onChain = found.onChain;
        if (!this._isDry()) {
          pos.managerAddr = found.managerAddr;
          const mk = (Array.isArray(this.markets) ? this.markets : [])
            .find(m => String(m.managerAddr || "").toLowerCase() === String(found.managerAddr).toLowerCase());
          if (mk) {
            if (!pos.poolAddr) pos.poolAddr = mk.poolAddr;
            if (!pos.marketSymbol) pos.marketSymbol = mk.marketSymbol || mk.symbol;
          }
          saveState(this.state);
        }
        this.log(`[CLOSE] position #${positionId} located on-chain on manager ${short(found.managerAddr)} — identity recorded`, "warn");
      } else if (found.status === "closed" || found.status === "missing") {
        this.log(`[CLOSE] position #${positionId} not active on any known manager (id never reported) — clearing zombie state`, "warn");
        this._clearPosition(pos, "zombie (never reported)");
        return DONE;
      } else if (found.status === "no-id") {
        // A record without positionId is a failed-OPEN leftover — no on-chain
        // position can exist for it, so it must not block anything.
        this.log(`[CLOSE] stored record has no positionId (failed-open leftover) — clearing`, "warn");
        this._clearPosition(pos, "no positionId", false);
        return DONE;
      } else {
        const d = this._noteCloseFailure(pos, null, "POSITION_UNRESOLVED");
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
      this._clearPosition(pos, "already inactive on-chain");
      return DONE;
    }
    if (!onChain) {
      const d = this._noteCloseFailure(pos, null, "POSITION_UNREADABLE");
      this.log(`[CLOSE] positions(${positionId}) unreadable on ${short(managerAddr)} — position KEPT, retry in ${Math.ceil(d / 1000)}s`, "warn");
      return { ok: false, blocked: true, continueCycle: true, code: "POSITION_UNREADABLE" };
    }
    const sig = this._closeSig(onChain);

    // LOCAL/ON-CHAIN DIVERGENCE GUARD — the chain is authoritative. A stale
    // local record (e.g. collateralAmount left over from the open size after a
    // partial close, as on #75: local 1721515506 vs chain 12007481) would make
    // every locally-computed close size wrong. Reconcile BEFORE attempting so
    // the attempt uses real numbers; never the other way round.
    this._syncActivePositionFromChain(pos, onChain, { managerAddr });

    // HOLD WINDOW — an open position is not auto-closed before holdUntil
    // (min..max hold from the confirmed open) UNLESS the emergency probe
    // proves on-chain risk. Runs AFTER on-chain truth (the record above is
    // live) and BEFORE the backoff: a hold is not a failure, so no backoff,
    // no retry counter — the cycle continues with the record kept.
    const heldOutcome = await this._evaluateHoldGate(pos, { provider, managerAddr, positionId });
    if (heldOutcome) return heldOutcome;

    // Identical attempt inside the backoff window → do not touch the chain,
    // let SWAP maintenance continue this cycle and come back later.
    const retry = pos.closeRetry || null;
    if (retry && retry.sig === sig && Number(retry.nextAt || 0) > Date.now()) {
      const waitS = Math.ceil((Number(retry.nextAt) - Date.now()) / 1000);
      this.log(`[CLOSE] #${positionId} backoff ${waitS}s — attempt ${retry.attempts} on unchanged position (code=${retry.code || "?"}); other positions unaffected`, "info");
      return { ok: false, blocked: true, continueCycle: true, code: retry.code || "BACKOFF" };
    }

    const dryRun = this.config.dryRun;
    this.setState(STATES.CLOSE);
    this.log(`[AUTO] CLOSING position #${positionId} (${pos.side}) market=${pos.marketSymbol || resolved?.marketSymbol || "?"} manager=${short(managerAddr)} src=${resolved?.source || "chain"} attempt=${retry && retry.sig === sig ? Number(retry.attempts) + 1 : 1}`, "warn");

    const closeResult = await closePositionFn({
      wallet, provider, managerAddr, positionId,
      config: this.config, log: this.log.bind(this), dryRun, txManager: this.txManager,
    });

    return this._applyCloseResult(pos, closeResult, sig);
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

    const configuredTargetStr = collateralTargetStr(this.config, collateralToken, side);
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
    // The caller may force read-only (runSingleAction passes its confirm-gated
    // dryRun). Without --confirm the OPEN path must be a plan, never a TX —
    // documented contract: "TX writes require BOTH confirm and config.dryRun=false".
    const dryRun = opts.dryRun !== undefined && opts.dryRun !== null ? !!opts.dryRun : this.config.dryRun;

    await this.ensureMarkets();

    // CAP / PENDING GATE — enforced in EVERY open path (auto loop, --single=open).
    // Dry-run planning may exceed the cap (records are kept by dry closes), but
    // a pending open always blocks (double-open protection is not optional).
    if (!dryRun) {
      const gate = this._canOpenNew();
      if (!gate.ok) {
        this.log(`[BLOCKED] OPEN ${side} refused (code=${gate.code})`, "error");
        return false;
      }
    } else if (this._positions().some(p => p?.pendingOpen)) {
      const pending = this._positions().find(p => p?.pendingOpen);
      this.log(`[BLOCKED] open tx ${pending.txHash || "?"} still pending — resolve it before planning another OPEN`, "error");
      return false;
    }

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

      // PER-MARKET SLOT — another tracked position (active or pending) already
      // occupies this market. One position per market is a MARKET limit, never
      // a global one: other markets stay fully tradable.
      if (this._marketHasPosition(candidate)) {
        this.log(`[SKIP] ${candidate.symbol} ${side}: market already has a tracked position — trying next candidate`, "warn");
        this._rotMarketSkip(candidate.symbol, side);
        continue;
      }

      // EXPOSURE CAP — per-token collateral budget (maxTotalCollateral).
      const exp = this._exposureGate(ctx);
      if (!exp.ok) {
        this.log(`[SKIP] ${candidate.symbol} ${side}: ${exp.code} — ${exp.reason} — trying next candidate`, "warn");
        this._rotMarketSkip(candidate.symbol, side);
        continue;
      }

      // EXIT VIABILITY — never open where the pool cannot absorb a future
      // close (read-only reserve floor on both legs). A thin pool is SKIPPED
      // with a reason; the bot moves to the next candidate instead of opening
      // a position it could never safely exit.
      const exitProbe = await this._probeMarketExitFeasible(candidate, ctx);
      if (!exitProbe.ok) {
        this.log(`[SKIP] ${candidate.symbol} ${side}: exit not viable (${exitProbe.code}: ${exitProbe.reason}) — trying next candidate`, "warn");
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
      this._trackOpenedPosition({
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
      }, { pending: true });
      this.log(`[OPEN] PENDING tx=${openResult.txHash} — awaiting confirmation; sessionStats.opens NOT incremented`, "warn");
      return true;
    } else if (openResult) {
      this._recordDirectionSuccess(marketUsed.symbol, side);
      this._rotMarketDone(marketUsed.symbol, side);
      this._trackOpenedPosition({
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
      });
      this.log(`[OPEN] SUCCESS — position #${openResult.positionId} (${side} ${marketUsed.symbol}) — ${this._activeCount()} position(s) tracked`, "success");
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
    const stored = this._findPosition(positionId) || null;
    if (!mgrAddr && stored) {
      mgrAddr = this.resolveManagerForPosition(stored)?.managerAddr || stored.managerAddr || null;
    }
    if (!mgrAddr && !managerAddr) {
      // Last resort: any tracked record's manager (display-only fallback).
      const primary = this._primaryPosition();
      if (primary?.managerAddr) mgrAddr = primary.managerAddr;
    }
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

    // previewClosePosition() answers projectedHealthBps = type(uint256).max
    // (2^256−1) for a FULL close — the position is gone afterwards, so there is
    // no projected health. A real health value is ~bps (≪1e12); the sentinel
    // must never surface as a number (it renders as 1.15e77 on screen).
    let closeFullHealthBps = null;
    if (closeFull && !closeFull.err) {
      try {
        const v = BigInt(closeFull.projectedHealthBps);
        closeFullHealthBps = v >= 2n ** 255n ? null : Number(v);
      } catch { closeFullHealthBps = null; }
    }

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
            // realizedPnl is returned in COLLATERAL (token0) units — the site
            // formats it with collateralDecimals, never with the debt decimals.
            realizedPnlHuman: collateralDec !== null ? ethers.formatUnits(closeFull.realizedPnl, collateralDec) : null,
            closePrice: String(closeFull.closePrice),
            projectedHealthBps: closeFullHealthBps,
            projectedHealthNote: closeFullHealthBps === null ? "N/A (position fully closed)" : null,
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
      this.log(`[STATUS] full-close preview: recv=${rep.closeFull.collateralReturned} repay=${rep.closeFull.repayAmount} pnl=${rep.closeFull.realizedPnlHuman ?? rep.closeFull.realizedPnl} closePrice=${rep.closeFull.closePrice} health=${rep.closeFull.projectedHealthBps ?? rep.closeFull.projectedHealthNote ?? "?"} (closeBps=${rep.closeFull.closeBps})`, "info");
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
      this._syncFromReport(rep); // POSITION SYNC — chain → local cache for the tracked id
      this._clearIfTrackedClosed(rep);
      return { ok: rep.ok !== false, action: "status", reports: [rep] };
    }

    const mgrs = new Map();
    const add = (a) => { if (a && typeof a === "string" && a.startsWith("0x")) mgrs.set(a.toLowerCase(), a); };
    for (const rec of this._positions()) {
      add(rec?.managerAddr);
      add(this.resolveManagerForPosition(rec)?.managerAddr);
    }
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
        this._syncFromReport(rep);
        this._clearIfTrackedClosed(rep);
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
   * POSITION SYNC for single actions: push an authoritative describePosition()
   * snapshot into the matching tracked local record (never the other way
   * around).
   *
   * Only acts when the report matches a tracked record by id and actually read
   * the chain (found, active is a boolean). Never removes a record — removal
   * stays exclusive to _clearPosition (verified close / zombie).
   *
   * @param {object} report result of describePosition()
   * @returns {{synced:boolean, changed:string[]}}
   */
  _syncFromReport(report) {
    if (!report || report.found !== true || typeof report.active !== "boolean") {
      return { synced: false, changed: [] };
    }
    const tracked = this._findPosition(report.positionId);
    if (!tracked || tracked.pendingOpen) return { synced: false, changed: [] };
    const currentDebt = report.currentDebt ?? report.storedDebt ?? null;
    return this._syncActivePositionFromChain(
      tracked,
      {
        collateralAmount: report.collateralAmount !== undefined && report.collateralAmount !== null
          ? BigInt(report.collateralAmount) : null,
        currentDebt: currentDebt !== null && currentDebt !== undefined ? BigInt(currentDebt) : null,
        isLong: report.isLong ?? null,
      },
      { managerAddr: report.managerAddr || null },
    );
  }

  /**
   * When a read-only snapshot PROVES a tracked position is gone on-chain
   * (active=false), the stale local record is dropped (countClose=false — an
   * externally-closed position is not a close this bot performed).
   *
   * @returns {boolean} true when a stale record was cleared
   */
  _clearIfTrackedClosed(report) {
    if (!report || report.found !== true || report.active !== false) return false;
    const tracked = this._findPosition(report.positionId);
    if (!tracked || tracked.pendingOpen) return false;
    return this._clearPosition(tracked, "proven closed on-chain", false);
  }

  // Test seams — production delegates straight to the module functions below;
  // behavioral tests stub these to exercise decision logic without a chain.
  async _closePositionImpl(args) { return closePositionFn(args); }
  async _attemptPartialCloseImpl(args) { return attemptPartialClose(args); }

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

      // A submitted-but-unconfirmed open must settle first: if its receipt
      // already proves a position, opening again would DOUBLE-OPEN.
      // Settle every pending open first — a receipt may already prove a
      // position (and its slot must be counted before another open).
      await this._settleAllPendingOpens();
      const stillPending = this._positions().find(p => p?.pendingOpen);
      if (stillPending) {
        this.log(`[BLOCKED] open tx ${stillPending.txHash || "?"} still pending — resolve it before opening again`, "error");
        return { ...base, code: "OPEN_PENDING", txHash: stillPending.txHash || null };
      }

      // RECONCILE BEFORE GATING — a stale record for a position the chain
      // already closed must not occupy an open slot (read-only views only).
      for (const rec of [...this._positions()]) {
        if (rec?.pendingOpen || rec?.positionId == null) continue;
        try {
          const mgr = this.resolveManagerForPosition(rec)?.managerAddr || rec.managerAddr || null;
          if (!mgr) continue;
          const rep = await this.describePosition(String(rec.positionId), mgr);
          if (rep && rep.found === false) continue; // unreadable → KEEP
          if (rep && rep.active === false) {
            this.log(`[SYNC] tracked position #${rec.positionId} already closed on-chain — clearing stale record`, "warn");
            this._clearPosition(rec, "already closed on-chain", false);
            continue;
          }
          if (rep) this._syncFromReport(rep);
        } catch { /* unreadable → KEEP */ }
      }

      // CAP + PER-MARKET SLOT — a second open is refused when the global cap is
      // full or the SAME market already has a tracked position. A position on
      // market A never blocks opening on market B (multi-position).
      const pinMarket = opts.marketSymbol
        ? { marketSymbol: opts.marketSymbol, symbol: opts.marketSymbol }
        : null;
      const gate = this._canOpenNew({ market: pinMarket });
      if (!gate.ok) {
        if (gate.code === "MARKET_BUSY") {
          return { ...base, code: "OPEN_EXISTS", positionId: String(this._positions().find(p => this._marketKeyOf(p) === this._marketKeyOfCandidate(pinMarket))?.positionId ?? "") };
        }
        return { ...base, code: gate.code === "MAX_OPEN_POSITIONS" ? "OPEN_EXISTS" : gate.code };
      }

      this.log(`[SINGLE] OPEN ${side}${opts.marketSymbol ? ` on ${opts.marketSymbol}` : ""}${lev !== null ? ` @ ${lev}x` : ""} confirm=${confirm} dryRun=${dryRun}`, "warn");
      const ok = await this.prepareAndOpen(side, {
        marketSymbol: opts.marketSymbol || null,
        leverage: lev,
        dryRun, // confirm-gated: without --confirm this is a PLAN, never a TX
      });
      const ap = this._lastOpenedRecord && this._positions().includes(this._lastOpenedRecord)
        ? this._lastOpenedRecord
        : null;
      const pending = !!ap?.pendingOpen && !!ap?.txHash;
      return {
        ...base,
        ok: !!ok && (dryRun || pending || !!ap),
        code: !ok ? "OPEN_BLOCKED"
          : dryRun ? "OPEN_PLANNED"
          : pending ? "OPEN_PENDING"
          : "OPENED",
        dryRun,
        opened: ok ? ap : null,
        txHash: pending ? ap.txHash : (ap && !dryRun ? ap.txHash : null),
        // dry-run: the leverage/market plan was logged by _resolveOpenLeverage
      };
    }

    if (action === "close" || action === "partial") {
      // Settle pending opens first — a receipt may already prove the position
      // (confirmed-but-not-synced): the id fallback below then works.
      await this._settleAllPendingOpens();
      const stillPending = this._positions().find(p => p?.pendingOpen);
      if (stillPending) {
        this.log(`[BLOCKED] open tx ${stillPending.txHash || "?"} still pending — cannot resolve a position id yet`, "error");
        return { ...base, code: "OPEN_PENDING" };
      }
      const idRaw = opts.positionId ?? this._primaryPosition()?.positionId ?? null;
      if (idRaw === null || idRaw === undefined || `${idRaw}` === "") {
        this.log(`[BLOCKED] --id=<positionId> required (no tracked active position to fall back to)`, "error");
        return { ...base, code: "NO_POSITION_ID" };
      }
      const idStr = String(idRaw);

      let mgrAddr = opts.manager || null;
      const stored = this._findPosition(idStr);
      if (!mgrAddr && stored) {
        mgrAddr = this.resolveManagerForPosition(stored)?.managerAddr || stored.managerAddr || null;
      }
      if (!mgrAddr) {
        this.log(`[BLOCKED] no manager for position #${idStr} — pass --manager=0x…`, "error");
        return { ...base, code: "NO_MANAGER", positionId: idStr };
      }

      const { provider, wallet } = this.getRuntime();
      const report = await this.describePosition(idStr, mgrAddr);
      this._logPositionReport(report);
      this._syncFromReport(report);
      if (!report.found) return { ...base, code: "NOT_FOUND", report };
      if (report.active === false) {
        // Proven gone on-chain: a stale tracked record for this id must not
        // survive as a fake "active" position (occupies a slot / repeats close).
        if (stored && !stored.pendingOpen) {
          this.log(`[SYNC] tracked position #${idStr} already closed on-chain — clearing stale record`, "warn");
          this._clearPosition(stored, "already closed on-chain", false);
        }
        return { ...base, ok: true, code: "ALREADY_CLOSED", report };
      }

      // OWNER GUARD — describePosition proved who owns this id on THAT manager.
      // A foreign owner (wrong --manager, cross-market id collision, stale
      // deployment address) must never reach the send path, dry or live.
      if (report.found && report.ours === false && report.user) {
        this.log(`[BLOCKED] position #${idStr} on ${short(mgrAddr)} belongs to ${short(report.user)}, not this wallet — refusing ${action}`, "error");
        return { ...base, code: "NOT_OURS", report };
      }

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
        const res = await this._closePositionImpl({
          wallet, provider, managerAddr: mgrAddr, positionId: BigInt(idStr),
          config: this.config, log: this.log.bind(this), dryRun: false, txManager: this.txManager,
        });
        const after = await this.describePosition(idStr, mgrAddr);
        this._logPositionReport(after);
        this._syncFromReport(after);
        const verifiedClosed = res?.ok && after.found && after.active === false;
        // Apply to local state: clears ONLY a verified close / zombie, keeps
        // the record on pending/blocked/still-active (never marks closed early).
        let applied = null;
        if (stored) {
          applied = this._applyCloseResult(stored, res);
        } else if (verifiedClosed) {
          this.log(`[CLOSE] #${idStr} closed on-chain (not tracked locally — local state untouched)`, "info");
        }
        // Chain-proven closed always wins: a failed/blocked result whose
        // post-read now shows active=false clears the stale record too.
        this._clearIfTrackedClosed(after);
        if (verifiedClosed) this.log(`[VERIFY] close CONFIRMED on-chain: #${idStr} is closed`, "success");
        else if (res && !res.ok && !res.failed) { /* dry or pending */ }
        return { ...base, ok: !!verifiedClosed, result: res, report: after, applied };
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

      const res = await this._attemptPartialCloseImpl({
        wallet, provider, managerAddr: mgrAddr, positionId: BigInt(idStr),
        config: this.config, log: this.log.bind(this), txManager: this.txManager,
        targetCloseBps: closeBps,
      });
      const after = await this.describePosition(idStr, mgrAddr);
      this._logPositionReport(after);
      this._syncFromReport(after);
      let applied = null;
      if (stored) {
        // Verified full close → clears; target-done (still active) → keeps the
        // record but reconciled with on-chain values; failed → keeps + backoff.
        applied = this._applyCloseResult(stored, res);
      }
      this._clearIfTrackedClosed(after);
      if (res?.ok && after.found && after.active === false) {
        this.log(`[VERIFY] partial #${idStr} drove the position to CLOSED on-chain`, "success");
      } else if (res?.ok) {
        this.log(`[VERIFY] partial #${idStr} confirmed on-chain (position still active, reduced)`, "success");
      }
      return { ...base, ok: !!res?.ok, result: res, report: after, applied };
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
  revertSelector, verifyOpenedPosition, verifySwapBalances, attemptPartialClose,
  // Open-event positionId extraction (topics layout proven on reference TX)
  extractPositionIdFromLogs, MAM_POSITION_CREATED_TOPIC, MARGIN_FEE_ASSESSED_TOPIC,
  CLOSE_POSITION_SELECTOR, MAX_PARTIAL_CLOSE_BPS,
  // Per-side collateral target resolution (test-visible for override logic)
  collateralTargetStr,
};
export default AutoTrader;
