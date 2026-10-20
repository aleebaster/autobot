// ═══════════════════════════════════════════════════════════════════════════
//  CLOSE SAFETY GUARDS — offline/mock proof suite (READ-ONLY, NO LIVE TX)
//
//  Verifies closePositionFn refuses to send when:
//    G1  the preview deteriorated past the slippage threshold (fresh preview
//        < amountOutMin = reference − slippageBps)  → CLOSE_SLIPPAGE_REFUSED
//        (refusal happens BEFORE signing — wallet.sendTransaction never runs)
//    G2  the manager address has no code (stale/wrong --manager)
//    G3  the chain / deployment identity changed (RPC chainId, config drift,
//        unreadable network)                          → CLOSE_CHAIN_ID_MISMATCH
//    G4  the position is closed / unknown             → zombie / NOT_FOUND
//    G5  the position is owned by another wallet      → NOT_OURS (runSingleAction)
//  and that the happy path encodes the preview-derived amountOutMin into the
//  verified ABI arg[1] of closePosition(uint256,uint256,uint256) @ 0xb35648d7.
//
//  Everything runs on in-memory mock provider/wallet objects — no RPC, no keys.
//
//  node test_close_safety_guards.mjs
// ═══════════════════════════════════════════════════════════════════════════
import { TEST_STATE_FILE, realStateHash } from "./_test_state_isolation.mjs";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { ethers } from "ethers";

// HARD TX BLOCK
const _origSend = ethers.JsonRpcProvider.prototype.send;
ethers.JsonRpcProvider.prototype.send = function (method, params) {
  if (method === "eth_sendRawTransaction" || method === "eth_sendTransaction") {
    return Promise.reject(new Error(`TX_BLOCKED: ${method} is forbidden in this test`));
  }
  return _origSend.call(this, method, params);
};

const REPO = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(REPO, "auto-trader-state.json");
const JOURNAL_FILE = path.join(REPO, "tx-journal.jsonl");
const CONFIG_FILE = path.join(REPO, "config.json");
const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const STATE_HASH_BEFORE = sha(STATE_FILE);
const JOURNAL_HASH_BEFORE = fs.existsSync(JOURNAL_FILE) ? sha(JOURNAL_FILE) : "(missing)";
const CONFIG_HASH_BEFORE = sha(CONFIG_FILE);

const { AutoTrader, closePositionFn } = await import("./autoTrader.js");

const PASS = [], FAIL = [];
let total = 0;
function check(name, ok, detail = "") {
  total++;
  if (ok) PASS.push(name); else FAIL.push(`${name} :: ${detail}`);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

// ─── ABIs (verified selectors, never hand-rolled) ───────────────────────────
const previewIface = new ethers.Interface([
  "function previewClosePosition(uint256,uint256) view returns (tuple(uint256 repayAmount, uint256 collateralReduced, uint256 collateralReturned, uint256 protocolFee, uint256 costBasisReduced, int256 realizedPnl, uint256 closePrice, uint256 projectedHealthBps))",
]);
const posIface = new ethers.Interface([
  "function positions(uint256) view returns (bool isLong, address user, address collateralToken, uint256 collateralAmount, uint256 debtAmount, uint256 borrowIndex, bool active)",
]);
const closeIface = new ethers.Interface(["function closePosition(uint256 positionId, uint256 amountOutMin, uint256 deadline)"]);
const PREVIEW_SEL = previewIface.getFunction("previewClosePosition").selector.toLowerCase();
const POS_SEL = posIface.getFunction("positions").selector.toLowerCase();
const CLOSE_SEL = closeIface.getFunction("closePosition").selector.toLowerCase();

const DUMMY_PK = "0x" + "11".repeat(32);
const WALLET_ADDR = new ethers.Wallet(DUMMY_PK).address;
const MGR = "0x186eA8d6c4CBbcEd1466338B1Ed41C7EF331f480";
const USDT = "0x3A1fF83BFD63E5e2564aEc95ade244234773049f";
const DEAD_ADDR = "0x000000000000000000000000000000000000dEaD";

const previewOk = (collReturned) => ({
  data: previewIface.encodeFunctionResult("previewClosePosition",
    [[1000n, 900n, collReturned, 1n, 100n, 5n, 8120n, 11900n]]),
});

const SLIPPAGE_BPS = 50n;
const REF_OUT = 1_000_000n;                     // reference preview collateralReturned
const MIN_OUT = (REF_OUT * (10000n - SLIPPAGE_BPS)) / 10000n; // 995000 — minimum acceptable

// ─── Mock provider / wallet / txManager (fully in-memory) ───────────────────
function makeMockProvider({ chainId = 11155111n, managerCode = "0x6080", previewResponses = [], closeRevert = null, positionActive = false } = {}) {
  let previewReads = 0, closeCalls = 0, posReads = 0;
  const p = {
    previewReads: () => previewReads, closeCalls: () => closeCalls, posReads: () => posReads,
    async getNetwork() {
      if (chainId === "THROW") throw Object.assign(new Error("could not detect network"), { shortMessage: "network unreadable" });
      return { chainId };
    },
    async getCode() { return managerCode; },
    async call({ data }) {
      const sel = String(data).slice(0, 10).toLowerCase();
      if (sel === PREVIEW_SEL) {
        const r = previewResponses[previewReads] ?? previewResponses[previewResponses.length - 1];
        previewReads++;
        if (!r) throw Object.assign(new Error("execution reverted (no preview response queued)"), { data: "0xdeadbeef" });
        if (r.revert) throw Object.assign(new Error(`execution reverted with custom error ${r.revert}`), { data: r.revert });
        return r.data;
      }
      if (sel === CLOSE_SEL) {
        closeCalls++;
        if (closeRevert) throw Object.assign(new Error(`execution reverted with custom error ${closeRevert}`), { data: closeRevert });
        return "0x";
      }
      if (sel === POS_SEL) {
        posReads++;
        return posIface.encodeFunctionResult("positions", [
          positionActive, WALLET_ADDR, USDT, 1000n, 500n, 10n ** 18n, positionActive,
        ]);
      }
      throw new Error(`unexpected eth_call selector ${sel}`);
    },
    async estimateGas() { return 1933297n; },
  };
  return p;
}

function makeWallet(sent) {
  return {
    address: WALLET_ADDR,
    async sendTransaction(tx) {
      sent.push(tx);
      return { hash: "0x" + "ab".repeat(32), wait: async () => ({ status: 1, gasUsed: 1933297n, blockNumber: 123n, logs: [] }) };
    },
  };
}
const makeTxManager = () => ({
  async sendAndWait({ sendFn }) {
    const tx = await sendFn(178533n);           // mock nonce — nothing is broadcast
    const receipt = await tx.wait();
    return { status: receipt.status, receipt, hash: tx.hash };
  },
});

const baseConfig = () => ({ deadlineSeconds: 1200, slippageBps: 50, chainId: "" });

async function runClose(provider, { sent = [], config = baseConfig(), positionId = 101n, managerAddr = MGR } = {}) {
  const logs = [];
  const wallet = makeWallet(sent);
  const res = await closePositionFn({
    wallet, provider, managerAddr, positionId, config,
    log: (m) => logs.push(String(m)), dryRun: false, txManager: makeTxManager(),
  });
  return { res, logs, sent };
}

// ═══ G1 — slippage guard refuses BEFORE signing ═════════════════════════════
console.log("\n== G1 — preview deterioration → refuse without signing ==");
{
  // fresh = MIN_OUT − 1 → worse than the allowed threshold
  const sent = [];
  const p = makeMockProvider({ previewResponses: [previewOk(REF_OUT), previewOk(MIN_OUT - 1n)] });
  const { res, logs } = await runClose(p, { sent });
  check("fresh preview below amountOutMin → CLOSE_SLIPPAGE_REFUSED",
    res?.failed === true && res.code === "CLOSE_SLIPPAGE_REFUSED", `code=${res?.code}`);
  check("state kept (clearState:false)", res?.clearState === false, `clearState=${res?.clearState}`);
  check("wallet.sendTransaction NEVER ran (refused before signing)",
    sent.length === 0 && p.posReads() === 0, `sends=${sent.length} preflightEthCall=${p.closeCalls()} (read-only OK)`);
  check("refusal log explains ref/fresh/min", logs.some((l) => l.includes("refusing WITHOUT signing")), logs[logs.length - 1]?.slice(0, 90));

  // fresh preview REVERTS right before signing → also refused, never sent
  const sent2 = [];
  const p2 = makeMockProvider({ previewResponses: [previewOk(REF_OUT), { revert: "0xf71ff020" }] });
  const { res: r2 } = await runClose(p2, { sent: sent2 });
  check("fresh preview revert → CLOSE_SLIPPAGE_FRESH_0xf71ff020, no send",
    r2?.failed === true && r2.code === "CLOSE_SLIPPAGE_FRESH_0xf71ff020" && sent2.length === 0,
    `code=${r2?.code} sends=${sent2.length}`);
}

// ═══ G1+ — happy path: exact preview-derived amountOutMin in verified ABI arg[1] ═══
console.log("\n== G1+ — happy path: amountOutMin = preview × (1 − slippage) ==");
{
  const sent = [];
  const p = makeMockProvider({ previewResponses: [previewOk(REF_OUT), previewOk(MIN_OUT)] }); // fresh == min (boundary: allowed)
  const { res } = await runClose(p, { sent });
  check("fresh == amountOutMin boundary → proceeds to (mock) send",
    sent.length === 1 && res?.ok === true && res.closed === true && res.verified === true,
    `sends=${sent.length} ok=${res?.ok} closed=${res?.closed}`);
  if (sent.length === 1) {
    const data = sent[0].data;
    check("selector is verified closePosition(uint256,uint256,uint256) = 0xb35648d7",
      data.slice(0, 10).toLowerCase() === CLOSE_SEL, data.slice(0, 10));
    const parsed = closeIface.parseTransaction({ data });
    check("arg[0] positionId = 101", parsed.args[0] === 101n, String(parsed.args[0]));
    check("arg[1] amountOutMin == preview×(10000−50)/10000 exactly (not 0)",
      parsed.args[1] === MIN_OUT && parsed.args[1] > 0n, `got=${parsed.args[1]} want=${MIN_OUT}`);
    check("arg[1] strictly below reference output (real floor, not loose)",
      parsed.args[1] < REF_OUT, `${parsed.args[1]} < ${REF_OUT}`);
    const dl = Number(parsed.args[2]);
    const now = Math.floor(Date.now() / 1000);
    check("arg[2] deadline = now + deadlineSeconds(1200)", dl >= now + 1150 && dl <= now + 1250, String(dl - now));
    check("sent to the injected manager only", String(sent[0].to).toLowerCase() === MGR.toLowerCase(), String(sent[0].to));
    check("post-close verification read positions() (active=false proof)", p.posReads() >= 1, `posReads=${p.posReads()}`);
  }

  // amountOutMin derived from config.slippageBps (established threshold)
  const sentB = [];
  const pB = makeMockProvider({ previewResponses: [previewOk(REF_OUT), previewOk(REF_OUT)] });
  const { res: rB } = await runClose(pB, { sent: sentB, config: { ...baseConfig(), slippageBps: 200 } });
  if (sentB.length === 1) {
    const want200 = (REF_OUT * 9800n) / 10000n;
    check("threshold follows config.slippageBps (200 bps → ×9800/10000)",
      closeIface.parseTransaction({ data: sentB[0].data }).args[1] === want200, `want=${want200}`);
  } else {
    check("threshold follows config.slippageBps (200 bps → ×9800/10000)", false, `sends=${sentB.length} rB=${rB?.code}`);
  }
}

// ═══ G2 — manager without code (stale/wrong --manager) ══════════════════════
console.log("\n== G2 — manager with no code on this chain ==");
{
  const sent = [];
  const p = makeMockProvider({ managerCode: "0x", previewResponses: [previewOk(REF_OUT)] });
  const { res } = await runClose(p, { sent });
  check("no code at manager → CLOSE_MANAGER_NO_CODE, no send",
    res?.failed === true && res.code === "CLOSE_MANAGER_NO_CODE" && sent.length === 0,
    `code=${res?.code} sends=${sent.length}`);
  check("no view/price calls made before the code guard", p.previewReads() === 0, `previewReads=${p.previewReads()}`);
}

// ═══ G3 — chain / deployment identity changes ═══════════════════════════════
console.log("\n== G3 — deployment / chain identity ==");
{
  const sent = [];
  const p = makeMockProvider({ chainId: 1n, previewResponses: [previewOk(REF_OUT)] });
  const { res } = await runClose(p, { sent });
  check("RPC chainId 1 != deployment 11155111 → CLOSE_CHAIN_ID_MISMATCH, no send",
    res?.failed === true && res.code === "CLOSE_CHAIN_ID_MISMATCH" && sent.length === 0,
    `code=${res?.code} sends=${sent.length}`);

  const sentC = [];
  const pC = makeMockProvider({ chainId: 11155111n, previewResponses: [previewOk(REF_OUT)] });
  const { res: rC } = await runClose(pC, { sent: sentC, config: { ...baseConfig(), chainId: 147 } });
  check("config.chainId 147 != deployment 11155111 (config drift) → refused, no send",
    rC?.failed === true && rC.code === "CLOSE_CHAIN_ID_MISMATCH" && sentC.length === 0,
    `code=${rC?.code} sends=${sentC.length}`);

  const sentD = [];
  const pD = makeMockProvider({ chainId: "THROW", previewResponses: [previewOk(REF_OUT)] });
  const { res: rD } = await runClose(pD, { sent: sentD });
  check("RPC network unreadable → refused, no send",
    rD?.failed === true && rD.code === "CLOSE_CHAIN_ID_MISMATCH" && sentD.length === 0,
    `code=${rD?.code} sends=${sentD.length}`);
}

// ═══ G4 — closed / zombie position ══════════════════════════════════════════
console.log("\n== G4 — zombie (pre-flight MAM_InvalidPosition) ==");
{
  const sent = [];
  const p = makeMockProvider({ previewResponses: [previewOk(REF_OUT)], closeRevert: "0xa5732d32" });
  const { res } = await runClose(p, { sent });
  check("pre-flight MAM_InvalidPosition → zombie clear (existing contract)",
    res?.failed === true && res.clearState === true && res.reason === "zombie" && sent.length === 0,
    `clearState=${res?.clearState} reason=${res?.reason} sends=${sent.length}`);
  check("zombie never reached signing", sent.length === 0 && p.posReads() === 0, `posReads=${p.posReads()}`);
}

// ═══ G5 — runSingleAction level guards (owner / closed) ═════════════════════
console.log("\n== G5 — runSingleAction: wrong owner & already closed ==");
const makeTrader = () => {
  const t = new AutoTrader({
    accounts: [{ address: WALLET_ADDR, privateKey: DUMMY_PK }],
    selectedWalletIndex: 0,
    proxies: [],
    rpcUrl: "http://127.0.0.1:9",
    chainId: 11155111,
    config: { dryRun: false, maxLeverage: 5, leverageMax: 10, deadlineSeconds: 1200, slippageBps: 50 },
    confirmedPools: {},
    getProvider: () => ({ call: async () => { throw new Error("no chain in this test"); }, getNetwork: async () => ({ chainId: 11155111n }), getCode: async () => "0x6080" }),
    log: () => {},
  });
  t.state.activePositions = [];
  return t;
};
{
  const t = makeTrader();
  let closeCalls = 0;
  t._closePositionImpl = async () => { closeCalls++; return { ok: true, closed: true }; };
  t.describePosition = async () => ({
    ok: true, found: true, active: true, positionId: "101", managerAddr: MGR,
    ours: false, user: DEAD_ADDR, side: "SHORT", isLong: false,
    collateralAmount: "1", currentDebt: "1", closeFull: null, status: "ACTIVE",
  });
  const r = await t.runSingleAction({ action: "close", positionId: 101, manager: MGR, confirm: false });
  check("foreign owner on --manager → NOT_OURS (never reaches closePositionFn)",
    r.code === "NOT_OURS" && closeCalls === 0, `code=${r.code} closeCalls=${closeCalls}`);

  const t2 = makeTrader();
  let closeCalls2 = 0;
  t2._closePositionImpl = async () => { closeCalls2++; return { ok: true }; };
  t2.describePosition = async () => ({
    ok: true, found: true, active: false, positionId: "101", managerAddr: MGR,
    ours: true, user: WALLET_ADDR, side: "SHORT", isLong: false,
    collateralAmount: "0", currentDebt: "0", closeFull: null, status: "CLOSED",
  });
  const r2 = await t2.runSingleAction({ action: "close", positionId: 101, manager: MGR, confirm: false });
  check("already-closed position → ALREADY_CLOSED, no send",
    r2.code === "ALREADY_CLOSED" && r2.ok === true && closeCalls2 === 0,
    `code=${r2.code} closeCalls=${closeCalls2}`);

  const t3 = makeTrader();
  let closeCalls3 = 0;
  t3._closePositionImpl = async () => { closeCalls3++; return { ok: true }; };
  t3.describePosition = async () => ({
    ok: true, found: false, active: false, positionId: "101", managerAddr: MGR,
    status: "NOT_FOUND", reason: "MAM_InvalidPosition",
  });
  const r3 = await t3.runSingleAction({ action: "close", positionId: 101, manager: MGR, confirm: false });
  check("NOT_FOUND on manager → blocked, no send",
    r3.code === "NOT_FOUND" && closeCalls3 === 0, `code=${r3.code} closeCalls=${closeCalls3}`);

  // our own active position still reaches the (mocked) close path — guards
  // must not block the legitimate case.
  const t4 = makeTrader();
  let closeCalls4 = 0;
  t4._closePositionImpl = async () => { closeCalls4++; return { ok: true, closed: true }; };
  t4.describePosition = async () => ({
    ok: true, found: true, active: true, positionId: "101", managerAddr: MGR,
    ours: true, user: WALLET_ADDR, side: "SHORT", isLong: false,
    collateralAmount: "1", currentDebt: "1",
    closeFull: { closeBps: 10000, collateralReturned: "1000000", repayAmount: "4060000", realizedPnl: "-300000", realizedPnlHuman: "-0.3", closePrice: "8120", projectedHealthBps: 0 },
    status: "ACTIVE",
  });
  const r4 = await t4.runSingleAction({ action: "close", positionId: 101, manager: MGR, confirm: false });
  check("our own active position still reaches the close path (DRY plan)",
    r4.code === "DRY" && r4.ok === true && closeCalls4 === 0, `code=${r4.code} closeCalls=${closeCalls4}`);
}

// ═══ Static source assertions ═══════════════════════════════════════════════
console.log("\n== static source assertions ==");
{
  const src = fs.readFileSync(path.join(REPO, "autoTrader.js"), "utf8");
  check("old positional 0n encoding is GONE",
    !src.includes('coder.encode(["uint256", "uint256", "uint256"], [positionId, 0n, BigInt(deadline)])'));
  check("new preview-derived encoding present",
    src.includes('coder.encode(["uint256", "uint256", "uint256"], [positionId, amountOutMin, BigInt(deadline)])'));
  check("slippage refusal code present", src.includes('code: "CLOSE_SLIPPAGE_REFUSED"'));
  check("chain guard code present", src.includes('code: "CLOSE_CHAIN_ID_MISMATCH"'));
  check("manager code guard present", src.includes('code: "CLOSE_MANAGER_NO_CODE"'));
  check("owner guard (NOT_OURS) present", src.includes('code: "NOT_OURS"'));
  // slice the closePositionFn body only (end markers: next top-level fn or the class)
  const cfStart = src.indexOf("async function closePositionFn(");
  const markers = [
    src.indexOf("\nasync function ", cfStart + 10),
    src.indexOf("\nfunction ", cfStart + 10),
    src.indexOf("export class AutoTrader", cfStart + 10),
    cfStart + 20000,
  ].filter((x) => x > 0);
  const cfEnd = markers.length ? Math.min(...markers) : -1;
  const cf = cfStart >= 0 && cfEnd > 0 ? src.slice(cfStart, cfEnd) : "";
  check("closePositionFn found for ordering check", cf.length > 1000, `len=${cf.length}`);
  check("fresh preview runs AFTER gas estimation, BEFORE send (inside closePositionFn)",
    cf.indexOf("const fresh = await previewCloseAt") > cf.indexOf("provider.estimateGas({ from: walletAddr, to: managerAddr, data: calldata")
    && cf.indexOf("const fresh = await previewCloseAt") < cf.indexOf("wallet.sendTransaction({ to: managerAddr, data: calldata"));
}

// ═══ Purity — repo state/journal/config untouched ═══════════════════════════
console.log("\n== purity: repo state/journal/config untouched ==");
check("auto-trader-state.json unchanged", sha(STATE_FILE) === STATE_HASH_BEFORE);
check("tx-journal.jsonl unchanged", sha(JOURNAL_FILE) === JOURNAL_HASH_BEFORE);
check("config.json unchanged", sha(CONFIG_FILE) === CONFIG_HASH_BEFORE);
check("real state hash helper agrees", realStateHash() === STATE_HASH_BEFORE);

console.log(`\nRESULT: ${PASS.length}/${total} passed, ${FAIL.length} failed`);
if (FAIL.length) { console.log("FAILURES:"); FAIL.forEach((f) => console.log(`  - ${f}`)); }
process.exit(FAIL.length ? 1 : 0);
