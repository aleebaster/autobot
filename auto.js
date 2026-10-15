#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
//  AUTONOMOUS TRADING LOOP — CLI Entry Point
//  Usage: npm run auto
// ═══════════════════════════════════════════════════════════════════════════

import { ethers } from "ethers";
import fs from "fs";
import { AutoTrader } from "./autoTrader.js";
import { getActiveDeployment, getConfirmedPools } from "./deployments/index.js";
import { DEFAULT_ETH_GUARD } from "./tokenInventory.js";
import { resolveRuntimeMode, describeRuntimeMode } from "./runtimeMode.js";

// ─── Load config ───
function loadConfig() {
  try {
    const raw = fs.readFileSync("config.json", "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

// ─── Load wallet accounts ───
function loadAccounts() {
  // Try config.json first
  try {
    const raw = fs.readFileSync("config.json", "utf8");
    const cfg = JSON.parse(raw);
    if (cfg.accounts && cfg.accounts.length > 0) return cfg.accounts;
  } catch {}
  // Try wallets/pk.txt
  try {
    const pk = fs.readFileSync("wallets/pk.txt", "utf8").trim();
    if (pk) {
      const wallet = new ethers.Wallet(pk);
      return [{ address: wallet.address, privateKey: pk }];
    }
  } catch {}
  return [];
}

// ─── RPC provider ───
function getProvider(rpcUrl, chainId) {
  return new ethers.JsonRpcProvider(rpcUrl, chainId);
}

// ─── Logger ───
function log(msg, level = "info") {
  const ts = new Date().toISOString().slice(11, 19);
  const prefix = {
    info: " ",
    warn: "⚠️",
    error: "❌",
    success: "✅",
  }[level] || " ";
  console.log(`[${ts}] ${prefix} ${msg}`);
}

// ─── Main ───
async function main() {
  const config = loadConfig();
  const accounts = loadAccounts();
  const deployment = getActiveDeployment();
  const confirmedPools = getConfirmedPools();

  // CLI flags
  const args = process.argv.slice(2);
  const once = args.includes("--once");
  const swapMatrix = args.includes("--swap-matrix");
  const swapOnce = args.includes("--swap-once");
  const swapLoop = args.includes("--swap-loop");
  const singleSwap = args.includes("--single-swap");
  const confirm = args.includes("--confirm");
  const argValue = (name) => {
    const hit = args.find(a => a.startsWith(`${name}=`));
    return hit ? hit.split("=").slice(1).join("=") : null;
  };
  const fromToken = argValue("--from");
  const toToken = argValue("--to");
  const swapAmount = argValue("--amount");
  const leverageArg = args.find(a => a.startsWith("--leverage="));
  const leverage = leverageArg ? parseInt(leverageArg.split("=")[1]) : 2;

  // ─── RUNTIME MODE — one answer for "what may this process do?" ───
  // `fullAutoEnabled` in config.json is the ONLY live master. `--dry-run` and
  // `simulateOnly` force a read-only run. There is no implicit path to live.
  const mode = resolveRuntimeMode(config, args);
  const dryRun = mode.dryRun;
  if (!mode.liveEnabled) {
    console.log(`\n  ⛔ ${mode.refusal}`);
    mode.reasons.forEach(r => console.log(`     • ${r}`));
    if (mode.dryRun) {
      console.log(`\n  → Proceeding READ-ONLY. ${describeRuntimeMode(mode)}`);
    } else {
      console.error(`\nRefusing to start: ${mode.refusal}`);
      process.exit(1);
    }
  } else {
    console.log(`\n  ⚠️  LIVE MODE ENABLED — ${describeRuntimeMode(mode)}`);
    mode.reasons.forEach(r => console.log(`     • ${r}`));
  }

  console.log("═══════════════════════════════════════════════════════");
  console.log("  NEMESIS AUTONOMOUS TRADER — Sepolia Testnet");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  Factory:     ${deployment.factory}`);
  console.log(`  Router:      ${deployment.router}`);
  console.log(`  ⚠️  DEPLOYMENT MISMATCH: бот і сайт Nemesis використовують різні Factory/Router.`);
  console.log(`     Позиції бота можуть не відображатися на сайті (не є помилкою індексатора).`);
  console.log(`     Bot  factory ${deployment.factory}  router ${deployment.router}`);
  console.log(`     Site factory 0x35f75f9218c640335d7166628319c4d95d1b0ae8  router 0x6c2844a5aFd10e22195d5f58227434b5b073b6d3`);
  const marketCount = Object.keys(confirmedPools || {}).length;
  const sampleMgr = Object.values(confirmedPools || {}).find(p => p?.manager)?.manager || "N/A";
  console.log(`  Markets:     ${marketCount} confirmed pool(s) + dynamic factory discovery`);
  console.log(`  Sample mgr:  ${sampleMgr}`);
  console.log(`  Rotation:    all active MARKET × SIDE (no single preferred market)`);
  console.log(`  Leverage:    ${leverage}x`);
  console.log(`  Dry run:     ${dryRun}`);
  console.log(`  Once mode:   ${once}`);
  console.log(`  Accounts:    ${accounts.length}`);
  console.log("═══════════════════════════════════════════════════════");

  if (accounts.length === 0) {
    console.error("No accounts found in config.json. Cannot trade.");
    process.exit(1);
  }

  const rpcUrl = config.rpcUrl || "https://ethereum-sepolia-rpc.publicnode.com";
  const chainId = config.chainId || 11155111;
  const provider = new ethers.JsonRpcProvider(rpcUrl, chainId);

  // Show wallet balance
  const walletAddr = accounts[0].address;
  const ethBal = await provider.getBalance(walletAddr);
  console.log(`  Wallet:      ${walletAddr}`);
  console.log(`  ETH Balance: ${ethers.formatEther(ethBal)} ETH`);
  console.log("═══════════════════════════════════════════════════════");

  if (ethBal < ethers.parseEther("0.003")) {
    console.error("  ⚠️ ETH balance too low for gas. Need at least 0.003 ETH.");
    process.exit(1);
  }

  // Build AutoTrader dependencies
  const autoConfig = {
    defaultLeverage: leverage,
    maxLeverage: Number(config.maxLeverage ?? 5),
    // Leverage window + per-market overrides (read-only from config.json):
    // resolveLeverageForOpen() clamps contractBounds ∩ [leverageMin..leverageMax]
    // ∩ marketLeverage[symbol] and probes previewOpenPosition per candidate.
    leverageMin: Number(config.leverageMin ?? 1),
    leverageMax: Number(config.leverageMax ?? config.maxLeverage ?? 5),
    marketLeverage: (config.marketLeverage && typeof config.marketLeverage === "object")
      ? config.marketLeverage : {},
    leverageAutoStep: config.leverageAutoStep !== false,
    autoLoopIntervalMs: once ? 0 : 5_000,
    ethGuard: { ...DEFAULT_ETH_GUARD },
    dryRun,
    cooldownAfterOpenMs: 3_000,
    cooldownAfterCloseMs: 3_000,
    autoSwap: config.autoSwap,
    swap: config.swap,
    swapEconomy: config.swapEconomy,
    enableLong: config.enableLong !== false,
    enableShort: config.enableShort !== false,
    enableClose: config.enableClose !== false,
    targetCollateralUSDT: config.targetCollateralUSDT || "10",
    targetCollateralWETH: config.targetCollateralWETH || "0.002",
    targetCollateralGeneric: config.targetCollateralGeneric || "10",
    maxCollateralTargetShort: config.maxCollateralTargetShort || "10000",
    targetReserveUSDT: config.targetReserveUSDT || "20",
    targetReserveWETH: config.targetReserveWETH || "0.004",
    targetReserveGeneric: config.targetReserveGeneric || "20",
    deadlineSeconds: config.deadlineSeconds || 1200,
    slippageBps: config.slippageBps || 50,
    availableMarkets: config.availableMarkets || [],
    preferredMarket: config.preferredMarket || null,
  };

  const deps = {
    accounts,
    selectedWalletIndex: 0,
    proxies: config.proxies || [],
    rpcUrl,
    chainId,
    config: autoConfig,
    confirmedPools,
    getProvider: (url, chain) => new ethers.JsonRpcProvider(url, chain),
    log,
  };

  const trader = new AutoTrader(deps);

  // ─── READ-ONLY: check every directed SWAP pair (no transaction) ───
  if (swapMatrix) {
    console.log("\n  SWAP MATRIX MODE — read-only route check for every direction.\n");
    try {
      const res = await trader.runSwapMatrix();
      console.log(`\n  Routable: ${res.routable}/${res.total}  |  funded at probe size: ${res.funded}/${res.total}`);
      process.exit(res.routable === res.total ? 0 : 2);
    } catch (e) {
      console.error(`Swap matrix error: ${e.message}`);
      process.exit(1);
    }
  }

  // ─── ONE real swap — requires an explicit --confirm ───
  if (swapOnce) {
    console.log(`\n  SWAP ONCE MODE — ${confirm ? "confirmed, one swap will be executed" : "NOT confirmed — nothing will be sent (add --confirm)"}.\n`);
    try {
      const res = await trader.runSwapOnce({ confirm, from: fromToken, to: toToken, count: 1 });
      process.exit(res?.blocked === "CONFIRM_REQUIRED" ? 3 : 0);
    } catch (e) {
      console.error(`Swap-once error: ${e.message}`);
      process.exit(1);
    }
  }

  // ─── ONE explicitly-sized swap — requires --confirm + --from/--to/--amount ───
  if (singleSwap) {
    console.log(`\n  SINGLE-SWAP MODE — exactly ONE swap, then exit.`);
    console.log(`  Direction: ${fromToken || "(not set)"} → ${toToken || "(not set)"}   amount: ${swapAmount || "(not set)"}`);
    console.log(`  Confirm:   ${confirm ? "yes — one transaction will be signed" : "NO — read-only plan only"}`);
    console.log(`  No rotation, no OPEN/CLOSE, no approve, no loop.\n`);
    try {
      const res = await trader.runSingleSwap({ confirm, from: fromToken, to: toToken, amount: swapAmount });
      if (res?.plan) {
        const p = res.plan;
        console.log("\n  ── SINGLE-SWAP PLAN ──────────────────────────────────────────────");
        console.log(`  direction      ${p.direction}`);
        console.log(`  tokenIn        ${p.tokenIn}`);
        console.log(`  tokenOut       ${p.tokenOut}`);
        console.log(`  path           ${(p.path || []).join(" -> ")}  (${p.hops})`);
        console.log(`  pool           ${p.pool}`);
        console.log(`  router         ${p.router}`);
        console.log(`  amountIn       ${p.amountInHuman}  (raw ${p.amountIn})`);
        console.log(`  quoteOut       ${p.quoteOutHuman}  (raw ${p.quoteOut})`);
        console.log(`  amountOutMin   ${p.amountOutMinHuman}  (raw ${p.amountOutMin}, slippage ${p.slippageBps} bps)`);
        console.log(`  poolShare      ${p.poolSharePct === null ? "-" : p.poolSharePct.toFixed(4) + "%"}`);
        console.log(`  priceImpact    ${p.priceImpactExFeePct === null ? "-" : p.priceImpactExFeePct.toFixed(4) + "%"} (ex-fee)`);
        console.log(`  gas estimate   ${p.gasEstimate ?? "-"}  (~${p.gasCostEth ?? "?"} ETH @ ${p.gasPriceWei ?? "?"} wei)`);
        console.log(`  preflight      ${p.preflight}   deadline ${p.deadline}   txCap ${p.txCap}`);
        console.log("  ─────────────────────────────────────────────────────────────────\n");
      }
      if (res?.blocked) process.exit(2);
      if (res?.result?.status === "skip" || res?.result?.status === "fail") process.exit(3);
      process.exit(0);
    } catch (e) {
      console.error(`Single-swap error: ${e.message}`);
      process.exit(1);
    }
  }

  // ─── ONE explicit action: open | close | partial | status | swap ───
  // --single=<mode>; dry-run by default, --confirm allows the write path.
  const singleMode = argValue("--single");
  if (singleMode) {
    const modeName = String(singleMode).toLowerCase();
    const sideArg = argValue("--side");
    const marketArg = argValue("--market");
    const idArg = argValue("--id");
    const pctArg = argValue("--pct");
    const managerArg = argValue("--manager");
    const levOverride = leverageArg !== undefined && leverageArg !== null
      ? parseInt(leverageArg.split("=")[1]) : null;
    console.log(`\n  SINGLE ACTION: ${modeName}`);
    console.log(`  args: side=${sideArg || "-"} market=${marketArg || "-"} id=${idArg || "-"} pct=${pctArg || "-"} leverage=${levOverride ?? "-"} manager=${managerArg || "-"}`);
    console.log(`  confirm=${confirm ? "YES (TX allowed if config.dryRun=false)" : "NO — read-only/dry-run only"}\n`);
    try {
      const res = await trader.runSingleAction({
        action: modeName,
        confirm,
        side: sideArg,
        marketSymbol: marketArg,
        leverage: Number.isFinite(levOverride) ? levOverride : null,
        positionId: idArg,
        pct: pctArg !== null ? Number(pctArg) : null,
        manager: managerArg,
        from: fromToken,
        to: toToken,
        amount: swapAmount,
      });
      const json = JSON.stringify(res, (k, v) => typeof v === "bigint" ? v.toString() : v, 1);
      console.log(`\n  ── ${modeName.toUpperCase()} RESULT ──────────────────────────────`);
      console.log(json);
      console.log("  ───────────────────────────────────────────────────────────\n");
      if (res?.ok) process.exit(0);
      const usageCodes = ["BAD_SIDE", "BAD_LEVERAGE", "BAD_PCT", "NO_POSITION_ID", "NO_MANAGER", "BAD_ID", "UNKNOWN_ACTION"];
      if (usageCodes.includes(res?.code)) process.exit(2);
      if (res?.code === "DRY") process.exit(0);
      process.exit(3);
    } catch (e) {
      console.error(`Single action error: ${e.message}`);
      process.exit(1);
    }
  }

  // ─── CONTINUOUS rotation — requires an explicit --confirm ───
  if (swapLoop) {
    const maxCyclesArg = argValue("--max-cycles");
    const maxCycles = maxCyclesArg ? Number(maxCyclesArg) : null;
    console.log(`\n  SWAP LOOP MODE — ${confirm ? "confirmed, the rotation will send transactions" : "NOT confirmed — nothing will be sent (add --confirm)"}.\n`);
    try {
      const res = await trader.runSwapLoop({ confirm, maxCycles, from: fromToken, to: toToken });
      process.exit(res?.blocked === "CONFIRM_REQUIRED" ? 3 : 0);
    } catch (e) {
      console.error(`Swap-loop error: ${e.message}`);
      process.exit(1);
    }
  }

  if (dryRun) {
    console.log("\n  DRY RUN MODE — no transactions will be sent.\n");
    try {
      await trader.runCycle();
    } catch (e) {
      console.error(`Cycle error: ${e.message}`);
    }
    process.exit(0);
  }

  if (once) {
    console.log("\n  SINGLE CYCLE MODE — executing one cycle then exiting.\n");
    try {
      await trader.runCycle();
    } catch (e) {
      console.error(`Cycle error: ${e.message}`);
    }
    process.exit(0);
  }

  // Handle graceful shutdown
  process.on("SIGINT", () => {
    console.log("\n  Received SIGINT — stopping trader gracefully...");
    trader.stop();
  });

  process.on("SIGTERM", () => {
    console.log("\n  Received SIGTERM — stopping trader gracefully...");
    trader.stop();
  });

  // Start autonomous loop
  await trader.start();
}

main().catch((e) => {
  console.error(`Fatal: ${e.message}`);
  process.exit(1);
});
