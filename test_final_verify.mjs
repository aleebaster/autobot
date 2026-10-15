// ═══════════════════════════════════════════════════════════════════════════
//  FINAL VERIFICATION: LONG 2x/5x + SHORT 2x/5x pre-flight + safety check
// ═══════════════════════════════════════════════════════════════════════════

import { ethers } from "ethers";
import fs from "fs";
import { getConfirmedPools } from "./deployments/index.js";
import { openPosition } from "./autoTrader.js";

const WETH  = "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9";
const USDT  = "0x5f2E83cCDEa73D60aF400e03F1Cd8Fb9eaB07b20";

function log(msg) { console.log(`  ${msg}`); }

async function main() {
  const pk = fs.readFileSync("wallets/pk.txt", "utf8").trim();
  const provider = new ethers.JsonRpcProvider("https://ethereum-sepolia-rpc.publicnode.com", 11155111);
  const wallet = new ethers.Wallet(pk, provider);
  const confirmedPools = getConfirmedPools();
  const managerAddr = confirmedPools["ETH/USDT"].manager;
  const poolAddr = confirmedPools["ETH/USDT"].pool;

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  FINAL VERIFICATION: LONG 2x/5x + SHORT 2x/5x");
  console.log("═══════════════════════════════════════════════════════════════");

  const tests = [
    { side: "LONG",  leverage: 2, collateral: "10",      collateralToken: USDT, decimals: 6 },
    { side: "LONG",  leverage: 5, collateral: "10",      collateralToken: USDT, decimals: 6 },
    { side: "SHORT", leverage: 2, collateral: "0.002",   collateralToken: WETH, decimals: 18 },
    { side: "SHORT", leverage: 5, collateral: "0.002",   collateralToken: WETH, decimals: 18 },
  ];

  const results = [];
  for (const t of tests) {
    const collateralAmount = t.side === "LONG"
      ? ethers.parseUnits(t.collateral, 6)
      : ethers.parseEther(t.collateral);

    console.log(`\n  --- ${t.side} ${t.leverage}x (${t.collateral} ${t.side === "LONG" ? "USDT" : "WETH"}) ---`);

    try {
      const result = await openPosition({
        wallet, provider, managerAddr, poolAddr,
        side: t.side, collateralToken: t.collateralToken,
        collateralAmount, leverage: t.leverage,
        config: { deadlineSeconds: 1200, ethGuard: { MIN_ETH_GAS_RESERVE: 0.003 }, maxLeverage: 5 },
        log, dryRun: true,
      });
      results.push({ test: `${t.side} ${t.leverage}x`, status: "PASS" });
      console.log(`  RESULT: PASS`);
    } catch (e) {
      results.push({ test: `${t.side} ${t.leverage}x`, status: "FAIL", error: e.message?.slice(0, 60) });
      console.log(`  RESULT: FAIL — ${e.message?.slice(0, 60)}`);
    }
  }

  // Verify: no amountOutMin=0 in any calldata scenario
  console.log("\n═══════════ SAFETY CHECK ═══════════");
  console.log("  Verifying amountOutMin=0 never reaches TX...");

  // Read the autoTrader source to check
  const src = fs.readFileSync("autoTrader.js", "utf8");

  // Check that diagnosticCalldata is const (not let/var) and never assigned to calldata
  const hasDiagConst = src.includes("const diagnosticCalldata = encodeCalldata(0n)");
  const hasDiagAssign = /calldata\s*=\s*diagnosticCalldata/.test(src);
  const hasAmtOutZero = /amountOutMin\s*=\s*0n/.test(src);

  console.log(`  diagnosticCalldata is const:  ${hasDiagConst ? "YES" : "NO"}`);
  console.log(`  diagnosticCalldata→calldata:  ${hasDiagAssign ? "DANGER — assigned!" : "SAFE — never assigned"}`);
  console.log(`  amountOutMin = 0n exists:     ${hasAmtOutZero ? "DANGER — found!" : "SAFE — not found"}`);

  if (hasDiagAssign || hasAmtOutZero) {
    console.log("\n  *** SAFETY VIOLATION: amountOutMin=0 could reach TX ***");
    process.exit(1);
  } else {
    console.log("  *** SAFETY CONFIRMED: amountOutMin=0 is pre-flight only ***");
  }

  // Summary
  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  RESULTS SUMMARY");
  console.log("═══════════════════════════════════════════════════════════════");
  for (const r of results) {
    console.log(`  ${r.test.padEnd(12)} ${r.status}${r.error ? ` — ${r.error}` : ""}`);
  }
  console.log("═══════════════════════════════════════════════════════════════");
}

main().catch(e => { console.error(`FATAL: ${e.message}`); process.exit(1); });
