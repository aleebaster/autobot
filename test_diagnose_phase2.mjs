// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 2: Check active positions + decode unknown errors
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
const POSITION_CREATED_TOPIC  = "0x2e462fabb57854af0ee2383faf948da3dc380bd08e582513c3e8e1177478c64a";
const POSITION_CLOSED_TOPIC   = "0xe42b698fcce590b36d0b1c0ec13604bdcfb56db3f30c080c63614334e0d00b1a";

const MANAGER_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function getAvailableLiquidity() view returns (uint256)",
  "function LTV_BPS() view returns (uint256)",
  "function PROTOCOL_FEE_BPS() view returns (uint256)",
  "function positions(uint256) view returns (bool isLong, address collateralToken, uint256 collateralAmount, uint256 borrowAmount, uint256 leverageX10, uint256 openedAt, uint256 healthFactor)",
  "function getActivePositionIds(address user) view returns (uint256[])",
  "function userPositionCount(address) view returns (uint256)",
];

const POOL_ABI = [
  "function getReserves() view returns (uint112, uint112)",
  "function totalSupply() view returns (uint256)",
  "function token0() view returns (address)",
  "function getOraclePrice() view returns (uint256, uint256)",
  "function swapFeeBps() view returns (uint256)",
  "function getRiskPrice() view returns (uint256, uint256)",
  "function emaInitialized() view returns (bool)",
  "function balanceOf(address) view returns (uint256)",
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
];

function log(msg) { console.log(msg); }

async function main() {
  const pk = fs.readFileSync("wallets/pk.txt", "utf8").trim();
  const provider = new ethers.JsonRpcProvider("https://ethereum-sepolia-rpc.publicnode.com", 11155111);
  const wallet = new ethers.Wallet(pk, provider);
  const walletAddr = wallet.address;

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  PHASE 2: POSITION STATE + ERROR DECODE");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  Wallet:  ${walletAddr}`);
  console.log(`  Manager: ${MANAGER}`);

  // ════════ 1. Check Manager LP balance (active position indicator) ════════
  console.log("\n═══════════ 1. MANAGER BALANCE (LP POSITION) ═══════════");
  const mgr = new ethers.Contract(MANAGER, MANAGER_ABI, provider);
  const lpBalance = await mgr.balanceOf(walletAddr);
  console.log(`  Manager.balanceOf(wallet) = ${lpBalance.toString()}`);
  console.log(`  Has active position:      ${lpBalance > 0n ? "YES" : "NO"}`);

  // ════════ 2. Try various position query methods ════════
  console.log("\n═══════════ 2. POSITION QUERY METHODS ═══════════");

  try {
    const count = await mgr.userPositionCount(walletAddr);
    console.log(`  userPositionCount = ${count.toString()}`);
  } catch (e) {
    console.log(`  userPositionCount: REVERTED (${e.message?.slice(0, 60)})`);
  }

  try {
    const ids = await mgr.getActivePositionIds(walletAddr);
    console.log(`  getActivePositionIds = [${ids.map(id => id.toString()).join(", ")}]`);
  } catch (e) {
    console.log(`  getActivePositionIds: REVERTED (${e.message?.slice(0, 60)})`);
  }

  // ════════ 3. Scan recent events for this wallet ════════
  console.log("\n═══════════ 3. RECENT EVENTS FOR THIS WALLET ═══════════");
  const latestBlock = await provider.getBlockNumber();
  const fromBlock = Math.max(latestBlock - 5000, 0);

  const logs = await provider.getLogs({
    address: MANAGER,
    topics: [null, "0x000000000000000000000000" + walletAddr.slice(2).toLowerCase()],
    fromBlock,
    toBlock: latestBlock,
  });

  const createdLogs = logs.filter(l => l.topics[0] === POSITION_CREATED_TOPIC);
  const closedLogs = logs.filter(l => l.topics[0] === POSITION_CLOSED_TOPIC);

  console.log(`  Scanned blocks ${fromBlock} to ${latestBlock}`);
  console.log(`  PositionCreated events: ${createdLogs.length}`);
  console.log(`  PositionClosed events:  ${closedLogs.length}`);

  const openIds = new Set();
  const closedIds = new Set();

  for (const e of createdLogs) {
    const posId = Number(BigInt(e.topics[2]));
    const blockNum = e.blockNumber;
    const txHash = e.transactionHash;
    console.log(`    PositionCreated #${posId} block=${blockNum} tx=${txHash}`);
    openIds.add(posId);
  }

  for (const e of closedLogs) {
    const posId = Number(BigInt(e.topics[1]));
    const blockNum = e.blockNumber;
    const txHash = e.transactionHash;
    console.log(`    PositionClosed #${posId} block=${blockNum} tx=${txHash}`);
    closedIds.add(posId);
  }

  const stillOpen = [...openIds].filter(id => !closedIds.has(id));
  console.log(`\n  Still open (created but not closed): [${stillOpen.join(", ")}]`);
  console.log(`  Total active positions: ${stillOpen.length}`);

  // ════════ 4. Check Manager code + potential max positions limit ════════
  console.log("\n═══════════ 4. MANAGER CONTRACT DETAILS ═══════════");
  const code = await provider.getCode(MANAGER);
  console.log(`  Manager code size: ${(code.length - 2) / 2} bytes`);

  const impl = "0xeE68790cDb86BDCB7B9681E6fa7DC53744Ba4f4C";
  const implCode = await provider.getCode(impl);
  console.log(`  Implementation code size: ${(implCode.length - 2) / 2} bytes`);

  // Search for "max" or limit-related patterns in bytecode
  // Check for MAX_POSITIONS_PER_USER, MAX_OPEN_POSITIONS etc
  const mgrExtra = [
    "MAX_POSITIONS_PER_USER", "MAX_OPEN_POSITIONS", "MAX_POSITIONS",
    "maxPositions", "maxPositionsPerUser",
  ];
  for (const fn of mgrExtra) {
    try {
      const val = await mgr[fn]();
      console.log(`  ${fn}() = ${val.toString()}`);
    } catch {}
  }

  // ════════ 5. Decode 0x763d8933 error (from collateralAmount=0 test) ════════
  console.log("\n═══════════ 5. DECODE UNKNOWN ERRORS ═══════════");

  // Search for 0x763d8933 in implementation bytecode
  const found763d = implCode.includes("763d8933");
  console.log(`  0x763d8933 in implementation bytecode: ${found763d}`);

  // Common error selectors to check
  const errorSelectors = {
    "0x763d8933": "MAM_Unknown_763d8933",
    "0x56e7f09d": "MAM_OpenOracleDivergence",
    "0x7939f424": "MAM_BROKEN_PROXY",
    "0x24811982": "MAM_WRONG_COLLATERAL_TOKEN",
    "0x499ad952": "MAM_POSITION_NOT_ALLOWED",
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
    "0x3ccfd60b": "MAM_PositionNotActive",
    "0x4349d6e4": "MAM_PositionLimitReached",
    "0x0a5dbdatabase": "InvalidState",
  };

  console.log("  Checking all error selectors against implementation bytecode:");
  for (const [sel, name] of Object.entries(errorSelectors)) {
    const found = implCode.includes(sel.slice(2));
    if (found) console.log(`    ${sel} ${name}: FOUND`);
  }

  // ════════ 6. Simulate with the exact values the bot logged ════════
  console.log("\n═══════════ 6. SIMULATE WITH BOT'S LOGGED VALUES ═══════════");
  console.log(`  Bot logged: collateralLp=175838161270 borrowAmount=703352645080 amountOutMin=39948004503723916`);
  console.log(`  leverageX10=50 (5x) collateralAmount=10000000 (10 USDT)`);

  // Try pre-flight with the EXACT values the bot computed
  const deadline = Math.floor(Date.now() / 1000) + 1200;
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const params = coder.encode(
    ["bool", "address", "uint256", "uint256", "uint256", "uint256", "uint256"],
    [true, USDT, 10000000n, 703352645080n, 50n, 39948004503723916n, BigInt(deadline)]
  );
  const calldata = "0xfa2b1dfd" + params.slice(2);

  console.log(`\n  Attempting pre-flight with bot's EXACT logged params...`);
  try {
    const result = await provider.call({ from: walletAddr, to: MANAGER, data: calldata, value: 0n });
    console.log(`  RESULT: PASS (returned: ${result})`);
    console.log(`  THIS MEANS the revert was STATE-DEPENDENT, not param-dependent`);
  } catch (e) {
    const rawMsg = e?.shortMessage || e?.message || String(e);
    let revertData = null;
    if (e?.data) revertData = e.data;
    else if (e?.info?.error?.data) revertData = e.info.error.data;
    else {
      const match = rawMsg.match(/0x[0-9a-fA-F]{8,}/);
      if (match) revertData = match[0];
    }
    if (!revertData && e?.cause?.data) revertData = e.cause.data;
    if (!revertData && e?.cause?.info?.error?.data) revertData = e.cause.info.error.data;

    console.log(`  RESULT: FAIL`);
    console.log(`  rawMsg:     ${rawMsg.slice(0, 150)}`);
    console.log(`  revertData: ${revertData}`);
    if (revertData) {
      console.log(`  selector:   ${revertData.slice(0, 10)}`);
      for (const [sel, name] of Object.entries(errorSelectors)) {
        if (revertData.startsWith(sel)) console.log(`  MATCHED: ${name}`);
      }
    }
    console.log(`  Full error: ${JSON.stringify(e, (k,v) => typeof v === "bigint" ? v.toString() : v, 2)?.slice(0, 300)}`);
  }

  // ════════ 7. Check if active position blocks new opens ════════
  console.log("\n═══════════ 7. ACTIVE POSITION BLOCK TEST ═══════════");
  if (stillOpen.length > 0) {
    console.log(`  Wallet has ${stillOpen.length} active position(s): [${stillOpen.join(", ")}]`);
    console.log(`  Testing if opening another position is blocked...`);

    // Try with current pool state, small collateral
    const testParams = coder.encode(
      ["bool", "address", "uint256", "uint256", "uint256", "uint256", "uint256"],
      [true, USDT, 1000000n, 0n, 20n, 0n, BigInt(deadline)]
    );
    const testCalldata = "0xfa2b1dfd" + testParams.slice(2);

    try {
      await provider.call({ from: walletAddr, to: MANAGER, data: testCalldata, value: 0n });
      console.log(`  PASS — active position does NOT block new opens`);
    } catch (e) {
      const rawMsg = e?.shortMessage || e?.message || String(e);
      let revertData = e?.data || e?.info?.error?.data || e?.cause?.data || e?.cause?.info?.error?.data || null;
      if (!revertData) {
        const match = rawMsg.match(/0x[0-9a-fA-F]{8,}/);
        if (match) revertData = match[0];
      }
      console.log(`  FAIL — active position BLOCKS new opens`);
      console.log(`  revertData: ${revertData || rawMsg.slice(0, 100)}`);
    }
  } else {
    console.log(`  No active positions — cannot test position-blocking theory`);
  }

  // ════════ 8. Pool state change analysis ════════
  console.log("\n═══════════ 8. POOL STATE CHANGE ANALYSIS ═══════════");
  const pc = new ethers.Contract(POOL, POOL_ABI, provider);
  const [res, ts, t0, op, sfb] = await Promise.all([
    pc.getReserves(), pc.totalSupply(), pc.token0(), pc.getOraclePrice(), pc.swapFeeBps()
  ]);
  const r0 = BigInt(res[0]), r1 = BigInt(res[1]);
  const q112 = 1n << 112n;

  console.log(`  Current reserve0 (USDT raw): ${r0}`);
  console.log(`  Current reserve1 (WETH):     ${r1}`);
  console.log(`  Current totalSupply:         ${ts}`);
  console.log(`  oraclePrice0:                ${BigInt(op[0])}`);

  // The bot's collateralLp for 10 USDT was 175838161270
  // With current state, we compute 27089369784
  // This means pool state was VERY different when bot ran
  const botCollateralLp = 175838161270n;
  const currentCollateralLp = 27089369784n;
  console.log(`\n  Bot's collateralLp for 10 USDT: ${botCollateralLp}`);
  console.log(`  Current collateralLp for 10 USDT: ${currentCollateralLp}`);
  console.log(`  Ratio: ${Number(botCollateralLp) / Number(currentCollateralLp)}x`);
  console.log(`  This suggests significant pool state change between bot run and now`);

  // What would the bot's borrowAmount mean with current reserves?
  const botBorrow = 703352645080n;
  const availableLiq = await mgr.getAvailableLiquidity();
  console.log(`\n  Bot's borrowAmount: ${botBorrow}`);
  console.log(`  Current available liquidity: ${availableLiq}`);
  console.log(`  Utilization if bot params used now: ${botBorrow * 10000n / availableLiq} bps`);

  // ════════ 9. Direct Manager view of wallet state ════════
  console.log("\n═══════════ 9. WALLET STATE ON MANAGER ═══════════");

  // Check if the Manager proxy has a different state
  const mgrProxyCode = await provider.getCode(MANAGER);
  console.log(`  Proxy code size: ${(mgrProxyCode.length - 2) / 2} bytes`);
  console.log(`  Proxy delegatecall to: ${impl}`);

  // Check pool LP balance for wallet
  const poolLp = await pc.balanceOf(walletAddr);
  console.log(`  Pool LP balance: ${poolLp}`);

  // Check if wallet has LP tokens in the Manager
  console.log(`  Manager LP balance: ${lpBalance}`);

  // ════════ 10. Try 5x with a very small collateral to see if leverage is the issue ════════
  console.log("\n═══════════ 10. SMALL COLLATERAL + 5x LEVERAGE ═══════════");
  const smallTests = [
    { collateral: "1", desc: "1 USDT" },
    { collateral: "0.1", desc: "0.1 USDT" },
    { collateral: "0.01", desc: "0.01 USDT" },
  ];

  for (const t of smallTests) {
    const collateralAmt = ethers.parseUnits(t.collateral, 6);
    // Simple quote for small amounts
    const effective = feeAdjusted(collateralAmt, 10n);
    const reserve0 = BigInt(res[0]);
    const reserve1 = BigInt(res[1]);
    const totalSupply = BigInt(ts);
    const op0 = BigInt(op[0]);
    const swapFeeBpsVal = BigInt(sfb);

    const collateralValue = effective * op0 / q112;
    const poolValue = reserve0 * op0 / q112 + reserve1;
    const collateralLp = poolValue === 0n ? 0n : collateralValue * totalSupply / poolValue;
    const borrowAmt = collateralLp * 40000n / BPS; // 5x → (5-1)*10000

    const testParams = coder.encode(
      ["bool", "address", "uint256", "uint256", "uint256", "uint256", "uint256"],
      [true, USDT, collateralAmt, borrowAmt, 50n, 0n, BigInt(deadline)]
    );
    const testCalldata = "0xfa2b1dfd" + testParams.slice(2);

    try {
      await provider.call({ from: walletAddr, to: MANAGER, data: testCalldata, value: 0n });
      console.log(`  ${t.desc} + 5x: PASS`);
    } catch (e) {
      const revertData = e?.data || e?.info?.error?.data || e?.cause?.data || e?.cause?.info?.error?.data || null;
      const match = (e?.shortMessage || e?.message || "").match(/0x[0-9a-fA-F]{8,}/);
      console.log(`  ${t.desc} + 5x: FAIL → ${revertData || match?.[0] || e?.message?.slice(0, 80)}`);
    }
  }

  // ════════ SUMMARY ════════
  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  DIAGNOSIS SUMMARY");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  Active positions:        ${stillOpen.length} [${stillOpen.join(", ")}]`);
  console.log(`  Manager LP balance:      ${lpBalance}`);
  console.log(`  Pool LP balance:         ${poolLp}`);
  console.log(`  Available liquidity:     ${availableLiq}`);
  console.log(`  Bot's collateralLp:      ${botCollateralLp}`);
  console.log(`  Current collateralLp:    ${currentCollateralLp}`);
  console.log(`  Bot's borrowAmount:      ${botBorrow}`);
  console.log(`═══════════════════════════════════════════════════════════════`);
}

function feeAdjusted(amount, feeBps = 100n) {
  if (amount === 0n || feeBps <= 0n) return amount;
  if (feeBps >= BPS) return 0n;
  return amount * (BPS - feeBps) / BPS;
}

main().catch(e => { console.error(`FATAL: ${e.message}`); process.exit(1); });
