#!/usr/bin/env node
/**
 * test_inventory.mjs — Controlled real test of inventory-aware swap logic
 * 
 * Tests:
 * 1. Real on-chain balances
 * 2. Inventory status (DEFICIT / OK / SURPLUS)
 * 3. generateInventoryAwarePairs() with real data
 * 4. ETH Guard blocking tests (simulated, no real tx)
 * 
 * NO TRANSACTIONS ARE SENT.
 */

import { ethers } from "ethers";
import { TokenInventory, EthSessionTracker, generateInventoryAwarePairs, DEFAULT_INVENTORY, DEFAULT_ETH_GUARD } from "./tokenInventory.js";

const RPC = "https://ethereum-sepolia-rpc.publicnode.com/557d07a988c4164482ef0c56a10f98ee0e3073440fd72fbe89cd7f6fef809388";
const WALLET = "0x315E5193633A962B3F369F9C3833D973D0588cCD";

const provider = new ethers.JsonRpcProvider(RPC, 11155111);

// Token addresses (same as deployments)
const TOKEN_MAP = {
  ETH:     { address: "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9", decimals: 18 },
  WETH:    { address: "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9", decimals: 18 },
  USDC:    { address: "0x5dcf1Db10F87CB7839640F9B85C4ECfA29b56e80", decimals: 6 },
  USDT:    { address: "0x5f2E83cCDEa73D60aF400e03F1Cd8Fb9eaB07b20", decimals: 6 },
  DAI:     { address: "0xa3215a5cA659e0Bd57c0B33d5EAD71901A24d3d6", decimals: 6 },
  NEMESIS: { address: "0x18D18A40614b6d8C6154309F517acf9829308842", decimals: 6 },
  UNI:     { address: "0xEaBEcd70AC3330d65e09e429824C49d0D8812952", decimals: 6 },
  LINK:    { address: "0x1132087D2D97b55E5fe1B0FcA7b99348B5f07e28", decimals: 6 },
};

// Known valid swap pairs (from discoveredSwapPairs in index.js)
const ALL_SWAP_PAIRS = [
  { from: "ETH", to: "USDT" },
  { from: "ETH", to: "USDC" },
  { from: "ETH", to: "DAI" },
  { from: "ETH", to: "UNI" },
  { from: "ETH", to: "LINK" },
  { from: "ETH", to: "NEMESIS" },
  { from: "USDT", to: "ETH" },
  { from: "USDC", to: "ETH" },
  { from: "DAI", to: "ETH" },
  { from: "UNI", to: "ETH" },
  { from: "LINK", to: "ETH" },
  { from: "NEMESIS", to: "ETH" },
  // Token→Token pairs (if pools exist)
  { from: "USDT", to: "USDC" },
  { from: "USDC", to: "USDT" },
  { from: "USDT", to: "DAI" },
  { from: "DAI", to: "USDT" },
  { from: "USDT", to: "UNI" },
  { from: "UNI", to: "USDT" },
  { from: "USDT", to: "LINK" },
  { from: "LINK", to: "USDT" },
  { from: "USDT", to: "NEMESIS" },
  { from: "NEMESIS", to: "USDT" },
];

function log(tag, msg) {
  console.log(`[${tag}] ${msg}`);
}

function section(title) {
  console.log(`\n${"═".repeat(70)}`);
  console.log(`  ${title}`);
  console.log(`${"═".repeat(70)}`);
}

async function main() {
  section("STEP 1: Read Real On-Chain Balances");

  const inventory = new TokenInventory();

  // Force refresh by resetting lastRefresh
  inventory.lastRefresh = 0;
  await inventory.refreshBalances(provider, WALLET, TOKEN_MAP, (msg, sev) => {
    log(sev === "warn" ? "⚠️" : "📋", msg);
  });

  section("STEP 2: Inventory Status");

  console.log("\n  TOKEN        BALANCE            MINIMUM         TARGET          MAXIMUM         STATUS");
  console.log("  " + "─".repeat(100));

  for (const [sym, target] of Object.entries(DEFAULT_INVENTORY)) {
    const bal = inventory.balances[sym];
    const status = inventory.getTokenStatus(sym);
    const balStr = bal ? bal.float.toFixed(target.decimals >= 18 ? 6 : 2) : "?";
    const icon = status === "deficit" ? "🔴" : status === "surplus" ? "🟡" : status === "ok" ? "🟢" : "❓";

    console.log(
      `  ${icon} ${sym.padEnd(10)} ${balStr.padStart(12)}    ${String(target.minimum).padStart(12)}    ${String(target.target).padStart(12)}    ${String(target.maximum).padStart(12)}    [${status.toUpperCase()}]`
    );
  }

  console.log();

  // ETH spending guard summary
  console.log("  ETH GUARD LIMITS:");
  console.log(`    MAX_ETH_SWAP_PER_TX:      ${DEFAULT_ETH_GUARD.MAX_ETH_SWAP_PER_TX} ETH`);
  console.log(`    MAX_ETH_SWAP_PER_SESSION:  ${DEFAULT_ETH_GUARD.MAX_ETH_SWAP_PER_SESSION} ETH`);
  console.log(`    MIN_ETH_GAS_RESERVE:       ${DEFAULT_ETH_GUARD.MIN_ETH_GAS_RESERVE} ETH`);
  console.log(`    MAX_TOTAL_ETH_EXPOSURE:    ${DEFAULT_ETH_GUARD.MAX_TOTAL_ETH_EXPOSURE} ETH`);
  console.log(`    ETH_BLOCK_THRESHOLD:       ${DEFAULT_ETH_GUARD.ETH_BLOCK_THRESHOLD} ETH`);

  section("STEP 3: Generate Inventory-Aware Pairs");

  const pairs = generateInventoryAwarePairs(inventory, ALL_SWAP_PAIRS, (msg, sev) => {
    log(sev === "warn" ? "⚠️" : "📋", msg);
  });

  console.log(`\n  Generated ${pairs.length} pairs (sorted by priority):\n`);
  console.log("  PRIO  FROM          → TO            REASON");
  console.log("  " + "─".repeat(80));

  const ethSwapsToTokens = [];
  const tokenToEthSwaps = [];
  const tokenToTokenSwaps = [];

  for (const pair of pairs) {
    const icon = pair.from === "ETH" ? "🔵" : pair.to === "ETH" ? "🟠" : "🟢";
    console.log(
      `  ${icon} [${pair.priority}]  ${pair.from.padEnd(12)} → ${pair.to.padEnd(14)} ${pair.reason}`
    );

    if (pair.from === "ETH") ethSwapsToTokens.push(pair);
    else if (pair.to === "ETH") tokenToEthSwaps.push(pair);
    else tokenToTokenSwaps.push(pair);
  }

  console.log(`\n  SUMMARY:`);
  console.log(`    Token→Token swaps: ${tokenToTokenSwaps.length}`);
  console.log(`    ETH→Token swaps:   ${ethSwapsToTokens.length}`);
  console.log(`    Token→ETH swaps:   ${tokenToEthSwaps.length}`);

  section("STEP 4: Verify Priority Order");

  let issues = [];

  // Check that Token→Token pairs come first
  const firstNonTokenPair = pairs.findIndex(p => p.from === "ETH" || p.to === "ETH");
  const lastTokenPair = (() => {
    for (let i = pairs.length - 1; i >= 0; i--) {
      if (pairs[i].from !== "ETH" && pairs[i].to !== "ETH") return i;
    }
    return -1;
  })();

  if (firstNonTokenPair !== -1 && lastTokenPair !== -1 && firstNonTokenPair < lastTokenPair) {
    issues.push("❌ FAIL: ETH swap pair appears BEFORE token→token pair!");
  } else {
    console.log("  ✅ Token→Token pairs come before ETH pairs");
  }

  // Check ETH→Token only for deficit tokens
  for (const p of ethSwapsToTokens) {
    const status = inventory.getTokenStatus(p.to);
    if (status !== "deficit") {
      issues.push(`❌ FAIL: ETH→${p.to} generated but ${p.to} is ${status.toUpperCase()}, not DEFICIT`);
    }
  }

  if (ethSwapsToTokens.length === 0) {
    console.log("  ✅ No ETH→Token swaps generated (no deficit tokens needing ETH)");
  } else {
    console.log(`  ℹ️  ${ethSwapsToTokens.length} ETH→Token swaps (only for deficit tokens)`);
  }

  // Check Token→ETH only for gas reserve replenishment
  for (const p of tokenToEthSwaps) {
    const ethBal = inventory.balances.ETH ? inventory.balances.ETH.float : 0;
    const gasReserve = DEFAULT_ETH_GUARD.MIN_ETH_GAS_RESERVE;
    if (ethBal >= gasReserve) {
      issues.push(`❌ FAIL: Token→ETH generated but ETH (${ethBal.toFixed(6)}) >= gas reserve (${gasReserve})`);
    }
  }

  if (tokenToEthSwaps.length === 0) {
    console.log("  ✅ No Token→ETH swaps generated (ETH above gas reserve)");
  } else {
    console.log(`  ⚠️  ${tokenToEthSwaps.length} Token→ETH swaps (EMERGENCY gas reserve replenishment)`);
  }

  section("STEP 5: ETH Guard Blocking Tests (Simulated)");

  const guard = new EthSessionTracker();

  // Test 1: Per-TX limit
  const txCheck1 = guard.checkSwapLimit(0.01); // Under limit
  const txCheck2 = guard.checkSwapLimit(0.05); // Over limit
  console.log(`  [Per-TX] 0.01 ETH: allowed=${txCheck1.allowed} (expected: true)`);
  console.log(`  [Per-TX] 0.05 ETH: allowed=${txCheck2.allowed} (expected: false)`);
  if (!txCheck1.allowed || txCheck2.allowed) issues.push("❌ FAIL: Per-TX guard broken");

  // Test 2: Session limit
  guard.recordEthSwap(0.08);
  const sessCheck1 = guard.checkSwapLimit(0.01); // 0.08 + 0.01 = 0.09 < 0.1
  const sessCheck2 = guard.checkSwapLimit(0.03); // 0.08 + 0.03 = 0.11 > 0.1
  console.log(`  [Session] +0.01 (total 0.09): allowed=${sessCheck1.allowed} (expected: true)`);
  console.log(`  [Session] +0.03 (total 0.11): allowed=${sessCheck2.allowed} (expected: false)`);
  if (!sessCheck1.allowed || sessCheck2.allowed) issues.push("❌ FAIL: Session guard broken");

  // Test 3: Gas reserve
  const gasCheck1 = guard.checkGasReserve(0.01, 0.005); // 0.01 - 0.005 = 0.005 > 0.003
  const gasCheck2 = guard.checkGasReserve(0.005, 0.003); // 0.005 - 0.003 = 0.002 < 0.003
  console.log(`  [GasReserve] 0.01-0.005=0.005: allowed=${gasCheck1.allowed} (expected: true)`);
  console.log(`  [GasReserve] 0.005-0.003=0.002: allowed=${gasCheck2.allowed} (expected: false)`);
  if (!gasCheck1.allowed || gasCheck2.allowed) issues.push("❌ FAIL: Gas reserve guard broken");

  // Test 4: Block threshold
  const blockCheck1 = guard.checkBlockThreshold(0.01);  // Above threshold
  const blockCheck2 = guard.checkBlockThreshold(0.003); // Below threshold
  console.log(`  [BlockThreshold] 0.01 ETH: blocked=${blockCheck1.blocked} (expected: false)`);
  console.log(`  [BlockThreshold] 0.003 ETH: blocked=${blockCheck2.blocked} (expected: true)`);
  if (blockCheck1.blocked || !blockCheck2.blocked) issues.push("❌ FAIL: Block threshold guard broken");

  // Test 5: Full canUseEthAsSource
  const canEth1 = inventory.canUseEthAsSource(0.005, 0.1);   // Should be allowed
  const canEth2 = inventory.canUseEthAsSource(0.05, 0.1);    // Per-TX limit exceeded
  const canEth3 = inventory.canUseEthAsSource(0.005, 0.002); // Below block threshold
  console.log(`  [canUseEth] 0.005 ETH, bal=0.1:   allowed=${canEth1.allowed} (expected: true)`);
  console.log(`  [canUseEth] 0.05 ETH, bal=0.1:    allowed=${canEth2.allowed} (expected: false)`);
  console.log(`  [canUseEth] 0.005 ETH, bal=0.002: allowed=${canEth3.allowed} (expected: false)`);
  if (!canEth1.allowed || canEth2.allowed || canEth3.allowed) issues.push("❌ FAIL: canUseEthAsSource broken");

  section("STEP 6: Token→Token Swap Candidates");

  // Show what the first few real token→token swaps would be
  const ttPairs = pairs.filter(p => p.from !== "ETH" && p.to !== "ETH");
  if (ttPairs.length > 0) {
    console.log(`\n  First ${Math.min(10, ttPairs.length)} token→token swap candidates:\n`);
    for (const p of ttPairs.slice(0, 10)) {
      const fromBal = inventory.balances[p.from];
      const toStatus = inventory.getTokenStatus(p.to);
      console.log(`    ${p.from.padEnd(10)} [bal=${fromBal ? fromBal.float.toFixed(2) : "?"}]  →  ${p.to.padEnd(10)} [status=${toStatus}]  (${p.reason})`);
    }
  } else {
    console.log("\n  ⚠️  No token→token pairs available (check pool discovery)");
  }

  section("FINAL REPORT");

  console.log(`\n  Wallet:      ${WALLET}`);
  console.log(`  ETH Balance: ${inventory.balances.ETH ? inventory.balances.ETH.float.toFixed(6) : "?"} ETH`);

  const ethBelowThreshold = inventory.balances.ETH && inventory.balances.ETH.float < DEFAULT_ETH_GUARD.ETH_BLOCK_THRESHOLD;
  const ethBelowGasReserve = inventory.balances.ETH && inventory.balances.ETH.float < DEFAULT_ETH_GUARD.MIN_ETH_GAS_RESERVE;

  if (ethBelowThreshold) {
    console.log("  ⛔ ETH BELOW BLOCK THRESHOLD — ALL ETH SWAPS BLOCKED");
  } else if (ethBelowGasReserve) {
    console.log("  ⚠️  ETH BELOW GAS RESERVE — only emergency Token→ETH allowed");
  } else {
    console.log("  ✅ ETH above all safety thresholds");
  }

  console.log(`\n  Generated pairs: ${pairs.length} total`);
  console.log(`    Token→Token: ${tokenToTokenSwaps.length}`);
  console.log(`    ETH→Token:   ${ethSwapsToTokens.length} (last resort only)`);
  console.log(`    Token→ETH:   ${tokenToEthSwaps.length} (emergency gas only)`);
  console.log(`    Total ETH pairs: ${ethSwapsToTokens.length + tokenToEthSwaps.length}`);

  if (issues.length === 0) {
    console.log("\n  ✅ ALL TESTS PASSED");
  } else {
    console.log(`\n  ❌ ${issues.length} ISSUE(S) FOUND:`);
    for (const issue of issues) {
      console.log(`    ${issue}`);
    }
  }

  console.log(`\n  📝 ETH SESSION TRACKER SUMMARY:`);
  console.log(`    ${guard.getSummary().split("\n").join("\n    ")}`);

  console.log(`\n${"═".repeat(70)}`);
  console.log(`  NO TRANSACTIONS WERE SENT. This is a dry-run test.`);
  console.log(`${"═".repeat(70)}\n`);
}

main().catch(err => {
  console.error("FATAL:", err);
  process.exit(1);
});
