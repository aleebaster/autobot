import { ethers } from "ethers";
import fs from "fs";

const RPC = "https://ethereum-sepolia-rpc.publicnode.com/557d07a988c4164482ef0c56a10f98ee0e3073440fd72fbe89cd7f6fef809388";
const MGR = "0x53bb0fFBdA04E5982fa08D846aA265Ff6cFE068e";
const QADAI = "0xe99655E262eF4C20eBeC4805B3963dad52a1538e";
const WALLET_ADDR = "0x315E5193633A962B3F369F9C3833D973D0588cCD";
const CYCLES = 6;
const AMOUNT = "0.1";
const LEVERAGE = 20; // 2x encoded as 20 (leverageX10)

const POS_ABI = [
  "function openPosition(bool isLong,address collateralToken,uint256 collateralAmount,uint256 borrowAmount,uint256 leverageX10,uint256 amountOutMin,uint256 deadline) returns (uint256)",
  "function closePosition(uint256 positionId,uint256 amountOutMin,uint256 deadline)",
  "function getPosition(uint256 positionId) view returns (bool,address,address,uint256,uint256,uint256,uint256)",
  "function getUserPositions(address user) view returns (uint256[])",
  "function getAvailableLiquidity() view returns (uint256)",
  "function LTV_BPS() view returns (uint256)",
  "function PROTOCOL_FEE_BPS() view returns (uint256)",
  "event MAM_PositionCreated(uint256 indexed positionId,address indexed user,bool isLong,address collateralToken,uint256 collateralAmount,uint256 borrowAmount,uint256 debtAmount,uint256 leverageX10,uint256 deadline)",
  "event MAM_PositionClosed(uint256 indexed positionId,uint256 collateralReturned,int256 lossCollateral,uint256 borrowAmount)",
];
const POOL_ABI = [
  "function getReserves() view returns (uint112,uint112)",
  "function totalSupply() view returns (uint256)",
  "function token0() view returns (address)",
  "function getOraclePrice() view returns (uint256,uint256)",
  "function swapFeeBps() view returns (uint256)",
];
const FACTORY_ABI = [
  "function getPool(address,address) view returns (address)",
  "function getManager(address) view returns (address)",
];
const WETH = "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9";
const FACTORY = "0xDd3D572f8B74dC4F83d268f50f962A7fE1C57c14";
const BPS = 10000n;

const results = [];

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function getFeeParams(provider) {
  const fd = await provider.getFeeData();
  if (fd.maxFeePerGas && fd.maxPriorityFeePerGas)
    return { maxFeePerGas: fd.maxFeePerGas, maxPriorityFeePerGas: fd.maxPriorityFeePerGas, type: 2 };
  return { gasPrice: fd.gasPrice || ethers.parseUnits("1", "gwei"), type: 0 };
}

async function quoteAmountOutMin(provider) {
  const [tA, tB] = [QADAI, WETH].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  const factory = new ethers.Contract(FACTORY, FACTORY_ABI, provider);
  const poolAddr = await factory.getPool(tA, tB);
  const pool = new ethers.Contract(poolAddr, POOL_ABI, provider);
  const mgr = new ethers.Contract(MGR, POS_ABI, provider);
  const [reserves, totalSupply, token0, oraclePrice, swapFeeBps, availableLiquidity, ltvBps, protocolFeeBps] =
    await Promise.all([pool.getReserves(), pool.totalSupply(), pool.token0(), pool.getOraclePrice(), pool.swapFeeBps(), mgr.getAvailableLiquidity(), mgr.LTV_BPS(), mgr.PROTOCOL_FEE_BPS().catch(() => 100n)]);

  const r0 = BigInt(reserves[0]), r1 = BigInt(reserves[1]), ts = BigInt(totalSupply);
  const oracle0 = BigInt(oraclePrice[0]);
  const collateralToken = QADAI.toLowerCase();
  const collateralAmount = ethers.parseUnits(AMOUNT, 6);
  const effectiveCollateral = collateralAmount * (BPS - BigInt(protocolFeeBps)) / BPS;
  const collateralIsToken0 = collateralToken === token0.toLowerCase();
  const q112 = 1n << 112n;
  const collateralValue = collateralIsToken0 ? effectiveCollateral * oracle0 / q112 : effectiveCollateral;
  const poolValue = r0 * oracle0 / q112 + r1;
  const collateralLp = poolValue === 0n ? 0n : collateralValue * ts / poolValue;
  const lev = LEVERAGE / 10;
  let lpBorrowAmount = collateralLp * BigInt(Math.floor(10000 * Math.max(0, lev - 1))) / BPS;
  const maxByLtv = BigInt(ltvBps) >= BPS ? lpBorrowAmount : collateralLp * BigInt(ltvBps) / (BPS - BigInt(ltvBps));
  if (lpBorrowAmount > maxByLtv) lpBorrowAmount = maxByLtv;
  if (lpBorrowAmount > BigInt(availableLiquidity)) lpBorrowAmount = BigInt(availableLiquidity);

  const reserveIn = collateralIsToken0 ? r1 : r0;
  const reserveOut = collateralIsToken0 ? r0 : r1;
  const amountIn = collateralIsToken0 ? lpBorrowAmount * r1 / ts : lpBorrowAmount * r0 / ts;
  const collateralFromLp = collateralIsToken0 ? lpBorrowAmount * r0 / ts : lpBorrowAmount * r1 / ts;
  const adjustedReserveIn = reserveIn - amountIn;
  const adjustedReserveOut = reserveOut - collateralFromLp;
  const amountInWithFee = amountIn * (BPS - BigInt(swapFeeBps));
  const amountOutMinRaw = amountInWithFee * adjustedReserveOut / (adjustedReserveIn * BPS + amountInWithFee);
  return amountOutMinRaw * (BPS - 50n) / BPS;
}

async function openPosition(wallet, provider, isLong) {
  const mgr = new ethers.Contract(MGR, POS_ABI, wallet);
  const collateralAmount = ethers.parseUnits(AMOUNT, 6);
  const amountOutMin = await quoteAmountOutMin(provider);
  const deadline = Math.floor(Date.now() / 1000) + 1200;
  const feeParams = await getFeeParams(provider);
  const nonce = await provider.getTransactionCount(wallet.address, "pending");
  const gasEst = await mgr.openPosition.estimateGas(isLong, QADAI, collateralAmount, 0n, BigInt(LEVERAGE), amountOutMin, BigInt(deadline));
  const tx = await mgr.openPosition(isLong, QADAI, collateralAmount, 0n, BigInt(LEVERAGE), amountOutMin, BigInt(deadline), {
    ...feeParams, gasLimit: gasEst + gasEst / 5n, nonce,
  });
  console.log(`    TX: ${tx.hash}`);
  const receipt = await tx.wait();
  if (receipt.status !== 1) throw new Error("openPosition reverted");
  let positionId = null;
  for (const log of receipt.logs) {
    try {
      const parsed = mgr.interface.parseLog(log);
      if (parsed?.name === "MAM_PositionCreated") positionId = parsed.args.positionId.toString();
    } catch {}
  }
  if (!positionId) throw new Error("No PositionCreated event");
  console.log(`    Position #${positionId} created at block ${receipt.blockNumber}`);
  return { hash: tx.hash, block: receipt.blockNumber, positionId };
}

async function closePosition(wallet, provider, positionId) {
  const mgr = new ethers.Contract(MGR, POS_ABI, wallet);
  const deadline = Math.floor(Date.now() / 1000) + 1200;
  const feeParams = await getFeeParams(provider);
  const nonce = await provider.getTransactionCount(wallet.address, "pending");
  const gasEst = await mgr.closePosition.estimateGas(BigInt(positionId), 0, BigInt(deadline));
  const tx = await mgr.closePosition(BigInt(positionId), 0, BigInt(deadline), {
    ...feeParams, gasLimit: gasEst + gasEst / 5n, nonce,
  });
  console.log(`    TX: ${tx.hash}`);
  const receipt = await tx.wait();
  if (receipt.status !== 1) throw new Error("closePosition reverted");
  console.log(`    Position #${positionId} closed at block ${receipt.blockNumber}`);
  return { hash: tx.hash, block: receipt.blockNumber };
}

async function verifyPositionState(provider, positionId) {
  const mgr = new ethers.Contract(MGR, POS_ABI, provider);
  const pos = await mgr.getPosition(positionId);
  return { collateralAmt: pos[3], debt: pos[4], isActive: pos[3] > 0n || pos[4] > 0n };
}

async function main() {
  const pk = fs.readFileSync("pk.txt", "utf8").trim().split("\n")[0].trim();
  const provider = new ethers.JsonRpcProvider(RPC, 11155111);
  const wallet = new ethers.Wallet(pk, provider);
  console.log(`Wallet: ${wallet.address}`);
  console.log(`Cycles: ${CYCLES} (${CYCLES / 2} LONG + ${CYCLES / 2} SHORT)`);
  console.log(`Amount: ${AMOUNT} QADAI, Leverage: ${LEVERAGE / 10}x (leverageX10=${LEVERAGE})`);
  console.log("=".repeat(60));

  for (let i = 0; i < CYCLES; i++) {
    const isLong = i % 2 === 0;
    const side = isLong ? "LONG" : "SHORT";
    console.log(`\n[CYCLE ${i + 1}/${CYCLES}] ${side}`);

    try {
      console.log(`  Opening ${side}...`);
      const openResult = await openPosition(wallet, provider, isLong);
      await sleep(5000);

      const state = await verifyPositionState(provider, openResult.positionId);
      console.log(`  Verified: collateral=${state.collateralAmt.toString()} debt=${state.debt.toString()} active=${state.isActive}`);

      console.log(`  Waiting 30s for UI indexing...`);
      await sleep(30000);

      console.log(`  Closing position #${openResult.positionId}...`);
      const closeResult = await closePosition(wallet, provider, openResult.positionId);
      await sleep(5000);

      const stateAfter = await verifyPositionState(provider, openResult.positionId);
      console.log(`  Verified after close: active=${stateAfter.isActive}`);

      results.push({
        cycle: i + 1, side, positionId: openResult.positionId,
        openHash: openResult.hash, openBlock: openResult.block,
        closeHash: closeResult.hash, closeBlock: closeResult.block,
        status: "SUCCESS",
      });
      console.log(`  CYCLE ${i + 1} ${side} COMPLETE`);

    } catch (error) {
      console.log(`  CYCLE ${i + 1} ${side} FAILED: ${error.message}`);
      results.push({ cycle: i + 1, side, status: "FAILED", error: error.message });
    }
  }

  console.log("\n" + "=".repeat(60));
  console.log("FINAL RESULTS:");
  console.log("=".repeat(60));
  for (const r of results) {
    if (r.status === "SUCCESS") {
      console.log(`  Cycle ${r.cycle} ${r.side}: #${r.positionId} | Open: ${r.openHash} | Close: ${r.closeHash} | SUCCESS`);
    } else {
      console.log(`  Cycle ${r.cycle} ${r.side}: FAILED - ${r.error}`);
    }
  }
  const success = results.filter((r) => r.status === "SUCCESS").length;
  console.log(`\nTotal: ${success}/${CYCLES} succeeded`);
}

main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
