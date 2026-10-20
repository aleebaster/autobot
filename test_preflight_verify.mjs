// ═══════════════════════════════════════════════════════════════════════════
//  STEP 13: Pre-flight verify 2x/3x/4x/5x + Real E2E
//  Uses the EXACT same code path as autoTrader (imported directly)
// ═══════════════════════════════════════════════════════════════════════════

import "./_test_state_isolation.mjs"; // state redirect + default-deny live-TX guard
import { ethers } from "ethers";
import fs from "fs";
import { getConfirmedPools } from "./deployments/index.js";

const WETH  = "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9";
const USDT  = "0x5f2E83cCDEa73D60aF400e03F1Cd8Fb9eaB07b20";
const USDC  = "0x5dcf1Db10F87CB7839640F9B85C4ECfA29b56e80";
const MANAGER = "0x2069b502DD917DC089171F96BeE390FcB5bad29d";
const POOL    = "0xf32E24b7F739c7C17544cb972833aB551121A72B";
const POSITION_CREATED_TOPIC = "0x2e462fabb57854af0ee2383faf948da3dc380bd08e582513c3e8e1177478c64a";
const POSITION_CLOSED_TOPIC  = "0xe42b698fcce590b36d0b1c0ec13604bdcfb56db3f30c080c63614334e0d00b1a";
const BPS = 10000n;

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address, address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
  "function decimals() view returns (uint8)",
];
const MANAGER_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function getAvailableLiquidity() view returns (uint256)",
];
const POOL_ABI = [
  "function getReserves() view returns (uint112, uint112)",
  "function totalSupply() view returns (uint256)",
  "function token0() view returns (address)",
  "function getOraclePrice() view returns (uint256, uint256)",
  "function swapFeeBps() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
];

function log(msg, level = "info") {
  const ts = new Date().toISOString().slice(11, 19);
  const pfx = { info: " ", warn: " ", error: " ", success: " " }[level] || " ";
  console.log(`[${ts}] ${pfx} ${msg}`);
}

async function main() {
  const pk = fs.readFileSync("wallets/pk.txt", "utf8").trim();
  const provider = new ethers.JsonRpcProvider("https://ethereum-sepolia-rpc.publicnode.com", 11155111);
  const wallet = new ethers.Wallet(pk, provider);
  const confirmedPools = getConfirmedPools();
  const managerAddr = confirmedPools["ETH/USDT"].manager;
  const poolAddr = confirmedPools["ETH/USDT"].pool;

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  STEP 13: PRE-FLIGHT + REAL E2E");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  Wallet:  ${wallet.address}`);
  console.log(`  Manager: ${managerAddr}`);
  console.log(`  Pool:    ${poolAddr}`);

  // ════════ 1. Import autoTrader functions directly ════════
  console.log("\n═══════════ 1. IMPORT autoTrader ═══════════");
  const autoTrader = await import("./autoTrader.js");
  console.log("  autoTrader.js loaded successfully");

  // ════════ 2. Pre-flight test 2x/3x/4x/5x ════════
  console.log("\n═══════════ 2. PRE-FLIGHT TEST 2x/3x/4x/5x ═══════════");

  const leverageTests = [2, 3, 4, 5];
  const collateralAmount = ethers.parseUnits("10", 6); // 10 USDT
  const logs = [];
  const logCapture = (msg, level) => { logs.push({ msg, level }); console.log(`  ${msg}`); };

  for (const lev of leverageTests) {
    console.log(`\n  --- ${lev}x LEVERAGE ---`);
    logs.length = 0;

    try {
      const result = await autoTrader.openPosition({
        wallet,
        provider,
        managerAddr,
        poolAddr,
        side: "LONG",
        collateralToken: USDT,
        collateralAmount,
        leverage: lev,
        config: {
          deadlineSeconds: 1200,
          ethGuard: { MIN_ETH_GAS_RESERVE: 0.003 },
          maxLeverage: 5,
        },
        log: logCapture,
        dryRun: true,
      });
      console.log(`  ${lev}x: PASS (dryRun)`);
    } catch (e) {
      console.log(`  ${lev}x: ERROR — ${e.message?.slice(0, 80)}`);
    }
  }

  // ════════ 3. Real E2E: 2x OPEN + CLOSE ════════
  console.log("\n═══════════ 3. REAL E2E: 2x OPEN + CLOSE ═══════════");

  // Record balances before
  const usdtBefore = await new ethers.Contract(USDT, ERC20_ABI, provider).balanceOf(wallet.address);
  const ethBefore = await provider.getBalance(wallet.address);
  console.log(`  USDT before: ${ethers.formatUnits(usdtBefore, 6)}`);
  console.log(`  ETH before:  ${ethers.formatEther(ethBefore)}`);

  // Run openPosition for real with 2x leverage
  const e2eLogs = [];
  const e2eLog = (msg, level) => { e2eLogs.push({ msg, level }); console.log(`  ${msg}`); };

  console.log("\n  --- OPEN 2x ---");
  try {
    const openResult = await autoTrader.openPosition({
      wallet,
      provider,
      managerAddr,
      poolAddr,
      side: "LONG",
      collateralToken: USDT,
      collateralAmount,
      leverage: 2,
      config: {
        deadlineSeconds: 1200,
        ethGuard: { MIN_ETH_GAS_RESERVE: 0.003 },
        maxLeverage: 5,
      },
      log: e2eLog,
      dryRun: false,
    });

    if (openResult) {
      console.log(`\n  OPEN SUCCESS`);
      console.log(`  TX: ${openResult.txHash}`);
      console.log(`  Position ID: #${openResult.positionId}`);
      console.log(`  Gas used: ${openResult.gasUsed}`);

      // Check for auto-close (V2 pattern)
      const openReceipt = await provider.getTransactionReceipt(openResult.txHash);
      const closeEvents = openReceipt.logs.filter(l => l.topics[0] === POSITION_CLOSED_TOPIC);

      if (closeEvents.length > 0) {
        console.log(`  Position auto-closed in same TX (V2 pattern)`);
        console.log(`  CLOSE TX: ${openResult.txHash} (same TX)`);
      } else {
        // Manual close
        console.log(`\n  --- CLOSE #${openResult.positionId} ---`);
        const closeResult = await autoTrader.closePositionFn({
          wallet,
          provider,
          managerAddr,
          positionId: openResult.positionId,
          config: { deadlineSeconds: 1200, ethGuard: { MIN_ETH_GAS_RESERVE: 0.003 } },
          log: e2eLog,
          dryRun: false,
        });

        if (closeResult?.txHash) {
          console.log(`  CLOSE TX: ${closeResult.txHash}`);
          console.log(`  Gas used: ${closeResult.gasUsed}`);
        } else if (closeResult?.failed) {
          console.log(`  CLOSE failed: ${closeResult.reason?.slice(0, 60)}`);
        } else {
          console.log(`  CLOSE returned null`);
        }
      }

      // Record balances after
      const usdtAfter = await new ethers.Contract(USDT, ERC20_ABI, provider).balanceOf(wallet.address);
      const ethAfter = await provider.getBalance(wallet.address);
      console.log(`\n  --- BALANCES ---`);
      console.log(`  USDT before: ${ethers.formatUnits(usdtBefore, 6)}`);
      console.log(`  USDT after:  ${ethers.formatUnits(usdtAfter, 6)}`);
      console.log(`  ETH before:  ${ethers.formatEther(ethBefore)}`);
      console.log(`  ETH after:   ${ethers.formatEther(ethAfter)}`);
      console.log(`  ETH gas:     ${ethers.formatEther(ethBefore - ethAfter)}`);

      // Check LP balance
      const lpBal = await new ethers.Contract(managerAddr, MANAGER_ABI, provider).balanceOf(wallet.address);
      console.log(`  LP balance:  ${lpBal}`);

    } else {
      console.log(`  OPEN returned null`);
    }
  } catch (e) {
    console.log(`  OPEN ERROR: ${e.message?.slice(0, 100)}`);
    console.log(`  Stack: ${e.stack?.slice(0, 200)}`);
  }

  // ════════ 4. Final summary ════════
  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  STEP 13 COMPLETE");
  console.log("═══════════════════════════════════════════════════════════════");
}

main().catch(e => { console.error(`FATAL: ${e.message}`); process.exit(1); });
