import { ethers } from "ethers";
import fs from "fs";

// ============================================================
// BOT CONFIG (matches index.js)
// ============================================================
const SEPOLIA_RPC_URL = "https://ethereum-sepolia-rpc.publicnode.com/557d07a988c4164482ef0c56a10f98ee0e3073440fd72fbe89cd7f6fef809388";
const LEVERAGED_FACTORY = "0x938B84B0F4E02B008dDf5FF3108C4DCd163e1318";
const LEVERAGED_ROUTER = "0xeDeC53F31C5f7BE26fcD1C5Edf405AE653BBd342";
let V2_MANAGER_ADDR = null; // will be set after discovery
const LEVERAGED_DAI = "0xf43ca549bb166cd3b165b5262226bba8cb4114dc";
const WETH = "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const BPS = 10000n;

// ============================================================
// ABIs (matches index.js exactly)
// ============================================================
const POSITION_ABI = [
  "function openPosition(bool isLong,address collateralToken,uint256 collateralAmount,uint256 borrowAmount,uint256 leverageX10,uint256 amountOutMin,uint256 deadline) returns (uint256 positionId)",
  "function closePosition(uint256 positionId,uint256 amountOutMin,uint256 deadline)",
  "function partialClose(uint256 positionId,uint256 closeBps,uint256 amountOutMin,uint256 deadline)",
  "function PROTOCOL_FEE_BPS() view returns (uint256)",
  "function LTV_BPS() view returns (uint256)",
  "function getAvailableLiquidity() view returns (uint256)",
  "function getPosition(uint256 positionId) view returns (bool isLong,address user,address collateralToken,uint256 collateralAmount,uint256 debtAmount,uint256 currentDebt,uint256 healthFactor)",
  "function getUserPositions(address user) view returns (uint256[])",
  "error MAM_InvalidLeverage()",
  "error MAM_InsufficientLiquidity()",
  "error MAM_InsufficientCollateral()",
  "error MAM_InvalidCollateralToken()",
  "error MAM_Expired()",
  "error MAM_ZeroAmount()",
  "error MAM_ZeroBorrow()",
  "error MAM_ZeroCollateral()",
  "error MAM_ExceedsLTV()",
  "event MAM_PositionCreated(uint256 indexed positionId,address indexed user,bool isLong,address collateralToken,uint256 collateralAmount,uint256 borrowAmount,uint256 debtAmount,uint256 leverageX10,uint256 deadline)",
  "event MAM_LoopPositionCreated(uint256 indexed positionId,address indexed user,uint256 leverageX10)",
  "event MAM_PositionClosed(uint256 indexed positionId,uint256 collateralReturned,int256 lossCollateral,uint256 borrowAmount)",
  "event MAM_PositionPartiallyClosed(uint256 indexed positionId,uint256 debtRepaid,uint256 collateralConsumed,uint256 collateralReturned,uint256 protocolFee)"
];

const FACTORY_ABI = [
  "function getPool(address tokenA,address tokenB) view returns (address)",
  "function getManager(address pool) view returns (address)"
];

const POOL_ABI = [
  "function getReserves() view returns (uint112 reserve0,uint112 reserve1)",
  "function totalSupply() view returns (uint256)",
  "function token0() view returns (address)",
  "function getOraclePrice() view returns (uint256,uint256)",
  "function swapFeeBps() view returns (uint256)"
];

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)"
];

const POSITION_IFACE = new ethers.Interface(POSITION_ABI);

// ============================================================
// HELPERS
// ============================================================
function sortTokenPair(a, b) {
  return [a, b].sort((x, y) => (x.toLowerCase() < y.toLowerCase() ? -1 : 1));
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  console.log("============================================");
  console.log("  LIVE EXECUTION TEST - NEW POSITION");
  console.log("============================================");

  // --- Load wallet ---
  const pk = fs.readFileSync("pk.txt", "utf8").trim();
  const provider = new ethers.JsonRpcProvider(SEPOLIA_RPC_URL);
  const wallet = new ethers.Wallet(pk, provider);
  const walletAddr = wallet.address;
  console.log("Wallet:", walletAddr);
  const bal = await provider.getBalance(walletAddr);
  console.log("ETH balance:", ethers.formatEther(bal));
  if (bal < ethers.parseEther("0.01")) {
    console.log("❌ Insufficient ETH for gas");
    process.exit(1);
  }

  // --- Discover V2 market (ETH/DAI) ---
  console.log("\n--- Discovering V2 market ETH/DAI ---");
  const factory = new ethers.Contract(LEVERAGED_FACTORY, FACTORY_ABI, provider);
  const [tokenA, tokenB] = sortTokenPair(LEVERAGED_DAI, WETH);
  console.log("Pool key:", tokenA, tokenB);
  const pool = await factory.getPool(tokenA, tokenB);
  console.log("Pool:", pool);
  if (pool === ZERO_ADDRESS) throw new Error("Pool not found on V2 factory");
  const manager = await factory.getManager(pool);
  console.log("Manager:", manager);

  // --- Check manager state ---
  const mgr = new ethers.Contract(manager, POSITION_ABI, provider);
  const [feeBps, ltvBps, availLiq] = await Promise.all([
    mgr.PROTOCOL_FEE_BPS(),
    mgr.LTV_BPS(),
    mgr.getAvailableLiquidity()
  ]);
  console.log("Protocol fee BPS:", feeBps.toString());
  console.log("LTV BPS:", ltvBps.toString());
  console.log("Available liquidity:", availLiq.toString());
  if (availLiq <= 0n) throw new Error("No available liquidity");

  // --- Check DAI balance and approve V2 router ---
  console.log("\n--- Token Setup ---");
  const dai = new ethers.Contract(LEVERAGED_DAI, ERC20_ABI, wallet);
  const daiBalance = await dai.balanceOf(walletAddr);
  const daiDecimals = await dai.decimals();
  console.log("DAI balance:", ethers.formatUnits(daiBalance, daiDecimals), "DAI");
  const daiSymbol = await dai.symbol();
  console.log("DAI symbol:", daiSymbol);

  const TRADE_AMOUNT = "0.033321"; // small test amount (6 decimals for V2 DAI)
  const collateralWei = ethers.parseUnits(TRADE_AMOUNT, daiDecimals);
  console.log("Collateral wei:", collateralWei.toString());
  if (daiBalance < collateralWei) throw new Error("Insufficient DAI balance");

  V2_MANAGER_ADDR = manager;
  // Approve the MANAGER (bot approves tx.to which is the manager)
  const existingAllowance = await dai.allowance(walletAddr, V2_MANAGER_ADDR);
  console.log("Manager allowance:", ethers.formatUnits(existingAllowance, daiDecimals));
  if (existingAllowance < collateralWei) {
    console.log("Approving V2 manager...");
    const txApprove = await dai.approve(V2_MANAGER_ADDR, ethers.MaxUint256);
    await txApprove.wait();
    console.log("Approved. Tx:", txApprove.hash);
  }

  // --- Build open tx params ---
  console.log("\n--- Building OPEN transaction ---");
  const isLong = true;
  const leverage = 20n; // 2.0x
  const borrowAmt = 0n; // 0 = auto
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200);

  // Use min amountOutMin (the bot's quoteLeveragedAmountOutMin is complex;
  // for testing we let the contract determine the output)
  const amountOutMin = 10000n;
  console.log("amountOutMin:", amountOutMin.toString());

  // --- OPEN POSITION ---
  console.log("\n=============================================");
  console.log("  OPENING LONG POSITION");
  console.log("=============================================");
  const openData = POSITION_IFACE.encodeFunctionData("openPosition", [
    isLong, LEVERAGED_DAI, collateralWei, borrowAmt, leverage, amountOutMin, deadline
  ]);
  console.log("Calldata:", openData.slice(0, 66) + "...");

  const gasLimit = await provider.estimateGas({ from: wallet.address, to: manager, data: openData, value: 0n });
  const openTx = await wallet.sendTransaction({
    to: manager, data: openData, value: 0n,
    gasLimit
  });
  console.log("OPEN TX HASH:", openTx.hash);
  console.log("Waiting for confirmation...");

  const openReceipt = await openTx.wait();
  console.log("\n--- OPEN RESULT ---");
  console.log("Status:", openReceipt.status === 1 ? "SUCCESS ✅" : "FAILED ❌");
  console.log("Block:", openReceipt.blockNumber);
  console.log("Gas used:", openReceipt.gasUsed.toString());

  // Parse events
  let positionId = null;
  let createdEvent = null;
  let loopEvent = null;
  let closedEvent = null;
  let parseErrorCount = 0;

  for (const log of openReceipt.logs) {
    try {
      const parsed = POSITION_IFACE.parseLog(log);
      if (parsed?.name === "MAM_PositionCreated") {
        createdEvent = parsed;
        positionId = parsed.args.positionId.toString();
      }
      if (parsed?.name === "MAM_LoopPositionCreated") {
        loopEvent = parsed;
      }
      if (parsed?.name === "MAM_PositionClosed") {
        closedEvent = parsed;
      }
    } catch {
      parseErrorCount++;
    }
  }

  console.log("Parsed MAM_PositionCreated:", createdEvent ? "YES ✅" : "NO ❌");
  if (createdEvent) {
    console.log("  positionId:", positionId);
    console.log("  isLong:", createdEvent.args.isLong);
    console.log("  user:", createdEvent.args.user);
    console.log("  collateralToken:", createdEvent.args.collateralToken);
    console.log("  collateralAmount:", createdEvent.args.collateralAmount.toString());
    console.log("  borrowAmount:", createdEvent.args.borrowAmount.toString());
    console.log("  debtAmount:", createdEvent.args.debtAmount.toString());
    console.log("  leverageX10:", createdEvent.args.leverageX10.toString());
    console.log("  deadline:", createdEvent.args.deadline.toString());
  }
  console.log("Parsed MAM_LoopPositionCreated:", loopEvent ? "YES ✅" : "NO");
  console.log("Parsed MAM_PositionClosed (should not appear):", closedEvent ? "UNEXPECTED ⚠️" : "none ✅");
  console.log("Non-matching logs skipped:", parseErrorCount);

  if (!positionId) {
    console.log("\n❌ CRITICAL: No PositionCreated event found — bot would throw");
    console.log("  'receipt confirmed but no PositionCreated event was found'");
    process.exit(1);
  }

  // Verify position on-chain
  const savedMgr = new ethers.Contract(manager, POSITION_ABI, provider);
  const onChainPos = await savedMgr.getPosition(positionId);
  console.log("\nOn-chain position check:");
  console.log("  positionId:", positionId);
  console.log("  user:", onChainPos[1]);
  const userMatch = String(onChainPos[1]).toLowerCase() === walletAddr.toLowerCase();
  console.log("  user matches wallet:", userMatch ? "YES ✅" : "NO ❌");
  console.log("  collateralAmount:", onChainPos[3].toString());

  // --- Update config.json activePositions ---
  const configPath = "config.json";
  let config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (!config.activePositions) config.activePositions = [];
  config.activePositions.push({
    side: "LONG",
    positionId,
    managerAddress: manager,
    symbol: "ETH/DAI",
    marketToken: WETH,
    collateralToken: LEVERAGED_DAI,
    closeTarget: manager,
    openTarget: manager,
    txHash: openTx.hash,
    openedAt: Math.floor(Date.now() / 1000)
  });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  console.log("\n--- Config saved ✅ ---");
  console.log("  activePositions count:", config.activePositions.length);

  // ============================================================
  // CLOSE POSITION
  // ============================================================
  console.log("\n=============================================");
  console.log("  CLOSING POSITION " + positionId);
  console.log("=============================================");

  // Wait a moment for the position to settle
  await sleep(5000);

  const closeDeadline = BigInt(Math.floor(Date.now() / 1000) + 1200);
  const closeData = POSITION_IFACE.encodeFunctionData("closePosition", [
    BigInt(positionId), 1n, closeDeadline
  ]);

  console.log("Close target manager:", manager);
  // Retry loop: close can fail transiently
  let closeReceipt = null;
  let closeTx = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const closeGas = await provider.estimateGas({ from: wallet.address, to: manager, data: closeData, value: 0n });
      closeTx = await wallet.sendTransaction({
        to: manager, data: closeData, value: 0n,
        gasLimit: closeGas
      });
      console.log("CLOSE TX HASH:", closeTx.hash);
      console.log("Waiting for confirmation...");
      closeReceipt = await closeTx.wait();
      if (closeReceipt.status === 1) break;
      console.log(`Close attempt ${attempt} failed (status=0), retrying...`);
      await sleep(5000);
    } catch(e) {
      console.log(`Close attempt ${attempt} error: ${e.message.slice(0,100)}`);
      if (attempt < 3) await sleep(5000);
    }
  }
  if (!closeReceipt || closeReceipt.status !== 1) throw new Error("Close failed after 3 attempts");

  console.log("\n--- CLOSE RESULT ---");
  console.log("Status:", closeReceipt.status === 1 ? "SUCCESS ✅" : "FAILED ❌");
  console.log("Block:", closeReceipt.blockNumber);
  console.log("Gas used:", closeReceipt.gasUsed.toString());

  // Parse close events
  let closeFound = false;
  let closeParsedEvent = null;
  let closeErrorCount = 0;

  for (const log of closeReceipt.logs) {
    try {
      const parsed = POSITION_IFACE.parseLog(log);
      if (parsed?.name === "MAM_PositionClosed") {
        closeFound = true;
        closeParsedEvent = parsed;
        console.log("\nParsed MAM_PositionClosed ✅");
        console.log("  positionId:", parsed.args.positionId.toString());
        console.log("  collateralReturned:", parsed.args.collateralReturned.toString());
        if (parsed.args.lossCollateral !== undefined) {
          const loss = BigInt(parsed.args.lossCollateral);
          console.log("  lossCollateral:", loss.toString(), loss < 0n ? "(gain)" : "(loss)");
        }
        if (parsed.args.borrowAmount !== undefined) {
          console.log("  borrowAmount:", parsed.args.borrowAmount.toString());
        }
      }
      if (parsed?.name === "MAM_PositionPartiallyClosed") {
        closeFound = true;
        console.log("\nParsed MAM_PositionPartiallyClosed ✅");
        console.log("  positionId:", parsed.args.positionId.toString());
        console.log("  debtRepaid:", parsed.args.debtRepaid.toString());
        console.log("  collateralReturned:", parsed.args.collateralReturned.toString());
      }
    } catch {
      closeErrorCount++;
    }
  }

  // Fail if close event wasn't decoded
  if (!closeFound) {
    console.log("\n❌ TEST FAILED: MAM_PositionClosed not found in receipt");
    console.log("  parseLog() returned null — ABI mismatch");
    process.exit(1);
  }

  console.log("Close event found: YES ✅");
  console.log("Non-matching logs skipped:", closeErrorCount);

  // Verify position is gone on-chain
  await sleep(3000);
  const postClosePos = await savedMgr.getPosition(positionId);
  const stillActive = BigInt(postClosePos[3] || 0n) > 0n || BigInt(postClosePos[4] || 0n) > 0n;
  console.log("\nPost-close on-chain check:");
  console.log("  collateral remaining:", postClosePos[3].toString());
  console.log("  debt remaining:", postClosePos[4].toString());
  console.log("  Position closed:", stillActive ? "NO ❌ (still active)" : "YES ✅");

  // --- Update config.json: remove closed position ---
  config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const beforeCount = config.activePositions.length;
  config.activePositions = config.activePositions.filter(p => p.positionId !== positionId);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  console.log("  activePositions before:", beforeCount, "-> after:", config.activePositions.length);

  // ============================================================
  // FINAL OUTPUT (user-requested format)
  // ============================================================
  console.log("\n" + "=".repeat(50));
  console.log("  TEST RESULTS");
  console.log("=".repeat(50));
  console.log("");
  console.log("1. Open transaction hash:");
  console.log("  " + openTx.hash);
  console.log("");
  console.log("2. Open PositionCreated decoded event:");
  if (createdEvent) {
    console.log("  positionId:      " + positionId);
    console.log("  isLong:          " + createdEvent.args.isLong);
    console.log("  user:            " + createdEvent.args.user);
    console.log("  collateralToken: " + createdEvent.args.collateralToken);
    console.log("  collateralAmt:   " + createdEvent.args.collateralAmount.toString());
    console.log("  borrowAmount:    " + createdEvent.args.borrowAmount.toString());
    console.log("  debtAmount:      " + createdEvent.args.debtAmount.toString());
    console.log("  leverageX10:     " + createdEvent.args.leverageX10.toString());
    console.log("  deadline:        " + createdEvent.args.deadline.toString());
  }
  console.log("");
  console.log("3. Close transaction hash:");
  console.log("  " + closeTx.hash);
  console.log("");
  console.log("4. Close PositionClosed decoded event:");
  if (closeParsedEvent) {
    console.log("  positionId:         " + closeParsedEvent.args.positionId.toString());
    console.log("  collateralReturned: " + closeParsedEvent.args.collateralReturned.toString());
    const loss = BigInt(closeParsedEvent.args.lossCollateral);
    console.log("  lossCollateral:     " + loss.toString() + (loss < 0n ? " (gain)" : " (loss)"));
    console.log("  borrowAmount:       " + closeParsedEvent.args.borrowAmount.toString());
  }
  console.log("");
  console.log("5. Final activePositions (" + config.activePositions.length + "):");
  if (config.activePositions.length === 0) {
    console.log("  (empty — position removed correctly)");
  } else {
    for (const p of config.activePositions) {
      console.log("  - side=" + p.side + " id=" + p.positionId + " symbol=" + p.symbol);
    }
  }
  console.log("");
  console.log("6. Final conclusion:");
  const allOk = openReceipt.status === 1 && closeReceipt.status === 1 && positionId && closeFound;
  if (allOk) {
    console.log("  ✅ PASS");
    console.log("  Manager: " + manager);
    console.log("  Pool: " + pool);
    console.log("  Collateral token: " + LEVERAGED_DAI);
    console.log("  Leverage: " + Number(leverage) / 10 + "x");
    console.log("  Open block: " + openReceipt.blockNumber);
    console.log("  Close block: " + closeReceipt.blockNumber);
  } else {
    console.log("  ❌ FAIL");
    process.exit(1);
  }
}

main().catch(err => {
  console.error("\n❌ TEST FAILED:", err.message);
  process.exit(1);
});
