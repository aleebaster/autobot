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
  const dryRun = args.includes("--dry-run");
  const once = args.includes("--once");
  const leverageArg = args.find(a => a.startsWith("--leverage="));
  const leverage = leverageArg ? parseInt(leverageArg.split("=")[1]) : 2;

  console.log("═══════════════════════════════════════════════════════");
  console.log("  NEMESIS AUTONOMOUS TRADER — Sepolia Testnet");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  Factory:     ${deployment.factory}`);
  console.log(`  Router:      ${deployment.router}`);
  console.log(`  Manager:     ${confirmedPools["ETH/USDT"]?.manager || "N/A"}`);
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
    maxLeverage: 5,
    autoLoopIntervalMs: once ? 0 : 30_000,
    ethGuard: { ...DEFAULT_ETH_GUARD },
    dryRun,
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
