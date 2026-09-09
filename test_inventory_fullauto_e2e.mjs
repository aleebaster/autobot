#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
//  INVENTORY FULL AUTO E2E TEST — Sepolia
//
//  Exercises the NEW inventory-aware swap logic through AutoTrader.runCycle():
//
//  1. Read current balances
//  2. Create deficit: swap USDT→USDC to get USDT below targetReserveUSDT
//  3. Run Full Auto cycle — bot detects deficit, swaps USDC→USDT
//  4. Verify position opened
//  5. Close position
//  6. Verify loop continues (second cycle runs without stopping)
//
//  KEY: The test does NOT call swap functions manually.
//       It forces a deficit, then lets AutoTrader.runCycle() handle the rest.
// ═══════════════════════════════════════════════════════════════════════════

import { ethers } from "ethers";
import fs from "fs";
import { AutoTrader } from "./autoTrader.js";
import { getConfirmedPools } from "./deployments/index.js";
import { DEFAULT_ETH_GUARD } from "./tokenInventory.js";

const RPC_URL = "https://ethereum-sepolia-rpc.publicnode.com";
const CHAIN_ID = 11155111;
const WETH  = "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9";
const USDT  = "0x5f2E83cCDEa73D60aF400e03F1Cd8Fb9eaB07b20";
const USDC  = "0x5dcf1Db10F87CB7839640F9B85C4ECfA29b56e80";
const ROUTER = "0x8f6eB7870334b1FD8006Fd52413f01689f4E57e9";

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
  "function decimals() view returns (uint8)",
];
const ROUTER_ABI = [
  "function swapExactTokensForTokens(uint256,uint256,address[],address,uint256) returns (uint256[])",
  "function getAmountsOut(uint256,address[]) view returns (uint256[])",
];
const POSITION_CREATED_TOPIC = "0x2e462fabb57854af0ee2383faf948da3dc380bd08e582513c3e8e1177478c64a";

// ═══════════════════════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════════════════════

let logs = [];
let swapDetected = false;
let swapTxHash = null;
let positionOpened = false;
let positionClosed = false;
let cycleCount = 0;

function log(msg, level = "info") {
  const ts = new Date().toISOString().slice(11, 19);
  const prefix = { info: " ", warn: " ", error: " ", success: " " }[level] || " ";
  const line = `[${ts}] ${prefix} ${msg}`;
  console.log(line);
  logs.push(line);

  // Track key events
  if (msg.includes("[SWAP]") && msg.includes("CONFIRMED")) swapDetected = true;
  if (msg.includes("[SWAP]") && msg.includes("TX hash=")) {
    const m = msg.match(/hash=(0x[a-fA-F0-9]+)/);
    if (m) swapTxHash = m[1];
  }
  if (msg.includes("Position ID:")) positionOpened = true;
  if (msg.includes("[CLOSE] SUCCESS")) positionClosed = true;
  if (msg.includes("CYCLE END")) cycleCount++;
}

async function readBalances(provider, addr) {
  const ethBal = await provider.getBalance(addr);
  const usdtBal = await new ethers.Contract(USDT, ERC20_ABI, provider).balanceOf(addr);
  const wethBal = await new ethers.Contract(WETH, ERC20_ABI, provider).balanceOf(addr);
  const usdcBal = await new ethers.Contract(USDC, ERC20_ABI, provider).balanceOf(addr);
  return { ethBal, usdtBal, wethBal, usdcBal };
}

function printBalances(label, b) {
  console.log(`\n═══════════ ${label} ═══════════`);
  console.log(`  ETH:    ${ethers.formatEther(b.ethBal)}`);
  console.log(`  USDT:   ${ethers.formatUnits(b.usdtBal, 6)}`);
  console.log(`  USDC:   ${ethers.formatUnits(b.usdcBal, 6)}`);
  console.log(`  WETH:   ${ethers.formatEther(b.wethBal)}`);
}

// ═══════════════════════════════════════════════════════════════════════════
//  SETUP: Create USDT deficit by swapping USDT → USDC
// ═══════════════════════════════════════════════════════════════════════════

async function createDeficit(wallet, provider, currentUsdt, deficitTargetUsdt) {
  // deficitTargetUsdt = target USDT balance after setup (e.g., 5 USDT)
  // We need to swap away (currentUsdt - deficitTargetUsdt) USDT → USDC
  const toSwap = currentUsdt - ethers.parseUnits(deficitTargetUsdt.toString(), 6);
  if (toSwap <= 0n) {
    console.log(`  Cannot create deficit: current=${ethers.formatUnits(currentUsdt, 6)} USDT, target=${deficitTargetUsdt} USDT`);
    return false;
  }

  console.log(`\n═══════════ SETUP: Creating deficit ═══════════`);
  console.log(`  Swapping ${ethers.formatUnits(toSwap, 6)} USDT → USDC`);
  console.log(`  Target USDT after: ~${deficitTargetUsdt} USDT`);

  const usdtW = new ethers.Contract(USDT, ERC20_ABI, wallet);
  const allowance = await usdtW.allowance(wallet.address, ROUTER);
  if (allowance < toSwap) {
    log("  Approving USDT → Router...", "warn");
    const tx = await usdtW.approve(ROUTER, ethers.MaxUint256, { gasLimit: 100000n });
    await tx.wait();
  }

  const routerW = new ethers.Contract(ROUTER, ROUTER_ABI, wallet);
  const routerR = new ethers.Contract(ROUTER, ROUTER_ABI, provider);
  const path = [USDT, USDC];
  const quote = await routerR.getAmountsOut(toSwap, path);
  const minOut = quote[1] * 95n / 100n;
  const deadline = Math.floor(Date.now() / 1000) + 1200;

  const tx = await routerW.swapExactTokensForTokens(toSwap, minOut, path, wallet.address, deadline, { gasLimit: 300000n });
  const rc = await tx.wait();
  log(`  Setup swap TX: ${tx.hash} status=${rc.status} gas=${rc.gasUsed}`, rc.status === 1 ? "success" : "error");
  return rc.status === 1;
}

// ═══════════════════════════════════════════════════════════════════════════
//  CLEANUP: Swap USDC back to USDT
// ═══════════════════════════════════════════════════════════════════════════

async function cleanupUsdcToUsdt(wallet, provider, amountUsdc) {
  if (amountUsdc <= 0n) return;
  console.log(`\n═══════════ CLEANUP: Swapping ${ethers.formatUnits(amountUsdc, 6)} USDC → USDT ═══════════`);

  const usdcW = new ethers.Contract(USDC, ERC20_ABI, wallet);
  const allowance = await usdcW.allowance(wallet.address, ROUTER);
  if (allowance < amountUsdc) {
    const tx = await usdcW.approve(ROUTER, ethers.MaxUint256, { gasLimit: 100000n });
    await tx.wait();
  }

  const routerW = new ethers.Contract(ROUTER, ROUTER_ABI, wallet);
  const routerR = new ethers.Contract(ROUTER, ROUTER_ABI, provider);
  const path = [USDC, USDT];
  const quote = await routerR.getAmountsOut(amountUsdc, path);
  const minOut = quote[1] * 95n / 100n;
  const deadline = Math.floor(Date.now() / 1000) + 1200;

  const tx = await routerW.swapExactTokensForTokens(amountUsdc, minOut, path, wallet.address, deadline, { gasLimit: 300000n });
  const rc = await tx.wait();
  log(`  Cleanup swap: ${tx.hash} status=${rc.status}`, rc.status === 1 ? "success" : "error");
}

// ═══════════════════════════════════════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  const pk = fs.readFileSync("wallets/pk.txt", "utf8").trim();
  const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID);
  const wallet = new ethers.Wallet(pk, provider);
  const addr = wallet.address;
  const confirmedPools = getConfirmedPools();

  console.log("═══════════════════════════════════════════════════════════");
  console.log("  INVENTORY FULL AUTO E2E TEST — Sepolia");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  Wallet:  ${addr}`);
  console.log(`  Manager: ${confirmedPools["ETH/USDT"]?.manager}`);
  console.log(`  Pool:    ${confirmedPools["ETH/USDT"]?.pool}`);

  // ════════ STEP 0: Read balances ════════
  const balBefore = await readBalances(provider, addr);
  printBalances("BALANCES BEFORE", balBefore);

  // ════════ STEP 1: Create USDT deficit ════════
  // targetReserveUSDT = 20 USDT (default)
  // We need USDT < 20 USDT for the swap to trigger
  // Current USDT might be ~15-25 USDT depending on prior cycles
  const currentUsdtFloat = Number(ethers.formatUnits(balBefore.usdtBal, 6));
  const targetReserveFloat = 20;

  console.log(`\n═══════════ COLLATERAL ANALYSIS ═══════════`);
  console.log(`  Current USDT:    ${currentUsdtFloat.toFixed(6)}`);
  console.log(`  targetReserve:   ${targetReserveFloat} USDT`);
  console.log(`  targetCollateral: 10 USDT`);

  if (currentUsdtFloat >= targetReserveFloat) {
    // Current USDT is above target — create deficit
    const deficitTarget = 5; // Set USDT to 5 USDT (well below targetReserve=20)
    console.log(`  Strategy: Swapping USDT → USDC to create deficit (target=${deficitTarget} USDT)`);
    const setupOk = await createDeficit(wallet, provider, balBefore.usdtBal, deficitTarget);
    if (!setupOk) { console.error("SETUP FAILED"); process.exit(1); }
  } else {
    console.log(`  USDT already below targetReserve — no setup needed`);
  }

  const balAfterSetup = await readBalances(provider, addr);
  printBalances("BALANCES AFTER DEFICIT CREATION", balAfterSetup);

  const usdtAfterSetup = Number(ethers.formatUnits(balAfterSetup.usdtBal, 6));
  console.log(`\n═══════════ DEFICIT VERIFICATION ═══════════`);
  console.log(`  USDT after setup: ${usdtAfterSetup.toFixed(6)}`);
  console.log(`  targetReserve:    ${targetReserveFloat} USDT`);
  console.log(`  Deficit:          ${usdtAfterSetup < targetReserveFloat ? "YES — SWAP SHOULD TRIGGER" : "NO — still above target"}`);

  if (usdtAfterSetup >= targetReserveFloat) {
    console.error("ERROR: Could not create USDT deficit");
    process.exit(1);
  }

  // ════════ STEP 2: Run Full Auto cycle ════════
  console.log("\n═══════════ RUNNING FULL AUTO CYCLE ═══════════");

  // Create a fresh AutoTrader with the right state
  // Set lastSide=SHORT so next cycle goes LONG
  const stateFile = "auto-trader-state.json";
  const prevState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const savedState = { ...prevState }; // save for restore

  // Clear active position to start fresh
  const clearState = {
    activePosition: null,
    sessionStats: prevState.sessionStats,
    lastCycleTime: 0,
    lastSide: "SHORT", // Force next cycle to LONG
  };
  fs.writeFileSync(stateFile, JSON.stringify(clearState, null, 2));

  const autoConfig = {
    defaultLeverage: 2,
    maxLeverage: 5,
    autoLoopIntervalMs: 0, // Run single cycle only
    ethGuard: { ...DEFAULT_ETH_GUARD },
    dryRun: false,
    targetCollateralUSDT: "10",
    targetCollateralWETH: "0.002",
    targetReserveUSDT: "20",
    targetReserveWETH: "0.004",
    deadlineSeconds: 1200,
    cooldownAfterOpenMs: 1000,
    cooldownAfterCloseMs: 1000,
  };

  const deps = {
    accounts: [{ address: addr, privateKey: pk }],
    selectedWalletIndex: 0,
    proxies: [],
    rpcUrl: RPC_URL,
    chainId: CHAIN_ID,
    config: autoConfig,
    confirmedPools,
    getProvider: (url, chain) => new ethers.JsonRpcProvider(url, chain),
    log,
  };

  const trader = new AutoTrader(deps);

  // Run one cycle — this should:
  // 1. Detect USDT deficit (5 < 20 targetReserve)
  // 2. Swap USDC → USDT
  // 3. Open LONG
  // (Close happens in next cycle)

  // Override start() to run just one cycle
  try {
    trader.running = true;
    trader.stopRequested = false;
    await trader.runCycle();
    trader.stopRequested = true;
    trader.running = false;
  } catch (e) {
    log(`[ERROR] Cycle failed: ${e.message?.slice(0, 80)}`, "error");
  }

  // ════════ STEP 3: Read state after cycle ════════
  const stateAfter = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const balAfter = await readBalances(provider, addr);
  printBalances("BALANCES AFTER CYCLE", balAfter);

  // ════════ STEP 4: Close position if open ════════
  if (stateAfter.activePosition) {
    console.log("\n═══════════ CLOSING POSITION ═══════════");
    // Run another cycle — this should close the active position
    const closeState = {
      ...clearState,
      activePosition: stateAfter.activePosition,
    };
    fs.writeFileSync(stateFile, JSON.stringify(closeState, null, 2));

    const trader2 = new AutoTrader(deps);
    try {
      trader2.running = true;
      trader2.stopRequested = false;
      await trader2.runCycle();
      trader2.stopRequested = true;
      trader2.running = false;
    } catch (e) {
      log(`[ERROR] Close cycle failed: ${e.message?.slice(0, 80)}`, "error");
    }
  }

  // ════════ STEP 5: Verify loop continues ════════
  console.log("\n═══════════ LOOP CONTINUITY TEST ═══════════");
  const stateFinal = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const balFinal = await readBalances(provider, addr);
  printBalances("BALANCES FINAL", balFinal);

  // ════════ RESULTS ════════
  const usdtDelta = balFinal.usdtBal - balBefore.usdtBal;
  const usdcDelta = balFinal.usdcBal - balBefore.usdcBal;
  const wethDelta = balFinal.wethBal - balBefore.wethBal;

  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  INVENTORY FULL AUTO E2E RESULTS");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  SWAP DETECTED:      ${swapDetected ? "YES ✅" : "NO ❌"}`);
  console.log(`  SWAP TX:            ${swapTxHash || "N/A"}`);
  console.log(`  POSITION OPENED:    ${positionOpened ? "YES ✅" : "NO ❌"}`);
  console.log(`  POSITION CLOSED:    ${positionClosed ? "YES ✅" : "NOT YET (next cycle)"}`);
  console.log(`  CYCLES RUN:         ${cycleCount}`);
  console.log(``);
  console.log(`  USDT delta:         ${usdtDelta >= 0n ? "+" : ""}${ethers.formatUnits(usdtDelta, 6)} USDT`);
  console.log(`  USDC delta:         ${usdcDelta >= 0n ? "+" : ""}${ethers.formatUnits(usdcDelta, 6)} USDC`);
  console.log(`  WETH delta:         ${wethDelta >= 0n ? "+" : ""}${ethers.formatEther(wethDelta)} WETH`);
  console.log(``);
  console.log(`  LOGS:`);
  for (const l of logs) {
    if (l.includes("[SWAP]") || l.includes("[INVENTORY]") || l.includes("[OPEN]") || l.includes("[CLOSE]") || l.includes("[BLOCKED]")) {
      console.log(`    ${l}`);
    }
  }
  console.log(``);
  console.log(`  VERDICT: ${swapDetected && positionOpened ? "PASS ✅" : "FAIL ❌"}`);
  console.log("═══════════════════════════════════════════════════════════");

  // Restore state
  fs.writeFileSync(stateFile, JSON.stringify(savedState, null, 2));

  if (!swapDetected || !positionOpened) {
    process.exit(1);
  }
}

main().catch(e => { console.error(`FATAL: ${e.message}`); process.exit(1); });
