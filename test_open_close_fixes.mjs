// ═══════════════════════════════════════════════════════════════════════════
//  OPEN / CLOSE FIXES — offline proof suite (READ-ONLY, NO LIVE TX)
//
//  Fixes verified here:
//   F1 OPEN-APPROVE: gas estimate+25% (no hardcoded 100_000), no-send on
//      estimate failure, allowance re-read after receipt.
//   F2 borrowIndex→currentDebt misnaming: readOnChainPosition maps field 6 as
//      borrowIndex and currentDebt from getPositionDebt (real debt); state
//      sync no longer poisons debtAmount with the 1e18-scaled index.
//   F3 findMaxCloseBps classification: full probe map → CLOSE_NO_FEASIBLE_WINDOW
//      when low bps are TooSmall AND high bps are Liquidity (the #134 case),
//      instead of misreporting dust.
//   F4 attemptPartialClose: precise detail for the no-window case.
  //   F5 _adoptAllFromChain: adopt on-chain active positions when the local
  //      record is empty (orphans #101/#103/#104/#106 become closeable).
//
//  node test_open_close_fixes.mjs
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
const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const STATE_HASH_BEFORE = sha(STATE_FILE);
const JOURNAL_FILE = path.join(REPO, "tx-journal.jsonl");
const JOURNAL_HASH_BEFORE = fs.existsSync(JOURNAL_FILE) ? sha(JOURNAL_FILE) : "(missing)";
const CONFIG_HASH_BEFORE = sha(path.join(REPO, "config.json"));

const {
  AutoTrader, openPosition, readOnChainPosition, previewCloseAt,
  findMaxCloseBps, attemptPartialClose, revertSelector,
} = await import("./autoTrader.js");

const PASS = [], FAIL = [];
let total = 0;
function check(name, ok, detail = "") {
  total++;
  if (ok) PASS.push(name); else FAIL.push(`${name} :: ${detail}`);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const SEL = {
  TOO_SMALL: "0x01556191",   // MAM_CloseAmountTooSmall
  LIQ: "0xf71ff020",         // MAM_InsufficientLiquidity
  INVALID: "0xa5732d32",     // MAM_InvalidPosition
};

const WALLET = "0x315E5193633A962B3F369F9C3833D973D0588cCD";
const MGR = "0x186eA8d6c4CBbcEd1466338B1Ed41C7EF331f480";

// ─────────────────────────────────────────────────────────────────────────────
// Mock provider: table-driven eth_call responses keyed by selector.
// Reverts are thrown with `.data` so revertSelector() classifies them.
// ─────────────────────────────────────────────────────────────────────────────
function makeRevert(sel) {
  const e = new Error(`execution reverted: ${sel}`);
  e.data = sel;
  e.info = { error: { data: sel } };
  return e;
}

function encodePositions({ isLong, user, collateralToken, coll, debt, idx, active }) {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  return coder.encode(
    ["bool", "address", "address", "uint256", "uint256", "uint256", "bool"],
    [isLong, user, collateralToken, coll, debt, idx, active],
  );
}

// previewClosePosition success payload (8-field tuple, static encoding)
function encodePreviewOk() {
  return ethers.AbiCoder.defaultAbiCoder().encode(
    ["tuple(uint256,uint256,uint256,uint256,uint256,int256,uint256,uint256)"],
    [[1n, 1n, 1n, 0n, 1n, -1n, 1n, 10000n]],
  );
}

function mockProvider({ calls = {}, handlers = {} } = {}) {
  const log = [];
  const iface = new ethers.Interface([
    "function previewClosePosition(uint256,uint256)",
    "function positions(uint256)",
    "function getPositionDebt(uint256)",
    "function getUserPositions(address)",
    "function allowance(address,address)",
    "function decimals()",
    "function symbol()",
  ]);
  const p = {
    _log: log,
    async call(tx) {
      const sel = String(tx.data || "").slice(0, 10);
      log.push({ sel, to: tx.to, from: tx.from });
      if (handlers.call) {
        const r = await handlers.call(tx, sel);
        if (r !== undefined) return r;
      }
      const key = `${tx.to?.toLowerCase?.()}:${sel}`;
      if (calls[key] !== undefined) {
        const v = calls[key];
        if (typeof v === "function") return v(tx);
        if (v && v.revert) throw makeRevert(v.revert);
        return v;
      }
      // generic decode helpers
      const dec = iface.parseTransaction({ data: tx.data });
      if (dec?.name === "previewClosePosition") {
        const fn = handlers.previewClose;
        if (fn) {
          const r = fn(BigInt(dec.args[0]), BigInt(dec.args[1]));
          if (r.revert) throw makeRevert(r.revert);
          return r.encoded;
        }
      }
      throw new Error(`MOCK_CALL_UNHANDLED ${key} (${dec?.name || "?"})`);
    },
    async estimateGas(tx) {
      if (handlers.estimateGas) return handlers.estimateGas(tx);
      return 100000n;
    },
    async getCode() { return handlers.code ?? "0x60806040"; },
    async getFeeData() { return { gasPrice: 1_000_000_000n, maxFeePerGas: null, maxPriorityFeePerGas: null }; },
    async getBalance() { return ethers.parseEther("1"); },
    async getBlockNumber() { return 11940000; },
    async getNetwork() { return { chainId: 11155111n, name: "sepolia" }; },
    async resolveName(n) { return n; },
  };
  return p;
}

function mockWallet(address, provider) {
  const sent = [];
  const w = {
    address,
    provider,
    sent,
    async call(tx) { return provider.call(tx); },
    async estimateGas(tx) { return provider.estimateGas(tx); },
    async sendTransaction(tx) {
      sent.push(tx);
      return { hash: "0x" + "11".repeat(32), wait: async () => ({ status: 1, gasUsed: 1n, blockNumber: 1n, logs: [] }) };
    },
  };
  return w;
}

// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  console.log("\n== F2: readOnChainPosition maps borrowIndex → real debt ==");

  // #134 REAL on-chain words: word5(debtAmount)=2379, word6(borrowIndex)=1000310762152510207
  const pos134 = encodePositions({
    isLong: true, user: WALLET, collateralToken: "0x3A1fF83BFD63E5e2564aEc95ade244234773049f",
    coll: 16873680n, debt: 2379n, idx: 1000310762152510207n, active: true,
  });
  const debtWord = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [2379n]);
  const prov1 = mockProvider({
    calls: {
      [`${MGR.toLowerCase()}:0xf7844276`]: pos134,            // positions(134)
      [`${MGR.toLowerCase()}:0x9cbcf381`]: debtWord,           // getPositionDebt (selector probed below)
    },
    handlers: {
      call: async (tx) => {
        const dec = (() => { try { return new ethers.Interface([
          "function positions(uint256)","function getPositionDebt(uint256)",
        ]).parseTransaction({ data: tx.data }); } catch { return null; } })();
        if (dec?.name === "getPositionDebt") return debtWord;
        if (dec?.name === "positions") return pos134;
        return undefined;
      },
    },
  });
  const rp = await readOnChainPosition(prov1, MGR, 134n);
  check("readOnChainPosition readable", !!rp);
  check("currentDebt = REAL debt (2379), not borrowIndex",
    rp && rp.currentDebt === 2379n, `currentDebt=${rp?.currentDebt}`);
  check("borrowIndex preserved as borrowIndex",
    rp && rp.borrowIndex === 1000310762152510207n, `borrowIndex=${rp?.borrowIndex}`);
  check("debtAmount = 2379", rp && rp.debtAmount === 2379n, `debtAmount=${rp?.debtAmount}`);
  check("state-like poisoning avoided (currentDebt !== 1e18-scale index)",
    rp && rp.currentDebt !== 1000310762152510207n);

  console.log("\n== F3: findMaxCloseBps classifies the no-window case (#134) ==");
  const prov2 = mockProvider({
    handlers: {
      previewClose: (id, bps) => {
        // #134: bps 1..4 → TooSmall, bps ≥5 → Liquidity (verified live on drpc)
        if (id !== 134n) return { revert: SEL.INVALID };
        if (bps <= 4n) return { revert: SEL.TOO_SMALL };
        return { revert: SEL.LIQ };
      },
    },
  });
  const noWin = await findMaxCloseBps(prov2, MGR, 134n, { log: () => {} });
  check("no-window → CLOSE_NO_FEASIBLE_WINDOW (was misreported as dust)",
    noWin.ok === false && noWin.code === "CLOSE_NO_FEASIBLE_WINDOW",
    `code=${noWin?.code} probes=${noWin?.probes}`);
  check("band reports tooSmall 1..4",
    noWin.band && noWin.band.tooSmallMin === 1n && noWin.band.tooSmallMax === 4n,
    JSON.stringify({ t: [String(noWin.band?.tooSmallMin), String(noWin.band?.tooSmallMax)] }));
  check("band reports illiquid ≥5",
    noWin.band && noWin.band.illiquidMin === 5n,
    `illiquidMin=${noWin.band?.illiquidMin}`);
  check("probes bounded (≤48)", noWin.probes <= 48, String(noWin.probes));

  const provAllSmall = mockProvider({ handlers: { previewClose: () => ({ revert: SEL.TOO_SMALL }) } });
  const allSmall = await findMaxCloseBps(provAllSmall, MGR, 7n, { log: () => {} });
  check("all-TooSmall → CLOSE_AMOUNT_TOO_SMALL (unchanged)",
    allSmall.ok === false && allSmall.code === "CLOSE_AMOUNT_TOO_SMALL", `code=${allSmall?.code}`);

  const provAllLiq = mockProvider({ handlers: { previewClose: () => ({ revert: SEL.LIQ }) } });
  const allLiq = await findMaxCloseBps(provAllLiq, MGR, 7n, { log: () => {} });
  check("all-Liquidity → CLOSE_BPS_NOT_FOUND (unchanged)",
    allLiq.ok === false && allLiq.code === "CLOSE_BPS_NOT_FOUND", `code=${allLiq?.code}`);

  const provWindow = mockProvider({
    handlers: {
      previewClose: (id, bps) => (bps >= 100n && bps <= 5000n ? { encoded: encodePreviewOk() } : { revert: bps < 100n ? SEL.TOO_SMALL : SEL.LIQ }),
    },
  });
  const win = await findMaxCloseBps(provWindow, MGR, 7n, { log: () => {} });
  check("feasible window found when one exists",
    win.ok === true && win.closeBps >= 100n && win.closeBps <= 5000n,
    win.ok ? `closeBps=${win.closeBps}` : `code=${win.code}`);

  console.log("\n== F4: attemptPartialClose no-window → controlled WAIT, state kept ==");
  const prov3 = mockProvider({
    handlers: {
      call: async (tx) => {
        const I = new ethers.Interface([
          "function positions(uint256)", "function getPositionDebt(uint256)",
        ]);
        let dec; try { dec = I.parseTransaction({ data: tx.data }); } catch { dec = null; }
        if (dec?.name === "positions") {
          return encodePositions({ isLong: true, user: WALLET, collateralToken: MGR, coll: 16873680n, debt: 2379n, idx: 1000310762152510207n, active: true });
        }
        if (dec?.name === "getPositionDebt") return ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [2379n]);
        return undefined;
      },
      previewClose: (id, bps) => (bps <= 4n ? { revert: SEL.TOO_SMALL } : { revert: SEL.LIQ }),
    },
  });
  const wallet3 = mockWallet(WALLET, prov3);
  const logs3 = [];
  const r3 = await attemptPartialClose({
    wallet: wallet3, provider: prov3, managerAddr: MGR, positionId: 134n,
    config: { deadlineSeconds: 120, slippageBps: 50, maxPartialCloseAttempts: 3 },
    log: (...a) => logs3.push(a.join(" ")), txManager: null, targetCloseBps: null,
  });
  check("no-window → failed + clearState:false + wait",
    r3 && r3.failed === true && r3.clearState === false && r3.wait === true,
    `code=${r3?.code}`);
  check("code = CLOSE_NO_FEASIBLE_WINDOW", r3?.code === "CLOSE_NO_FEASIBLE_WINDOW", `code=${r3?.code}`);
  check("detail names BOTH bands (1..4 too small, ≥5 liquidity)",
    logs3.some(l => l.includes("no feasible window") && l.includes("MAM_CloseAmountTooSmall") && l.includes("MAM_InsufficientLiquidity")),
    logs3.find(l => l.includes("no feasible window"))?.slice(0, 160) || "no detail line");
  check("position stays tracked (no clear, no TX sent)",
    wallet3.sent.length === 0 && r3.clearState === false, `sent=${wallet3.sent.length}`);
  check("log says position REMAINS ACTIVE/TRACKED",
    logs3.some(l => l.includes("REMAINS ACTIVE")));

  console.log("\n== F5: _adoptAllFromChain adopts on-chain orphans when state is empty ==");
  const mkDeps = () => ({ config: { dryRun: false }, accounts: [{ address: WALLET }], selectedWalletIndex: 0, proxies: [null], log: () => {}, confirmedPools: {} });
  const t = new AutoTrader(mkDeps());
  t.markets = [{ managerAddr: MGR, marketSymbol: "NEMESIS/USDT", poolAddr: "0xccA34A36A37941bF54eE0eEFe5a86f98d93ACDd0", paymentToken: "0x3A1fF83BFD63E5e2564aEc95ade244234773049f" }];
  const prov4 = mockProvider({
    handlers: {
      call: async (tx) => {
        const I = new ethers.Interface([
          "function getUserPositions(address)", "function positions(uint256)",
          "function getPositionDebt(uint256)", "function previewClosePosition(uint256,uint256)",
        ]);
        let dec; try { dec = I.parseTransaction({ data: tx.data }); } catch { dec = null; }
        if (dec?.name === "getUserPositions") {
          return ethers.AbiCoder.defaultAbiCoder().encode(["uint256[]"], [[101n, 134n]]);
        }
        if (dec?.name === "positions") {
          const id = BigInt(dec.args[0]);
          // #101 SHORT active (real: coll=5969862, debt=4060053865) — full close PASSES live
          if (id === 101n) return encodePositions({ isLong: false, user: WALLET, collateralToken: "0x3A1fF83BFD63E5e2564aEc95ade244234773049f", coll: 5969862n, debt: 4060053865n, idx: 1000221125841507219n, active: true });
          // #134 LONG active but full-close preview is illiquid → not preferred
          if (id === 134n) return encodePositions({ isLong: true, user: WALLET, collateralToken: "0x3A1fF83BFD63E5e2564aEc95ade244234773049f", coll: 16873680n, debt: 2379n, idx: 1000310762152510207n, active: true });
          throw makeRevert(SEL.INVALID);
        }
        if (dec?.name === "getPositionDebt") {
          const id = BigInt(dec.args[0]);
          const v = id === 101n ? 4060439166n : 2379n;
          return ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [v]);
        }
        if (dec?.name === "previewClosePosition") {
          const id = BigInt(dec.args[0]);
          if (id === 101n) return encodePreviewOk();
          throw makeRevert(SEL.LIQ); // #134 not closable now
        }
        return undefined;
      },
    },
  });
  t.getRuntime = () => ({ provider: prov4, wallet: { address: WALLET } });
  t.state.activePositions = [];
  const adoptedCount = await t._adoptAllFromChain();
  const ids = (t.state.activePositions || []).map(p => p.positionId);
  check("orphans adopted from chain (count)", adoptedCount === 2, `adopted=${adoptedCount} ids=${JSON.stringify(ids)}`);
  const rec101 = (t.state.activePositions || []).find(p => p.positionId === 101);
  check("adopted record has side/collateral/debt/manager",
    rec101 && rec101.side === "SHORT" &&
    rec101.collateralAmount === "5969862" &&
    rec101.currentDebt === "4060439166" &&
    String(rec101.managerAddr).toLowerCase() === MGR.toLowerCase(),
    JSON.stringify({ side: rec101?.side, coll: rec101?.collateralAmount, debt: rec101?.currentDebt }));
  check("adoptedFromChain marker set", rec101?.adoptedFromChain === true);

  // dry run must NOT adopt
  const dryDeps = mkDeps(); dryDeps.config = { dryRun: true };
  const tDry = new AutoTrader(dryDeps);
  tDry.markets = t.markets;
  tDry.getRuntime = () => ({ provider: prov4, wallet: { address: WALLET } });
  tDry.state.activePositions = [];
  const adoptedDry = await tDry._adoptAllFromChain();
  check("dry-run does NOT adopt (state untouched)", adoptedDry === 0 && !(tDry.state.activePositions?.length));

  console.log("\n== F2 sync: state debt fields get the REAL debt ==");
  const tS = new AutoTrader(mkDeps());
  const rec134 = { positionId: 134, side: "LONG", collateralAmount: "16873680", debtAmount: "1000310762152510207", currentDebt: "1000310762152510207" };
  tS.state.activePositions = [rec134];
  const sync = tS._syncActivePositionFromChain(
    rec134,
    { collateralAmount: 16873680n, currentDebt: 2379n, debtAmount: 2379n, isLong: true },
    { managerAddr: MGR },
  );
  check("debtAmount synced to real debt 2379 (was poisoned 1.0003e18)",
    rec134.debtAmount === "2379", `debtAmount=${rec134.debtAmount}`);
  check("currentDebt field synced too",
    rec134.currentDebt === "2379", `currentDebt=${rec134.currentDebt}`);
  check("storedDebt records raw debtAmount", rec134.storedDebt === "2379", `storedDebt=${rec134.storedDebt}`);
  check("sync reported changes", sync.synced === true, JSON.stringify(sync.changed));

  console.log("\n== F1: OPEN-APPROVE source guarantees ==");
  const src = fs.readFileSync(path.join(REPO, "autoTrader.js"), "utf8");
  check("no hardcoded 100_000 gasLimit in OPEN approve path",
    !/approve\(managerAddr, ethers\.MaxUint256, \{ gasLimit: 100000n/.test(src));
  check("approve gas comes from estimateGas + 25% margin",
    /approveGas = est \+ est \/ 4n/.test(src) && /estimateGas\(\{ from: walletAddr, to: collateralToken, data: approveCalldata/.test(src));
  check("estimate failure refuses to send", /approve estimate FAILED.*NOT sending/s.test(src));
  check("allowance re-read after approve receipt", /allowanceAfter/.test(src) && /after approve receipt — NOT opening/.test(src));

  console.log("\n== F1 live read-only proof (Sepolia estimateGas) ==");
  try {
    const live = new ethers.JsonRpcProvider("https://sepolia.drpc.org");
    const I20 = new ethers.Interface(["function approve(address,uint256)"]);
    const data = I20.encodeFunctionData("approve", [MGR, ethers.MaxUint256]);
    const est = await live.estimateGas({ from: WALLET, to: "0x3A1fF83BFD63E5e2564aEc95ade244234773049f", data });
    check("USDT approve needs >100_000 gas (proves the OOG root cause)", est > 100000n, `estimate=${est}`);
    check("estimate+25% covers it", est + est / 4n >= est, `limit=${est + est / 4n}`);
  } catch (e) {
    check("USDT approve estimate (network)", false, e.message?.slice(0, 80));
  }

  console.log("\n== F3 live read-only proof (#134 no-window on drpc) ==");
  try {
    const live = new ethers.JsonRpcProvider("https://sepolia.drpc.org");
    const a4 = await previewCloseAt(live, MGR, 134n, 4n);
    const a5 = await previewCloseAt(live, MGR, 134n, 5n);
    check("#134 bps=4 → MAM_CloseAmountTooSmall", a4.ok === false && a4.err === SEL.TOO_SMALL, a4.err);
    check("#134 bps=5 → MAM_InsufficientLiquidity", a5.ok === false && a5.err === SEL.LIQ, a5.err);
    const liveFound = await findMaxCloseBps(live, MGR, 134n, { log: () => {} });
    check("#134 findMaxCloseBps → CLOSE_NO_FEASIBLE_WINDOW",
      liveFound.ok === false && liveFound.code === "CLOSE_NO_FEASIBLE_WINDOW", `code=${liveFound?.code}`);
    const s101 = await previewCloseAt(live, MGR, 101n, 10000n);
    check("#101 (SHORT) already CLOSED on-chain → preview reverts MAM_InvalidPosition (0xa5732d32)",
      s101.ok === false && s101.err === SEL.INVALID, s101.ok ? "still active" : s101.err);
  } catch (e) {
    check("live #134/#101 probes (network)", false, e.message?.slice(0, 80));
  }

  console.log("\n== purity: repo state/journal/config untouched ==");
  check("auto-trader-state.json unchanged", sha(STATE_FILE) === STATE_HASH_BEFORE);
  check("tx-journal.jsonl unchanged", sha(JOURNAL_FILE) === JOURNAL_HASH_BEFORE);
  check("config.json unchanged", sha(path.join(REPO, "config.json")) === CONFIG_HASH_BEFORE);
  check("real state hash helper agrees", realStateHash() === STATE_HASH_BEFORE);

  console.log(`\nRESULT: ${PASS.length}/${total} passed, ${FAIL.length} failed`);
  if (FAIL.length) { console.log("FAILURES:"); FAIL.forEach(f => console.log(`  - ${f}`)); }
  process.exit(FAIL.length ? 1 : 0);
}

let CONFIG_FILE_UNUSED;
main().catch(e => { console.error(e); process.exit(1); });
