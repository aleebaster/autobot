#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
//  INVENTORY E2E TEST — LONG deficit: USDC→USDT swap → OPEN → CLOSE
//
//  Setup:
//   1. Pre-step: swap USDT→USDC to drain USDT balance below target
//   2. Run Full Auto with targetCollateralUSDT=12 and lastSide=SHORT
//   3. Bot detects DEFICIT (need 12, have ~2), swaps USDC→USDT
//   4. Bot opens LONG 2x with 12 USDT, then auto-closes
// ═══════════════════════════════════════════════════════════════════════════

import { TEST_STATE_FILE, realStateHash } from "./_test_state_isolation.mjs";
import { ethers } from "ethers";
import fs from "fs";
import { AutoTrader } from "./autoTrader.js";
import { getConfirmedPools } from "./deployments/index.js";
import { DEFAULT_ETH_GUARD } from "./tokenInventory.js";

// ═══ LIVE-TEST GATE (default: SKIP) ═══════════════════════════════════════
// This suite can sign real transactions. Normal runs must never do that:
// it is only reachable with the explicit opt-in phrase below (the global
// signer guard in _test_state_isolation.mjs enforces the same + chainId).
if (process.env.NEMESIS_ALLOW_LIVE_TX !== "SEND LIVE TRANSACTIONS") {
  console.log('SKIP — live-test opt-in missing. Re-run only with: NEMESIS_ALLOW_LIVE_TX="SEND LIVE TRANSACTIONS" (NEMESIS_LIVE_CHAIN_ID defaults to 11155111).');
  process.exit(0);
}

const rpcUrl = "https://ethereum-sepolia-rpc.publicnode.com";
const chainId = 11155111;
const WETH = "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9";
const USDT = "0x5f2E83cCDEa73D60aF400e03F1Cd8Fb9eaB07b20";
const USDC = "0x5dcf1Db10F87CB7839640F9B85C4ECfA29b56e80";
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
];
const ROUTER_ABI = [
  "function swapExactTokensForTokens(uint256,uint256,address[],address,uint256) returns (uint256[])",
];

function logMsg(msg, level = "info") {
  const ts = new Date().toISOString().slice(11, 19);
  const prefix = { info: " ", warn: " ", error: " ", success: " " }[level] || " ";
  console.log(`[${ts}] ${prefix} ${msg}`);
}

async function readBalances(provider, addr) {
  const ethBal = await provider.getBalance(addr);
  const usdtBal = await new ethers.Contract(USDT, ERC20_ABI, provider).balanceOf(addr);
  const wethBal = await new ethers.Contract(WETH, ERC20_ABI, provider).balanceOf(addr);
  const usdcBal = await new ethers.Contract(USDC, ERC20_ABI, provider).balanceOf(addr);
  return { ethBal, usdtBal, wethBal, usdcBal };
}

async function main() {
  const pk = fs.readFileSync("wallets/pk.txt", "utf8").trim();
  const provider = new ethers.JsonRpcProvider(rpcUrl, chainId);
  const wallet = new ethers.Wallet(pk, provider);
  const addr = wallet.address;
  const confirmedPools = getConfirmedPools();
  const ROUTER = "0x8f6eB7870334b1FD8006Fd52413f01689f4E57e9";
  const routerAddr = ROUTER;
  const managerAddr = confirmedPools["ETH/USDT"].manager;

  console.log("═══════════════════════════════════════════════════════════");
  console.log("  INVENTORY E2E TEST — LONG Deficit (USDC → USDT)");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  Wallet: ${addr}`);

  // ── STEP 0: Current balances ──
  let bal = await readBalances(provider, addr);
  console.log("\n  === STEP 0: CURRENT BALANCES ===");
  console.log(`  ETH:  ${ethers.formatEther(bal.ethBal)}`);
  console.log(`  USDT: ${ethers.formatUnits(bal.usdtBal, 6)}`);
  console.log(`  WETH: ${ethers.formatUnits(bal.wethBal, 18)}`);
  console.log(`  USDC: ${ethers.formatUnits(bal.usdcBal, 6)}`);

  // ── STEP 1: Pre-step — drain USDT to ~2 USDT by swapping USDT→USDC ──
  const TARGET_COLLATERAL = 12n * 10n ** 6n; // 12 USDT
  const targetUSDT = Number(ethers.formatUnits(TARGET_COLLATERAL, 6));
  const currentUSDT = Number(ethers.formatUnits(bal.usdtBal, 6));
  const DRAIN_TO = 2.0; // leave ~2 USDT

  console.log(`\n  === STEP 1: DRAIN USDT (pre-step) ===`);
  console.log(`  Current USDT: ${currentUSDT.toFixed(6)}`);
  console.log(`  Target for test: ${targetUSDT} USDT`);
  console.log(`  Draining USDT to ~${DRAIN_TO} USDT via USDT→USDC swap`);

  if (currentUSDT > DRAIN_TO + 1) {
    const drainAmount = bal.usdtBal - ethers.parseUnits(DRAIN_TO.toFixed(6), 6);
    const router = new ethers.Contract(routerAddr, ROUTER_ABI, wallet);
    const tokenIn = new ethers.Contract(USDT, ERC20_ABI, wallet);

    console.log(`  Draining ${ethers.formatUnits(drainAmount, 6)} USDT → USDC`);

    // Approve
    const allowance = await tokenIn.allowance(addr, routerAddr);
    if (allowance < drainAmount) {
      console.log(`  Approving router for ${ethers.formatUnits(drainAmount, 6)} USDT...`);
      const approveTx = await tokenIn.approve(routerAddr, drainAmount);
      await approveTx.wait();
      console.log(`  Approved TX: ${approveTx.hash}`);
    }

    // Swap USDT→USDC
    const deadline = Math.floor(Date.now() / 1000) + 600;
    const swapTx = await router.swapExactTokensForTokens(
      drainAmount, 0n, [USDT, USDC], addr, deadline
    );
    const receipt = await swapTx.wait();
    console.log(`  USDT→USDC drain TX: ${swapTx.hash}`);
    console.log(`  Gas used: ${receipt.gasUsed.toString()}`);

    // Re-read balances
    bal = await readBalances(provider, addr);
    console.log(`  Post-drain USDT: ${ethers.formatUnits(bal.usdtBal, 6)}`);
    console.log(`  Post-drain USDC: ${ethers.formatUnits(bal.usdcBal, 6)}`);
  } else {
    console.log(`  USDT already low enough, skipping drain`);
  }

  // ── STEP 2: Compute deficit ──
  const postDrainUSDT = bal.usdtBal;
  const deficit = TARGET_COLLATERAL > postDrainUSDT ? TARGET_COLLATERAL - postDrainUSDT : 0n;
  console.log(`\n  === STEP 2: DEFICIT SCENARIO ===`);
  console.log(`  Required USDT: ${targetUSDT}`);
  console.log(`  Available USDT: ${ethers.formatUnits(postDrainUSDT, 6)}`);
  console.log(`  Deficit: ${ethers.formatUnits(deficit, 6)} USDT`);
  console.log(`  USDC available for swap: ${ethers.formatUnits(bal.usdcBal, 6)}`);
  console.log(`  Expected: bot swaps USDC → USDT via USDC/USDT pool`);

  // ── STEP 3: Run Full Auto Cycle ──
  console.log(`\n  === STEP 3: RUNNING FULL AUTO CYCLE (LONG, target=${targetUSDT} USDT) ===\n`);

  const logs = [];
  const autoConfig = {
    defaultLeverage: 2,
    maxLeverage: 5,
    autoLoopIntervalMs: 0,
    ethGuard: { ...DEFAULT_ETH_GUARD, MIN_ETH_GAS_RESERVE: 0.0001 },
    dryRun: false,
    targetCollateralUSDT: targetUSDT.toString(),
    targetCollateralWETH: "0.002",
    deadlineSeconds: 1200,
    cooldownAfterOpenMs: 0,
    cooldownAfterCloseMs: 0,
  };

  const deps = {
    accounts: [{ address: addr, privateKey: pk }],
    selectedWalletIndex: 0,
    proxies: [],
    rpcUrl,
    chainId,
    config: autoConfig,
    confirmedPools,
    getProvider: (url, chain) => new ethers.JsonRpcProvider(url, chain),
    log: (msg, level) => {
      logMsg(msg, level);
      logs.push({ msg, level, ts: Date.now() });
    },
  };

  const trader = new AutoTrader(deps);
  trader.state.lastSide = "SHORT"; // Force LONG next

  let openTxHash = null;
  let closeTxHash = null;
  let swapTxHash = null;
  let positionId = null;

  try {
    await trader.runCycle();

    for (const l of logs) {
      if (l.msg.includes("Position ID:")) {
        const m = l.msg.match(/Position ID:\s*(\d+)/);
        if (m) positionId = m[1];
      }
      if (l.msg.includes("[SWAP]") && l.msg.includes("TX hash=")) {
        const m = l.msg.match(/TX hash=([0x0-9a-fA-F]+)/);
        if (m) swapTxHash = m[1];
      }
      if (l.msg.includes("[OPEN]") && l.msg.includes("TX:")) {
        const m = l.msg.match(/TX: ([0x0-9a-fA-F]+)/);
        if (m) openTxHash = m[1];
      }
      if (l.msg.includes("[CLOSE]") && l.msg.includes("TX:")) {
        const m = l.msg.match(/TX: ([0x0-9a-fA-F]+)/);
        if (m) closeTxHash = m[1];
      }
    }
  } catch (e) {
    console.error(`\n  CYCLE ERROR: ${e.message}`);
  }

  // ── STEP 4: Post-cycle balances ──
  const balAfter = await readBalances(provider, addr);
  console.log("\n  === STEP 4: POST-CYCLE BALANCES ===");
  console.log(`  ETH:  ${ethers.formatEther(balAfter.ethBal)} (Δ ${ethers.formatEther(balAfter.ethBal - bal.ethBal)})`);
  console.log(`  USDT: ${ethers.formatUnits(balAfter.usdtBal, 6)} (Δ ${ethers.formatUnits(balAfter.usdtBal - bal.usdtBal, 6)})`);
  console.log(`  WETH: ${ethers.formatUnits(balAfter.wethBal, 18)} (Δ ${ethers.formatUnits(balAfter.wethBal - bal.wethBal, 18)})`);
  console.log(`  USDC: ${ethers.formatUnits(balAfter.usdcBal, 6)} (Δ ${ethers.formatUnits(balAfter.usdcBal - bal.usdcBal, 6)})`);

  // ── Summary ──
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  RESULTS SUMMARY");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  Direction:       LONG`);
  console.log(`  Target:          ${targetUSDT} USDT`);
  console.log(`  Available:       ${ethers.formatUnits(postDrainUSDT, 6)} USDT`);
  console.log(`  Deficit:         ${ethers.formatUnits(deficit, 6)} USDT`);
  console.log(`  Swap detected:   ${swapTxHash ? "YES" : "NO"}`);
  console.log(`  Swap TX:         ${swapTxHash || "N/A"}`);
  console.log(`  Position ID:     ${positionId || "N/A"}`);
  console.log(`  OPEN TX:         ${openTxHash || "N/A"}`);
  console.log(`  CLOSE TX:        ${closeTxHash || "N/A"}`);
  console.log("═══════════════════════════════════════════════════════════");

  // Full log
  console.log("\n  === FULL LOG ===");
  for (const l of logs) {
    const prefix = { info: " ", warn: " ", error: " ", success: " " }[l.level] || " ";
    console.log(`  ${prefix} ${l.msg}`);
  }
}

main().catch(e => { console.error(`Fatal: ${e.message}`); process.exit(1); });
