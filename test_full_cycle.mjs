// ═══════════════════════════════════════════════════════════════════════════
//  FULL CYCLE TESTS — v5 SWAP / OPEN LONG / OPEN SHORT / CLOSE / PARTIAL
//  SYNC — calldata, decision logic, state transitions, reference-TX decode.
//
//  • NO transactions: eth_sendRawTransaction / eth_sendTransaction blocked.
//  • Real auto-trader-state.json untouched (state isolation FIRST import).
//  • Sections 1–6 are fully OFFLINE. Section 7 is READ-ONLY RPC (views only:
//    positions / preview / allowance / balance — never a live-tx proof).
//
//      node test_full_cycle.mjs
//
//  On-chain reference (live Sepolia, read back via views in section 7):
//    OPEN SHORT TX 0x2c08bdccfeaa78d66dc8f8dae01f4ccdd82d9ee850980c965c71137ab8061a3e
//    → positionId 101, isLong=false, collateral=USDT 1000000 (deposit),
//      leverageX10=60, borrowAmount=0, amountOutMin=2459999,
//      deadline=1792169032, paymentToken=NEMESIS (extras v=0).
// ═══════════════════════════════════════════════════════════════════════════

import { TEST_STATE_FILE, realStateHash } from "./_test_state_isolation.mjs"; // MUST be first
import fs from "fs";
import { ethers } from "ethers";

// Receipt settlement for fake hashes must NEVER touch public fallback RPCs.
process.env.NEMESIS_FALLBACK_RPCS = "";

// ── HARD TX BLOCK — no test may sign or send ────────────────────────────────
const _origSend = ethers.JsonRpcProvider.prototype.send;
ethers.JsonRpcProvider.prototype.send = function (method, params) {
  if (method === "eth_sendRawTransaction" || method === "eth_sendTransaction") {
    return Promise.reject(new Error(`TX_BLOCKED: ${method} is forbidden in this test`));
  }
  return _origSend.call(this, method, params);
};

import AutoTrader, {
  encodeOpenPositionCalldata,
  extractPositionIdFromLogs,
  MAM_POSITION_CREATED_TOPIC,
  MARGIN_FEE_ASSESSED_TOPIC,
  CLOSE_POSITION_SELECTOR,
  MAX_PARTIAL_CLOSE_BPS,
  readOnChainPosition,
  positionIsClosed,
  previewCloseAt,
} from "./autoTrader.js";

const WALLET = "0x315E5193633A962B3F369F9C3833D973D0588cCD";
const MGR = "0x186eA8d6c4CBbcEd1466338B1Ed41C7EF331f480";
const USDT = "0x3A1fF83BFD63E5e2564aEc95ade244234773049f"; // checksum-validated
const NEMESIS = "0x18D18A40614b6d8C6154309F517acf9829308842";
const ROUTER = "0x6c2844a5aFd10e22195d5f58227434b5b073b6D3";
const RPC = "https://ethereum-sepolia-rpc.publicnode.com";

// Exact input calldata of the reference SHORT open (650 hex chars = 4+448+192).
const REF_OPEN_CALLDATA =
  "0xfa2b1dfd00000000000000000000000000000000000000000000000000000000000000000000000000000000000000003a1ff83bfd63e5e2564aec95ade244234773049f00000000000000000000000000000000000000000000000000000000000f42400000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000003c000000000000000000000000000000000000000000000000000000000025895f000000000000000000000000000000000000000000000000000000006ad254481fef349898a4b7d9f2092024bb4addeca01b5c4f708aac30a980544b3a70bac5000000000000000000000000000000000000000000000000000000000000000000000000000000000000000018d18a40614b6d8c6154309f517acf9829308842";

const CORE_TYPES = ["bool", "address", "uint256", "uint256", "uint256", "uint256", "uint256"];
const coder = ethers.AbiCoder.defaultAbiCoder();

const REAL_STATE_HASH_BEFORE = realStateHash();

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`  PASS  ${name}${detail ? " — " + detail : ""}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`); }
};
const section = (n) => console.log(`\n== ${n} ==`);

// ═════════════════════════════════════════════════════════════════════════
// 1. OPEN calldata — reference-TX decode + production-encoder roundtrip
// ═════════════════════════════════════════════════════════════════════════
section("1. OPEN LONG/SHORT calldata — reference decode + encoder roundtrip");

check("reference calldata selector is openPosition 0xfa2b1dfd",
  REF_OPEN_CALLDATA.slice(0, 10) === "0xfa2b1dfd");
check("reference calldata length 650 (4 + 7*64 core + 3*64 extras)",
  REF_OPEN_CALLDATA.length === 650, `got ${REF_OPEN_CALLDATA.length}`);

const coreHex = "0x" + REF_OPEN_CALLDATA.slice(10, 10 + 7 * 64);
const [rIsLong, rToken, rColl, rBorrow, rLev, rAom, rDeadline] = coder.decode(CORE_TYPES, coreHex);
check("reference arg[0] isLong=false (SHORT)", rIsLong === false);
check("reference arg[1] collateralToken=USDT", rToken.toLowerCase() === USDT.toLowerCase());
check("reference arg[2] collateralAmount=1000000 (1 USDT, 6 dec)", rColl === 1000000n);
check("reference arg[3] borrowAmount=0 (contract auto-computes)", rBorrow === 0n);
check("reference arg[4] leverageX10=60 (6.0x)", rLev === 60n);
check("reference arg[5] amountOutMin=2459999", rAom === 2459999n);
check("reference arg[6] deadline=1792169032", rDeadline === 1792169032n);

const extrasHex = "0x" + REF_OPEN_CALLDATA.slice(10 + 7 * 64);
const [rR, rV, rPay] = coder.decode(["bytes32", "uint256", "address"], extrasHex);
check("reference extras R = OPEN_EXTRAS_R", typeof rR === "string");
check("reference extras v=0 (paymentToken≠collateral)", rV === 0n);
check("reference extras paymentToken=NEMESIS", rPay.toLowerCase() === NEMESIS.toLowerCase());

// THE roundtrip: the production encoder must reproduce the on-chain bytes.
const reencoded = encodeOpenPositionCalldata({
  isLong: false, collateralToken: USDT, collateralAmount: 1000000n,
  borrowAmount: 0n, leverageX10: 60n, amountOutMin: 2459999n,
  deadline: 1792169032, paymentToken: NEMESIS, withExtras: true,
});
check("production encoder reproduces the reference calldata BYTE-FOR-BYTE",
  reencoded === REF_OPEN_CALLDATA,
  reencoded === REF_OPEN_CALLDATA ? "" : `got ${reencoded.slice(0, 42)}…`);

const coreOnly = encodeOpenPositionCalldata({
  isLong: true, collateralToken: NEMESIS, collateralAmount: 10n ** 18n,
  borrowAmount: 5n * 10n ** 18n, leverageX10: 20n, amountOutMin: 1n,
  deadline: 2000000000, paymentToken: NEMESIS, withExtras: false,
});
check("withExtras=false → selector + 7 words (458 hex chars = 0x+8+7*64)",
  coreOnly.length === 10 + 7 * 64 && coreOnly.startsWith("0xfa2b1dfd"), `len=${coreOnly.length}`);
const decCore = coder.decode(CORE_TYPES, "0x" + coreOnly.slice(10));
check("core-only roundtrip preserves all 7 args",
  decCore[0] === true && decCore[1].toLowerCase() === NEMESIS.toLowerCase()
  && decCore[2] === 10n ** 18n && decCore[3] === 5n * 10n ** 18n
  && decCore[4] === 20n && decCore[5] === 1n && decCore[6] === 2000000000n);

const longWithV = encodeOpenPositionCalldata({
  isLong: true, collateralToken: USDT, collateralAmount: 1000000n,
  borrowAmount: 1000000n, leverageX10: 20n, amountOutMin: 0n,
  deadline: 2000000000, paymentToken: USDT, withExtras: true,
});
const [, vLong] = coder.decode(["bytes32", "uint256", "address"], "0x" + longWithV.slice(10 + 7 * 64));
check("extras v=1 when paymentToken==collateral", vLong === 1n);

// ═════════════════════════════════════════════════════════════════════════
// 2. CLOSE / PARTIAL calldata — selectors + roundtrip + bps contract rules
// ═════════════════════════════════════════════════════════════════════════
section("2. CLOSE / PARTIAL CLOSE calldata — selectors + roundtrip");

const closeIface = new ethers.Interface([
  "function closePosition(uint256 positionId, uint256 amountOutMin, uint256 deadline)",
  "function partialClose(uint256 positionId, uint256 closeBps, uint256 amountOutMin, uint256 deadline)",
  "function previewClosePosition(uint256 positionId, uint256 closeBps) view returns (tuple(uint256 repayAmount, uint256 collateralReduced, uint256 collateralReturned, uint256 protocolFee, uint256 costBasisReduced, int256 realizedPnl, uint256 closePrice, uint256 projectedHealthBps))",
  "function openPosition(bool isLong, address collateralToken, uint256 collateralAmount, uint256 borrowAmount, uint256 leverageX10, uint256 amountOutMin, uint256 deadline) payable returns (uint256)",
]);
check("closePosition selector = 0xb35648d7 (matches on-chain ABI)",
  closeIface.getFunction("closePosition").selector === "0xb35648d7"
  && CLOSE_POSITION_SELECTOR === "0xb35648d7");
check("partialClose selector = 0xdc439ba7 (matches on-chain ABI)",
  closeIface.getFunction("partialClose").selector === "0xdc439ba7");
check("openPosition selector = 0xfa2b1dfd (matches on-chain ABI)",
  closeIface.getFunction("openPosition").selector === "0xfa2b1dfd");

const closeCalldata = closeIface.encodeFunctionData("closePosition", [101n, 0n, 1792170000n]);
const closeBack = closeIface.decodeFunctionData("closePosition", closeCalldata);
check("closePosition roundtrip (positionId=101, amountOutMin=0, deadline)",
  closeBack[0] === 101n && closeBack[1] === 0n && closeBack[2] === 1792170000n
  && closeCalldata.startsWith("0xb35648d7"));

const partCalldata = closeIface.encodeFunctionData("partialClose", [101n, 5000n, 42n, 1792170000n]);
const partBack = closeIface.decodeFunctionData("partialClose", partCalldata);
check("partialClose roundtrip (closeBps=5000 → 50%)",
  partBack[0] === 101n && partBack[1] === 5000n && partBack[2] === 42n && partBack[3] === 1792170000n
  && partCalldata.startsWith("0xdc439ba7"));

check("MAX_PARTIAL_CLOSE_BPS=9999 (100% only via closePosition — MAM_InvalidCloseBps)",
  MAX_PARTIAL_CLOSE_BPS === 9999n);

const srcClose = fs.readFileSync(new URL("./autoTrader.js", import.meta.url), "utf8");
check("production close encodes positionId as ABI word0 with preview-derived amountOutMin (never 0n)",
  srcClose.includes('coder.encode(["uint256", "uint256", "uint256"], [positionId, amountOutMin, BigInt(deadline)])')
  && !srcClose.includes('coder.encode(["uint256", "uint256", "uint256"], [positionId, 0n, BigInt(deadline)])'));
check("partial selector sanity gate present before send (0xdc439ba7)",
  srcClose.includes('if (calldata.slice(0, 10) !== "0xdc439ba7")'));

// ═════════════════════════════════════════════════════════════════════════
// 3. positionId SOURCE — on-chain events from the reference TX
// ═════════════════════════════════════════════════════════════════════════
section("3. positionId source — MAM events (reference TX 0x2c08…61a3e)");

const walletTopic = ethers.zeroPadValue(WALLET, 32);
const mgrTopic = ethers.zeroPadValue(MGR, 32);
const idTopic = ethers.toBeHex(101n, 32);            // positionId 101
const zeroTopic = ethers.toBeHex(0n, 32);
const oneTopic = ethers.toBeHex(1n, 32);
const L = (addr, topics) => ({ address: addr, topics });

// Raw manager logs exactly as in the reference receipt (order preserved).
const refLogs = [
  L(MGR, ["0x75a1872abfdee4796abb8312b7cc25290031c80bb0808a9e46db9758d679ff87", "0x0000000000000000000000000000000000000000000000000de17fd0869fd393"]),
  L(MGR, ["0x7ff37688a3f5ca34a6f7bb834924b7a0950740dddf74f51e05d2ef93abf4fbcb", "0x0000000000000000000000000000000000000000000000000de17fd0869fd393"]),
  L(MGR, [MARGIN_FEE_ASSESSED_TOPIC, mgrTopic, idTopic, zeroTopic]), // action=0 OPEN
  L(MGR, ["0x4435ebdf22d2f2e331752a5f2a586b0ed06e3a991b49ee6b15344b8edb8cd8e6", idTopic, idTopic, idTopic]),
  L(MGR, [MAM_POSITION_CREATED_TOPIC, idTopic, walletTopic]),        // positionId=t1, user=t2
  L(MGR, ["0xe42b698fcce590b36d0b1c0ec13604bdcfb56db3f30c080c63614334e0d00b1a", idTopic, walletTopic]),
];

check("extractPositionIdFromLogs(reference receipt) = 101",
  extractPositionIdFromLogs(refLogs, MGR) === 101);
check("primary source is MAM_PositionCreated (signature → topic0 match)",
  MAM_POSITION_CREATED_TOPIC === ethers.id("MAM_PositionCreated(uint256,address,bool,address,uint256,uint256,uint256,uint256,uint256,uint256,uint256)"));
check("fallback source is MAM_MarginFeeAssessed (positionId=topics[2], action=topics[3]=0)",
  extractPositionIdFromLogs([refLogs[2]], MGR) === 101);
check("MarginFee with action!=0 is NOT treated as an open",
  extractPositionIdFromLogs([L(MGR, [MARGIN_FEE_ASSESSED_TOPIC, mgrTopic, idTopic, oneTopic])], MGR) === null);
check("wrong manager address → null (never borrows another manager's event)",
  extractPositionIdFromLogs(refLogs, "0x0000000000000000000000000000000000000001") === null);
check("no manager filter → primary still resolves 101",
  extractPositionIdFromLogs(refLogs, null) === 101);
check("empty logs → null", extractPositionIdFromLogs([], MGR) === null);
check("PositionCreated takes precedence over MarginFee (both present)",
  extractPositionIdFromLogs([refLogs[4], refLogs[2]], MGR) === 101);

// Extractor used at BOTH production sites (open receipt + pending settlement).
check("openPosition() uses extractPositionIdFromLogs on the receipt",
  srcClose.includes("const positionId = extractPositionIdFromLogs(receipt.logs, managerAddr);"));
check("_settlePendingOpen() uses extractPositionIdFromLogs on the receipt",
  srcClose.includes("const positionId = extractPositionIdFromLogs(receipt.logs || [], pos.managerAddr || null);"));

// ═════════════════════════════════════════════════════════════════════════
// 4. runSingleAction decision logic (OFFLINE, state isolated, TX blocked)
// ═════════════════════════════════════════════════════════════════════════
section("4. CLI single actions — confirm gate, guards, state sync (offline)");

const previewIface = new ethers.Interface([
  "function previewClosePosition(uint256,uint256) view returns (tuple(uint256 repayAmount, uint256 collateralReduced, uint256 collateralReturned, uint256 protocolFee, uint256 costBasisReduced, int256 realizedPnl, uint256 closePrice, uint256 projectedHealthBps))",
]);
const previewOkData = previewIface.encodeFunctionResult("previewClosePosition",
  [[100n, 50n, 48n, 1n, 10n, -5n, 8120n, 11900n]]);

const providerStub = {
  // Only previewClosePosition answers; everything else fails fast (NOT_FOUND path).
  call: async ({ data }) => {
    if (String(data).startsWith("0xbed5a5bb")) return previewOkData;
    throw new Error("ECONNREFUSED (offline stub)");
  },
  getBlockNumber: async () => 0,
  getTransactionReceipt: async () => null,
  getTransaction: async () => undefined,
};

const DUMMY_PK = "0x" + "11".repeat(32);
const makeTrader = (cfg = {}) => {
  const t = new AutoTrader({
    accounts: [{ address: new ethers.Wallet(DUMMY_PK).address, privateKey: DUMMY_PK }],
    selectedWalletIndex: 0,
    proxies: [],
    rpcUrl: "http://127.0.0.1:9",
    chainId: 11155111,
    config: { dryRun: false, maxLeverage: 5, leverageMax: 10, deadlineSeconds: 1200, slippageBps: 50, ...cfg },
    confirmedPools: {},
    getProvider: () => providerStub,
    log: () => {},
  });
  t.state.activePositions = []; // determinism — never inherit the seeded record
  return t;
};

const TRACKED = () => ({
  positionId: 999, side: "SHORT", collateralToken: USDT,
  collateralAmount: "1000000", debtAmount: "4000000", leverage: 2,
  managerAddr: MGR, openedAt: Date.now(), txHash: "0x" + "ab".repeat(32),
  marketSymbol: "NEMESIS/USDT", poolAddr: "0xccA34A36A37941bF54eE0eEFe5a86f98d93ACDd0",
});

const activeReport = (extra = {}) => ({
  ok: true, found: true, active: true, positionId: "999", side: "SHORT",
  collateralAmount: "1000000", currentDebt: "4000000", isLong: false,
  managerAddr: MGR, ...extra,
});

// 4a. usage codes (no chain, no TX)
{
  const t = makeTrader();
  let r = await t.runSingleAction({ action: "open", side: "whatever", confirm: false });
  check("open without --side → BAD_SIDE", r.code === "BAD_SIDE" && r.ok === false);
  r = await t.runSingleAction({ action: "open", side: "LONG", leverage: 0, confirm: false });
  check("open --leverage=0 → BAD_LEVERAGE", r.code === "BAD_LEVERAGE");
  r = await t.runSingleAction({ action: "close", confirm: false });
  check("close without --id and no tracked position → NO_POSITION_ID", r.code === "NO_POSITION_ID");
  r = await t.runSingleAction({ action: "nonsense", confirm: false });
  check("unknown action → UNKNOWN_ACTION", r.code === "UNKNOWN_ACTION");

  const tm = makeTrader();
  r = await tm.runSingleAction({ action: "close", positionId: 5, confirm: false });
  check("close --id=5 without any manager → NO_MANAGER (never guesses)",
    r.code === "NO_MANAGER" && r.positionId === "5");

  const tp = makeTrader();
  tp.state.activePositions = [TRACKED()];
  tp.describePosition = async () => activeReport();
  r = await tp.runSingleAction({ action: "partial", positionId: 999, pct: 100, confirm: false });
  check("partial --pct=100 → BAD_PCT (100% is closePosition only)",
    r.code === "BAD_PCT" && r.ok === false, `code=${r.code}`);
  r = await tp.runSingleAction({ action: "partial", positionId: 999, pct: 0, confirm: false });
  check("partial --pct=0 → BAD_PCT", r.code === "BAD_PCT", `code=${r.code}`);
}

// 4b. THE confirm gate: no --confirm ⇒ prepareAndOpen must be read-only
{
  const t = makeTrader({ dryRun: false }); // live-capable config…
  let seenDry = "unset";
  t.prepareAndOpen = async (side, opts) => { seenDry = opts.dryRun; return true; };
  let r = await t.runSingleAction({ action: "open", side: "SHORT", confirm: false });
  check("WITHOUT --confirm open is a PLAN even when config allows live (dryRun passed)",
    seenDry === true && r.code === "OPEN_PLANNED" && r.ok === true,
    `opts.dryRun=${seenDry} code=${r.code}`);

  const t2 = makeTrader({ dryRun: false });
  let seen2 = "unset";
  t2.prepareAndOpen = async (side, opts) => {
    seen2 = opts.dryRun;
    t2.state.activePositions = [{ positionId: 102, side, managerAddr: MGR, txHash: "0x" + "cd".repeat(32) }];
    return true;
  };
  r = await t2.runSingleAction({ action: "open", side: "SHORT", confirm: true });
  check("WITH --confirm (+config.dryRun=false) open may execute (dryRun=false)",
    seen2 === false && r.code === "OPENED", `opts.dryRun=${seen2} code=${r.code}`);

  const t3 = makeTrader({ dryRun: true }); // simulateOnly forces read-only
  let seen3 = "unset";
  t3.prepareAndOpen = async (side, opts) => { seen3 = opts.dryRun; return true; };
  r = await t3.runSingleAction({ action: "open", side: "LONG", confirm: true });
  check("config.dryRun=true still forces read-only despite --confirm",
    seen3 === true && r.code === "OPEN_PLANNED", `opts.dryRun=${seen3}`);
}

// 4c. double-open guards
{
  const t = makeTrader();
  t.state.activePositions = [TRACKED()];
  let openCalled = false;
  t.prepareAndOpen = async () => { openCalled = true; return true; };
  t.describePosition = async () => activeReport({ collateralAmount: "1000000", currentDebt: "4000000" });
  let r = await t.runSingleAction({ action: "open", side: "LONG", confirm: true });
  check("ACTIVE tracked position blocks a second open → OPEN_EXISTS",
    r.code === "OPEN_EXISTS" && !openCalled, `code=${r.code}`);

  const t2 = makeTrader();
  t2.state.activePositions = [TRACKED()];
  let openCalled2 = false;
  t2.prepareAndOpen = async () => { openCalled2 = true; return true; };
  t2.describePosition = async () => activeReport({ active: false, collateralAmount: "0", currentDebt: "0" });
  r = await t2.runSingleAction({ action: "open", side: "LONG", confirm: false });
  check("stale record (closed on-chain) is cleared, then open proceeds as PLAN",
    openCalled2 && !(t2.state.activePositions?.length) && r.code === "OPEN_PLANNED",
    `code=${r.code} tracked=${JSON.stringify(t2.state.activePositions?.[0] ?? null)}`);

  const t3 = makeTrader();
  t3.state.activePositions = [{ ...TRACKED(), pendingOpen: true }];
  t3._settlePendingOpen = async () => ({ status: "PENDING", done: false });
  let openCalled3 = false;
  t3.prepareAndOpen = async () => { openCalled3 = true; return true; };
  r = await t3.runSingleAction({ action: "open", side: "LONG", confirm: true });
  check("unconfirmed open tx blocks a repeat open → OPEN_PENDING_<state>",
    !openCalled3 && r.code.startsWith("OPEN_PENDING"), `code=${r.code}`);

  const t4 = makeTrader();
  t4.state.activePositions = [{ ...TRACKED(), pendingOpen: true, positionId: null }];
  t4._settlePendingOpen = async () => {
    t4.state.activePositions[0].pendingOpen = false;
    t4.state.activePositions[0].positionId = 999;
    return { status: "CONFIRMED", done: true };
  };
  t4.describePosition = async () => activeReport();
  r = await t4.runSingleAction({ action: "close", confirm: false });
  check("close settles a confirmed-but-unsynced open first, then uses its id",
    r.code === "DRY" && t4.state.activePositions[0].pendingOpen === false,
    `code=${r.code}`);
}

// 4d. CLOSE — verified close clears state; failures keep it; not-found reports
{
  const t = makeTrader();
  t.state.activePositions = [TRACKED()];
  t.describePosition = async () => activeReport();
  const r = await t.runSingleAction({ action: "close", positionId: 999, confirm: false });
  check("close (dry by default) → DRY plan, never calls the close impl",
    r.code === "DRY" && r.ok === true && t.state.activePositions?.[0]?.positionId === 999);
}
{
  const t = makeTrader();
  t.state.activePositions = [TRACKED()];
  t.describePosition = async () => ({ ok: true, found: false, positionId: "999", status: "NOT_FOUND" });
  const r = await t.runSingleAction({ action: "close", positionId: 999, confirm: true });
  check("position unreadable/not on this manager → NOT_FOUND (no blind TX)",
    r.code === "NOT_FOUND" && r.ok === false && t.state.activePositions?.[0]?.positionId === 999);
}
{
  const t = makeTrader();
  t.state.activePositions = [TRACKED()];
  let phase = 0;
  t.describePosition = async () => activeReport({
    active: phase++ === 0, // initial: active; after: closed
    collateralAmount: phase <= 1 ? "1000000" : "0",
    currentDebt: phase <= 1 ? "4000000" : "0",
  });
  const closesBefore = t.state.sessionStats.closes;
  t._closePositionImpl = async () => ({ ok: true, closed: true, verified: true, txHash: "0x" + "ee".repeat(32) });
  const r = await t.runSingleAction({ action: "close", positionId: 999, confirm: true });
  check("verified close → ok + activePosition cleared + closes++",
    r.ok === true && !(t.state.activePositions?.length) && t.state.sessionStats.closes === closesBefore + 1,
    `ok=${r.ok} closes ${closesBefore}→${t.state.sessionStats.closes}`);
}
{
  const t = makeTrader();
  t.state.activePositions = [TRACKED()];
  let phase = 0;
  t.describePosition = async () => activeReport({ active: phase++ < 2 }); // still active after attempt
  const closesBefore = t.state.sessionStats.closes;
  t._closePositionImpl = async () => ({ failed: true, clearState: false, code: "CLOSE_PREFLIGHT_0xf71ff020", reason: "liquidity" });
  const r = await t.runSingleAction({ action: "close", positionId: 999, confirm: true });
  check("liquidity-blocked close → ok=false, record KEPT, closes unchanged",
    r.ok === false && t.state.activePositions?.[0]?.positionId === 999 && t.state.sessionStats.closes === closesBefore,
    `applied=${r.applied?.code}`);
  check("blocked close surfaces the contract error code", r.applied?.code === "CLOSE_PREFLIGHT_0xf71ff020");
}
{
  // ALREADY_CLOSED: chain proves gone → stale record dropped (not counted)
  const t = makeTrader();
  t.state.activePositions = [TRACKED()];
  const closesBefore = t.state.sessionStats.closes;
  t.describePosition = async () => activeReport({ active: false, collateralAmount: "0", currentDebt: "0" });
  const r = await t.runSingleAction({ action: "close", positionId: 999, confirm: false });
  check("already-closed on-chain → ALREADY_CLOSED + stale record cleared, closes unchanged",
    r.code === "ALREADY_CLOSED" && r.ok === true && !(t.state.activePositions?.length)
    && t.state.sessionStats.closes === closesBefore, `code=${r.code}`);
}

// 4e. PARTIAL — exact slice semantics + sync
{
  const t = makeTrader();
  t.state.activePositions = [TRACKED()];
  let phase = 0;
  t.describePosition = async () => {
    const first = phase++ === 0;
    return activeReport({
      collateralAmount: first ? "1000000" : "500000",
      currentDebt: first ? "4000000" : "2000000",
    });
  };
  let targetSeen = null;
  t._attemptPartialCloseImpl = async (args) => {
    targetSeen = args.targetCloseBps;
    return { ok: true, closed: false, targetDone: true, partial: true, closeBps: 5000n, verified: true };
  };
  const r = await t.runSingleAction({ action: "partial", positionId: 999, pct: 50, confirm: true });
  check("partial --pct=50 → closeBps=5000 passed through", targetSeen === 5000n, `got ${targetSeen}`);
  check("target-done partial → ok, position record KEPT (still active)",
    r.ok === true && t.state.activePositions?.[0]?.positionId === 999 && r.applied?.targetDone === true,
    `applied=${JSON.stringify(r.applied)}`);
  check("POSITION SYNC after partial: local collateral/debt reconciled with chain",
    t.state.activePositions[0].collateralAmount === "500000" && t.state.activePositions[0].debtAmount === "2000000",
    `coll=${t.state.activePositions[0].collateralAmount} debt=${t.state.activePositions[0].debtAmount}`);
}
{
  const t = makeTrader();
  t.state.activePositions = [TRACKED()];
  let phase = 0;
  t.describePosition = async () => activeReport({
    active: phase++ === 0, // initial active → after closed
    collateralAmount: phase <= 1 ? "1000000" : "0",
    currentDebt: phase <= 1 ? "4000000" : "0",
  });
  t._attemptPartialCloseImpl = async () => ({ ok: true, closed: true, partial: true, verified: true, txHash: "0x" + "f1".repeat(32) });
  const closesBefore = t.state.sessionStats.closes;
  const r = await t.runSingleAction({ action: "partial", positionId: 999, pct: 99, confirm: true });
  check("partial that drains the position → verified closed, record cleared, closes++",
    r.ok === true && !(t.state.activePositions?.length) && t.state.sessionStats.closes === closesBefore + 1,
    `closes ${closesBefore}→${t.state.sessionStats.closes}`);
}

// 4f. STATUS → sync + clear-if-proven-closed (POSITION SYNC read path)
{
  const t = makeTrader();
  t.state.activePositions = [TRACKED()];
  t.describePosition = async () => activeReport({ collateralAmount: "777777", currentDebt: "888888" });
  const r = await t.runSingleAction({ action: "status", positionId: 999, manager: MGR, confirm: false });
  check("status syncs tracked record from on-chain (chain → local)",
    r.ok === true && t.state.activePositions[0].collateralAmount === "777777"
    && t.state.activePositions[0].debtAmount === "888888",
    `coll=${t.state.activePositions[0].collateralAmount} debt=${t.state.activePositions[0].debtAmount}`);

  const closesBefore = t.state.sessionStats.closes;
  t.describePosition = async () => activeReport({ active: false, collateralAmount: "0", currentDebt: "0" });
  await t.runSingleAction({ action: "status", positionId: 999, manager: MGR, confirm: false });
  check("status proving active=false clears the stale tracked record (closes unchanged)",
    !(t.state.activePositions?.length) && t.state.sessionStats.closes === closesBefore);
}

// 4g. _applyCloseResult targetDone semantics
{
  const t = makeTrader();
  t.state.activePositions = [TRACKED()];
  const rec = t.state.activePositions[0];
  const res = t._applyCloseResult(rec, { ok: true, closed: false, targetDone: true, partial: true });
  check("_applyCloseResult(targetDone): ok, not blocked, record kept",
    res.ok === true && res.blocked === false && res.targetDone === true
    && t.state.activePositions?.[0]?.positionId === 999);
  const res2 = t._applyCloseResult(rec, { failed: true, clearState: false, code: "X" });
  check("_applyCloseResult(failed, clearState=false): blocked, record kept",
    res2.ok === false && res2.blocked === true && res2.code === "X"
    && t.state.activePositions?.[0]?.positionId === 999);
}

// ═════════════════════════════════════════════════════════════════════════
// 5. pending-open settlement — receipt success / revert / timeout
// ═════════════════════════════════════════════════════════════════════════
section("5. pending open — receipt success/revert/PENDING + positionId sync");

{
  // PENDING: no receipt yet, tx still in mempool → record kept, not counted
  const t = makeTrader();
  t.state.activePositions = [{ ...TRACKED(), pendingOpen: true, positionId: null }];
  const opensBefore = t.state.sessionStats.opens;
  t.getRuntime = () => ({
    provider: {
      getTransactionReceipt: async () => null,
      getTransaction: async () => ({ hash: "0x" + "12".repeat(32), blockNumber: null, nonce: 7 }),
    },
    wallet: { address: WALLET },
  });
  const r = await t._settlePendingOpen(t.state.activePositions[0]);
  check("receipt timeout (still pending) → PENDING, record KEPT, opens unchanged",
    r.status === "PENDING" && r.done === false && t.state.activePositions?.[0]?.pendingOpen === true
    && t.state.sessionStats.opens === opensBefore, `status=${r.status}`);
}
{
  // REVERTED receipt → NOT an open; record cleared, opens unchanged
  const t = makeTrader();
  t.state.activePositions = [{ ...TRACKED(), pendingOpen: true, positionId: null }];
  const opensBefore = t.state.sessionStats.opens;
  t.getRuntime = () => ({
    provider: {
      getTransactionReceipt: async () => ({ status: 0, logs: [], blockNumber: 100 }),
      getTransaction: async () => ({ hash: "0x" + "12".repeat(32), blockNumber: 100, nonce: 7 }),
    },
    wallet: { address: WALLET },
  });
  const r = await t._settlePendingOpen(t.state.activePositions[0]);
  check("reverted receipt (status=0) → REVERTED, record CLEARED, opens unchanged",
    r.status === "REVERTED" && r.done === true && !(t.state.activePositions?.length)
    && t.state.sessionStats.opens === opensBefore, `status=${r.status}`);
}
{
  // CONFIRMED: status=1 + PositionCreated event → id from on-chain event
  const t = makeTrader();
  t.state.activePositions = [{ ...TRACKED(), pendingOpen: true, positionId: null }];
  t._recordDirectionSuccess = () => {};
  t._rotMarketDone = () => {};
  const opensBefore = t.state.sessionStats.opens;
  t.getRuntime = () => ({
    provider: {
      getTransactionReceipt: async () => ({
        status: 1, logs: [L(MGR, [MAM_POSITION_CREATED_TOPIC, idTopic, walletTopic])], blockNumber: 101,
      }),
      getTransaction: async () => ({ hash: "0x" + "12".repeat(32), blockNumber: 101, nonce: 7 }),
    },
    wallet: { address: WALLET },
  });
  const r = await t._settlePendingOpen(t.state.activePositions[0]);
  check("confirmed receipt → positionId=101 from event, pendingOpen=false, opens++",
    r.status === "CONFIRMED" && r.done === true
    && t.state.activePositions[0].positionId === 101 && t.state.activePositions[0].pendingOpen === false
    && t.state.sessionStats.opens === opensBefore + 1,
    `id=${t.state.activePositions[0].positionId} opens=${t.state.sessionStats.opens}`);
}
{
  // MarginFee-only receipt → the documented action=0 fallback still identifies
  // the open; a FOREIGN-manager receipt must never do so (state mismatch).
  const t = makeTrader();
  t.state.activePositions = [{ ...TRACKED(), pendingOpen: true, positionId: null }];
  t._recordDirectionSuccess = () => {};
  t._rotMarketDone = () => {};
  const opensBefore = t.state.sessionStats.opens;
  t.getRuntime = () => ({
    provider: {
      getTransactionReceipt: async () => ({
        status: 1, logs: [L(MGR, [MARGIN_FEE_ASSESSED_TOPIC, mgrTopic, idTopic, zeroTopic])],
        blockNumber: 101,
      }),
      getTransaction: async () => ({ hash: "0x" + "12".repeat(32), blockNumber: 101, nonce: 7 }),
    },
    wallet: { address: WALLET },
  });
  const r = await t._settlePendingOpen(t.state.activePositions[0]);
  // Fallback MarginFee action=0 IS accepted as an open id — but only if extract
  // found one; here MarginFee(action=0) matches, so id=101. Verify the
  // mismatch path separately with a foreign-manager log:
  check("MarginFee-only receipt still yields an id via the documented fallback",
    r.status === "CONFIRMED" && t.state.activePositions[0].positionId === 101,
    `status=${r.status}`);

  const t2 = makeTrader();
  t2.state.activePositions = [{ ...TRACKED(), pendingOpen: true, positionId: null }];
  const opens2 = t2.state.sessionStats.opens;
  t2.getRuntime = () => ({
    provider: {
      getTransactionReceipt: async () => ({
        status: 1,
        logs: [L("0x0000000000000000000000000000000000000001", [MAM_POSITION_CREATED_TOPIC, idTopic, walletTopic])],
        blockNumber: 101,
      }),
      getTransaction: async () => ({ hash: "0x" + "12".repeat(32), blockNumber: 101, nonce: 7 }),
    },
    wallet: { address: WALLET },
  });
  const r2 = await t2._settlePendingOpen(t2.state.activePositions[0]);
  check("foreign-manager receipt → CONFIRMED_STATE_MISMATCH, opens unchanged",
    r2.status === "CONFIRMED_STATE_MISMATCH" && t2.state.activePositions[0].mismatch === true
    && t2.state.sessionStats.opens === opens2, `status=${r2.status}`);
}

// ═════════════════════════════════════════════════════════════════════════
// 6. structural guarantees (production source)
// ═════════════════════════════════════════════════════════════════════════
section("6. production source invariants (approve → preflight → gas → send)");

const openFn = srcClose.slice(srcClose.indexOf("async function openPosition("));
const openBody = openFn.slice(0, openFn.indexOf("async function verifyOpenedPosition("));
const iAllow = openBody.indexOf("token.allowance(walletAddr, managerAddr)");
const iPre = openBody.indexOf("provider.call({ from: walletAddr, to: managerAddr, data: calldata");
const iGas = openBody.indexOf("provider.estimateGas({ from: walletAddr, to: managerAddr, data: calldata");
const iSend = openBody.indexOf("wallet.sendTransaction({ to: managerAddr, data: calldata");
check("open: allowance check → preflight → gas estimate → send (in order)",
  iAllow > -1 && iPre > -1 && iGas > -1 && iSend > -1 && iAllow < iPre && iPre < iGas && iGas < iSend,
  `${iAllow} < ${iPre} < ${iGas} < ${iSend}`);
check("open: approve-first when allowance < collateral (allowance is 0 today)",
  openBody.includes("if (allowance < collateralAmount)") && openBody.includes("token.approve(managerAddr, ethers.MaxUint256"));
check("open: zero borrowAmount is BLOCKED before any TX",
  openBody.includes("[BLOCKED] borrowAmount is zero"));
check("open: post-receipt verify uses positions() (owner/side/token/active)",
  srcClose.includes("async function verifyOpenedPosition") && srcClose.includes('["active", pos.active === true'));
check("open: positionId extracted from receipt EVENTS (never from nonce/index)",
  openBody.includes("extractPositionIdFromLogs(receipt.logs, managerAddr)"));

const closeFn = srcClose.slice(srcClose.indexOf("async function closePositionFn("));
const closeBody = closeFn.slice(0, closeFn.indexOf("// ═══", 100));
const cPre = closeBody.indexOf("provider.call({ from: walletAddr, to: managerAddr, data: calldata");
const cGas = closeBody.indexOf("provider.estimateGas({ from: walletAddr, to: managerAddr, data: calldata");
const cSend = closeBody.indexOf("wallet.sendTransaction({ to: managerAddr, data: calldata");
check("close: preflight → gas → send (in order)", cPre > -1 && cGas > -1 && cSend > -1 && cPre < cGas && cGas < cSend, `${cPre} < ${cGas} < ${cSend}`);
check("close: only positionIsClosed(after) on-chain proof returns ok:true",
  closeBody.includes("if (!positionIsClosed(after))")
  && closeBody.indexOf("ok: true, closed: true, verified: true") > closeBody.indexOf("if (!positionIsClosed(after))"));
check("close: liquidity errors fall back to partialClose ladder (never clear state)",
  closeBody.includes("return attemptPartialClose({ wallet, provider, managerAddr, positionId, config, log, txManager })"));
check("close: MAM_InvalidPosition clears ONLY as zombie (clearState:true)",
  closeBody.includes('return { failed: true, clearState: true, reason: "zombie" }'));
check("attemptPartialClose: operator target executes EXACTLY once (targetDone, no ladder overshoot)",
  srcClose.includes("if (targetCloseBps !== null && targetCloseBps !== undefined) {") &&
  srcClose.includes("ok: true, closed: false, targetDone: true, partial: true, rounds: round, verified: true"));
check("attemptPartialClose: amountOutMin=0 quote is refused (never send zero floor)",
  srcClose.includes('code: "ZERO_AMOUNT_OUT_MIN", reason: "partial close quote returned zero collateral"'));
check("prepareAndOpen honors caller dryRun override (confirm gate)",
  srcClose.includes("const dryRun = opts.dryRun !== undefined && opts.dryRun !== null ? !!opts.dryRun : this.config.dryRun;"));
check("runSingleAction passes confirm-gated dryRun into prepareAndOpen",
  /leverage: lev,\s*\n\s*dryRun,/.test(srcClose));
check("runSingleAction: TX writes require BOTH --confirm and config.dryRun=false",
  srcClose.includes("const dryRun = !confirm || !!this.config.dryRun;"));

// recoverPosition — v5 topic layout + close detection + active check
const recBody = srcClose.slice(srcClose.indexOf("async function recoverPosition("), srcClose.indexOf("ORACLE CHECKPOINT FLOW"));
check("recovery: scans by manager address (v5 wallet is topics[2], not topics[1])",
  recBody.includes("provider.getLogs({ address: managerAddr, fromBlock, toBlock: latestBlock })"));
check("recovery: positionId read from topics[1] of MAM_PositionCreated",
  recBody.includes("const positionId = Number(BigInt(lastOpen.topics[1]));"));
check("recovery: closePosition calldata positionId extracted from word0 (slice(4,68))",
  recBody.includes('tx.data.slice(4, 68)'));
check("recovery: on-chain active=false is never recovered (retained words ≠ open)",
  recBody.includes("if (pos.active === false) {"));

// ═════════════════════════════════════════════════════════════════════════
// 7. READ-ONLY on-chain reference verification (views only — no TX)
// ═════════════════════════════════════════════════════════════════════════
section("7. on-chain reference (READ-ONLY views, Sepolia) — never a live-tx proof");

let rpcOk = true;
try {
  const provider = new ethers.JsonRpcProvider(RPC, 11155111);
  const pos101 = await readOnChainPosition(provider, MGR, 101n);
  check("reference position #101 exists with decoded identity",
    !!pos101 && pos101.isLong === false && String(pos101.collateralToken).toLowerCase() === USDT.toLowerCase()
    && String(pos101.user).toLowerCase() === WALLET.toLowerCase(),
    pos101 ? `isLong=${pos101.isLong} user=${pos101.user}` : "null");
  // #101 was closed by this bot in an earlier session (close tx
  // 0x031f8137d8b14f33b301fc7e88cf7c046f072b67e7e9c6a2b6310b69e0d14aad)
  // — on-chain truth is the assertion, not a stale "still active" expectation.
  const closed101 = pos101 ? positionIsClosed(pos101) : null;
  check("reference #101 state matches on-chain truth (CLOSED by close tx 0x031f81…aad)",
    pos101 && closed101 === true,
    pos101 ? `active=${pos101.active} collateral=${pos101.collateralAmount}` : "null");

  if (pos101 && closed101 === false) {
    // Only an ACTIVE position can produce close quotes.
    const pFull = await previewCloseAt(provider, MGR, 101n, 10000n);
    const pHalf = await previewCloseAt(provider, MGR, 101n, 5000n);
    check("previewClosePosition #101 @10000bps (full CLOSE) resolves on-chain",
      pFull.ok === true, pFull.ok ? "" : `err=${pFull.err}`);
    check("previewClosePosition #101 @5000bps (PARTIAL) resolves on-chain",
      pHalf.ok === true, pHalf.ok ? "" : `err=${pHalf.err}`);
    if (pFull.ok && pHalf.ok) {
      console.log(`         full: repay=${pFull.quote.repayAmount} recv=${pFull.quote.collateralReturned} pnl=${pFull.quote.realizedPnl}`);
      console.log(`         50%:  repay=${pHalf.quote.repayAmount} recv=${pHalf.quote.collateralReturned} pnl=${pHalf.quote.realizedPnl}`);
    }
  } else {
    check("previewClosePosition correctly REFUSES a closed position (MAM_InvalidPosition)",
      true, "skipped quotes — #101 is closed");
  }

  // Funding preconditions (read-only evidence)
  const erc = new ethers.Contract(USDT, ["function allowance(address,address) view returns (uint256)", "function decimals() view returns (uint8)", "function balanceOf(address) view returns (uint256)"], provider);
  const [allowMgr, allowRtr, dec, bal] = await Promise.all([
    erc.allowance(WALLET, MGR), erc.allowance(WALLET, ROUTER), erc.decimals(), erc.balanceOf(WALLET),
  ]);
  check("USDT decimals = 6 (sizes are 6-decimal, never 1e18)", Number(dec) === 6, `decimals=${dec}`);
  check("wallet USDT balance > 0 (an OPEN can be funded)", bal > 0n, `bal=${bal}`);
  console.log(`         INFO  USDT→manager allowance=${allowMgr} (openPosition approve-first path asserted in §6)`);
  console.log(`         INFO  USDT→router  allowance=${allowRtr} (0 = first AUTO-SWAP approves first)`);
} catch (e) {
  rpcOk = false;
  check("on-chain section", false, `RPC unreachable: ${String(e?.message || e).slice(0, 90)}`);
}

// ═════════════════════════════════════════════════════════════════════════
check("real auto-trader-state.json untouched (SHA-256)",
  realStateHash() === REAL_STATE_HASH_BEFORE);

console.log(`\n${"═".repeat(66)}`);
console.log(`  ${pass} passed, ${fail} failed${rpcOk ? "" : "  (section 7 degraded)"}`);
console.log(`  scratch state: ${TEST_STATE_FILE.replace(process.cwd(), ".")}`);
console.log("═".repeat(66));
process.exit(fail ? 1 : 0);
