// ═══════════════════════════════════════════════════════════════════════════
//  DIAGNOSTIC: Decode Manager custom errors + test leverage levels
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
const USDC  = "0x5dcf1Db10F87CB7839640F9B85C4ECfA29b56e80";
const ROUTER = "0x8f6eB7870334b1FD8006Fd52413f01689f4E57e9";
const MANAGER = "0x2069b502DD917DC089171F96BeE390FcB5bad29d";
const POOL    = "0xf32E24b7F739c7C17544cb972833aB551121A72B";
const IMPL    = "0xeE68790cDb86BDCB7B9681E6fa7DC53744Ba4f4C";
const BPS     = 10000n;
const OPEN_SELECTOR = "0xfa2b1dfd";

const POOL_ABI = [
  "function getReserves() view returns (uint112, uint112)",
  "function totalSupply() view returns (uint256)",
  "function token0() view returns (address)",
  "function getOraclePrice() view returns (uint256, uint256)",
  "function swapFeeBps() view returns (uint256)",
  "function getRiskPrice() view returns (uint256, uint256)",
  "function emaInitialized() view returns (bool)",
  "function emaInitTimestamp() view returns (uint256)",
  "function MIN_TWAP_WINDOW() view returns (uint256)",
  "function checkpointOracle()",
  "function balanceOf(address) view returns (uint256)",
];

const MANAGER_ABI_FULL = [
  "function openPosition(bool isLong, address collateralToken, uint256 collateralAmount, uint256 borrowAmount, uint256 leverageX10, uint256 amountOutMin, uint256 deadline) returns (uint256)",
  "function closePosition(uint256 positionId, uint256 amountOutMin, uint256 deadline)",
  "function balanceOf(address account) view returns (uint256)",
  "function getAvailableLiquidity() view returns (uint256)",
  "function LTV_BPS() view returns (uint256)",
  "function PROTOCOL_FEE_BPS() view returns (uint256)",
  "function MAX_LEVERAGE_BPS() view returns (uint256)",
  "function MIN_LEVERAGE_BPS() view returns (uint256)",
  "function MAX_POSITION_SIZE() view returns (uint256)",
  "function MIN_POSITION_SIZE() view returns (uint256)",
  "function MAX_UTILIZATION_BPS() view returns (uint256)",
  "function maxBorrow() view returns (uint256)",
  "function currentUtilization() view returns (uint256)",
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

function log(msg, level = "info") {
  const ts = new Date().toISOString().slice(11, 19);
  const pfx = { info: " ", warn: " ", error: " ", success: " " }[level] || " ";
  console.log(`[${ts}] ${pfx} ${msg}`);
}

function feeAdjusted(amount, feeBps = 100n) {
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

function applySlippage(amount, slippageBps = 50n) {
  if (amount <= 0n) return 0n;
  return amount * (BPS - BigInt(slippageBps)) / BPS;
}

async function computeQuote(provider, { collateralToken, collateralAmount, leverageX10 }) {
  const poolContract = new ethers.Contract(POOL, POOL_ABI, provider);
  const managerContract = new ethers.Contract(MANAGER, MANAGER_ABI_FULL, provider);

  const [reserves, totalSupply, token0, oraclePrice, swapFeeBps, availableLiquidity, ltvBps, protocolFeeBps] = await Promise.all([
    poolContract.getReserves(),
    poolContract.totalSupply(),
    poolContract.token0(),
    poolContract.getOraclePrice(),
    poolContract.swapFeeBps(),
    managerContract.getAvailableLiquidity(),
    managerContract.LTV_BPS(),
    managerContract.PROTOCOL_FEE_BPS().catch(() => 100n),
  ]);

  const reserve0 = BigInt(reserves[0]);
  const reserve1 = BigInt(reserves[1]);
  const effectiveCollateral = feeAdjusted(collateralAmount, BigInt(protocolFeeBps));
  const collateralLp = collateralAsLp({
    collateralToken, collateralAmount: effectiveCollateral,
    reserve0, reserve1, totalSupply, token0, oraclePrice0: BigInt(oraclePrice[0]),
  });

  const lev = Number(leverageX10) / 10;
  let lpBorrowAmount = collateralLp * BigInt(Math.floor(10000 * Math.max(0, lev - 1))) / BPS;

  const maxByLtv = BigInt(ltvBps) >= BPS ? lpBorrowAmount : collateralLp * BigInt(ltvBps) / (BPS - BigInt(ltvBps));
  if (lpBorrowAmount > maxByLtv) lpBorrowAmount = maxByLtv;
  if (lpBorrowAmount > BigInt(availableLiquidity)) lpBorrowAmount = BigInt(availableLiquidity);

  const amountOutMinRaw = lpBorrowToExpectedOut({
    lpBorrowAmount, collateralToken, reserve0, reserve1, totalSupply, token0, swapFeeBps: BigInt(swapFeeBps),
  });
  const amountOutMinFinal = applySlippage(amountOutMinRaw, BigInt(50));

  return {
    reserve0, reserve1, totalSupply, token0, oraclePrice: BigInt(oraclePrice[0]),
    swapFeeBps: BigInt(swapFeeBps), availableLiquidity: BigInt(availableLiquidity),
    ltvBps: BigInt(ltvBps), protocolFeeBps: BigInt(protocolFeeBps),
    effectiveCollateral, collateralLp, lpBorrowAmount, amountOutMinRaw, amountOutMinFinal,
    lev,
  };
}

async function tryOpenPreFlight(provider, walletAddr, { isLong, collateralToken, collateralAmount, borrowAmount, leverageX10, amountOutMin }) {
  const deadline = Math.floor(Date.now() / 1000) + 1200;
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const params = coder.encode(
    ["bool", "address", "uint256", "uint256", "uint256", "uint256", "uint256"],
    [isLong, collateralToken, collateralAmount, borrowAmount, leverageX10, amountOutMin, BigInt(deadline)]
  );
  const calldata = OPEN_SELECTOR + params.slice(2);

  console.log(`\n  calldata length: ${calldata.length / 2 - 1} bytes`);
  console.log(`  calldata: ${calldata}`);

  try {
    const result = await provider.call({ from: walletAddr, to: MANAGER, data: calldata, value: 0n });
    return { success: true, result };
  } catch (e) {
    const rawMsg = e?.shortMessage || e?.message || String(e);
    // Extract raw revert data from error
    let revertData = null;
    if (e?.data) revertData = e.data;
    else if (e?.info?.error?.data) revertData = e.info.error.data;
    else {
      const match = rawMsg.match(/0x[0-9a-fA-F]{8,}/);
      if (match) revertData = match[0];
    }
    // Also try to get it from the cause
    if (!revertData && e?.cause?.data) revertData = e.cause.data;
    if (!revertData && e?.cause?.info?.error?.data) revertData = e.cause.info.error.data;

    return { success: false, rawMsg, revertData, fullError: e };
  }
}

async function main() {
  const pk = fs.readFileSync("wallets/pk.txt", "utf8").trim();
  const provider = new ethers.JsonRpcProvider("https://ethereum-sepolia-rpc.publicnode.com", 11155111);
  const wallet = new ethers.Wallet(pk, provider);

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  MANAGER OPEN POSITION DIAGNOSTIC");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  Wallet:     ${wallet.address}`);
  console.log(`  Manager:    ${MANAGER}`);
  console.log(`  Impl:       ${IMPL}`);
  console.log(`  Pool:       ${POOL}`);

  // ════════ 1. Fetch Manager implementation bytecode ════════
  console.log("\n═══════════ 1. MANAGER IMPLEMENTATION ═══════════");
  const implCode = await provider.getCode(IMPL);
  console.log(`  Implementation code length: ${implCode.length} chars (${(implCode.length - 2) / 2} bytes)`);

  // Search for known error selectors in bytecode
  const knownErrors = {
    "0x56e7f09d": "MAM_OpenOracleDivergence",
    "0x7939f424": "MAM_BROKEN_PROXY",
    "0x24811982": "MAM_WRONG_COLLATERAL_TOKEN",
    "0x499ad952": "MAM_POSITION_NOT_ALLOWED",
    "0x4e487b71": "Panic(uint256)",
    "0x08c379a0": "Error(string)",
  };

  console.log("  Searching for error selectors in bytecode...");
  for (const [sel, name] of Object.entries(knownErrors)) {
    const found = implCode.includes(sel.slice(2));
    console.log(`    ${sel} (${name}): ${found ? "FOUND" : "not found"}`);
  }

  // Search for ALL 4-byte selectors at PUSH4 locations (0x63XXXXXXXX)
  console.log("  Scanning for custom error selectors in bytecode...");
  const bytecode = implCode.slice(2);
  const foundSelectors = new Set();
  for (let i = 0; i < bytecode.length - 10; i++) {
    if (bytecode.slice(i, i + 2) === "63") {
      const sel = "0x" + bytecode.slice(i + 2, i + 10);
      if (/^0x[0-9a-f]{8}$/.test(sel)) {
        foundSelectors.add(sel);
      }
    }
  }
  console.log(`  Found ${foundSelectors.size} potential selectors in bytecode`);

  // ════════ 2. Fetch on-chain constraints ═══════════
  console.log("\n═══════════ 2. MANAGER ON-CHAIN CONSTRAINTS ═══════════");
  const mgr = new ethers.Contract(MANAGER, MANAGER_ABI_FULL, provider);

  const checks = [
    ["LTV_BPS()",         () => mgr.LTV_BPS()],
    ["PROTOCOL_FEE_BPS()",() => mgr.PROTOCOL_FEE_BPS()],
    ["getAvailableLiquidity()", () => mgr.getAvailableLiquidity()],
  ];

  // Try optional constraints
  const optionalChecks = [
    "MAX_LEVERAGE_BPS", "MIN_LEVERAGE_BPS", "MAX_POSITION_SIZE", "MIN_POSITION_SIZE",
    "MAX_UTILIZATION_BPS", "maxBorrow", "currentUtilization",
  ];
  for (const fn of optionalChecks) {
    try {
      const val = await mgr[fn]();
      checks.push([`${fn}()`, () => Promise.resolve(val)]);
    } catch {
      // Not present
    }
  }

  for (const [name, fn] of checks) {
    try {
      const val = await fn();
      console.log(`  ${name} = ${val.toString()}`);
    } catch (e) {
      console.log(`  ${name} = REVERTED (${e.message?.slice(0, 40)})`);
    }
  }

  // ════════ 3. Pool state ═══════════
  console.log("\n═══════════ 3. POOL STATE ═══════════");
  const pc = new ethers.Contract(POOL, POOL_ABI, provider);
  const [res, ts, t0, op, sfb] = await Promise.all([
    pc.getReserves(), pc.totalSupply(), pc.token0(), pc.getOraclePrice(), pc.swapFeeBps()
  ]);
  const r0 = BigInt(res[0]), r1 = BigInt(res[1]);
  const op0 = BigInt(op[0]), op1 = BigInt(op[1]);
  const q112 = 1n << 112n;
  const r0Adj = r0 * op0 / q112;
  console.log(`  reserve0: ${r0} (USDT: ${r0Adj})`);
  console.log(`  reserve1: ${r1} (WETH)`);
  console.log(`  totalSupply: ${ts}`);
  console.log(`  token0: ${t0}`);
  console.log(`  oraclePrice0: ${op0}`);
  console.log(`  oraclePrice1: ${op1}`);
  console.log(`  swapFeeBps: ${sfb}`);

  // ════════ 4. Compute quote for the FAILING case ═══════════
  console.log("\n═══════════ 4. COMPUTE QUOTE — FAILING 5x CASE ═══════════");
  const failingCollateral = ethers.parseUnits("10", 6); // 10 USDT
  const failingLeverageX10 = 50n; // 5x

  const failingQuote = await computeQuote(provider, {
    collateralToken: USDT, collateralAmount: failingCollateral, leverageX10: failingLeverageX10,
  });

  console.log(`  protocolFeeBps:     ${failingQuote.protocolFeeBps}`);
  console.log(`  effectiveCollateral: ${failingQuote.effectiveCollateral}`);
  console.log(`  collateralLp:       ${failingQuote.collateralLp}`);
  console.log(`  lev:                ${failingQuote.lev}x`);
  console.log(`  borrowAmount:       ${failingQuote.lpBorrowAmount}`);
  console.log(`  amountOutMinRaw:    ${failingQuote.amountOutMinRaw}`);
  console.log(`  amountOutMinFinal:  ${failingQuote.amountOutMinFinal}`);
  console.log(`  ltvBps:             ${failingQuote.ltvBps}`);
  console.log(`  availableLiquidity: ${failingQuote.availableLiquidity}`);

  // Compute expected borrow relationship
  console.log(`\n  --- BORROW MATH VERIFICATION ---`);
  console.log(`  collateralLp * (lev-1) = ${failingQuote.collateralLp} * ${failingQuote.lev - 1} = ${failingQuote.collateralLp * BigInt(Math.floor((failingQuote.lev - 1) * 10000)) / 10000n}`);
  console.log(`  borrowAmount = ${failingQuote.lpBorrowAmount}`);
  console.log(`  ratio borrow/collateralLp = ${Number(failingQuote.lpBorrowAmount) / Number(failingQuote.collateralLp)}`);
  console.log(`  expected for ${failingQuote.lev}x = ${(failingQuote.lev - 1).toFixed(1)}`);

  // Check if borrowAmount exceeds any limit
  if (failingQuote.availableLiquidity > 0n) {
    const utilBps = failingQuote.lpBorrowAmount * 10000n / failingQuote.availableLiquidity;
    console.log(`  utilization after open: ${utilBps} bps (${Number(utilBps) / 100}%)`);
  }

  // ════════ 5. Pre-flight with FAILING params ═══════════
  console.log("\n═══════════ 5. PRE-FLIGHT — FAILING 5x ═══════════");
  const failResult = await tryOpenPreFlight(provider, wallet.address, {
    isLong: true,
    collateralToken: USDT,
    collateralAmount: failingCollateral,
    borrowAmount: failingQuote.lpBorrowAmount,
    leverageX10: failingLeverageX10,
    amountOutMin: failingQuote.amountOutMinFinal,
  });

  if (failResult.success) {
    console.log("  RESULT: PASS (unexpected!)");
  } else {
    console.log("  RESULT: FAIL");
    console.log(`  rawMsg:     ${failResult.rawMsg}`);
    console.log(`  revertData: ${failResult.revertData}`);

    if (failResult.revertData) {
      const selector = failResult.revertData.slice(0, 10);
      console.log(`  errorSelector: ${selector}`);

      // Try to match against known errors
      if (knownErrors[selector]) {
        console.log(`  KNOWN ERROR: ${knownErrors[selector]}`);
      }

      // Decode if ABI known
      if (selector === "0x08c379a0") {
        try {
          const decoded = ethers.AbiCoder.defaultAbiCoder().decode(["string"], "0x" + failResult.revertData.slice(10));
          console.log(`  decoded message: "${decoded[0]}"`);
        } catch {}
      }

      // Also try common custom error decodings
      const commonErrors = {
        "0x1a0d271a": "MAM_InsufficientLiquidity(uint256,uint256)",
        "0x2b67b4d6": "MAM_MaxUtilization()",
        "0x4a9f4c28": "MAM_InvalidLeverage()",
        "0x5e5d3c5e": "MAM_ZeroBorrow()",
        "0x56e7f09d": "MAM_OpenOracleDivergence()",
        "0x525d4c92": "MAM_MaxPositionSize()",
        "0x3ccfd60b": "MAM_PositionNotActive(uint256)",
        "0x4e487b71": "Panic(uint256)",
        "0x393913e5": "MAM_MinPositionSize()",
        "0x1fc3ea0a": "MAM_InsufficientBalance()",
        "0x83d1d94a": "MAM_MaxLeverage()",
        "0x89716b34": "MAM_MinLeverage()",
        "0x44f4ce7e": "MAM_InvalidCollateral()",
        "0xf04f4d43": "MAM_MaxBorrow()",
      };

      for (const [sel, sig] of Object.entries(commonErrors)) {
        if (failResult.revertData.startsWith(sel)) {
          console.log(`  MATCHED ERROR: ${sig}`);
          try {
            const types = sig.match(/\((.*)\)/)?.[1];
            if (types) {
              const decoded = ethers.AbiCoder.defaultAbiCoder().decode(types.split(","), "0x" + failResult.revertData.slice(10));
              console.log(`  decoded args: ${JSON.stringify(decoded.map(d => d.toString()))}`);
            }
          } catch (e2) {
            console.log(`  decode failed: ${e2.message?.slice(0, 40)}`);
          }
        }
      }
    }

    // Dump full error object
    console.log(`\n  FULL ERROR DUMP:`);
    console.log(`  ${JSON.stringify(failResult.fullError, (k, v) => typeof v === "bigint" ? v.toString() : v, 2)?.slice(0, 500)}`);
  }

  // ════════ 6. TEST ALL LEVERAGE LEVELS ═══════════
  console.log("\n═══════════ 6. PRE-FLIGHT ALL LEVERAGE LEVELS ═══════════");

  const levTests = [2, 3, 4, 5];
  for (const lev of levTests) {
    const levX10 = BigInt(lev * 10);
    const quote = await computeQuote(provider, {
      collateralToken: USDT, collateralAmount: failingCollateral, leverageX10: levX10,
    });

    console.log(`\n  --- ${lev}x LEVERAGE ---`);
    console.log(`  collateralLp:       ${quote.collateralLp}`);
    console.log(`  borrowAmount:       ${quote.lpBorrowAmount}`);
    console.log(`  amountOutMinRaw:    ${quote.amountOutMinRaw}`);
    console.log(`  amountOutMinFinal:  ${quote.amountOutMinFinal}`);
    console.log(`  borrow/collateralLp: ${Number(quote.lpBorrowAmount) / Number(quote.collateralLp)}`);

    const result = await tryOpenPreFlight(provider, wallet.address, {
      isLong: true,
      collateralToken: USDT,
      collateralAmount: failingCollateral,
      borrowAmount: quote.lpBorrowAmount,
      leverageX10: levX10,
      amountOutMin: quote.amountOutMinFinal,
    });

    if (result.success) {
      console.log(`  ${lev}x: PASS`);
    } else {
      const sel = result.revertData?.slice(0, 10) || "unknown";
      const errName = knownErrors[sel] || "unknown error";
      console.log(`  ${lev}x: FAIL — selector=${sel} (${errName})`);
      console.log(`  revertData: ${result.revertData}`);
    }
  }

  // ════════ 7. Compare with SUCCESSFUL OPEN #86 ═══════════
  console.log("\n═══════════ 7. COMPARE WITH SUCCESSFUL OPEN #86 ═══════════");
  console.log(`  Successful OPEN #86 calldata params:`);
  console.log(`    isLong:          true`);
  console.log(`    collateralToken: USDT`);
  console.log(`    collateralAmount: 5000000 (5 USDT)`);
  console.log(`    borrowAmount:    18455287214`);
  console.log(`    leverageX10:     20 (2x)`);
  console.log(`    amountOutMin:    2459399`);
  console.log(`\n  Failing OPEN (5x) params:`);
  console.log(`    isLong:          true`);
  console.log(`    collateralToken: USDT`);
  console.log(`    collateralAmount: 10000000 (10 USDT)`);
  console.log(`    borrowAmount:    ${failingQuote.lpBorrowAmount}`);
  console.log(`    leverageX10:     50 (5x)`);
  console.log(`    amountOutMin:    ${failingQuote.amountOutMinFinal}`);

  // Also test 2x with current reserves to confirm it works
  console.log("\n  --- 2x with 10 USDT (same collateral, 2x leverage) ---");
  const q2x = await computeQuote(provider, {
    collateralToken: USDT, collateralAmount: failingCollateral, leverageX10: 20n,
  });
  console.log(`  collateralLp:       ${q2x.collateralLp}`);
  console.log(`  borrowAmount:       ${q2x.lpBorrowAmount}`);
  console.log(`  amountOutMinFinal:  ${q2x.amountOutMinFinal}`);
  const r2x = await tryOpenPreFlight(provider, wallet.address, {
    isLong: true, collateralToken: USDT, collateralAmount: failingCollateral,
    borrowAmount: q2x.lpBorrowAmount, leverageX10: 20n, amountOutMin: q2x.amountOutMinFinal,
  });
  console.log(`  2x with 10 USDT: ${r2x.success ? "PASS" : "FAIL"}`);
  if (!r2x.success) {
    console.log(`  revertData: ${r2x.revertData}`);
  }

  // ════════ 8. Try decoding ALL unique 4-byte selectors from foundSelectors ═══════════
  console.log("\n═══════════ 8. KNOWN CUSTOM ERRORS IN BYTECODE ═══════════");
  const allKnownSelectors = {
    "0x56e7f09d": "MAM_OpenOracleDivergence",
    "0x7939f424": "MAM_BROKEN_PROXY",
    "0x24811982": "MAM_WRONG_COLLATERAL_TOKEN",
    "0x499ad952": "MAM_POSITION_NOT_ALLOWED (V2 Router)",
    "0x5e5d3c5e": "MAM_ZeroBorrow",
    "0x525d4c92": "MAM_MaxPositionSize",
    "0x393913e5": "MAM_MinPositionSize",
    "0x83d1d94a": "MAM_MaxLeverage",
    "0x89716b34": "MAM_MinLeverage",
    "0x44f4ce7e": "MAM_InvalidCollateral",
    "0xf04f4d43": "MAM_MaxBorrow",
    "0x1a0d271a": "MAM_InsufficientLiquidity",
    "0x2b67b4d6": "MAM_MaxUtilization",
    "0x1fc3ea0a": "MAM_InsufficientBalance",
    "0x08c379a0": "Error(string)",
    "0x4e487b71": "Panic(uint256)",
  };

  for (const [sel, name] of Object.entries(allKnownSelectors)) {
    const found = implCode.includes(sel.slice(2));
    if (found) console.log(`  ${sel} ${name}: IN BYTECODE`);
  }

  // ════════ 9. amountOutMin scaling analysis ═══════════
  console.log("\n═══════════ 9. AMOUNT OUT MIN SCALING ANALYSIS ═══════════");
  console.log(`  LP decimals: 18 (same as WETH, standard Uniswap LP)`);
  console.log(`  Token decimals: USDT=6, WETH=18`);
  console.log(`  `);
  console.log(`  amountOutMinRaw (from pool quote) = ${failingQuote.amountOutMinRaw}`);
  console.log(`  This represents the expected TOKEN output from the LP borrow swap`);
  console.log(`  `);
  console.log(`  For 5x: `);
  console.log(`    collateralLp = ${failingQuote.collateralLp}`);
  console.log(`    borrowAmount = ${failingQuote.lpBorrowAmount}`);
  console.log(`    borrowLp/tokenOut ratio = LP→token conversion`);
  console.log(`    `);
  console.log(`    reserves: USDT=${failingQuote.reserve0}, WETH=${failingQuote.reserve1}`);
  console.log(`    totalSupply=${failingQuote.totalSupply}`);
  console.log(`    `);
  const collateralIsToken0 = USDT.toLowerCase() === failingQuote.token0.toLowerCase();
  const amtIn = collateralIsToken0
    ? failingQuote.lpBorrowAmount * failingQuote.reserve1 / failingQuote.totalSupply
    : failingQuote.lpBorrowAmount * failingQuote.reserve0 / failingQuote.totalSupply;
  const colFromLp = collateralIsToken0
    ? failingQuote.lpBorrowAmount * failingQuote.reserve0 / failingQuote.totalSupply
    : failingQuote.lpBorrowAmount * failingQuote.reserve1 / failingQuote.totalSupply;
  console.log(`    collateralIsToken0=${collateralIsToken0}`);
  console.log(`    LP→amountIn (WETH) = ${amtIn}`);
  console.log(`    LP→collateralBack (USDT) = ${colFromLp}`);
  console.log(`    amountOutMinRaw = expected WETH from AMM swap = ${failingQuote.amountOutMinRaw}`);
  console.log(`    `);
  console.log(`    amountOutMinFinal = amountOutMinRaw * 9950/10000 = ${failingQuote.amountOutMinFinal}`);

  // ════════ 10. Decode the actual failing calldata ═══════════
  console.log("\n═══════════ 10. DECODE FAILING CALLDATA ═══════════");
  const deadline = Math.floor(Date.now() / 1000) + 1200;
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const params = coder.encode(
    ["bool", "address", "uint256", "uint256", "uint256", "uint256", "uint256"],
    [true, USDT, failingCollateral, failingQuote.lpBorrowAmount, failingLeverageX10, failingQuote.amountOutMinFinal, BigInt(deadline)]
  );
  const calldata = OPEN_SELECTOR + params.slice(2);

  console.log(`  Selector:      ${calldata.slice(0, 10)}`);
  console.log(`  isLong:        true`);
  console.log(`  collateral:    ${USDT}`);
  console.log(`  collateralAmt: ${failingCollateral} (${ethers.formatUnits(failingCollateral, 6)} USDT)`);
  console.log(`  borrowAmount:  ${failingQuote.lpBorrowAmount}`);
  console.log(`  leverageX10:   ${failingLeverageX10} (${Number(failingLeverageX10) / 10}x)`);
  console.log(`  amountOutMin:  ${failingQuote.amountOutMinFinal}`);
  console.log(`  deadline:      ${deadline}`);

  // ════════ 11. Try with amountOutMin = 0 to isolate borrowAmount issue ═══════════
  console.log("\n═══════════ 11. ISOLATION: amountOutMin=0, varying borrowAmount ═══════════");

  // Test A: borrowAmount as bot computes it, amountOutMin=0
  const rA = await tryOpenPreFlight(provider, wallet.address, {
    isLong: true, collateralToken: USDT, collateralAmount: failingCollateral,
    borrowAmount: failingQuote.lpBorrowAmount, leverageX10: failingLeverageX10, amountOutMin: 0n,
  });
  console.log(`  A: borrowAmount=${failingQuote.lpBorrowAmount}, amountOutMin=0 → ${rA.success ? "PASS" : "FAIL " + (rA.revertData || rA.rawMsg?.slice(0, 80))}`);

  // Test B: borrowAmount=0, amountOutMin=0
  const rB = await tryOpenPreFlight(provider, wallet.address, {
    isLong: true, collateralToken: USDT, collateralAmount: failingCollateral,
    borrowAmount: 0n, leverageX10: failingLeverageX10, amountOutMin: 0n,
  });
  console.log(`  B: borrowAmount=0, amountOutMin=0 → ${rB.success ? "PASS" : "FAIL " + (rB.revertData || rB.rawMsg?.slice(0, 80))}`);

  // Test C: collateralAmount=0, borrowAmount=0
  const rC = await tryOpenPreFlight(provider, wallet.address, {
    isLong: true, collateralToken: USDT, collateralAmount: 0n,
    borrowAmount: 0n, leverageX10: failingLeverageX10, amountOutMin: 0n,
  });
  console.log(`  C: collateralAmount=0, borrowAmount=0 → ${rC.success ? "PASS" : "FAIL " + (rC.revertData || rC.rawMsg?.slice(0, 80))}`);

  // Test D: Exact params from successful OPEN #86
  console.log("\n  --- EXACT successful OPEN #86 params ---");
  const rD = await tryOpenPreFlight(provider, wallet.address, {
    isLong: true, collateralToken: USDT, collateralAmount: 5000000n,
    borrowAmount: 18455287214n, leverageX10: 20n, amountOutMin: 2459399n,
  });
  console.log(`  D: #86 exact params → ${rD.success ? "PASS" : "FAIL " + (rD.revertData || rD.rawMsg?.slice(0, 80))}`);

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  DIAGNOSTIC COMPLETE");
  console.log("═══════════════════════════════════════════════════════════════");
}

main().catch(e => { console.error(`FATAL: ${e.message}`); console.error(e.stack); process.exit(1); });
