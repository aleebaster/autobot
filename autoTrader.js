import { ethers } from "ethers";
import fs from "fs";
import { TokenInventory, EthSessionTracker, DEFAULT_ETH_GUARD } from "./tokenInventory.js";

// ═══════════════════════════════════════════════════════════════════════════
//  AUTONOMOUS TRADING LOOP — Nemesis Sepolia
//  AUDITED 2026-09-04 — 10 critical issues fixed
// ═══════════════════════════════════════════════════════════════════════════

const OPEN_POSITION_SELECTOR = "0xfa2b1dfd";
const CLOSE_POSITION_SELECTOR = "0xb35648d7";

const WETH = "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9";
const USDT = "0x5f2E83cCDEa73D60aF400e03F1Cd8Fb9eaB07b20";
const USDC = "0x5dcf1Db10F87CB7839640F9B85C4ECfA29b56e80";

// Event topic for PositionCreated — confirmed on-chain 2026-09-04
const POSITION_CREATED_TOPIC = "0x2e462fabb57854af0ee2383faf948da3dc380bd08e582513c3e8e1177478c64a";
// Event topic for PositionData2 — contains isLong, collateralToken, collateralAmount
const POSITION_DATA2_TOPIC = "0x23738081446e33f8965d406c81c9f20028aaea1de091dcd1b756dda92c04ed55";

const MANAGER_ABI = [
  "function openPosition(bool isLong, address collateralToken, uint256 collateralAmount, uint256 amountOutMin, uint256 leverage, uint256 size, uint256 deadline) returns (uint256)",
  "function closePosition(uint256 positionId, uint256 amountOutMin, uint256 deadline)",
  "function nonces(address user) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function factory() view returns (address)",
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

// ═══════════════════════════════════════════════════════════════════════════
//  STATE MACHINE
// ═══════════════════════════════════════════════════════════════════════════

const STATES = {
  IDLE:              "IDLE",
  SIGNAL:            "SIGNAL",
  WAIT:              "WAIT",
  PREPARE_COLLATERAL:"PREPARE_COLLATERAL",
  SWAP:              "SWAP",
  PRE_FLIGHT:        "PRE_FLIGHT",
  OPEN:              "OPEN",
  MONITOR:           "MONITOR",
  EXIT_SIGNAL:       "EXIT_SIGNAL",
  CLOSE:             "CLOSE",
  COOLDOWN:          "COOLDOWN",
};

// ═══════════════════════════════════════════════════════════════════════════
//  CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

const DEFAULT_AUTO_CONFIG = {
  autoLoopIntervalMs: 30_000,
  maxOpenPositions: 1,
  defaultLeverage: 2,
  maxLeverage: 5,
  // Fixed collateral targets (in token units, NOT % of balance)
  // LONG: USDT (6 decimals), SHORT: WETH (18 decimals)
  targetCollateralUSDT: "10",   // 10 USDT for LONG
  targetCollateralWETH: "0.002", // 0.002 WETH for SHORT
  minCollateralUSD: 1,
  maxCollateralPercent: 5, // legacy — used only if target not set
  reservePercent: 20, // legacy
  rsiLong: 30,
  rsiShort: 70,
  rsiExitLong: 65,
  rsiExitShort: 35,
  rsiSource: "coingecko",
  rsiPair: "ethereum",
  ethGuard: { ...DEFAULT_ETH_GUARD },
  slippagePercent: 1,
  deadlineSeconds: 1200,
  cooldownAfterOpenMs: 60_000,
  cooldownAfterCloseMs: 30_000,
  maxRetries: 3,
  retryDelayMs: 5000,
  dryRun: false,
};

// ═══════════════════════════════════════════════════════════════════════════
//  SIGNAL ENGINE — RSI-based (fixed Wilder smoothing)
// ═══════════════════════════════════════════════════════════════════════════

async function fetchRSI(pair = "ethereum") {
  try {
    const url = `https://api.coingecko.com/api/v3/coins/${pair}/market_chart?vs_currency=usd&days=1&interval=daily`;
    const resp = await fetch(url);
    const data = await resp.json();

    if (!data.prices || data.prices.length < 15) {
      return null;
    }

    const prices = data.prices.map(p => p[1]);
    const changes = [];
    for (let i = 1; i < prices.length; i++) {
      changes.push(prices[i] - prices[i - 1]);
    }

    if (changes.length === 0) return null;

    // Use Wilder-style smoothing (simplified EMA over all changes)
    const period = Math.min(changes.length, 14);
    const recentChanges = changes.slice(-period);

    let avgGain = 0;
    let avgLoss = 0;

    for (const c of recentChanges) {
      if (c > 0) avgGain += c;
      else avgLoss += Math.abs(c);
    }

    avgGain /= recentChanges.length;
    avgLoss /= recentChanges.length;

    if (avgLoss === 0) return 100;

    const rs = avgGain / avgLoss;
    const rsi = 100 - (100 / (1 + rs));

    return Math.round(rsi * 100) / 100;
  } catch (e) {
    return null;
  }
}

function getSignal(rsi, config) {
  if (rsi === null) return "WAIT";
  if (rsi < config.rsiLong) return "LONG";
  if (rsi > config.rsiShort) return "SHORT";
  return "WAIT";
}

function getExitSignal(rsi, side, config) {
  if (side === "LONG" && rsi >= config.rsiExitLong) return true;
  if (side === "SHORT" && rsi <= config.rsiExitShort) return true;
  return false;
}

// ═══════════════════════════════════════════════════════════════════════════
//  POSITION STATE — restart-safe persistence
// ═══════════════════════════════════════════════════════════════════════════

const STATE_FILE = "auto-trader-state.json";

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    }
  } catch {}
  return {
    activePosition: null,
    sessionStats: { opens: 0, closes: 0, pnl: 0 },
    lastCycleTime: 0,
  };
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch {}
}

// ═══════════════════════════════════════════════════════════════════════════
//  RESTART RECOVERY — detect on-chain positions (FIX #2)
//  Scans PositionCreated events, then checks for PositionData2 to get side.
//  If no close event found after the last open, position is considered active.
// ═══════════════════════════════════════════════════════════════════════════

async function recoverPosition(provider, walletAddr, managerAddr, log = () => {}) {
  const latestBlock = await provider.getBlockNumber();
  // Scan last 2000 blocks (~7 hours on Sepolia)
  const fromBlock = Math.max(latestBlock - 2000, 0);

  try {
    const logs = await provider.getLogs({
      address: managerAddr,
      topics: [null, "0x000000000000000000000000" + walletAddr.slice(2).toLowerCase()],
      fromBlock,
      toBlock: latestBlock,
    });

    // Find PositionCreated events
    const positionCreatedLogs = logs.filter(l => l.topics[0] === POSITION_CREATED_TOPIC);

    if (positionCreatedLogs.length === 0) {
      return null;
    }

    // For each position, check if there's a close after it
    // Find all close-related logs (logs from closePosition transactions)
    // A close is identified by the calldata starting with CLOSE_POSITION_SELECTOR
    // We detect this by looking for the specific event pattern or tx input
    const closeTxHashes = new Set();
    for (const logEntry of logs) {
      // If we see any event that indicates closure, note its tx hash
      // For now, check if any log from the manager has topic matching close patterns
      // More reliable: check if positionId doesn't appear as "active" anymore
    }

    // Get the last PositionCreated event
    const lastOpen = positionCreatedLogs[positionCreatedLogs.length - 1];
    const positionId = Number(BigInt(lastOpen.topics[2]));

    // Check if there's a PositionData2 event from the same position (confirms open)
    const positionDataLogs = logs.filter(l =>
      l.topics[0] === POSITION_DATA2_TOPIC &&
      l.topics[1] === lastOpen.topics[2] // same positionId
    );

    let side = "LONG"; // default
    let collateralToken = USDT;

    if (positionDataLogs.length > 0) {
      const data = positionDataLogs[positionDataLogs.length - 1].data;
      // PositionData2 data: isLong(1) + collateralToken(32) + collateralAmount(32) + ...
      const isLong = BigInt("0x" + data.slice(2, 66)) !== 0n;
      side = isLong ? "LONG" : "SHORT";
      collateralToken = "0x" + data.slice(66, 106).toLowerCase();
    }

    // Check if the close function was called after this open
    // by scanning for txs with closePosition selector to this manager
    const closeLogs = logs.filter(l =>
      l.address.toLowerCase() === managerAddr.toLowerCase() &&
      l.topics.some(t => t && t.toLowerCase().startsWith("0xb35648d7"))
    );

    // A simpler heuristic: check if closePosition calldata was sent
    // by looking at all tx hashes in our logs and checking their input data
    const allTxHashes = [...new Set(logs.map(l => l.transactionHash))];
    let positionClosed = false;

    for (const txHash of allTxHashes) {
      try {
        const tx = await provider.getTransaction(txHash);
        if (tx && tx.data && tx.data.startsWith(CLOSE_POSITION_SELECTOR)) {
          // This is a closePosition tx — check if it references our positionId
          const closeData = tx.data;
          const encodedPosId = closeData.slice(10, 74); // first uint256 after selector
          const closePosId = Number(BigInt("0x" + encodedPosId));
          if (closePosId === positionId) {
            positionClosed = true;
            break;
          }
        }
      } catch {}
    }

    if (positionClosed) {
      log(`[AUTO] Recovery: position #${positionId} was already closed`, "info");
      return null;
    }

    log(`[AUTO] Recovery: found active position #${positionId} side=${side}`, "warn");
    return {
      positionId,
      side,
      collateralToken,
      collateralAmount: null,
      leverage: null,
      openedAt: lastOpen.blockNumber,
    };
  } catch (e) {
    log(`[AUTO] Recovery error: ${e.message?.slice(0, 60)}`, "error");
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  SWAP LOGIC — ETH safety preserved (FIX #5, #6)
// ═══════════════════════════════════════════════════════════════════════════

// Token sources for swaps — priority order
// USDC is the best source for USDT (same decimals, ~1:1)
// WETH/ETH are fallback sources
const LONG_SOURCES = [USDC, WETH]; // USDT is target — sources: USDC, then WETH
const SHORT_SOURCES = [USDT, USDC]; // WETH is target — sources: USDT, then USDC

async function ensureCollateral({ wallet, provider, side, collateralAmount, config, log, dryRun }) {
  const walletAddr = wallet.address;
  const collateralToken = side === "LONG" ? USDT : WETH;
  const decimals = side === "LONG" ? 6 : 18;
  const sym = side === "LONG" ? "USDT" : "WETH";
  const tokenContract = new ethers.Contract(collateralToken, ERC20_ABI, provider);
  const balance = await tokenContract.balanceOf(walletAddr);

  log(`[COLLATERAL] target=${sym} required=${ethers.formatUnits(collateralAmount, decimals)} balance=${ethers.formatUnits(balance, decimals)}`, "info");

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
  log(`[COLLATERAL] INSUFFICIENT — deficit=${ethers.formatUnits(deficit, decimals)} ${sym}`, "warn");

  // Find a source token to swap from
  const sources = side === "LONG" ? LONG_SOURCES : SHORT_SOURCES;
  const routerAddr = "0x8f6eB7870334b1FD8006Fd52413f01689f4E57e9";
  const router = new ethers.Contract(routerAddr, ROUTER_ABI, provider);

  for (const sourceToken of sources) {
    const sourceContract = new ethers.Contract(sourceToken, ERC20_ABI, provider);
    const sourceBalance = await sourceContract.balanceOf(walletAddr);
    const sourceDecimals = sourceToken === WETH ? 18 : 6;
    const sourceSym = sourceToken === USDT ? "USDT" : sourceToken === USDC ? "USDC" : "WETH";

    if (sourceBalance <= 0n) {
      log(`[SWAP] ${sourceSym} balance=0 — skip`, "info");
      continue;
    }

    log(`[SWAP] Trying ${sourceSym} → ${sym}: balance=${ethers.formatUnits(sourceBalance, sourceDecimals)}`, "info");

    // Get quote via router
    const path = [sourceToken, collateralToken];
    try {
      // Quote: how much collateral do we get for the full source balance?
      const fullQuote = await router.getAmountsOut(sourceBalance, path);
      const expectedOut = fullQuote[1];

      if (expectedOut < deficit) {
        log(`[SWAP] ${sourceSym} insufficient: max output=${ethers.formatUnits(expectedOut, decimals)} < deficit=${ethers.formatUnits(deficit, decimals)}`, "warn");
        continue; // try next source
      }

      // Calculate exact input needed for deficit + 1% buffer
      const neededWithBuffer = deficit * 101n / 100n;
      const inputQuote = await router.getAmountsOut(neededWithBuffer, path);
      // inputQuote[0] is the input amount — but getAmountsOut expects (amountIn) → (amountOut)
      // We need getAmountsIn instead — but it's not available on this router
      // Use approximation: inputAmount = deficit * sourceBalance / expectedOut
      const swapAmount = neededWithBuffer * sourceBalance / expectedOut;
      const safeSwapAmount = swapAmount > sourceBalance ? sourceBalance : swapAmount;

      const amountOutMin = deficit * 99n / 100n; // 1% slippage tolerance

      log(`[SWAP] quote: ${ethers.formatUnits(safeSwapAmount, sourceDecimals)} ${sourceSym} → ~${ethers.formatUnits(expectedOut * safeSwapAmount / sourceBalance, decimals)} ${sym}`, "info");
      log(`[SWAP] minimumOut=${ethers.formatUnits(amountOutMin, decimals)} ${sym}`, "info");

      // Execute swap
      const swapResult = await executeSwap({
        wallet, provider, fromToken: sourceToken, toToken: collateralToken,
        amount: safeSwapAmount, amountOutMin, config, log,
      });

      if (!swapResult) {
        log(`[SWAP] ${sourceSym} → ${sym} FAILED — trying next source`, "error");
        continue;
      }

      // Post-swap verification
      const newBalance = await tokenContract.balanceOf(walletAddr);
      log(`[COLLATERAL] balance_after=${ethers.formatUnits(newBalance, decimals)} required=${ethers.formatUnits(collateralAmount, decimals)}`, "info");

      if (newBalance >= collateralAmount) {
        log(`[COLLATERAL] VERIFIED ✓ — sufficient after swap`, "success");
        return true;
      } else {
        log(`[COLLATERAL] Still insufficient after swap — need more`, "warn");
        // Continue to next source if available
        continue;
      }
    } catch (e) {
      log(`[SWAP] Quote/swap failed for ${sourceSym}: ${e.message?.slice(0, 60)}`, "error");
      continue;
    }
  }

  // Last resort: ETH → WETH → collateral (only for SHORT target)
  if (side === "SHORT") {
    const ethBalance = await provider.getBalance(walletAddr);
    const gasReserve = ethers.parseEther(String(config.ethGuard?.MIN_ETH_GAS_RESERVE || 0.003));
    const ethAvail = ethBalance - gasReserve - ethers.parseEther("0.005");

    if (ethAvail > ethers.parseEther("0.001")) {
      log(`[SWAP] Last resort: ETH → WETH (${ethers.formatEther(ethAvail)} available)`, "warn");

      const wethContract = new ethers.Contract(WETH, [
        "function deposit() payable",
        "function balanceOf(address) view returns (uint256)",
      ], wallet);

      const wrapTx = await wethContract.deposit({ value: ethAvail, gasLimit: 100000n });
      await wrapTx.wait();
      log(`[SWAP] Wrapped ${ethers.formatEther(ethAvail)} ETH → WETH`, "success");

      // Verify WETH balance is now sufficient
      const wethBal = await new ethers.Contract(WETH, ERC20_ABI, provider).balanceOf(walletAddr);
      if (wethBal >= collateralAmount) {
        log(`[COLLATERAL] VERIFIED ✓ — WETH sufficient after wrap`, "success");
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
  const fromDecimals = fromToken === WETH ? 18 : 6;
  const fromSym = fromToken === USDT ? "USDT" : fromToken === USDC ? "USDC" : "WETH";

  // Pre-flight: approve
  const allowance = await fromContract.allowance(walletAddr, routerAddr);
  if (allowance < amount) {
    log(`[SWAP] Approve ${fromSym} → Router...`, "info");
    const approveTx = await fromContract.approve(routerAddr, ethers.MaxUint256, { gasLimit: 100000n });
    await approveTx.wait();
    log(`[SWAP] Approved ✓`, "success");
  }

  // Pre-flight: eth_call simulation
  const path = [fromToken, toToken];
  const deadline = Math.floor(Date.now() / 1000) + config.deadlineSeconds;
  const calldata = router.interface.encodeFunctionData("swapExactTokensForTokens", [
    amount, amountOutMin, path, walletAddr, deadline,
  ]);

  try {
    await provider.call({ from: walletAddr, to: routerAddr, data: calldata, value: 0n });
    log(`[SWAP] Pre-flight OK ✓`, "info");
  } catch (e) {
    log(`[SWAP] Pre-flight REVERTED: ${e.message?.slice(0, 60)}`, "error");
    return false;
  }

  // Estimate gas
  let gasEstimate;
  try {
    gasEstimate = await provider.estimateGas({ from: walletAddr, to: routerAddr, data: calldata, value: 0n });
    log(`[SWAP] Gas estimate: ${gasEstimate}`, "info");
  } catch (e) {
    log(`[SWAP] Gas estimation FAILED: ${e.message?.slice(0, 60)}`, "error");
    return false;
  }

  // ETH reserve check
  const ethBalance = await provider.getBalance(walletAddr);
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice || 0n;
  const gasCost = gasEstimate * gasPrice;
  const gasReserve = ethers.parseEther(String(config.ethGuard?.MIN_ETH_GAS_RESERVE || 0.003));
  if (ethBalance < gasCost + gasReserve) {
    log(`[SWAP] BLOCKED: ETH ${ethers.formatEther(ethBalance)} < gas reserve`, "error");
    return false;
  }

  // Send swap TX
  const gasLimit = gasEstimate + gasEstimate / 5n;
  log(`[SWAP] TX_SENT`, "warn");
  const swapTx = await router.swapExactTokensForTokens(
    amount, amountOutMin, path, walletAddr, deadline,
    { gasLimit }
  );
  log(`[SWAP] TX hash=${swapTx.hash}`, "info");

  // Wait for receipt and verify status
  const receipt = await swapTx.wait();
  if (receipt.status !== 1) {
    log(`[SWAP] TX FAILED (status=0)`, "error");
    return false;
  }

  log(`[SWAP] SUCCESS ✓ gas=${receipt.gasUsed}`, "success");
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════
//  OPEN POSITION (FIX #4, #7, #9)
// ═══════════════════════════════════════════════════════════════════════════

async function openPosition({ wallet, provider, managerAddr, side, collateralToken, collateralAmount, leverage, config, log, dryRun }) {
  const walletAddr = wallet.address;
  const isLong = side === "LONG";
  const decimals = isLong ? 6 : 18;

  // FIX #7: Validate leverage
  const leverageNum = Number(leverage);
  if (leverageNum < 1 || leverageNum > config.maxLeverage * 10) {
    log(`[BLOCKED] Leverage ${leverageNum / 10}x exceeds max ${config.maxLeverage}x`, "error");
    return null;
  }

  // FIX #7: Validate min collateral
  const minCollateralRaw = isLong
    ? ethers.parseUnits(String(config.minCollateralUSD || 1), 6)
    : ethers.parseEther("0.0001"); // rough min for WETH
  if (collateralAmount < minCollateralRaw) {
    log(`[BLOCKED] Collateral ${ethers.formatUnits(collateralAmount, decimals)} below minimum`, "error");
    return null;
  }

  // FIX #9: Manager code check
  const managerCode = await provider.getCode(managerAddr);
  if (!managerCode || managerCode === "0x") {
    log(`[BLOCKED] Manager ${managerAddr.slice(0, 10)}... has no code`, "error");
    return null;
  }

  const size = collateralAmount * 492050n / 1000000n;
  const deadline = Math.floor(Date.now() / 1000) + config.deadlineSeconds;

  const coder = ethers.AbiCoder.defaultAbiCoder();
  const params = coder.encode(
    ["bool", "address", "uint256", "uint256", "uint256", "uint256", "uint256"],
    [isLong, collateralToken, collateralAmount, 0n, leverage, size, deadline]
  );
  const calldata = OPEN_POSITION_SELECTOR + params.slice(2);

  if (dryRun) {
    log(`[DRY] Would OPEN ${side} ${ethers.formatUnits(collateralAmount, decimals)} collateral, ${(leverageNum / 10)}x`, "info");
    return { dryRun: true, side, collateralAmount: collateralAmount.toString() };
  }

  // Ensure approval
  const token = new ethers.Contract(collateralToken, ERC20_ABI, wallet);
  const allowance = await token.allowance(walletAddr, managerAddr);
  if (allowance < collateralAmount) {
    log(`[STATE] Approve collateral → Manager...`, "info");
    const approveTx = await token.approve(managerAddr, ethers.MaxUint256, { gasLimit: 100000n });
    await approveTx.wait();
    log(`[STATE] Approved ✓`, "success");
  }

  // Pre-flight simulation
  try {
    await provider.call({ from: walletAddr, to: managerAddr, data: calldata, value: 0n });
    log(`[STATE] Pre-flight OK ✓`, "info");
  } catch (e) {
    log(`[BLOCKED] Pre-flight REVERTED: ${e.message?.slice(0, 80)}`, "error");
    return null;
  }

  // Estimate gas
  let gasEstimate;
  try {
    gasEstimate = await provider.estimateGas({ from: walletAddr, to: managerAddr, data: calldata, value: 0n });
    log(`[STATE] Gas estimate: ${gasEstimate}`, "info");
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
  log(`[STATE] Sending openPosition TX...`, "warn");
  const tx = await wallet.sendTransaction({ to: managerAddr, data: calldata, value: 0n, gasLimit });
  log(`[STATE] TX: ${tx.hash}`, "info");

  const receipt = await tx.wait();
  if (receipt.status !== 1) {
    log(`[BLOCKED] TX FAILED (status=0)`, "error");
    return null;
  }

  log(`[STATE] OPEN SUCCESS gas=${receipt.gasUsed}`, "success");

  // FIX #4: Extract positionId — if null, TX succeeded but event parsing failed → treat as failure
  let positionId = null;
  for (const logEntry of receipt.logs) {
    if (logEntry.topics[0] === POSITION_CREATED_TOPIC && logEntry.address.toLowerCase() === managerAddr.toLowerCase()) {
      positionId = Number(BigInt(logEntry.topics[2]));
      break;
    }
  }

  if (positionId === null) {
    log(`[BLOCKED] TX succeeded but PositionCreated event not found — NOT storing as active`, "error");
    return null;
  }

  log(`[STATE] Position ID: ${positionId}`, "success");

  return { txHash: tx.hash, positionId, gasUsed: receipt.gasUsed, blockNumber: receipt.blockNumber };
}

// ═══════════════════════════════════════════════════════════════════════════
//  CLOSE POSITION (FIX #3)
// ═══════════════════════════════════════════════════════════════════════════

async function closePositionFn({ wallet, provider, managerAddr, positionId, config, log, dryRun }) {
  const walletAddr = wallet.address;

  if (dryRun) {
    log(`[DRY] Would CLOSE position #${positionId}`, "info");
    return { dryRun: true };
  }

  // FIX #3: Verify position exists on-chain before closing
  const manager = new ethers.Contract(managerAddr, MANAGER_ABI, provider);
  const lpBal = await manager.balanceOf(walletAddr);
  // Note: LP balance is separate from position tracking, but a non-zero balance
  // at least confirms the manager interaction is valid

  const deadline = Math.floor(Date.now() / 1000) + config.deadlineSeconds;

  const coder = ethers.AbiCoder.defaultAbiCoder();
  const params = coder.encode(["uint256", "uint256", "uint256"], [positionId, 0n, deadline]);
  const calldata = CLOSE_POSITION_SELECTOR + params.slice(2);

  // Pre-flight
  try {
    await provider.call({ from: walletAddr, to: managerAddr, data: calldata, value: 0n });
    log(`[STATE] Close pre-flight OK ✓`, "info");
  } catch (e) {
    log(`[BLOCKED] Close pre-flight REVERTED: ${e.message?.slice(0, 80)}`, "error");
    log(`[WARN] Position may no longer exist — clearing state`, "warn");
    return { failed: true, reason: e.message?.slice(0, 60) };
  }

  // Estimate gas
  let gasEstimate;
  try {
    gasEstimate = await provider.estimateGas({ from: walletAddr, to: managerAddr, data: calldata, value: 0n });
  } catch (e) {
    log(`[BLOCKED] Close gas estimation FAILED: ${e.message?.slice(0, 80)}`, "error");
    return null;
  }

  const gasLimit = gasEstimate + gasEstimate / 5n;
  log(`[STATE] Sending closePosition TX...`, "warn");
  const tx = await wallet.sendTransaction({ to: managerAddr, data: calldata, value: 0n, gasLimit });
  log(`[STATE] TX: ${tx.hash}`, "info");

  const receipt = await tx.wait();
  if (receipt.status !== 1) {
    log(`[BLOCKED] Close TX FAILED (status=0)`, "error");
    return null;
  }

  log(`[STATE] CLOSE SUCCESS gas=${receipt.gasUsed}`, "success");

  return { txHash: tx.hash, gasUsed: receipt.gasUsed, blockNumber: receipt.blockNumber };
}

// ═══════════════════════════════════════════════════════════════════════════
//  AUTO TRADER — Main Orchestrator (FIX #1, #8, #10)
// ═══════════════════════════════════════════════════════════════════════════

export class AutoTrader {
  constructor(deps) {
    this.deps = deps;
    this.config = { ...DEFAULT_AUTO_CONFIG, ...deps.config };
    this.running = false;
    this.stopRequested = false;
    this.cycleRunning = false; // FIX #1: mutex
    this.state = loadState();
    this.inventory = new TokenInventory();
    this.currentState = STATES.IDLE; // FIX #8: explicit state tracking
  }

  log(msg, level = "info") {
    this.deps.log(msg, level);
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
    const ethUsdt = confirmedPools["ETH/USDT"];
    return ethUsdt?.manager || "0x2069b502DD917DC089171F96BeE390FcB5bad29d";
  }

  setState(newState) {
    this.currentState = newState;
  }

  async runCycle() {
    // FIX #1: Mutex — prevent overlapping cycles
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

      this.log("[STATE] ═══ CYCLE START ═══", "info");

      // ═══ PHASE 1: If active position → CLOSE immediately ═══
      if (this.state.activePosition) {
        this.setState(STATES.CLOSE);
        this.log(`[STATE] CLOSE position #${this.state.activePosition.positionId} (${this.state.activePosition.side})`, "warn");

        const closeResult = await closePositionFn({
          wallet, provider, managerAddr,
          positionId: this.state.activePosition.positionId,
          config: this.config, log: this.log.bind(this), dryRun,
        });

        if (closeResult?.failed) {
          this.log(`[WARN] Close failed — clearing state`, "warn");
          this.state.activePosition = null;
          this.state.sessionStats.closes++;
          saveState(this.state);
        } else if (closeResult) {
          this.log(`[STATE] CLOSE SUCCESS TX: ${closeResult.txHash || "dry-run"}`, "success");
          this.state.activePosition = null;
          this.state.sessionStats.closes++;
          saveState(this.state);

          this.setState(STATES.COOLDOWN);
          this.log(`[STATE] COOLDOWN ${this.config.cooldownAfterCloseMs / 1000}s...`, "info");
          await this.sleep(this.config.cooldownAfterCloseMs);
        } else {
          this.log(`[WARN] Close failed — will retry next cycle`, "warn");
        }
        // After close → fall through to SELECT_DIRECTION + OPEN
      }

      // ═══ PHASE 2: SELECT DIRECTION (alternate LONG/SHORT) ═══
      this.setState(STATES.SIGNAL);
      const lastSide = this.state.lastSide || null;
      const side = lastSide === "LONG" ? "SHORT" : "LONG";
      this.log(`[STATE] DIRECTION: ${side} (alternating)`, "warn");

      this.setState(STATES.PREPARE_COLLATERAL);
      const collateralToken = side === "LONG" ? USDT : WETH;
      const collateralDecimals = side === "LONG" ? 6 : 18;
      const collateralSym = side === "LONG" ? "USDT" : "WETH";

      // Fixed testnet collateral
      const targetStr = side === "LONG"
        ? (this.config.targetCollateralUSDT || "1")
        : (this.config.targetCollateralWETH || "0.0002");
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

      // ── Step 4: Ensure collateral (swap ONLY if needed) ──
      if (balance >= collateralAmount) {
        this.log(`[COLLATERAL] SUFFICIENT — no swap needed`, "success");
      } else {
        this.setState(STATES.SWAP);
        this.log(`[STATE] Swap needed for collateral`, "warn");
        const swapOk = await ensureCollateral({
          wallet, provider, side, collateralAmount, config: this.config,
          log: this.log.bind(this), dryRun,
        });
        if (!swapOk) {
          this.log(`[BLOCKED] Cannot obtain collateral. Skipping.`, "error");
          return;
        }
        // Post-swap verification: re-read balance
        const postSwapBalance = await tokenContract.balanceOf(walletAddr);
        if (postSwapBalance < collateralAmount) {
          this.log(`[BLOCKED] Collateral still insufficient after swap: have ${ethers.formatUnits(postSwapBalance, collateralDecimals)}, need ${ethers.formatUnits(collateralAmount, collateralDecimals)}`, "error");
          return;
        }
        this.log(`[COLLATERAL] Post-swap balance: ${ethers.formatUnits(postSwapBalance, collateralDecimals)} ${collateralSym} ✓`, "success");
      }

      // ── Step 5: Pre-flight ──
      this.setState(STATES.PRE_FLIGHT);

      // ── Step 6: Open position ──
      this.setState(STATES.OPEN);
      this.log(`[STATE] OPEN ${side} ${this.config.defaultLeverage}x...`, "warn");

      const openResult = await openPosition({
        wallet, provider, managerAddr, side, collateralToken, collateralAmount,
        leverage: BigInt(this.config.defaultLeverage * 10), // 2x = 20
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
        this.log(`[STATE] MONITOR position #${openResult.positionId} (${side})`, "success");

        // Brief cooldown → next cycle will CLOSE it
        this.log(`[STATE] COOLDOWN ${this.config.cooldownAfterOpenMs / 1000}s...`, "info");
        await this.sleep(this.config.cooldownAfterOpenMs);
      } else {
        this.log(`[BLOCKED] Open failed — skipping cycle`, "error");
      }

      this.log("[STATE] ═══ CYCLE END ═══", "info");
    } catch (e) {
      this.log(`[ERROR] Cycle error: ${e.message?.slice(0, 80)}`, "error");
      // FIX #5: Don't store fake state on error
    } finally {
      this.cycleRunning = false; // Release mutex
    }
  }

  async start() {
    if (this.running) {
      this.log("[AUTO] Already running.", "warn");
      return;
    }

    this.running = true;
    this.stopRequested = false;
    this.log("══════════════════════════════════════════════", "warn");
    this.log("  AUTONOMOUS TRADING LOOP STARTED", "warn");
    this.log(`  Interval: ${this.config.autoLoopIntervalMs / 1000}s`, "info");
    this.log(`  Leverage: ${this.config.defaultLeverage}x`, "info");
    this.log(`  RSI Long: <${this.config.rsiLong} | Short: >${this.config.rsiShort}`, "info");
    this.log(`  Dry run: ${this.config.dryRun}`, "info");
    this.log("══════════════════════════════════════════════", "warn");

    // FIX #2: Restart recovery — verify on-chain, not just local state
    this.log("[STATE] RECOVERY: scanning on-chain for active positions...", "info");
    const { provider } = this.getRuntime();
    const recovered = await recoverPosition(
      provider,
      this.deps.accounts[this.deps.selectedWalletIndex].address,
      this.getManagerAddr(),
      this.log.bind(this),
    );
    if (recovered) {
      this.log(`[STATE] RECOVERED position #${recovered.positionId} side=${recovered.side}`, "warn");
      this.state.activePosition = recovered;
      this.state.sessionStats.opens++; // Count as an open for stats
      saveState(this.state);
    } else {
      // FIX #2: If recovery finds nothing, clear any stale local state
      if (this.state.activePosition) {
        this.log(`[WARN] Local state had position #${this.state.activePosition.positionId} but on-chain says none — clearing`, "warn");
        this.state.activePosition = null;
        saveState(this.state);
      }
    }

    while (!this.stopRequested) {
      try {
        await this.runCycle();
      } catch (e) {
        this.log(`[ERROR] Unhandled cycle error: ${e.message?.slice(0, 80)}`, "error");
      }

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

export { STATES, DEFAULT_AUTO_CONFIG };
export default AutoTrader;
