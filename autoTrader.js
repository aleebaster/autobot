import { ethers } from "ethers";
import fs from "fs";
import { TokenInventory, EthSessionTracker, DEFAULT_ETH_GUARD } from "./tokenInventory.js";

// ═══════════════════════════════════════════════════════════════════════════
//  AUTONOMOUS TRADING LOOP — Nemesis Sepolia (V2 — CORRECTED)
//  FIX: openPosition ABI, borrowAmount, amountOutMin, oracle checkpoint
// ═══════════════════════════════════════════════════════════════════════════

const OPEN_POSITION_SELECTOR = "0xfa2b1dfd";
const CLOSE_POSITION_SELECTOR = "0xb35648d7";
const BPS = 10000n;

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
//  STATE MACHINE
// ═══════════════════════════════════════════════════════════════════════════

const STATES = {
  IDLE:               "IDLE",
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
  minCollateralUSD: 1,
  slippageBps: 50,
  deadlineSeconds: 1200,
  cooldownAfterOpenMs: 60_000,
  cooldownAfterCloseMs: 30_000,
  maxRetries: 3,
  retryDelayMs: 5000,
  dryRun: false,
  ethGuard: { ...DEFAULT_ETH_GUARD },
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
    log(`[RECOVERY] found active position #${positionId}`, "warn");
    return { positionId, side: "LONG", collateralToken: USDT, openedAt: lastOpen.blockNumber };
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

async function ensureOracleReady(wallet, poolAddress, side, provider, log = () => {}) {
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

  if (!needsCheckpoint) {
    log(`[ORACLE] Oracle is ready — no checkpoint needed`, "success");
    return;
  }

  // Step 5: Send checkpointOracle
  log(`[ORACLE] Sending Pool.checkpointOracle()...`, "warn");
  const poolWrite = new ethers.Contract(poolAddress, POOL_ABI, wallet);
  const feeParams = await getFeeParams(provider);
  let checkpointTx;
  try {
    checkpointTx = await poolWrite.checkpointOracle({ gasLimit: 500000n, ...feeParams });
    log(`[ORACLE] checkpointOracle tx hash=${checkpointTx.hash}`, "warn");
  } catch (cpErr) {
    const decodedErr = cpErr?.shortMessage || cpErr?.message || String(cpErr);
    log(`[ORACLE] checkpointOracle FAILED: ${decodedErr}`, "error");
    throw new Error(`checkpointOracle failed: ${decodedErr}`);
  }

  // Step 6: Wait for confirmations
  log(`[ORACLE] Waiting for ${ORACLE_CHECKPOINT_CONFIRMATIONS} confirmations...`, "info");
  try {
    await checkpointTx.wait(ORACLE_CHECKPOINT_CONFIRMATIONS);
    log(`[ORACLE] Checkpoint confirmed after ${ORACLE_CHECKPOINT_CONFIRMATIONS} blocks`, "success");
  } catch (confErr) {
    log(`[ORACLE] Checkpoint confirmation failed: ${confErr.message}`, "error");
    throw new Error(`checkpointOracle confirmation failed: ${confErr.message}`);
  }

  // Step 7: Re-verify
  try {
    const rpAfter = await pool.getRiskPrice();
    log(`[ORACLE] Post-checkpoint getRiskPrice: price0Avg=${rpAfter[0]} price1Avg=${rpAfter[1]}`, "info");
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

  let amountOutMinFinal = applySlippage(amountOutMinRaw, BigInt(50));
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

async function ensureCollateral({ wallet, provider, side, collateralAmount, config, log, dryRun }) {
  const walletAddr = wallet.address;
  const collateralToken = side === "LONG" ? USDT : WETH;
  const decimals = side === "LONG" ? 6 : 18;
  const sym = side === "LONG" ? "USDT" : "WETH";
  const tokenContract = new ethers.Contract(collateralToken, ERC20_ABI, provider);
  const balance = await tokenContract.balanceOf(walletAddr);

  log(`[SWAP-DEBUG] requiredCollateral=${ethers.formatUnits(collateralAmount, decimals)} ${sym}`, "info");
  log(`[SWAP-DEBUG] currentCollateral=${ethers.formatUnits(balance, decimals)} ${sym}`, "info");
  log(`[SWAP-DEBUG] router=${routerAddr || "0x8f6eB7870334b1FD8006Fd52413f01689f4E57e9"}`, "info");

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

  const sources = side === "LONG" ? LONG_SOURCES : SHORT_SOURCES;
  const routerAddr = "0x8f6eB7870334b1FD8006Fd52413f01689f4E57e9";
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
        amount: safeSwapAmount, amountOutMin, config, log,
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

  // Last resort: ETH → WETH
  if (side === "SHORT") {
    const ethBalance = await provider.getBalance(walletAddr);
    const gasReserve = ethers.parseEther(String(config.ethGuard?.MIN_ETH_GAS_RESERVE || 0.003));
    const ethAvail = ethBalance - gasReserve - ethers.parseEther("0.005");
    if (ethAvail > ethers.parseEther("0.001")) {
      log(`[SWAP] Last resort: ETH → WETH (${ethers.formatEther(ethAvail)} available)`, "warn");
      const wethContract = new ethers.Contract(WETH, ["function deposit() payable", "function balanceOf(address) view returns (uint256)"], wallet);
      const wrapTx = await wethContract.deposit({ value: ethAvail, gasLimit: 100000n });
      await wrapTx.wait();
      log(`[SWAP] Wrapped ${ethers.formatEther(ethAvail)} ETH → WETH`, "success");
      const wethBal = await new ethers.Contract(WETH, ERC20_ABI, provider).balanceOf(walletAddr);
      if (wethBal >= collateralAmount) {
        log(`[COLLATERAL] VERIFIED — WETH sufficient after wrap`, "success");
        return true;
      }
    }
  }

  log(`[SWAP] BLOCKED — no source token can cover deficit`, "error");
  return false;
}

async function executeSwap({ wallet, provider, fromToken, toToken, amount, amountOutMin, config, log }) {
  const walletAddr = wallet.address;
  const routerAddr = "0x8f6eB7870334b1FD8006Fd52413f01689f4E57e9";
  const router = new ethers.Contract(routerAddr, ROUTER_ABI, wallet);
  const fromContract = new ethers.Contract(fromToken, ERC20_ABI, wallet);
  const fromSym = fromToken === USDT ? "USDT" : fromToken === USDC ? "USDC" : "WETH";

  const allowance = await fromContract.allowance(walletAddr, routerAddr);
  log(`[SWAP-DEBUG] executeSwap: from=${fromSym} to=${toToken === USDT ? "USDT" : toToken === WETH ? "WETH" : "???"} amount=${ethers.formatUnits(amount, fromToken === WETH ? 18 : 6)} allowance=${ethers.formatUnits(allowance, fromToken === WETH ? 18 : 6)}`, "info");
  if (allowance < amount) {
    log(`[SWAP] Approve ${fromSym} → Router...`, "info");
    const approveTx = await fromContract.approve(routerAddr, ethers.MaxUint256, { gasLimit: 100000n });
    await approveTx.wait();
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
  const gasReserve = ethers.parseEther(String(config.ethGuard?.MIN_ETH_GAS_RESERVE || 0.003));
  log(`[SWAP-DEBUG] ethBalance=${ethers.formatEther(ethBalance)} gasCost=${ethers.formatEther(gasCost)} gasReserve=${ethers.formatEther(gasReserve)}`, "info");
  if (ethBalance < gasCost + gasReserve) { log(`[SWAP] BLOCKED: ETH < gas reserve`, "error"); return false; }

  const gasLimit = gasEstimate + gasEstimate / 5n;
  log(`[SWAP] TX_SENT`, "warn");
  const swapTx = await router.swapExactTokensForTokens(amount, amountOutMin, path, walletAddr, deadline, { gasLimit });
  log(`[SWAP] TX hash=${swapTx.hash}`, "info");
  const receipt = await swapTx.wait();
  if (receipt.status !== 1) { log(`[SWAP] TX FAILED (status=0)`, "error"); return false; }
  log(`[SWAP] SUCCESS gas=${receipt.gasUsed}`, "success");
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════
//  OPEN POSITION — CORRECTED (with oracle checkpoint + proper quote)
// ═══════════════════════════════════════════════════════════════════════════

async function openPosition({ wallet, provider, managerAddr, poolAddr, side, collateralToken, collateralAmount, leverage, config, log, dryRun }) {
  const walletAddr = wallet.address;
  const isLong = side === "LONG";
  const decimals = isLong ? 6 : 18;
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
    await ensureOracleReady(wallet, poolAddr, side, provider, log);
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
    const approveTx = await token.approve(managerAddr, ethers.MaxUint256, { gasLimit: 100000n });
    await approveTx.wait();
    log(`[OPEN] Approved`, "success");
  }

  // Encode calldata — CORRECT parameter order
  const deadline = Math.floor(Date.now() / 1000) + config.deadlineSeconds;
  const coder = ethers.AbiCoder.defaultAbiCoder();

  // Pre-flight simulation — encode calldata with the computed amountOutMin
  const encodeCalldata = (aom) => {
    const p = coder.encode(
      ["bool", "address", "uint256", "uint256", "uint256", "uint256", "uint256"],
      [isLong, collateralToken, collateralAmount, borrowAmount, leverageX10, aom, BigInt(deadline)]
    );
    return OPEN_POSITION_SELECTOR + p.slice(2);
  };

  let calldata = encodeCalldata(amountOutMin);

  // Attempt 1: pre-flight with computed amountOutMin
  try {
    await provider.call({ from: walletAddr, to: managerAddr, data: calldata, value: 0n });
    log(`[PREFLIGHT] isLong=${isLong} collateralToken=${collateralToken === USDT ? "USDT" : "WETH"} collateralAmount=${collateralAmount} leverageX10=${leverageX10} borrowAmount=${borrowAmount} amountOutMin=${amountOutMin} deadline=${deadline}`, "info");
    log(`[PREFLIGHT] PASS`, "success");
  } catch (e) {
    const revertData = e?.data || e?.info?.error?.data || e?.cause?.data || e?.cause?.info?.error?.data || null;
    const match = (e?.shortMessage || e?.message || "").match(/0x[0-9a-fA-F]{8,}/);
    const rawRevert = revertData || match?.[0] || "unknown";
    log(`[PREFLIGHT] isLong=${isLong} collateralToken=${collateralToken === USDT ? "USDT" : "WETH"} collateralAmount=${collateralAmount} leverageX10=${leverageX10} borrowAmount=${borrowAmount} amountOutMin=${amountOutMin} deadline=${deadline}`, "info");
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
        log(`[BLOCKED] MAM_OpenOracleDivergence — oracle needs checkpoint`, "error");
      }
      return null;
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
  const gasReserve = ethers.parseEther(String(config.ethGuard?.MIN_ETH_GAS_RESERVE || 0.003));
  if (ethBalance < gasCost + gasReserve) {
    log(`[BLOCKED] ETH ${ethers.formatEther(ethBalance)} below gas reserve`, "error");
    return null;
  }

  // Send TX
  const gasLimit = gasEstimate + gasEstimate / 5n;
  log(`[OPEN] Sending openPosition TX...`, "warn");
  const tx = await wallet.sendTransaction({ to: managerAddr, data: calldata, value: 0n, gasLimit });
  log(`[OPEN] TX: ${tx.hash}`, "info");

  const receipt = await tx.wait();
  if (receipt.status !== 1) {
    log(`[BLOCKED] TX FAILED (status=0)`, "error");
    return null;
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
  return { txHash: tx.hash, positionId, gasUsed: receipt.gasUsed, blockNumber: receipt.blockNumber };
}

// ═══════════════════════════════════════════════════════════════════════════
//  CLOSE POSITION
// ═══════════════════════════════════════════════════════════════════════════

async function closePositionFn({ wallet, provider, managerAddr, positionId, config, log, dryRun }) {
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
  log(`[CLOSE] Sending closePosition TX...`, "warn");
  const tx = await wallet.sendTransaction({ to: managerAddr, data: calldata, value: 0n, gasLimit });
  log(`[CLOSE] TX: ${tx.hash}`, "info");

  const receipt = await tx.wait();
  if (receipt.status !== 1) {
    log(`[BLOCKED] Close TX FAILED (status=0)`, "error");
    return null;
  }

  log(`[CLOSE] SUCCESS gas=${receipt.gasUsed}`, "success");
  return { txHash: tx.hash, gasUsed: receipt.gasUsed, blockNumber: receipt.blockNumber };
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
    this.currentState = STATES.IDLE;
    this._logListeners = [];
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

  getManagerAddr() {
    const confirmedPools = this.deps.confirmedPools || {};
    return confirmedPools["ETH/USDT"]?.manager || "0x2069b502DD917DC089171F96BeE390FcB5bad29d";
  }

  getPoolAddr() {
    const confirmedPools = this.deps.confirmedPools || {};
    return confirmedPools["ETH/USDT"]?.pool || "0xf32E24b7F739c7C17544cb972833aB551121A72B";
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
      const managerAddr = this.getManagerAddr();
      const poolAddr = this.getPoolAddr();

      this.log("[CYCLE] ═══ CYCLE START ═══", "info");

      // PHASE 1: If active position → CLOSE
      if (this.state.activePosition) {
        this.setState(STATES.CLOSE);
        this.log(`[CLOSE] position #${this.state.activePosition.positionId} (${this.state.activePosition.side})`, "warn");

        const closeResult = await closePositionFn({
          wallet, provider, managerAddr,
          positionId: this.state.activePosition.positionId,
          config: this.config, log: this.log.bind(this), dryRun,
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

      // PHASE 3: PREPARE COLLATERAL
      this.setState(STATES.PREPARE_COLLATERAL);
      const collateralToken = side === "LONG" ? USDT : WETH;
      const collateralDecimals = side === "LONG" ? 6 : 18;
      const collateralSym = side === "LONG" ? "USDT" : "WETH";
      const targetStr = side === "LONG"
        ? (this.config.targetCollateralUSDT || "10")
        : (this.config.targetCollateralWETH || "0.002");
      const collateralAmount = side === "LONG"
        ? ethers.parseUnits(targetStr, 6)
        : ethers.parseEther(targetStr);

      const tokenContract = new ethers.Contract(collateralToken, ERC20_ABI, provider);
      const balance = await tokenContract.balanceOf(walletAddr);
      this.log(`[COLLATERAL] target=${collateralSym} required=${ethers.formatUnits(collateralAmount, collateralDecimals)} balance=${ethers.formatUnits(balance, collateralDecimals)}`, "info");

      if (collateralAmount <= 0n) {
        this.log(`[BLOCKED] Invalid collateral target`, "error");
        return;
      }

      // Swap if needed
      if (balance >= collateralAmount) {
        this.log(`[COLLATERAL] SUFFICIENT — no swap needed`, "success");
      } else {
        this.setState(STATES.SWAP);
        this.log(`[SWAP] needed for collateral`, "warn");
        const swapOk = await ensureCollateral({
          wallet, provider, side, collateralAmount, config: this.config,
          log: this.log.bind(this), dryRun,
        });
        if (!swapOk) {
          this.log(`[BLOCKED] Cannot obtain collateral. Skipping.`, "error");
          return;
        }
        const postSwapBalance = await tokenContract.balanceOf(walletAddr);
        if (postSwapBalance < collateralAmount) {
          this.log(`[BLOCKED] Collateral still insufficient after swap`, "error");
          return;
        }
        this.log(`[COLLATERAL] Post-swap balance: ${ethers.formatUnits(postSwapBalance, collateralDecimals)} ${collateralSym}`, "success");
      }

      // PHASE 4: OPEN
      this.setState(STATES.OPEN);
      this.log(`[OPEN] ${side} ${this.config.defaultLeverage}x...`, "warn");

      const openResult = await openPosition({
        wallet, provider, managerAddr, poolAddr, side, collateralToken, collateralAmount,
        leverage: this.config.defaultLeverage,
        config: this.config, log: this.log.bind(this), dryRun,
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

      this.log("[CYCLE] ═══ CYCLE END ═══", "info");
    } catch (e) {
      this.log(`[ERROR] Cycle error: ${e.message?.slice(0, 80)}`, "error");
    } finally {
      this.cycleRunning = false;
    }
  }

  async start() {
    if (this.running) { this.log("[AUTO] Already running.", "warn"); return; }
    this.running = true;
    this.stopRequested = false;
    this.log("══════════════════════════════════════════════", "warn");
    this.log("  AUTONOMOUS TRADING LOOP STARTED", "warn");
    this.log(`  Interval: ${this.config.autoLoopIntervalMs / 1000}s`, "info");
    this.log(`  Leverage: ${this.config.defaultLeverage}x`, "info");
    this.log(`  Dry run: ${this.config.dryRun}`, "info");
    this.log("══════════════════════════════════════════════", "warn");

    // Restart recovery
    this.log("[RECOVERY] scanning on-chain for active positions...", "info");
    const { provider } = this.getRuntime();
    const recovered = await recoverPosition(
      provider, this.deps.accounts[this.deps.selectedWalletIndex].address,
      this.getManagerAddr(), this.log.bind(this),
    );
    if (recovered) {
      this.log(`[RECOVERED] position #${recovered.positionId} side=${recovered.side}`, "warn");
      this.state.activePosition = recovered;
      this.state.sessionStats.opens++;
      saveState(this.state);
    } else if (this.state.activePosition) {
      this.log(`[WARN] Local state had position but on-chain says none — clearing`, "warn");
      this.state.activePosition = null;
      saveState(this.state);
    }

    while (!this.stopRequested) {
      try { await this.runCycle(); }
      catch (e) { this.log(`[ERROR] Unhandled: ${e.message?.slice(0, 80)}`, "error"); }
      if (!this.stopRequested && this.config.autoLoopIntervalMs > 0) {
        await this.sleep(this.config.autoLoopIntervalMs);
      }
    }
    this.running = false;
    this.log("[AUTO] Trading loop stopped.", "warn");
  }

  stop() {
    this.stopRequested = true;
    this.log("[AUTO] Stop requested.", "warn");
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export { STATES, DEFAULT_AUTO_CONFIG, openPosition, closePositionFn };
export default AutoTrader;
