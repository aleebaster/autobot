import { ethers } from "ethers";
import fs from "fs";
import { TokenInventory, EthSessionTracker, DEFAULT_ETH_GUARD, calculateInventoryDeficit, SwapJournal, selectRandomSwapPair, calculateRandomSwapAmount, getTokenAddress, getSwapPairs, TOKEN_DECIMALS } from "./tokenInventory.js";
import { getRouterAddress } from "./deployments/index.js";

// ═══════════════════════════════════════════════════════════════════════════
//  AUTONOMOUS TRADING LOOP — Nemesis Sepolia (V2 — CORRECTED)
//  FIX: openPosition ABI, borrowAmount, amountOutMin, oracle checkpoint
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

function tokenDecimalsOf(addr) {
  return addr && addr.toLowerCase() === WETH.toLowerCase() ? 18 : 6;
}

function tokenSymbolOf(addr) {
  if (!addr) return "?";
  const a = addr.toLowerCase();
  if (a === USDT.toLowerCase()) return "USDT";
  if (a === USDC.toLowerCase()) return "USDC";
  if (a === WETH.toLowerCase()) return "WETH";
  return short(addr);
}

function riskyTokenOfMarket(market) {
  const t0 = market?.poolToken0;
  const coll = market?.collateralToken;
  if (t0 && t0.toLowerCase() !== USDT.toLowerCase()) return t0;
  if (coll && coll.toLowerCase() !== USDT.toLowerCase()) return coll;
  return WETH;
}

function pairTokensOfMarket(market) {
  const token0 = market.poolToken0;
  const risky = riskyTokenOfMarket(market);
  const token1 = token0 && token0.toLowerCase() === USDT.toLowerCase() ? risky : USDT;
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

function swapSourcesFor(collateralToken, side) {
  const base = side === "LONG" ? LONG_SOURCES : SHORT_SOURCES;
  const all = [USDT, USDC, WETH];
  const ordered = [...base, ...all.filter(t => !base.some(b => b.toLowerCase() === t.toLowerCase()))];
  const target = (collateralToken || "").toLowerCase();
  return ordered.filter(t => t.toLowerCase() !== target);
}

/**
 * Resolve active trading market for a side.
 * Prefers NEMESIS/USDT (reference market, supportsLong/Short), then config availableMarkets.
 * Collateral rule: token0 → LONG, token1 → SHORT.
 */
function resolveTradingMarket({ side, confirmedPools = {}, availableMarkets = [], preferSymbol = "NEMESIS/USDT" }) {
  const eligible = (availableMarkets || []).filter(m => {
    if (!m?.isActive) return false;
    if (side === "LONG" && m.supportsLong === false) return false;
    if (side === "SHORT" && m.supportsShort === false) return false;
    const p = confirmedPools[m.symbol];
    return !!(p && p.deployed !== false && p.manager && p.pool);
  });
  const ordered = [
    ...eligible.filter(m => m.symbol === preferSymbol),
    ...eligible.filter(m => m.symbol !== preferSymbol),
  ];
  const market = ordered[0];
  if (!market) return null;
  const poolInfo = confirmedPools[market.symbol];
  const { token0, token1, risky } = pairTokensOfMarket(market);
  const collateralToken = side === "LONG" ? token0 : token1;
  return {
    symbol: market.symbol,
    managerAddr: poolInfo.manager,
    poolAddr: poolInfo.pool,
    poolToken0: token0,
    poolToken1: token1,
    riskyToken: risky,
    paymentToken: risky,
    collateralToken,
    decimals: tokenDecimalsOf(collateralToken),
    collateralSym: tokenSymbolOf(collateralToken),
    market,
  };
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
  const tokens = [
    { sym: "ETH", addr: null, decimals: 18, type: "native" },
    { sym: "USDT", addr: USDT, decimals: 6 },
    { sym: "WETH", addr: WETH, decimals: 18 },
    { sym: "USDC", addr: USDC, decimals: 6 },
  ];
  const lines = [];
  for (const t of tokens) {
    try {
      let bal;
      if (t.type === "native") {
        bal = await provider.getBalance(walletAddr);
      } else {
        const c = new ethers.Contract(t.addr, ["function balanceOf(address) view returns (uint256)"], provider);
        bal = await c.balanceOf(walletAddr);
      }
      lines.push(`${t.sym}=${ethers.formatUnits(bal, t.decimals)}`);
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
  preferredMarket: "NEMESIS/USDT",
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

const LONG_SOURCES = [USDC, WETH];
const SHORT_SOURCES = [USDT, USDC];

async function ensureCollateral({ wallet, provider, side, collateralToken: collateralTokenArg, collateralAmount, config, log, dryRun, txManager }) {
  const walletAddr = wallet.address;
  const collateralToken = collateralTokenArg || (side === "LONG" ? USDT : WETH);
  const decimals = tokenDecimalsOf(collateralToken);
  const sym = tokenSymbolOf(collateralToken);
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

  const sources = swapSourcesFor(collateralToken, side);
  const router = new ethers.Contract(routerAddr, ROUTER_ABI, provider);

  for (const sourceToken of sources) {
    const sourceContract = new ethers.Contract(sourceToken, ERC20_ABI, provider);
    const sourceBalance = await sourceContract.balanceOf(walletAddr);
    const sourceDecimals = sourceToken === WETH ? 18 : 6;
    const sourceSym = sourceToken === USDT ? "USDT" : sourceToken === USDC ? "USDC" : "WETH";

    if (sourceBalance <= 0n) { log(`[SWAP] ${sourceSym} balance=0 — skip`, "info"); continue; }
    log(`[SWAP] Trying ${sourceSym} → ${sym}: balance=${ethers.formatUnits(sourceBalance, sourceDecimals)}`, "info");

    const path = [sourceToken, collateralToken];
    try {
      const fullQuote = await router.getAmountsOut(sourceBalance, path);
      const expectedOut = fullQuote[1];
      if (expectedOut < deficit) {
        log(`[SWAP] ${sourceSym} insufficient: max output < deficit`, "warn");
        continue;
      }
      const neededWithBuffer = deficit * 101n / 100n;
      const swapAmount = neededWithBuffer * sourceBalance / expectedOut;
      const safeSwapAmount = swapAmount > sourceBalance ? sourceBalance : swapAmount;
      const amountOutMin = deficit * 99n / 100n;

      log(`[SWAP-DEBUG] tokenIn=${sourceSym} tokenOut=${sym}`, "info");
      log(`[SWAP-DEBUG] sourceBalance=${ethers.formatUnits(sourceBalance, sourceDecimals)} ${sourceSym}`, "info");
      log(`[SWAP-DEBUG] fullQuoteOut=${ethers.formatUnits(expectedOut, decimals)} ${sym}`, "info");
      log(`[SWAP-DEBUG] neededWithBuffer=${ethers.formatUnits(neededWithBuffer, decimals)} ${sym}`, "info");
      log(`[SWAP-DEBUG] swapAmount=${ethers.formatUnits(safeSwapAmount, sourceDecimals)} ${sourceSym}`, "info");
      log(`[SWAP-DEBUG] amountOutMin=${ethers.formatUnits(amountOutMin, decimals)} ${sym}`, "info");
      log(`[SWAP-DEBUG] allowance=${ethers.formatUnits(await new ethers.Contract(sourceToken, ERC20_ABI, provider).allowance(walletAddr, routerAddr), sourceDecimals)} ${sourceSym}`, "info");

      log(`[SWAP] quote: ${ethers.formatUnits(safeSwapAmount, sourceDecimals)} ${sourceSym} → ~${ethers.formatUnits(expectedOut * safeSwapAmount / sourceBalance, decimals)} ${sym}`, "info");

      const swapResult = await executeSwap({
        wallet, provider, fromToken: sourceToken, toToken: collateralToken,
        amount: safeSwapAmount, amountOutMin, config, log, txManager,
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
  if (side === "SHORT" && collateralToken.toLowerCase() === WETH.toLowerCase()) {
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

async function executeSwap({ wallet, provider, fromToken, toToken, amount, amountOutMin, config, log, txManager }) {
  const walletAddr = wallet.address;
  const routerAddr = getRouterAddress();
  const router = new ethers.Contract(routerAddr, ROUTER_ABI, wallet);
  const fromContract = new ethers.Contract(fromToken, ERC20_ABI, wallet);
  const fromSym = fromToken === USDT ? "USDT" : fromToken === USDC ? "USDC" : "WETH";
  const srcDecimals = fromToken === WETH ? 18 : 6;

  const allowance = await fromContract.allowance(walletAddr, routerAddr);
  log(`[SWAP-DEBUG] executeSwap: from=${fromSym} to=${toToken === USDT ? "USDT" : toToken === WETH ? "WETH" : "???"} amount=${ethers.formatUnits(amount, srcDecimals)} allowance=${ethers.formatUnits(allowance, srcDecimals)}`, "info");
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

  const path = [fromToken, toToken];
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
  const decimals = tokenDecimalsOf(collateralToken);
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
    log(`[PREFLIGHT] isLong=${isLong} collateralToken=${tokenSymbolOf(collateralToken)} collateralAmount=${collateralAmount} leverageX10=${leverageX10} borrowAmount=${borrowAmount} amountOutMin=${amountOutMin} deadline=${deadline}`, "info");
    log(`[PREFLIGHT] PASS`, "success");
  } catch (e) {
    const revertData = e?.data || e?.info?.error?.data || e?.cause?.data || e?.cause?.info?.error?.data || null;
    const match = (e?.shortMessage || e?.message || "").match(/0x[0-9a-fA-F]{8,}/);
    const rawRevert = revertData || match?.[0] || "unknown";
    log(`[PREFLIGHT] isLong=${isLong} collateralToken=${tokenSymbolOf(collateralToken)} collateralAmount=${collateralAmount} leverageX10=${leverageX10} borrowAmount=${borrowAmount} amountOutMin=${amountOutMin} deadline=${deadline}`, "info");
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
   * Resolve market for a side (pool-aware). Prefer NEMESIS/USDT per config/reference.
   */
  resolveMarket(side) {
    const confirmedPools = this.deps.confirmedPools || {};
    const availableMarkets = this.config.availableMarkets || this.deps.availableMarkets || [];
    return resolveTradingMarket({
      side,
      confirmedPools,
      availableMarkets,
      preferSymbol: this.config.preferredMarket || "NEMESIS/USDT",
    });
  }

  getManagerAddr(side) {
    if (side) {
      const m = this.resolveMarket(side);
      if (m) return m.managerAddr;
    }
    if (this.state?.activePosition?.managerAddr) return this.state.activePosition.managerAddr;
    const confirmedPools = this.deps.confirmedPools || {};
    const forSide = this.resolveMarket(this.state?.lastSide || "SHORT");
    if (forSide) return forSide.managerAddr;
    return confirmedPools["NEMESIS/USDT"]?.manager
      || confirmedPools["ETH/USDT"]?.manager
      || "0xD45dde32C66769ED835A0F0f45EC0bF6973857FD";
  }

  getPoolAddr(side) {
    if (side) {
      const m = this.resolveMarket(side);
      if (m) return m.poolAddr;
    }
    if (this.state?.activePosition?.poolAddr) return this.state.activePosition.poolAddr;
    const confirmedPools = this.deps.confirmedPools || {};
    const forSide = this.resolveMarket(this.state?.lastSide || "SHORT");
    if (forSide) return forSide.poolAddr;
    return confirmedPools["NEMESIS/USDT"]?.pool
      || confirmedPools["ETH/USDT"]?.pool
      || "0x792bCdbe39E6aF13EeEbab251Cb59D6824EBe28e";
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

      // PHASE 0: AUTO-SWAP — proactive token rebalancing (always)
      const autoSwapConfig = this.config.autoSwap || {};
      if (autoSwapConfig.enabled) {
        this.setState(STATES.AUTO_SWAP);
        const maxSwaps = autoSwapConfig.maxSwapsPerCycle || 2;
        const tokenAddrs = { USDC, USDT, WETH };
        let swapsDone = 0;

        this.log(`[AUTO-SWAP] Phase started (max ${maxSwaps} swaps per cycle)`, "info");

        // Refresh inventory for auto-swap decisions
        const inventoryTokenMap = {};
        for (const [sym, addr] of Object.entries(tokenAddrs)) {
          inventoryTokenMap[sym] = { address: addr, decimals: TOKEN_DECIMALS[sym] || 6 };
        }
        try {
          await this.inventory.refreshBalances(provider, walletAddr, inventoryTokenMap, this.log.bind(this));
          this.inventory.logStatus(this.log.bind(this));
        } catch (e) {
          this.log(`[AUTO-SWAP] Inventory refresh failed: ${e.message?.slice(0, 60)}`, "error");
        }

        for (let i = 0; i < maxSwaps; i++) {
          try {
            // Re-fetch fresh balances for each swap
            const freshBalances = {};
            for (const [sym, addr] of Object.entries(tokenAddrs)) {
              try {
                if (sym === "WETH") {
                  const c = new ethers.Contract(addr, ERC20_ABI, provider);
                  freshBalances[sym] = { raw: await c.balanceOf(walletAddr), float: parseFloat(ethers.formatUnits(await c.balanceOf(walletAddr), 18)) };
                } else {
                  const c = new ethers.Contract(addr, ERC20_ABI, provider);
                  const bal = await c.balanceOf(walletAddr);
                  freshBalances[sym] = { raw: bal, float: parseFloat(ethers.formatUnits(bal, TOKEN_DECIMALS[sym])) };
                }
              } catch { freshBalances[sym] = { raw: 0n, float: 0 }; }
            }

            // Select a random pair
            const pair = selectRandomSwapPair(this.swapJournal, freshBalances, autoSwapConfig, tokenAddrs, this.log.bind(this));
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

            const amountResult = calculateRandomSwapAmount(pair.from, fromBal.float, autoSwapConfig);
            if (!amountResult) {
              this.log(`[AUTO-SWAP] Amount too small for ${pair.from} — skip`, "info");
              continue;
            }

            // Convert float amount to raw BigInt
            const decimals = TOKEN_DECIMALS[pair.from] || 6;
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

            // Get quote from Router
            const router = new ethers.Contract(getRouterAddress(), ROUTER_ABI, provider);
            let quote;
            try {
              quote = await router.getAmountsOut(amountRaw, [pair.fromAddr, pair.toAddr]);
            } catch (e) {
              this.log(`[AUTO-SWAP] Quote failed for ${pair.from}→${pair.to}: ${e.message?.slice(0, 60)}`, "error");
              continue;
            }

            const expectedOut = quote[1];
            const toDecimals = TOKEN_DECIMALS[pair.to] || 6;
            const amountOutMin = applySlippage(expectedOut, BigInt(autoSwapConfig.slippageBps || 50));

            // Log pre-swap details
            this.log(`[SWAP] pair=${pair.from}→${pair.to}`, "warn");
            this.log(`[SWAP] amountIn=${ethers.formatUnits(amountRaw, decimals)} ${pair.from}`, "warn");
            this.log(`[SWAP] expectedOut=${ethers.formatUnits(expectedOut, toDecimals)} ${pair.to}`, "warn");
            this.log(`[SWAP] amountOutMin=${ethers.formatUnits(amountOutMin, toDecimals)} ${pair.to}`, "warn");

            if (dryRun) {
              this.log(`[DRY] Would swap ${amountResult.amountFloat.toFixed(4)} ${pair.from} → ${pair.to}`, "info");
              this.swapJournal.record({ from: pair.from, to: pair.to, amount: amountResult.amountFloat });
              swapsDone++;
              continue;
            }

            // Execute swap
            const swapResult = await executeSwap({
              wallet, provider,
              fromToken: pair.fromAddr, toToken: pair.toAddr,
              amount: amountRaw, amountOutMin,
              config: this.config, log: this.log.bind(this), txManager: this.txManager,
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

            // Record in journal
            this.swapJournal.record({ from: pair.from, to: pair.to, amount: amountResult.amountFloat });
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

      // PHASE 1: If active position → CLOSE
      if (this.state.activePosition) {
        this.setState(STATES.CLOSE);
        this.log(`[CLOSE] position #${this.state.activePosition.positionId} (${this.state.activePosition.side})`, "warn");

        const closeResult = await closePositionFn({
          wallet, provider, managerAddr,
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

      // PHASE 2: SELECT DIRECTION (alternating LONG/SHORT, or use RSI)
      this.setState(STATES.SIGNAL);
      const lastSide = this.state.lastSide || null;
      let side;

      // Try RSI first
      try {
        const rsi = await fetchRSI("ethereum");
        if (rsi !== null) {
          const signal = getSignal(rsi, { rsiLong: 30, rsiShort: 70 });
          this.log(`[RSI] value=${rsi} signal=${signal}`, "info");
          if (signal !== "WAIT") {
            side = signal;
          }
        }
      } catch {}

      // Fallback: alternating
      if (!side) {
        side = lastSide === "LONG" ? "SHORT" : "LONG";
      }
      this.log(`[DIRECTION] ${side}`, "warn");

      // PHASE 3: PREPARE COLLATERAL — INVENTORY-AWARE, pool-aware market
      this.setState(STATES.PREPARE_COLLATERAL);
      const market = this.resolveMarket(side);
      if (!market) {
        this.log(`[BLOCKED] No active market supports ${side}`, "error");
        return;
      }
      this.log(`[MARKET] ${market.symbol} manager=${short(market.managerAddr)} coll=${market.collateralSym}`, "info");
      const collateralToken = market.collateralToken;
      const collateralDecimals = market.decimals;
      const collateralSym = market.collateralSym;

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

        // Select swap source from inventory
        const sources = swapSourcesFor(collateralToken, side);
        let swapSuccess = false;

        for (const sourceToken of sources) {
          const sourceContract = new ethers.Contract(sourceToken, ERC20_ABI, provider);
          const sourceBalance = await sourceContract.balanceOf(walletAddr);
          const sourceDecimals = sourceToken === WETH ? 18 : 6;
          const sourceSym = sourceToken === USDT ? "USDT" : sourceToken === USDC ? "USDC" : "WETH";

          if (sourceBalance <= 0n) {
            this.log(`[SWAP] ${sourceSym} balance=0 — skip`, "info");
            continue;
          }

          this.log(`[SWAP] ${sourceSym} balance=${ethers.formatUnits(sourceBalance, sourceDecimals)} — trying ${sourceSym} → ${collateralSym}`, "info");

          try {
            const router = new ethers.Contract(getRouterAddress(), ROUTER_ABI, provider);
            const fullQuote = await router.getAmountsOut(sourceBalance, [sourceToken, collateralToken]);
            const expectedOut = fullQuote[1];

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
              log: this.log.bind(this), txManager: this.txManager,
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

      // PHASE 4: OPEN
      this.setState(STATES.OPEN);
      this.log(`[OPEN] ${side} ${this.config.defaultLeverage}x...`, "warn");

      const openResult = await openPosition({
        wallet, provider, managerAddr: market.managerAddr, poolAddr: market.poolAddr,
        side, collateralToken, collateralAmount,
        leverage: this.config.defaultLeverage,
        config: this.config, log: this.log.bind(this), dryRun, txManager: this.txManager,
        paymentToken: market.paymentToken,
      });

      if (openResult?.dryRun) {
        this.log(`[DRY] Open would execute`, "info");
        this.state.lastSide = side;
        saveState(this.state);
      } else if (openResult) {
        this.state.activePosition = {
          positionId: openResult.positionId,
          side,
          collateralToken,
          collateralAmount: collateralAmount.toString(),
          leverage: this.config.defaultLeverage,
          openedAt: Date.now(),
          txHash: openResult.txHash,
          marketSymbol: market.symbol,
          managerAddr: market.managerAddr,
          poolAddr: market.poolAddr,
        };
        this.state.lastSide = side;
        this.state.sessionStats.opens++;
        saveState(this.state);

        this.setState(STATES.MONITOR);
        this.log(`[MONITOR] position #${openResult.positionId} (${side})`, "success");

        this.log(`[COOLDOWN] ${this.config.cooldownAfterOpenMs / 1000}s...`, "info");
        await this.sleep(this.config.cooldownAfterOpenMs);
      } else {
        this.log(`[BLOCKED] Open failed — skipping cycle`, "error");
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

      // Recovery
      try {
        this.log("[RECOVERY] scanning on-chain...", "info");
        const { provider } = this.getRuntime();
        const walletAddr = this.deps.accounts[this.deps.selectedWalletIndex].address;
        const managers = [...new Set([
          this.getManagerAddr("SHORT"),
          this.resolveMarket("LONG")?.managerAddr,
          this.deps.confirmedPools?.["NEMESIS/USDT"]?.manager,
          this.deps.confirmedPools?.["ETH/USDT"]?.manager,
        ].filter(Boolean))];
        let recovered = null;
        for (const mgr of managers) {
          recovered = await recoverPosition(provider, walletAddr, mgr, this.log.bind(this));
          if (recovered) {
            recovered.managerAddr = mgr;
            const sym = Object.entries(this.deps.confirmedPools || {})
              .find(([, p]) => p?.manager?.toLowerCase() === mgr.toLowerCase())?.[0];
            if (sym) recovered.marketSymbol = sym;
            recovered.poolAddr = this.deps.confirmedPools?.[sym]?.pool;
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
          // STEP 1: Random token-to-token swaps
          if (!this.stopRequested) {
            await this.doRandomSwaps();
          }

          // STEP 2: Open position if none active
          if (!this.state.activePosition && !this.stopRequested) {
            const side = this.nextSide();
            this.log(`[AUTO] NEXT ACTION: OPEN ${side}`, "info");
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

    const { provider, wallet } = this.getRuntime();
    const walletAddr = wallet.address;
    const dryRun = this.config.dryRun;
    const tokenAddrs = { USDC, USDT, WETH };

    const swapCount = 1 + Math.floor(Math.random() * 2);
    this.log(`[AUTO] SWAPPING — ${swapCount} random swap(s)`, "info");

    for (let i = 0; i < swapCount; i++) {
      if (this.stopRequested) break;

      try {
        const freshBalances = {};
        for (const [sym, addr] of Object.entries(tokenAddrs)) {
          try {
            const c = new ethers.Contract(addr, ERC20_ABI, provider);
            const bal = await c.balanceOf(walletAddr);
            freshBalances[sym] = { raw: bal, float: parseFloat(ethers.formatUnits(bal, TOKEN_DECIMALS[sym] || 6)) };
          } catch { freshBalances[sym] = { raw: 0n, float: 0 }; }
        }

        const pair = selectRandomSwapPair(this.swapJournal, freshBalances, autoSwapConfig, tokenAddrs, this.log.bind(this));
        if (!pair) {
          this.log(`[AUTO-SWAP] No valid pair`, "info");
          break;
        }

        const fromBal = freshBalances[pair.from];
        if (!fromBal || fromBal.float <= 0) continue;

        const amountResult = calculateRandomSwapAmount(pair.from, fromBal.float, autoSwapConfig);
        if (!amountResult) continue;

        const decimals = TOKEN_DECIMALS[pair.from] || 6;
        const amountRaw = ethers.parseUnits(amountResult.amountFloat.toFixed(decimals), decimals);

        if (amountRaw > fromBal.raw * 90n / 100n) continue;
        if (amountRaw > fromBal.raw) continue;

        const router = new ethers.Contract(getRouterAddress(), ROUTER_ABI, provider);
        const quote = await router.getAmountsOut(amountRaw, [pair.fromAddr, pair.toAddr]);
        const expectedOut = quote[1];
        const toDecimals = TOKEN_DECIMALS[pair.to] || 6;
        const amountOutMin = applySlippage(expectedOut, BigInt(autoSwapConfig.slippageBps || 50));

        this.log(`[AUTO] SWAPPING ${pair.from} → ${pair.to} [${ethers.formatUnits(amountRaw, decimals)}]`, "warn");

        if (dryRun) {
          this.log(`[DRY] Would swap ${amountResult.amountFloat.toFixed(4)} ${pair.from} → ${pair.to}`, "info");
          this.swapJournal.record({ from: pair.from, to: pair.to, amount: amountResult.amountFloat });
          continue;
        }

        const swapResult = await executeSwap({
          wallet, provider,
          fromToken: pair.fromAddr, toToken: pair.toAddr,
          amount: amountRaw, amountOutMin,
          config: this.config, log: this.log.bind(this), txManager: this.txManager,
        });

        if (swapResult) {
          this.swapJournal.record({ from: pair.from, to: pair.to, amount: amountResult.amountFloat });
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

    const market = this.resolveMarket(side);
    if (!market) {
      this.log(`[BLOCKED] No active market supports ${side}`, "error");
      return false;
    }
    const managerAddr = market.managerAddr;
    const poolAddr = market.poolAddr;
    this.log(`[MARKET] ${market.symbol} manager=${short(managerAddr)} coll=${market.collateralSym}`, "info");

    const collateralToken = market.collateralToken;
    const collateralDecimals = market.decimals;
    const collateralSym = market.collateralSym;

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
      const sources = swapSourcesFor(collateralToken, side);
      let swapSuccess = false;

      for (const sourceToken of sources) {
        try {
          const sourceContract = new ethers.Contract(sourceToken, ERC20_ABI, provider);
          const sourceBalance = await sourceContract.balanceOf(walletAddr);
          const sourceDecimals = sourceToken === WETH ? 18 : 6;
          const sourceSym = sourceToken === USDT ? "USDT" : sourceToken === USDC ? "USDC" : "WETH";

          if (sourceBalance <= 0n) {
            this.log(`[SWAP] ${sourceSym} balance=0 — skip`, "info");
            continue;
          }

          this.log(`[SWAP] ${sourceSym} → ${collateralSym}: balance=${ethers.formatUnits(sourceBalance, sourceDecimals)}`, "info");

          const router = new ethers.Contract(getRouterAddress(), ROUTER_ABI, provider);
          const fullQuote = await router.getAmountsOut(sourceBalance, [sourceToken, collateralToken]);
          const expectedOut = fullQuote[1];

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
            log: this.log.bind(this), txManager: this.txManager,
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
          this.log(`[SWAP] ${sourceSym} → ${collateralSym} failed: ${e.message?.slice(0, 60)}`, "error");
          this.txManager.resetNonce();
          continue;
        }
      }

      // Last resort: ETH → WETH for SHORT only when collateral is WETH
      if (!swapSuccess && !dryRun && side === "SHORT" && collateralToken.toLowerCase() === WETH.toLowerCase()) {
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

    // Open position
    this.setState(STATES.OPEN);
    const openResult = await openPosition({
      wallet, provider, managerAddr, poolAddr, side, collateralToken, collateralAmount,
      leverage: this.config.defaultLeverage,
      config: this.config, log: this.log.bind(this), dryRun, txManager: this.txManager,
      paymentToken: market.paymentToken,
    });

    if (openResult?.dryRun) {
      this.log(`[DRY] Open ${side} would execute`, "info");
      this.state.lastSide = side;
      saveState(this.state);
      return true;
    } else if (openResult) {
      this.state.activePosition = {
        positionId: openResult.positionId,
        side, collateralToken,
        collateralAmount: collateralAmount.toString(),
        leverage: this.config.defaultLeverage,
        openedAt: Date.now(),
        txHash: openResult.txHash,
        marketSymbol: market.symbol,
        managerAddr: market.managerAddr,
        poolAddr: market.poolAddr,
      };
      this.state.lastSide = side;
      this.state.sessionStats.opens++;
      saveState(this.state);
      this.log(`[OPEN] SUCCESS — position #${openResult.positionId} (${side})`, "success");
      return true;
    } else {
      this.log(`[BLOCKED] Open failed`, "error");
      return false;
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export { STATES, DEFAULT_AUTO_CONFIG, openPosition, closePositionFn, resolveTradingMarket, encodeOpenPositionCalldata, TxManager };
export default AutoTrader;
