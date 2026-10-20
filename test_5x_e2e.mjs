// ═══════════════════════════════════════════════════════════════════════════
//  REAL E2E: 5x leverage OPEN + CLOSE
// ═══════════════════════════════════════════════════════════════════════════

// signer guard in _test_state_isolation.mjs enforces the same + chainId).
import { ethers } from "ethers";
import fs from "fs";
import { getConfirmedPools } from "./deployments/index.js";
import { openPosition, closePositionFn } from "./autoTrader.js";

// ═══ LIVE-TEST GATE (default: SKIP) ═══════════════════════════════════════
// This suite can sign real transactions. Normal runs must never do that:
// it is only reachable with the explicit opt-in phrase below (the global
if (process.env.NEMESIS_ALLOW_LIVE_TX !== "SEND LIVE TRANSACTIONS") {
  console.log('SKIP — live-test opt-in missing. Re-run only with: NEMESIS_ALLOW_LIVE_TX="SEND LIVE TRANSACTIONS" (NEMESIS_LIVE_CHAIN_ID defaults to 11155111).');
  process.exit(0);
}

const USDT  = "0x5f2E83cCDEa73D60aF400e03F1Cd8Fb9eaB07b20";
const MANAGER = "0x2069b502DD917DC089171F96BeE390FcB5bad29d";
const POSITION_CLOSED_TOPIC  = "0xe42b698fcce590b36d0b1c0ec13604bdcfb56db3f30c080c63614334e0d00b1a";

function log(msg) { console.log(`  ${msg}`); }

async function main() {
  const pk = fs.readFileSync("wallets/pk.txt", "utf8").trim();
  const provider = new ethers.JsonRpcProvider("https://ethereum-sepolia-rpc.publicnode.com", 11155111);
  const wallet = new ethers.Wallet(pk, provider);
  const confirmedPools = getConfirmedPools();
  const managerAddr = confirmedPools["ETH/USDT"].manager;
  const poolAddr = confirmedPools["ETH/USDT"].pool;

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  REAL E2E: 5x LEVERAGE OPEN + CLOSE");
  console.log("═══════════════════════════════════════════════════════════════");

  const usdtBefore = await new ethers.Contract(USDT, ["function balanceOf(address) view returns (uint256)"], provider).balanceOf(wallet.address);
  console.log(`  USDT before: ${ethers.formatUnits(usdtBefore, 6)}`);

  console.log("\n  --- OPEN 5x ---");
  const openResult = await openPosition({
    wallet, provider, managerAddr, poolAddr,
    side: "LONG", collateralToken: USDT,
    collateralAmount: ethers.parseUnits("10", 6),
    leverage: 5,
    config: { deadlineSeconds: 1200, ethGuard: { MIN_ETH_GAS_RESERVE: 0.003 }, maxLeverage: 5 },
    log, dryRun: false,
  });

  if (openResult) {
    console.log(`\n  OPEN TX: ${openResult.txHash}`);
    console.log(`  Position: #${openResult.positionId}`);
    console.log(`  Gas: ${openResult.gasUsed}`);

    const receipt = await provider.getTransactionReceipt(openResult.txHash);
    const closes = receipt.logs.filter(l => l.topics[0] === POSITION_CLOSED_TOPIC);
    if (closes.length > 0) {
      console.log(`  V2 auto-close confirmed`);
    } else {
      console.log(`  Closing...`);
      const closeResult = await closePositionFn({
        wallet, provider, managerAddr, positionId: openResult.positionId,
        config: { deadlineSeconds: 1200, ethGuard: { MIN_ETH_GAS_RESERVE: 0.003 } },
        log, dryRun: false,
      });
      if (closeResult?.txHash) console.log(`  CLOSE TX: ${closeResult.txHash}`);
    }
  } else {
    console.log(`  OPEN returned null`);
  }

  const usdtAfter = await new ethers.Contract(USDT, ["function balanceOf(address) view returns (uint256)"], provider).balanceOf(wallet.address);
  console.log(`\n  USDT after: ${ethers.formatUnits(usdtAfter, 6)}`);
  console.log("═══════════════════════════════════════════════════════════════");
}

main().catch(e => { console.error(`FATAL: ${e.message}`); process.exit(1); });
