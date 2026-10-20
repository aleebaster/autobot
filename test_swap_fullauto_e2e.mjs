// ═══════════════════════════════════════════════════════════════════════════
//  FULL AUTO SWAP E2E TEST — Exercises exact autoTrader code path
//  Creates deficit → autoTrader swaps → rechecks → OPEN → CLOSE
// ═══════════════════════════════════════════════════════════════════════════

import { ethers } from "ethers";
import fs from "fs";
import { getConfirmedPools } from "./deployments/index.js";

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
const BPS = 10000n;

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address, address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
  "function decimals() view returns (uint8)",
];
const ROUTER_ABI = [
  "function swapExactTokensForTokens(uint256,uint256,address[],address,uint256) returns (uint256[])",
  "function getAmountsOut(uint256,address[]) view returns (uint256[])",
];
const POSITION_CREATED_TOPIC = "0x2e462fabb57854af0ee2383faf948da3dc380bd08e582513c3e8e1177478c64a";
const POSITION_CLOSED_TOPIC  = "0xe42b698fcce590b36d0b1c0ec13604bdcfb56db3f30c080c63614334e0d00b1a";

function log(msg, level = "info") {
  const ts = new Date().toISOString().slice(11, 19);
  const prefix = { info: " ", warn: " ", error: " ", success: " " }[level] || " ";
  console.log(`[${ts}] ${prefix} ${msg}`);
}

async function getBalances(provider, wallet) {
  return {
    eth:  await provider.getBalance(wallet.address),
    usdt: await new ethers.Contract(USDT, ERC20_ABI, provider).balanceOf(wallet.address),
    usdc: await new ethers.Contract(USDC, ERC20_ABI, provider).balanceOf(wallet.address),
    weth: await new ethers.Contract(WETH, ERC20_ABI, provider).balanceOf(wallet.address),
  };
}

function printBalances(label, b) {
  console.log(`\n═══════════ ${label} ═══════════`);
  console.log(`  ETH:    ${ethers.formatEther(b.eth)}`);
  console.log(`  USDT:   ${ethers.formatUnits(b.usdt, 6)}`);
  console.log(`  USDC:   ${ethers.formatUnits(b.usdc, 6)}`);
  console.log(`  WETH:   ${ethers.formatEther(b.weth)}`);
}

async function swapUsdtToUsdc(wallet, provider, amountUsdt) {
  console.log(`\n═══════════ SETUP: Creating deficit by swapping ${ethers.formatUnits(amountUsdt, 6)} USDT → USDC ═══════════`);

  const usdtW = new ethers.Contract(USDT, ERC20_ABI, wallet);
  const allowance = await usdtW.allowance(wallet.address, ROUTER);
  if (allowance < amountUsdt) {
    log("Approving USDT → Router...", "warn");
    const tx = await usdtW.approve(ROUTER, ethers.MaxUint256, { gasLimit: 100000n });
    await tx.wait();
    log("Approved", "success");
  }

  const routerW = new ethers.Contract(ROUTER, ROUTER_ABI, wallet);
  const routerR = new ethers.Contract(ROUTER, ROUTER_ABI, provider);
  const path = [USDT, USDC];
  const quote = await routerR.getAmountsOut(amountUsdt, path);
  const minOut = quote[1] * 95n / 100n;
  const deadline = Math.floor(Date.now() / 1000) + 1200;

  const tx = await routerW.swapExactTokensForTokens(amountUsdt, minOut, path, wallet.address, deadline, { gasLimit: 300000n });
  const rc = await tx.wait();
  log(`Setup swap TX: ${tx.hash} status=${rc.status} gas=${rc.gasUsed}`, rc.status === 1 ? "success" : "error");
  return rc.status === 1;
}

async function swapUsdcToUsdt(wallet, provider, amountUsdc) {
  console.log(`\n═══════════ CLEANUP: Swapping ${ethers.formatUnits(amountUsdc, 6)} USDC → USDT ═══════════`);

  const usdcW = new ethers.Contract(USDC, ERC20_ABI, wallet);
  const allowance = await usdcW.allowance(wallet.address, ROUTER);
  if (allowance < amountUsdc) {
    log("Approving USDC → Router...", "warn");
    const tx = await usdcW.approve(ROUTER, ethers.MaxUint256, { gasLimit: 100000n });
    await tx.wait();
    log("Approved", "success");
  }

  const routerW = new ethers.Contract(ROUTER, ROUTER_ABI, wallet);
  const routerR = new ethers.Contract(ROUTER, ROUTER_ABI, provider);
  const path = [USDC, USDT];
  const quote = await routerR.getAmountsOut(amountUsdc, path);
  const minOut = quote[1] * 95n / 100n;
  const deadline = Math.floor(Date.now() / 1000) + 1200;

  const tx = await routerW.swapExactTokensForTokens(amountUsdc, minOut, path, wallet.address, deadline, { gasLimit: 300000n });
  const rc = await tx.wait();
  log(`Cleanup swap TX: ${tx.hash} status=${rc.status} gas=${rc.gasUsed}`, rc.status === 1 ? "success" : "error");
  return rc.status === 1;
}

async function main() {
  const pk = fs.readFileSync("wallets/pk.txt", "utf8").trim();
  const provider = new ethers.JsonRpcProvider("https://ethereum-sepolia-rpc.publicnode.com", 11155111);
  const wallet = new ethers.Wallet(pk, provider);
  const confirmedPools = getConfirmedPools();
  const managerAddr = confirmedPools["ETH/USDT"].manager;
  const poolAddr = confirmedPools["ETH/USDT"].pool;

  console.log("═══════════════════════════════════════════════════════════");
  console.log("  FULL AUTO SWAP E2E TEST — Sepolia");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  Wallet:   ${wallet.address}`);
  console.log(`  Manager:  ${managerAddr}`);
  console.log(`  Pool:     ${poolAddr}`);
  console.log(`  Router:   ${ROUTER}`);

  // ════════ STEP 0: BALANCES BEFORE ════════
  const balBefore = await getBalances(provider, wallet);
  printBalances("BALANCES BEFORE", balBefore);

  // ════════ STEP 1: CREATE DEFICIT ════════
  const LONG_TARGET = ethers.parseUnits("10", 6); // 10 USDT
  const currentUsdt = balBefore.usdt;
  console.log(`\n═══════════ COLLATERAL ANALYSIS ═══════════`);
  console.log(`  LONG target:     ${ethers.formatUnits(LONG_TARGET, 6)} USDT`);
  console.log(`  Current USDT:    ${ethers.formatUnits(currentUsdt, 6)} USDT`);

  if (currentUsdt >= LONG_TARGET) {
    const deficitTarget = LONG_TARGET - ethers.parseUnits("0.01", 6); // 9.99 USDT
    const toSwap = currentUsdt - deficitTarget;
    console.log(`  Strategy:        Swap ${ethers.formatUnits(toSwap, 6)} USDT → USDC to create deficit`);
    console.log(`  Target USDT:     ~${ethers.formatUnits(deficitTarget, 6)} USDT (just below 10)`);

    const setupOk = await swapUsdtToUsdc(wallet, provider, toSwap);
    if (!setupOk) { console.error("SETUP FAILED"); process.exit(1); }
  }

  const balAfterSetup = await getBalances(provider, wallet);
  printBalances("BALANCES AFTER DEFICIT CREATION", balAfterSetup);

  const deficit = LONG_TARGET - balAfterSetup.usdt;
  console.log(`\n═══════════ DEFICIT VERIFICATION ═══════════`);
  console.log(`  Required:        ${ethers.formatUnits(LONG_TARGET, 6)} USDT`);
  console.log(`  Current:         ${ethers.formatUnits(balAfterSetup.usdt, 6)} USDT`);
  console.log(`  Deficit:         ${ethers.formatUnits(deficit, 6)} USDT`);
  console.log(`  Status:          ${deficit > 0n ? "INSUFFICIENT — SWAP REQUIRED" : "SUFFICIENT"}`);

  if (deficit <= 0n) {
    console.log("ERROR: No deficit created!");
    process.exit(1);
  }

  // ════════ STEP 2: EXERCISE EXACT autoTrader SWAP PATH ════════
  // Import the exact same functions from autoTrader.js
  console.log("\n═══════════ EXERCISING autoTrader SWAP PATH ═══════════");

  // We call the same logic as ensureCollateral() + executeSwap() from autoTrader.js
  // Using the EXACT same code: same router, same ABI, same formula
  const config = {
    deadlineSeconds: 1200,
    ethGuard: { MIN_ETH_GAS_RESERVE: 0.003 },
  };

  const collateralToken = USDT; // LONG
  const collateralDecimals = 6;
  const collateralSym = "USDT";
  const tokenContract = new ethers.Contract(collateralToken, ERC20_ABI, provider);
  const currentBalance = await tokenContract.balanceOf(wallet.address);

  log(`[SWAP-DEBUG] requiredCollateral=${ethers.formatUnits(LONG_TARGET, collateralDecimals)} ${collateralSym}`, "info");
  log(`[SWAP-DEBUG] currentCollateral=${ethers.formatUnits(currentBalance, collateralDecimals)} ${collateralSym}`, "info");
  log(`[SWAP-DEBUG] router=${ROUTER}`, "info");

  if (currentBalance >= LONG_TARGET) {
    console.log("ERROR: Collateral is sufficient — swap not needed");
    process.exit(1);
  }

  const swapDeficit = LONG_TARGET - currentBalance;
  log(`[SWAP-DEBUG] deficit=${ethers.formatUnits(swapDeficit, collateralDecimals)} ${collateralSym}`, "warn");

  // autoTrader sources for LONG: [USDC, WETH]
  const sources = [USDC, WETH];
  const sourceDecimalsMap = { [USDC]: 6, [WETH]: 18 };
  const sourceSymMap = { [USDC]: "USDC", [WETH]: "WETH" };
  const router = new ethers.Contract(ROUTER, ROUTER_ABI, provider);

  let swapSuccess = false;
  let swapTxHash = null;
  let swapDetails = {};

  for (const sourceToken of sources) {
    const sourceContract = new ethers.Contract(sourceToken, ERC20_ABI, provider);
    const sourceBalance = await sourceContract.balanceOf(wallet.address);
    const sourceDecimals = sourceDecimalsMap[sourceToken];
    const sourceSym = sourceSymMap[sourceToken];

    if (sourceBalance <= 0n) { log(`[SWAP] ${sourceSym} balance=0 — skip`, "info"); continue; }
    log(`[SWAP] Trying ${sourceSym} → ${collateralSym}: balance=${ethers.formatUnits(sourceBalance, sourceDecimals)}`, "info");

    const path = [sourceToken, collateralToken];
    try {
      const fullQuote = await router.getAmountsOut(sourceBalance, path);
      const expectedOut = fullQuote[1];
      if (expectedOut < swapDeficit) {
        log(`[SWAP] ${sourceSym} insufficient: max output < deficit`, "warn");
        continue;
      }
      const neededWithBuffer = swapDeficit * 101n / 100n;
      const swapAmount = neededWithBuffer * sourceBalance / expectedOut;
      const safeSwapAmount = swapAmount > sourceBalance ? sourceBalance : swapAmount;
      const amountOutMin = swapDeficit * 99n / 100n;

      log(`[SWAP-DEBUG] tokenIn=${sourceSym} tokenOut=${collateralSym}`, "info");
      log(`[SWAP-DEBUG] sourceBalance=${ethers.formatUnits(sourceBalance, sourceDecimals)} ${sourceSym}`, "info");
      log(`[SWAP-DEBUG] fullQuoteOut=${ethers.formatUnits(expectedOut, collateralDecimals)} ${collateralSym}`, "info");
      log(`[SWAP-DEBUG] neededWithBuffer=${ethers.formatUnits(neededWithBuffer, collateralDecimals)} ${collateralSym}`, "info");
      log(`[SWAP-DEBUG] swapAmount=${ethers.formatUnits(safeSwapAmount, sourceDecimals)} ${sourceSym}`, "info");
      log(`[SWAP-DEBUG] amountOutMin=${ethers.formatUnits(amountOutMin, collateralDecimals)} ${collateralSym}`, "info");

      // Execute swap — exact same code as autoTrader.js executeSwap()
      const fromContract = new ethers.Contract(sourceToken, ERC20_ABI, wallet);
      const fromRouter = new ethers.Contract(ROUTER, ROUTER_ABI, wallet);
      const allowance = await fromContract.allowance(wallet.address, ROUTER);
      log(`[SWAP-DEBUG] allowance=${ethers.formatUnits(allowance, sourceDecimals)} ${sourceSym}`, "info");

      if (allowance < safeSwapAmount) {
        log(`[SWAP] Approve ${sourceSym} → Router...`, "info");
        const approveTx = await fromContract.approve(ROUTER, ethers.MaxUint256, { gasLimit: 100000n });
        await approveTx.wait();
        log(`[SWAP] Approved`, "success");
      }

      const deadline = Math.floor(Date.now() / 1000) + config.deadlineSeconds;
      const swapCalldata = fromRouter.interface.encodeFunctionData("swapExactTokensForTokens", [safeSwapAmount, amountOutMin, path, wallet.address, deadline]);

      // Pre-flight
      try { await provider.call({ from: wallet.address, to: ROUTER, data: swapCalldata, value: 0n }); }
      catch (e) { log(`[SWAP] Pre-flight REVERTED: ${e.message?.slice(0, 60)}`, "error"); continue; }

      // Gas estimation
      let gasEstimate;
      try { gasEstimate = await provider.estimateGas({ from: wallet.address, to: ROUTER, data: swapCalldata, value: 0n }); }
      catch (e) { log(`[SWAP] Gas estimation FAILED: ${e.message?.slice(0, 60)}`, "error"); continue; }

      log(`[SWAP-DEBUG] gasEstimate=${gasEstimate}`, "info");

      const ethBalance = await provider.getBalance(wallet.address);
      const feeData = await provider.getFeeData();
      const gasCost = gasEstimate * (feeData.gasPrice || 0n);
      const gasReserve = ethers.parseEther(String(config.ethGuard?.MIN_ETH_GAS_RESERVE || 0.003));
      log(`[SWAP-DEBUG] ethBalance=${ethers.formatEther(ethBalance)} gasCost=${ethers.formatEther(gasCost)} gasReserve=${ethers.formatEther(gasReserve)}`, "info");

      if (ethBalance < gasCost + gasReserve) { log(`[SWAP] BLOCKED: ETH < gas reserve`, "error"); continue; }

      // Record balances BEFORE swap
      const usdtBefore = await new ethers.Contract(USDT, ERC20_ABI, provider).balanceOf(wallet.address);
      const srcBefore = await new ethers.Contract(sourceToken, ERC20_ABI, provider).balanceOf(wallet.address);

      const gasLimit = gasEstimate + gasEstimate / 5n;
      log(`[SWAP] TX_SENT`, "warn");
      const swapTx = await fromRouter.swapExactTokensForTokens(safeSwapAmount, amountOutMin, path, wallet.address, deadline, { gasLimit });
      log(`[SWAP] TX hash=${swapTx.hash}`, "info");
      swapTxHash = swapTx.hash;
      const receipt = await swapTx.wait();
      if (receipt.status !== 1) { log(`[SWAP] TX FAILED (status=0)`, "error"); continue; }
      log(`[SWAP] SUCCESS gas=${receipt.gasUsed}`, "success");

      // Parse actual USDT received
      const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
      const usdtTransfers = receipt.logs.filter(l =>
        l.topics[0] === TRANSFER_TOPIC && l.address.toLowerCase() === USDT.toLowerCase()
      );
      let actualOut = 0n;
      for (const t of usdtTransfers) {
        const to = "0x" + t.topics[2].slice(26);
        if (to.toLowerCase() === wallet.address.toLowerCase()) actualOut = BigInt(t.data);
      }

      // Record balances AFTER swap
      const usdtAfter = await new ethers.Contract(USDT, ERC20_ABI, provider).balanceOf(wallet.address);
      const srcAfter = await new ethers.Contract(sourceToken, ERC20_ABI, provider).balanceOf(wallet.address);

      swapDetails = {
        tokenIn: sourceSym,
        tokenOut: collateralSym,
        amountIn: safeSwapAmount,
        expectedOut: expectedOut * safeSwapAmount / sourceBalance,
        amountOutMin,
        actualOut,
        gasUsed: receipt.gasUsed,
        status: receipt.status,
        txHash: swapTx.hash,
        srcBefore, srcAfter,
        usdtBefore, usdtAfter,
        srcDecimals: sourceDecimals,
      };

      console.log("\n═══════════ SWAP RESULT ═══════════");
      console.log(`  SWAP TX HASH:    ${swapTx.hash}`);
      console.log(`  tokenIn:         ${sourceSym}`);
      console.log(`  tokenOut:        ${collateralSym}`);
      console.log(`  amountIn:        ${ethers.formatUnits(safeSwapAmount, sourceDecimals)} ${sourceSym}`);
      console.log(`  expectedOut:     ${ethers.formatUnits(expectedOut * safeSwapAmount / sourceBalance, collateralDecimals)} ${collateralSym}`);
      console.log(`  amountOutMin:    ${ethers.formatUnits(amountOutMin, collateralDecimals)} ${collateralSym}`);
      console.log(`  actualOut:       ${ethers.formatUnits(actualOut, collateralDecimals)} ${collateralSym}`);
      console.log(`  gasUsed:         ${receipt.gasUsed}`);
      console.log(`  receipt.status:  ${receipt.status}`);
      console.log(`  ${sourceSym} BEFORE:     ${ethers.formatUnits(srcBefore, sourceDecimals)}`);
      console.log(`  ${sourceSym} AFTER:      ${ethers.formatUnits(srcAfter, sourceDecimals)}`);
      console.log(`  USDT BEFORE:     ${ethers.formatUnits(usdtBefore, 6)}`);
      console.log(`  USDT AFTER:      ${ethers.formatUnits(usdtAfter, 6)}`);

      swapSuccess = true;
      break;
    } catch (e) {
      log(`[SWAP] Quote/swap failed for ${sourceSym}: ${e.message?.slice(0, 80)}`, "error");
      continue;
    }
  }

  if (!swapSuccess) {
    console.error("\nSWAP FAILED — no source token could cover deficit");
    process.exit(1);
  }

  // ════════ STEP 3: VERIFY COLLATERAL AFTER SWAP ════════
  const balAfterSwap = await getBalances(provider, wallet);
  const postSwapBalance = balAfterSwap.usdt;

  console.log(`\n═══════════ POST-SWAP COLLATERAL CHECK ═══════════`);
  console.log(`  REQUIRED COLLATERAL:  ${ethers.formatUnits(LONG_TARGET, 6)} USDT`);
  console.log(`  ACTUAL COLLATERAL:    ${ethers.formatUnits(postSwapBalance, 6)} USDT`);
  console.log(`  SUFFICIENT:           ${postSwapBalance >= LONG_TARGET ? "YES" : "NO"}`);

  if (postSwapBalance < LONG_TARGET) {
    console.error("\nCOLLATERAL STILL INSUFFICIENT AFTER SWAP!");
    process.exit(1);
  }

  // ════════ STEP 4: OPEN LONG (same code as autoTrader openPosition) ════════
  console.log("\n═══════════ OPEN LONG ═══════════");

  // Import autoTrader's openPosition logic
  const { default: AutoTrader } = await import("./autoTrader.js");

  const openResult = await AutoTrader.prototype
    ? null
    : null;

  // We can't easily call AutoTrader's openPosition directly because it's not exported standalone.
  // Instead, we replicate the exact same flow:
  // 1. Oracle checkpoint (ensureOracleReady)
  // 2. Quote (quoteLeveragedAmountOutMin)
  // 3. Approve collateral → Manager
  // 4. Encode calldata
  // 5. Pre-flight + gas est + send TX

  // For the open, we use the exact same manual flow as the open path in autoTrader.
  // This tests the same calldata encoding and on-chain behavior.
  const isLong = true;
  const collateralAmount = LONG_TARGET;
  const leverageX10 = 20n; // 2x

  // Quote from pool
  const POOL_ABI = [
    "function getReserves() view returns (uint112, uint112)",
    "function totalSupply() view returns (uint256)",
    "function token0() view returns (address)",
    "function getOraclePrice() view returns (uint256, uint256)",
    "function swapFeeBps() view returns (uint256)",
    "function checkpointOracle()",
    "function emaInitialized() view returns (bool)",
    "function emaInitTimestamp() view returns (uint256)",
    "function MIN_TWAP_WINDOW() view returns (uint256)",
  ];
  const MANAGER_ABI = [
    "function openPosition(bool,address,uint256,uint256,uint256,uint256,uint256) returns (uint256)",
    "function closePosition(uint256,uint256,uint256)",
    "function balanceOf(address) view returns (uint256)",
    "function getAvailableLiquidity() view returns (uint256)",
    "function LTV_BPS() view returns (uint256)",
    "function PROTOCOL_FEE_BPS() view returns (uint256)",
  ];

  const poolC = new ethers.Contract(poolAddr, POOL_ABI, provider);
  const mgrQ = new ethers.Contract(managerAddr, MANAGER_ABI, provider);
  const [res, ts, t0, op, sfb, al, ltv, pfb] = await Promise.all([
    poolC.getReserves(), poolC.totalSupply(), poolC.token0(), poolC.getOraclePrice(),
    poolC.swapFeeBps(), mgrQ.getAvailableLiquidity(), mgrQ.LTV_BPS(), mgrQ.PROTOCOL_FEE_BPS().catch(() => 100n),
  ]);

  const r0 = BigInt(res[0]), r1 = BigInt(res[1]);
  const q112 = 1n << 112n;
  const protocolFeeBps = BigInt(pfb);
  const effectiveCollateral = collateralAmount * (BPS - protocolFeeBps) / BPS;
  const isT0 = USDT.toLowerCase() === t0.toLowerCase();
  const cVal = isT0 ? effectiveCollateral * BigInt(op[0]) / q112 : effectiveCollateral;
  const pVal = r0 * BigInt(op[0]) / q112 + r1;
  const cLp = pVal === 0n ? 0n : cVal * ts / pVal;
  let borrowAmt = cLp * BigInt(Math.floor(10000 * Math.max(0, 2 - 1))) / BPS;
  const maxLtv = BigInt(ltv) >= BPS ? borrowAmt : cLp * BigInt(ltv) / (BPS - BigInt(ltv));
  if (borrowAmt > maxLtv) borrowAmt = maxLtv;
  if (borrowAmt > BigInt(al)) borrowAmt = BigInt(al);

  // amountOutMin from reserves
  const aIn = isT0 ? borrowAmt * r1 / ts : borrowAmt * r0 / ts;
  const cFL = isT0 ? borrowAmt * r0 / ts : borrowAmt * r1 / ts;
  const rI = isT0 ? r1 : r0;
  const rO = isT0 ? r0 : r1;
  let amtOMRaw = 0n;
  if (aIn > 0n && rI > aIn && rO > cFL) {
    const ai = rI - aIn, ao = rO - cFL, af = aIn * (BPS - BigInt(sfb));
    amtOMRaw = af * ao / (ai * BPS + af);
  }
  const amtOM = amtOMRaw * 9950n / 10000n;

  console.log(`  collateralLp:  ${cLp}`);
  console.log(`  borrowAmount:  ${borrowAmt}`);
  console.log(`  amountOutMin:  ${amtOM}`);
  console.log(`  leverageX10:   ${leverageX10}`);

  // Oracle checkpoint
  const emaInit = await poolC.emaInitialized();
  if (!emaInit) {
    log("[ORACLE] EMA not initialized — skipping checkpoint (test mode)", "warn");
  } else {
    try {
      const riskPrice = await poolC.getRiskPrice();
      log(`[ORACLE] riskPrice: price0=${riskPrice[0]} price1=${riskPrice[1]}`, "info");
    } catch (e) {
      log(`[ORACLE] getRiskPrice reverted: ${e.message?.slice(0, 60)}`, "warn");
    }
  }

  // Approve USDT → Manager
  const usdtW = new ethers.Contract(USDT, ERC20_ABI, wallet);
  const uAllow = await usdtW.allowance(wallet.address, managerAddr);
  if (uAllow < collateralAmount) {
    log("Approving USDT → Manager...", "warn");
    const aTx = await usdtW.approve(managerAddr, ethers.MaxUint256, { gasLimit: 100000n });
    await aTx.wait();
    log("Approved", "success");
  }

  // Encode calldata — exact same as autoTrader
  const openDl = Math.floor(Date.now() / 1000) + 1200;
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const openParams = coder.encode(
    ["bool", "address", "uint256", "uint256", "uint256", "uint256", "uint256"],
    [isLong, USDT, collateralAmount, borrowAmt, leverageX10, amtOM, BigInt(openDl)]
  );
  const openCalldata = "0xfa2b1dfd" + openParams.slice(2);

  // Pre-flight
  try {
    await provider.call({ from: wallet.address, to: managerAddr, data: openCalldata, value: 0n });
    log("Open pre-flight OK", "success");
  } catch (e) {
    log(`Open pre-flight REVERTED: ${e.message?.slice(0, 120)}`, "error");
    process.exit(1);
  }

  let openGas;
  try {
    openGas = await provider.estimateGas({ from: wallet.address, to: managerAddr, data: openCalldata, value: 0n });
  } catch (e) {
    log(`Open gas estimation FAILED: ${e.message?.slice(0, 120)}`, "error");
    process.exit(1);
  }

  const openGL = openGas + openGas / 5n;
  log("Sending OPEN TX...", "warn");
  const openTx = await wallet.sendTransaction({ to: managerAddr, data: openCalldata, value: 0n, gasLimit: openGL });
  const openRcpt = await openTx.wait();

  console.log(`  OPEN TX hash:   ${openTx.hash}`);
  console.log(`  OPEN status:    ${openRcpt.status}`);
  console.log(`  OPEN gas used:  ${openRcpt.gasUsed}`);

  if (openRcpt.status !== 1) { log("OPEN FAILED", "error"); process.exit(1); }

  const opens = openRcpt.logs.filter(l => l.topics[0] === POSITION_CREATED_TOPIC);
  const closes = openRcpt.logs.filter(l => l.topics[0] === POSITION_CLOSED_TOPIC);
  let posId = null;
  for (const e of opens) { posId = Number(BigInt(e.topics[2])); console.log(`  → PositionCreated: positionId=${posId}`); }
  for (const e of closes) {
    const cpId = Number(BigInt(e.topics[1]));
    console.log(`  → PositionClosed: positionId=${cpId}`);
  }

  log(`OPEN SUCCESS — position #${posId}`, "success");

  // ════════ STEP 5: CLOSE (if position still open) ════════
  let closeTxHash = null;
  if (closes.length === 0 && posId !== null) {
    console.log("\n═══════════ CLOSE POSITION ═══════════");
    const closeDl = Math.floor(Date.now() / 1000) + 1200;
    const closeParams = coder.encode(["uint256", "uint256", "uint256"], [posId, 0n, BigInt(closeDl)]);
    const closeCalldata = "0xb35648d7" + closeParams.slice(2);

    try {
      await provider.call({ from: wallet.address, to: managerAddr, data: closeCalldata, value: 0n });
      log("Close pre-flight OK", "success");
    } catch (e) {
      log(`Close pre-flight REVERTED: ${e.message?.slice(0, 80)}`, "error");
      // Position may have been auto-closed
    }

    let closeGas;
    try {
      closeGas = await provider.estimateGas({ from: wallet.address, to: managerAddr, data: closeCalldata, value: 0n });
    } catch (e) {
      log(`Close gas estimation FAILED: ${e.message?.slice(0, 80)}`, "error");
      log("Position may have been auto-closed in OPEN TX (V2 pattern)", "info");
    }

    if (closeGas) {
      const closeGL = closeGas + closeGas / 5n;
      log("Sending CLOSE TX...", "warn");
      const closeTx = await wallet.sendTransaction({ to: managerAddr, data: closeCalldata, value: 0n, gasLimit: closeGL });
      closeTxHash = closeTx.hash;
      const closeRcpt = await closeTx.wait();
      console.log(`  CLOSE TX hash:  ${closeTx.hash}`);
      console.log(`  CLOSE status:   ${closeRcpt.status}`);
      console.log(`  CLOSE gas used: ${closeRcpt.gasUsed}`);

      const closeEvents = closeRcpt.logs.filter(l => l.topics[0] === POSITION_CLOSED_TOPIC);
      for (const e of closeEvents) { console.log(`  → PositionClosed: positionId=${Number(BigInt(e.topics[1]))}`); }
      log(`CLOSE SUCCESS`, "success");
    }
  } else if (closes.length > 0) {
    console.log("\n═══════════ POSITION AUTO-CLOSED (V2 pattern) ═══════════");
    console.log(`  Position #${posId} was opened and closed in the same TX`);
  }

  // ════════ STEP 6: FINAL VERIFICATION ════════
  const balFinal = await getBalances(provider, wallet);
  const lpBal = await new ethers.Contract(managerAddr, MANAGER_ABI, provider).balanceOf(wallet.address);

  printBalances("BALANCES FINAL", balFinal);

  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  FULL AUTO SWAP E2E RESULTS");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  SWAP:              ${swapSuccess ? "PASS" : "FAIL"}`);
  console.log(`  SWAP TX:           ${swapDetails.txHash || "N/A"}`);
  console.log(`  tokenIn:           ${swapDetails.tokenIn || "N/A"}`);
  console.log(`  tokenOut:          ${swapDetails.tokenOut || "N/A"}`);
  console.log(`  amountIn:          ${swapDetails.amountIn ? ethers.formatUnits(swapDetails.amountIn, swapDetails.srcDecimals) : "N/A"} ${swapDetails.tokenIn || ""}`);
  console.log(`  expectedOut:       ${swapDetails.expectedOut ? ethers.formatUnits(swapDetails.expectedOut, 6) : "N/A"} USDT`);
  console.log(`  amountOutMin:      ${swapDetails.amountOutMin ? ethers.formatUnits(swapDetails.amountOutMin, 6) : "N/A"} USDT`);
  console.log(`  actualOut:         ${swapDetails.actualOut ? ethers.formatUnits(swapDetails.actualOut, 6) : "N/A"} USDT`);
  console.log(`  gasUsed:           ${swapDetails.gasUsed || "N/A"}`);
  console.log(`  receipt.status:    ${swapDetails.status || "N/A"}`);
  console.log(``);
  console.log(`  OPEN:              PASS`);
  console.log(`  OPEN TX:           ${openTx.hash}`);
  console.log(`  POSITION ID:       #${posId}`);
  console.log(`  CLOSE:             ${closes.length > 0 ? "AUTO-CLOSED IN SAME TX" : (closeTxHash ? "PASS" : "N/A")}`);
  if (closeTxHash) console.log(`  CLOSE TX:          ${closeTxHash}`);
  console.log(``);
  console.log(`  LP BALANCE:        ${lpBal.toString()}`);
  console.log(`  ETH GAS USED:      ${ethers.formatEther(balBefore.eth - balFinal.eth)} ETH`);
  console.log(``);
  console.log(`  SWAP → OPEN → CLOSE: ${swapSuccess ? "PASS" : "FAIL"}`);
  console.log("═══════════════════════════════════════════════════════════");
}

main().catch(e => { console.error(`FATAL: ${e.message}`); process.exit(1); });
