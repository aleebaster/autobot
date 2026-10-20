// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 3: Deep dive into 0x499ad952 — what exactly does the Manager reject?
//  Test: stale params vs fresh params, riskPrice vs oraclePrice
// ═══════════════════════════════════════════════════════════════════════════

import { ethers } from "ethers";
import fs from "fs";

// ═══ LIVE-TEST GATE (default: SKIP) ═══════════════════════════════════════
// This suite can sign real transactions. Normal runs must never do that:
// it is only reachable with the explicit opt-in phrase below (the global
// signer guard in _test_state_isolation.mjs enforces the same + chainId).
if (process.env.NEMESIS_ALLOW_LIVE_TX !== "SEND LIVE TRANSACTIONS") {
  console.log('SKIP — live-test opt-in missing. Re-run only with: NEMESIS_ALLOW_LIVE_TX="SEND LIVE TRANSACTIONS" (NEMESIS_LIVE_CHAIN_ID defaults to 11155111).');
  process.exit(0);
}

const WETH  = "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9";
const USDT  = "0x5f2E83cCDEa73D60aF400e03F1Cd8Fb9eaB07b20";
const MANAGER = "0x2069b502DD917DC089171F96BeE390FcB5bad29d";
const POOL    = "0xf32E24b7F739c7C17544cb972833aB551121A72B";
const BPS     = 10000n;
const OPEN_SELECTOR = "0xfa2b1dfd";

const POOL_ABI = [
  "function getReserves() view returns (uint112, uint112)",
  "function totalSupply() view returns (uint256)",
  "function token0() view returns (address)",
  "function getOraclePrice() view returns (uint256, uint256)",
  "function getRiskPrice() view returns (uint256, uint256)",
  "function swapFeeBps() view returns (uint256)",
  "function emaInitialized() view returns (bool)",
];

const MANAGER_ABI = [
  "function openPosition(bool,address,uint256,uint256,uint256,uint256,uint256) returns (uint256)",
  "function getAvailableLiquidity() view returns (uint256)",
  "function LTV_BPS() view returns (uint256)",
  "function PROTOCOL_FEE_BPS() view returns (uint256)",
];

function log(msg) { console.log(msg); }

function feeAdjusted(amount, feeBps) {
  if (amount === 0n || feeBps <= 0n) return amount;
  if (feeBps >= BPS) return 0n;
  return amount * (BPS - feeBps) / BPS;
}

function collateralAsLp({ collateralToken, collateralAmount, reserve0, reserve1, totalSupply, token0, oraclePrice0 }) {
  const q112 = 1n << 112n;
  if (collateralAmount === 0n || reserve0 === 0n || reserve1 === 0n || totalSupply === 0n || oraclePrice0 === 0n) return 0n;
  const collateralValue = collateralToken.toLowerCase() === token0.toLowerCase()
    ? collateralAmount * oraclePrice0 / q112 : collateralAmount;
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

async function tryOpen(provider, walletAddr, params) {
  const deadline = Math.floor(Date.now() / 1000) + 1200;
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const encoded = coder.encode(
    ["bool", "address", "uint256", "uint256", "uint256", "uint256", "uint256"],
    [params.isLong, params.collateralToken, params.collateralAmount, params.borrowAmount,
     params.leverageX10, params.amountOutMin, BigInt(deadline)]
  );
  const calldata = OPEN_SELECTOR + encoded.slice(2);
  try {
    await provider.call({ from: walletAddr, to: MANAGER, data: calldata, value: 0n });
    return { success: true };
  } catch (e) {
    const revertData = e?.data || e?.info?.error?.data || e?.cause?.data || e?.cause?.info?.error?.data || null;
    const match = (e?.shortMessage || e?.message || "").match(/0x[0-9a-fA-F]{8,}/);
    return { success: false, revertData: revertData || match?.[0] || "unknown" };
  }
}

async function main() {
  const pk = fs.readFileSync("wallets/pk.txt", "utf8").trim();
  const provider = new ethers.JsonRpcProvider("https://ethereum-sepolia-rpc.publicnode.com", 11155111);
  const wallet = new ethers.Wallet(pk, provider);

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  PHASE 3: 0x499ad952 DEEP DIVE");
  console.log("═══════════════════════════════════════════════════════════════");

  const pc = new ethers.Contract(POOL, POOL_ABI, provider);
  const mgr = new ethers.Contract(MANAGER, MANAGER_ABI, provider);

  // ════════ 1. Get BOTH oracle prices ════════
  console.log("\n═══════════ 1. ORACLE PRICE COMPARISON ═══════════");
  const [oraclePrice, riskPrice] = await Promise.all([
    pc.getOraclePrice(),
    pc.getRiskPrice(),
  ]);
  const op0 = BigInt(oraclePrice[0]), op1 = BigInt(oraclePrice[1]);
  const rp0 = BigInt(riskPrice[0]), rp1 = BigInt(riskPrice[1]);
  const q112 = 1n << 112n;

  console.log(`  getOraclePrice() — price0: ${op0}`);
  console.log(`  getRiskPrice()   — price0Avg: ${rp0}`);
  if (op0 > 0n && rp0 > 0n) {
    const deviationBps = op0 > rp0
      ? (op0 - rp0) * 10000n / rp0
      : (rp0 - op0) * 10000n / op0;
    console.log(`  Deviation: ${deviationBps} bps (${Number(deviationBps) / 100}%)`);
  }

  // ════════ 2. Compute quote with BOTH prices ════════
  console.log("\n═══════════ 2. QUOTE WITH DIFFERENT PRICES ═══════════");
  const collateralAmt = ethers.parseUnits("10", 6);
  const levX10 = 50n;

  const [res, ts, t0, sfb] = await Promise.all([
    pc.getReserves(), pc.totalSupply(), pc.token0(), pc.swapFeeBps()
  ]);
  const r0 = BigInt(res[0]), r1 = BigInt(res[1]);
  const tsBig = BigInt(ts);
  const sfbBig = BigInt(sfb);
  const pfb = await mgr.PROTOCOL_FEE_BPS().catch(() => 100n);
  const effective = feeAdjusted(collateralAmt, BigInt(pfb));

  for (const [priceName, price0] of [["oraclePrice", op0], ["riskPrice", rp0]]) {
    const cLp = collateralAsLp({
      collateralToken: USDT, collateralAmount: effective,
      reserve0: r0, reserve1: r1, totalSupply: tsBig, token0: t0, oraclePrice0: price0,
    });
    const borrowAmt = cLp * 40000n / BPS;
    const aomRaw = lpBorrowToExpectedOut({
      lpBorrowAmount: borrowAmt, collateralToken: USDT,
      reserve0: r0, reserve1: r1, totalSupply: tsBig, token0: t0, swapFeeBps: sfbBig,
    });
    const aomFinal = aomRaw * 9950n / 10000n;
    console.log(`\n  [${priceName}]`);
    console.log(`    collateralLp:  ${cLp}`);
    console.log(`    borrowAmount:  ${borrowAmt}`);
    console.log(`    amountOutMin:  ${aomFinal}`);

    const r = await tryOpen(provider, wallet.address, {
      isLong: true, collateralToken: USDT, collateralAmount: collateralAmt,
      borrowAmount: borrowAmt, leverageX10: levX10, amountOutMin: aomFinal,
    });
    console.log(`    pre-flight:    ${r.success ? "PASS" : "FAIL " + r.revertData}`);
  }

  // ════════ 3. Test amountOutMin=0 to isolate ════════
  console.log("\n═══════════ 3. ISOLATION: amountOutMin=0 ═══════════");
  const cLpOracle = collateralAsLp({
    collateralToken: USDT, collateralAmount: effective,
    reserve0: r0, reserve1: r1, totalSupply: tsBig, token0: t0, oraclePrice0: op0,
  });
  const borrowOracle = cLpOracle * 40000n / BPS;

  const r0_test = await tryOpen(provider, wallet.address, {
    isLong: true, collateralToken: USDT, collateralAmount: collateralAmt,
    borrowAmount: borrowOracle, leverageX10: levX10, amountOutMin: 0n,
  });
  console.log(`  oraclePrice + amountOutMin=0 → ${r0_test.success ? "PASS" : "FAIL " + r0_test.revertData}`);

  const cLpRisk = collateralAsLp({
    collateralToken: USDT, collateralAmount: effective,
    reserve0: r0, reserve1: r1, totalSupply: tsBig, token0: t0, oraclePrice0: rp0,
  });
  const borrowRisk = cLpRisk * 40000n / BPS;
  const r0_risk = await tryOpen(provider, wallet.address, {
    isLong: true, collateralToken: USDT, collateralAmount: collateralAmt,
    borrowAmount: borrowRisk, leverageX10: levX10, amountOutMin: 0n,
  });
  console.log(`  riskPrice + amountOutMin=0 → ${r0_risk.success ? "PASS" : "FAIL " + r0_risk.revertData}`);

  // ════════ 4. Test with bot's EXACT borrowAmount but amountOutMin=0 ════════
  console.log("\n═══════════ 4. BOT'S borrowAmount + amountOutMin=0 ═══════════");
  const r_bot_borrow = await tryOpen(provider, wallet.address, {
    isLong: true, collateralToken: USDT, collateralAmount: 10000000n,
    borrowAmount: 703352645080n, leverageX10: 50n, amountOutMin: 0n,
  });
  console.log(`  bot's borrowAmount=703352645080 + amountOutMin=0 → ${r_bot_borrow.success ? "PASS" : "FAIL " + r_bot_borrow.revertData}`);

  // ════════ 5. Test with bot's EXACT params but varying amountOutMin ════════
  console.log("\n═══════════ 5. BOT'S borrowAmount + varying amountOutMin ═══════════");
  const testAmounts = [0n, 1n, 100n, 1000n, 10000n, 100000n, 1000000n, 10000000n, 100000000n];
  for (const aom of testAmounts) {
    const r = await tryOpen(provider, wallet.address, {
      isLong: true, collateralToken: USDT, collateralAmount: 10000000n,
      borrowAmount: 703352645080n, leverageX10: 50n, amountOutMin: aom,
    });
    console.log(`  amountOutMin=${aom.toString().padStart(20)} → ${r.success ? "PASS" : "FAIL " + r.revertData}`);
  }

  // ════════ 6. Test with bot's EXACT amountOutMin but varying borrowAmount ════════
  console.log("\n═══════════ 6. BOT'S amountOutMin + varying borrowAmount ═══════════");
  const testBorrows = [0n, 1000000n, 100000000n, 1000000000n, 10000000000n, 100000000000n, 703352645080n, 1000000000000n];
  for (const borrow of testBorrows) {
    const r = await tryOpen(provider, wallet.address, {
      isLong: true, collateralToken: USDT, collateralAmount: 10000000n,
      borrowAmount: borrow, leverageX10: 50n, amountOutMin: 39948004503723916n,
    });
    console.log(`  borrowAmount=${borrow.toString().padStart(20)} → ${r.success ? "PASS" : "FAIL " + r.revertData}`);
  }

  // ════════ 7. Test with bot's EXACT collateralAmount but borrowAmount=0 ════════
  console.log("\n═══════════ 7. COLLATERAL ISOLATION ═══════════");
  const testCollateral = [1000000n, 5000000n, 10000000n, 50000000n, 100000000n];
  for (const col of testCollateral) {
    const r = await tryOpen(provider, wallet.address, {
      isLong: true, collateralToken: USDT, collateralAmount: col,
      borrowAmount: 0n, leverageX10: 50n, amountOutMin: 0n,
    });
    console.log(`  collateralAmount=${col.toString().padStart(12)} → ${r.success ? "PASS" : "FAIL " + r.revertData}`);
  }

  // ════════ 8. Test wrong collateral token ════════
  console.log("\n═══════════ 8. WRONG COLLATERAL TOKEN ═══════════");
  const r_wrong_token = await tryOpen(provider, wallet.address, {
    isLong: true, collateralToken: WETH, collateralAmount: 10000000n,
    borrowAmount: 0n, leverageX10: 50n, amountOutMin: 0n,
  });
  console.log(`  WETH as collateral → ${r_wrong_token.success ? "PASS" : "FAIL " + r_wrong_token.revertData}`);

  // ════════ 9. Leverage=0, leverage=1, leverage>50 ════════
  console.log("\n═══════════ 9. LEVERAGE EDGE CASES ═══════════");
  const levTests = [
    [0, "0x"],
    [10, "1x"],
    [15, "1.5x"],
    [50, "5x"],
    [51, "5.1x"],
    [100, "10x"],
    [200, "20x"],
    [1000, "100x"],
    [65535, "6553.5x"],
    [2**256-1, "MAX_UINT"],
  ];
  for (const [lev, desc] of levTests) {
    try {
      const levBI = BigInt(lev);
      const cLp = collateralAsLp({
        collateralToken: USDT, collateralAmount: effective,
        reserve0: r0, reserve1: r1, totalSupply: tsBig, token0: t0, oraclePrice0: op0,
      });
      const borrow = levBI > 10n ? cLp * (levBI - 10n) * 10000n / (10n * BPS) : 0n;
      const r = await tryOpen(provider, wallet.address, {
        isLong: true, collateralToken: USDT, collateralAmount: collateralAmt,
        borrowAmount: borrow, leverageX10: levBI, amountOutMin: 0n,
      });
      console.log(`  ${desc.padEnd(10)} borrow=${borrow.toString().padStart(20)} → ${r.success ? "PASS" : "FAIL " + r.revertData}`);
    } catch (e) {
      console.log(`  ${desc.padEnd(10)} → ERROR: ${e.message?.slice(0, 60)}`);
    }
  }

  // ════════ 10. isLong=false (SHORT) ════════
  console.log("\n═══════════ 10. SHORT POSITION ═══════════");
  const r_short = await tryOpen(provider, wallet.address, {
    isLong: false, collateralToken: WETH, collateralAmount: ethers.parseUnits("0.001", 18),
    borrowAmount: 0n, leverageX10: 20n, amountOutMin: 0n,
  });
  console.log(`  SHORT with WETH collateral → ${r_short.success ? "PASS" : "FAIL " + r_short.revertData}`);

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  PHASE 3 COMPLETE");
  console.log("═══════════════════════════════════════════════════════════════");
}

main().catch(e => { console.error(`FATAL: ${e.message}`); process.exit(1); });
