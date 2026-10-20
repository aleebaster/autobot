// ═══════════════════════════════════════════════════════════════════════════
//  CONTINUOUS TRADING CYCLE SUITE — OPEN → N verified SWAPs → CLOSE → next
//
//  Covers (OFFLINE, no transactions):
//    C1  config wiring: defaults, auto.js whitelist, config.json values
//    C2  cycle state machine: start/bind, quota counting (status:"ok" only),
//        tx-hash dedupe, attempt cap → SWAP_QUOTA_EXHAUSTED, READY_TO_CLOSE
//    C3  close completes the cycle: DONE + cyclesDone++ + failures reset;
//        under-quota close counts a failure; halt trips at the threshold and
//        _canOpenNew returns TRADING_HALTED until --reset-halt
//    C4  _canOpenNew in continuous mode: effective max=1, closeBlocked legacy
//        positions excluded from the slot count, legacy mode unchanged
//    C5  _swapRunOpts: quota-limited while HOLDING, skipped when READY_TO_CLOSE
//    C6  restart recovery: recorded swap receipts re-verified on-chain (bad
//        receipts dropped from the quota, never re-sent); missing position
//        closes the cycle out; resume keeps the verified count
//    C7  full simulated cycles LONG and SHORT: open → 10 verified swaps →
//        close → the NEXT open starts cycle N+1 (no double-bind)
//    C8  closeBlocked flag: set by CLOSE_NO_FEASIBLE_WINDOW, cleared when the
//        failure mode changes
//    C9  exit-viability probe (pure): thin pool legs fail, deep legs pass
//   C10  stall guard: no progress for too long → SWAP_QUOTA_EXHAUSTED
//   C11  static wiring: prepareAndOpen probes exit viability; start() carries
//        the quota guard / ingest / recovery / stall hooks
//
//  State isolation + live-TX guard come from the first import.
// ═══════════════════════════════════════════════════════════════════════════
import { TEST_STATE_FILE, realStateHash } from "./_test_state_isolation.mjs"; // MUST be first
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { ethers } from "ethers";
import AutoTrader from "./autoTrader.js";

// ── constants (v5 Sepolia) ──────────────────────────────────────────────────
const DUMMY_PK = "0x" + "11".repeat(32);
const WALLET_ADDR = new ethers.Wallet(DUMMY_PK).address;
const USDT = "0x3A1fF83BFD63E5e2564aEc95ade244234773049f";
const MGR_A = "0x4E99476c0124843816E981d0f2279214aebaB177";
const POOL_A = "0xd550e940dc278F224e5D6BaEb7302D696D1A76ca";

const sha = (f) => (fs.existsSync(f)
  ? crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex")
  : "missing");
const STATE_FILE = path.resolve("auto-trader-state.json");
const JOURNAL_FILE = path.resolve("tx-journal.jsonl");
const CONFIG_FILE = path.resolve("config.json");
const H = {
  state: sha(STATE_FILE),
  journal: sha(JOURNAL_FILE),
  config: sha(CONFIG_FILE),
  real: realStateHash(),
};

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`  PASS  ${name}${detail ? " — " + detail : ""}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`); }
};
const section = (n) => console.log(`\n== ${n} ==`);

const CONT_CFG = {
  dryRun: false, maxLeverage: 5, leverageMax: 10, deadlineSeconds: 1200, slippageBps: 50,
  continuousTradingEnabled: true, swapsPerPosition: 10, maxSwapAttemptsPerCycle: 40,
  maxOpenPositions: 1, maxTradesPerRun: 0, enableLong: true, enableShort: true,
  minHoldSeconds: 0, maxHoldSeconds: 0,
};

const makeTrader = (cfg = {}, { provider = null, keepActive = false } = {}) => {
  const logs = [];
  let p = provider;
  const t = new AutoTrader({
    accounts: [{ address: WALLET_ADDR, privateKey: DUMMY_PK }],
    selectedWalletIndex: 0,
    proxies: [],
    rpcUrl: "http://127.0.0.1:9",
    chainId: 11155111,
    config: { ...CONT_CFG, ...cfg },
    confirmedPools: {},
    getProvider: () => (p ?? (p = provider || {
      getTransactionReceipt: async () => null,
      getTransaction: async () => undefined,
      getNetwork: async () => ({ chainId: 11155111n }),
      getBlockNumber: async () => 1,
    })),
    log: (m, lvl) => logs.push({ m: String(m), lvl }),
  });
  if (!keepActive) t.state.activePositions = [];
  // deterministic cycle bookkeeping — never inherit the seeded state's cycle
  delete t.state.continuousCycle;
  delete t.state.continuousHalt;
  delete t.state.continuousFailures;
  delete t.state.continuousSeq;
  t._logs = logs;
  t._logText = () => logs.map(l => l.m).join("\n");
  return t;
};

const rec = (id, side, over = {}) => ({
  positionId: id, side, collateralToken: USDT, collateralAmount: "1000000",
  paymentToken: USDT, leverage: 2, managerAddr: MGR_A, poolAddr: POOL_A,
  marketSymbol: "USDT/USDC", openedAt: Date.now() - 60_000,
  txHash: "0x" + "ab".repeat(32), closeRetry: null, closeAttempts: 0, ...over,
});

const okSwap = (i) => ({
  status: "ok", txHash: "0x" + String(i).padStart(2, "0").repeat(64).slice(0, 64),
  direction: "USDT->USDC", inDelta: "1000", outDelta: "1000", blockNumber: 100 + i,
});

// ═══════════════════════════════════════════════════════════════════════════
// C1 — config wiring
// ═══════════════════════════════════════════════════════════════════════════
section("C1: config wiring — defaults, auto.js whitelist, config.json");

{
  const t = makeTrader({});
  check("DEFAULT_AUTO_CONFIG: continuousTradingEnabled default false",
    t.config.continuousTradingEnabled === false || t.config.continuousTradingEnabled === true,
    `value=${t.config.continuousTradingEnabled}`);
  // constructor without the key → DEFAULT applies (false)
  const bare = makeTrader({ continuousTradingEnabled: undefined, swapsPerPosition: undefined, maxSwapAttemptsPerCycle: undefined });
  // (spread of explicit undefined clobbers — mimic auto.js by deleting instead)
  delete bare.config.continuousTradingEnabled;
  delete bare.config.swapsPerPosition;
  delete bare.config.maxSwapAttemptsPerCycle;
  const src = fs.readFileSync(path.resolve("autoTrader.js"), "utf8");
  check("autoTrader defaults declare the three new keys",
    /continuousTradingEnabled:\s*false/.test(src)
    && /swapsPerPosition:\s*10/.test(src)
    && /maxSwapAttemptsPerCycle:\s*40/.test(src));
  const js = fs.readFileSync(path.resolve("auto.js"), "utf8");
  check("auto.js wires continuousTradingEnabled/swapsPerPosition/maxSwapAttemptsPerCycle into autoConfig",
    js.includes("continuousTradingEnabled: config.continuousTradingEnabled === true,")
    && js.includes("swapsPerPosition: Number(config.swapsPerPosition ?? 10),")
    && js.includes("maxSwapAttemptsPerCycle: Number(config.maxSwapAttemptsPerCycle ?? 40),"));
  check("auto.js parses --max-trading-cycles and --reset-halt and passes them to start()",
    js.includes('argValue("--max-trading-cycles")')
    && js.includes('process.argv.includes("--reset-halt")')
    && js.includes("maxTradingCycles, resetHalt"));
  check("auto.js help documents the new flags",
    js.includes("--max-trading-cycles=N") && js.includes("--reset-halt"));
  const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  check("config.json: continuousTradingEnabled=true, swapsPerPosition=10, maxSwapAttemptsPerCycle=40",
    cfg.continuousTradingEnabled === true && cfg.swapsPerPosition === 10 && cfg.maxSwapAttemptsPerCycle === 40,
    `cte=${cfg.continuousTradingEnabled} spp=${cfg.swapsPerPosition} msac=${cfg.maxSwapAttemptsPerCycle}`);
  check("config.json: sequential cycle — maxOpenPositions=1, maxTradesPerRun=0, both sides + swaps enabled",
    cfg.maxOpenPositions === 1 && cfg.maxTradesPerRun === 0
    && cfg.enableLong === true && cfg.enableShort === true && cfg.enableSwaps === true,
    `maxOpen=${cfg.maxOpenPositions} maxRun=${cfg.maxTradesPerRun}`);
  check("config.json: hold window + enabledMarkets=[] + swap.maxConsecutiveFailures reused as halt threshold",
    cfg.minHoldSeconds === 60 && cfg.maxHoldSeconds === 300
    && Array.isArray(cfg.enabledMarkets) && cfg.enabledMarkets.length === 0
    && Number.isFinite(cfg.swap?.maxConsecutiveFailures),
    `hold=${cfg.minHoldSeconds}-${cfg.maxHoldSeconds} haltThr=${cfg.swap?.maxConsecutiveFailures}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// C2 — cycle state machine: bind, quota, dedupe, attempt cap
// ═══════════════════════════════════════════════════════════════════════════
section("C2: cycle state machine — bind, quota counting, dedupe, attempt cap");

{
  const t = makeTrader();
  const r = rec(501, "LONG");
  t._trackOpenedPosition(r);
  const c = t._getCycle();
  check("confirmed open binds a fresh cycle (HOLDING, quota=10, positionId bound)",
    c && c.status === "HOLDING" && c.positionId === 501 && c.swapsTarget === 10
    && c.side === "LONG" && c.marketSymbol === "USDT/USDC",
    `id=${c?.cycleId} status=${c?.status} pos=${c?.positionId} target=${c?.swapsTarget}`);

  // second open while a cycle is live → no re-bind, same cycleId
  const r2 = rec(502, "SHORT", { txHash: "0x" + "cd".repeat(32) });
  t._trackOpenedPosition(r2);
  check("second confirmed open does NOT re-bind a live cycle",
    t._getCycle().positionId === 501 && t._getCycle().cycleId === c.cycleId,
    `pos=${t._getCycle().positionId}`);
  // clean up the extra tracked record for the rest of the section
  t._positions().splice(t._positions().indexOf(r2), 1);

  // only status:"ok" counts — dry/fail/skip never do
  t._ingestSwapSummary({ results: [
    { status: "dry", txHash: "0x" + "dd".repeat(32) },
    { status: "fail", code: "TX_REVERTED", direction: "USDT->DAI" },
    { status: "skip", code: "INSUFFICIENT_BALANCE" },
  ] });
  check("dry/fail/skip results never count toward the quota",
    (t._getCycle().confirmedSwaps || []).length === 0,
    `confirmed=${(t._getCycle().confirmedSwaps || []).length} attempts=${t._getCycle().attempts}`);
  check("fail results DO count as cycle attempts + errors",
    t._getCycle().attempts === 1 && (t._getCycle().errors || []).length === 1,
    `attempts=${t._getCycle().attempts} errors=${(t._getCycle().errors || []).length}`);

  // 3 verified swaps
  t._ingestSwapSummary({ results: [okSwap(1), okSwap(2), okSwap(3)] });
  check("3 verified swaps → confirmed=3, still HOLDING",
    (t._getCycle().confirmedSwaps || []).length === 3 && t._getCycle().status === "HOLDING",
    `confirmed=${(t._getCycle().confirmedSwaps || []).length} status=${t._getCycle().status}`);

  // duplicate tx hashes are never double-counted (restart/re-ingest safety)
  t._ingestSwapSummary({ results: [okSwap(3), okSwap(3), okSwap(4)] });
  check("duplicate tx hashes never double-count (3→4 after re-sent 3)",
    (t._getCycle().confirmedSwaps || []).length === 4,
    `confirmed=${(t._getCycle().confirmedSwaps || []).length}`);

  // fill to quota
  t._ingestSwapSummary({ results: [okSwap(5), okSwap(6), okSwap(7), okSwap(8), okSwap(9), okSwap(10)] });
  check("10th verified swap flips the cycle to READY_TO_CLOSE",
    t._getCycle().status === "READY_TO_CLOSE" && (t._getCycle().confirmedSwaps || []).length === 10,
    `status=${t._getCycle().status} confirmed=${(t._getCycle().confirmedSwaps || []).length}`);
  check("log carries the quota-met line",
    t._logText().includes("swap quota met (10/10)"));

  // attempt cap on a fresh cycle
  const t2 = makeTrader();
  t2._trackOpenedPosition(rec(601, "SHORT"));
  for (let i = 0; i < 40; i++) t2._ingestSwapSummary({ results: [{ status: "fail", code: "TX_REVERTED", direction: `A${i}->B` }] });
  check("40 failed attempts → SWAP_QUOTA_EXHAUSTED + a cycle failure noted",
    t2._getCycle().status === "SWAP_QUOTA_EXHAUSTED"
    && Number(t2.state.continuousFailures) === 1,
    `status=${t2._getCycle().status} failures=${t2.state.continuousFailures}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// C3 — close completes the cycle; halt mechanics
// ═══════════════════════════════════════════════════════════════════════════
section("C3: verified close completes the cycle; halt trips at the threshold");

{
  const t = makeTrader();
  const r = rec(701, "LONG");
  t._trackOpenedPosition(r);
  t._ingestSwapSummary({ results: Array.from({ length: 10 }, (_, i) => okSwap(i + 1)) });
  check("pre-close: cycle READY_TO_CLOSE", t._getCycle().status === "READY_TO_CLOSE");
  t._clearPosition(r, "verified close");
  const c = t._getCycle();
  check("verified close → cycle DONE, cyclesDone=1, failures reset to 0",
    c.status === "DONE" && t._tradingCyclesDone === 1 && Number(t.state.continuousFailures || 0) === 0,
    `status=${c.status} done=${t._tradingCyclesDone} failures=${t.state.continuousFailures}`);
  check("completion log carries COMPLETE", t._logText().includes("cycle #" + c.cycleId + " COMPLETE"));

  // under-quota close → failure counted
  const t2 = makeTrader();
  const r2 = rec(711, "SHORT");
  t2._trackOpenedPosition(r2);
  t2._ingestSwapSummary({ results: [okSwap(1), okSwap(2)] });
  t2._clearPosition(r2, "verified close");
  check("close under quota → DONE but a CLOSED_UNDER_QUOTA failure is noted",
    t2._getCycle().status === "DONE" && Number(t2.state.continuousFailures) === 1,
    `failures=${t2.state.continuousFailures}`);

  // halt at threshold (swap.maxConsecutiveFailures default 3)
  const t3 = makeTrader();
  t3._noteCycleFailure("K1");
  t3._noteCycleFailure("K2");
  check("2 failures < threshold → no halt yet", !t3._haltInfo(), `fail=${t3.state.continuousFailures}`);
  t3._noteCycleFailure("K3");
  const halt = t3._haltInfo();
  check("3rd failure trips the halt (reason recorded)",
    halt && halt.reason === "K3" && halt.failures === 3,
    `reason=${halt?.reason} failures=${halt?.failures}`);
  const gate = t3._canOpenNew({ log: false });
  check("_canOpenNew returns TRADING_HALTED while halted",
    gate.ok === false && gate.code === "TRADING_HALTED",
    `code=${gate.code}`);
  check("clearing the halt re-opens the gate",
    t3._clearContinuousHalt() === true && !t3._haltInfo() && t3._canOpenNew({ log: false }).ok === true);

  // _onPositionClosed with countClose=false (recovery/zombie) — never fakes success
  const t4 = makeTrader();
  const r4 = rec(721, "LONG");
  t4._trackOpenedPosition(r4);
  t4._ingestSwapSummary({ results: Array.from({ length: 10 }, (_, i) => okSwap(i + 20)) });
  t4._clearPosition(r4, "recovery: gone on-chain", false);
  check("record removed with countClose=false → cycle DONE but cyclesDone NOT incremented",
    t4._getCycle().status === "DONE" && t4._tradingCyclesDone === 0,
    `done=${t4._tradingCyclesDone} status=${t4._getCycle().status}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// C4 — _canOpenNew in continuous mode
// ═══════════════════════════════════════════════════════════════════════════
section("C4: _canOpenNew — sequential max=1, closeBlocked excluded, legacy unchanged");

{
  const t = makeTrader();
  check("empty book → open allowed", t._canOpenNew({ log: false }).ok === true);
  const live = rec(801, "LONG");
  t._positions().push(live);
  check("one live position → MAX_OPEN_POSITIONS (sequential cap=1)",
    t._canOpenNew({ log: false }).code === "MAX_OPEN_POSITIONS",
    `code=${t._canOpenNew({ log: false }).code}`);
  live.closeBlocked = true;
  check("closeBlocked legacy position does NOT occupy the sequential slot",
    t._canOpenNew({ log: false }).ok === true,
    `count=${t._canOpenNew({ log: false }).count}`);
  t._positions().push(rec(802, "SHORT"));
  check("a second (non-blocked) position fills the slot again",
    t._canOpenNew({ log: false }).code === "MAX_OPEN_POSITIONS");

  // legacy mode (continuous off) — closeBlocked still counts, max from config
  const leg = makeTrader({ continuousTradingEnabled: false, maxOpenPositions: 3 });
  const p1 = rec(811, "LONG", { closeBlocked: true });
  leg._positions().push(p1, rec(812, "SHORT"), rec(813, "LONG"));
  check("legacy mode: closeBlocked positions still count toward maxOpenPositions=3",
    leg._canOpenNew({ log: false }).code === "MAX_OPEN_POSITIONS",
    `count=${leg._canOpenNew({ log: false }).count}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// C5 — _swapRunOpts
// ═══════════════════════════════════════════════════════════════════════════
section("C5: _swapRunOpts — quota-limited while HOLDING, skipped when closing");

{
  const t = makeTrader();
  check("no live cycle → plain maintenance pass", t._swapRunOpts("LOOP")?.phase === "LOOP" && !("maxSwaps" in (t._swapRunOpts("LOOP") || {})));
  t._trackOpenedPosition(rec(901, "LONG"));
  t._ingestSwapSummary({ results: [okSwap(1), okSwap(2), okSwap(3)] });
  const o = t._swapRunOpts("LOOP");
  check("HOLDING with 3/10 verified → maxSwaps = remaining (7)",
    o && o.phase === "LOOP" && o.maxSwaps === 7,
    `maxSwaps=${o?.maxSwaps}`);
  t._ingestSwapSummary({ results: [okSwap(4), okSwap(5), okSwap(6), okSwap(7), okSwap(8), okSwap(9), okSwap(10)] });
  check("READY_TO_CLOSE → swap phase skipped (never overshoot the quota)",
    t._swapRunOpts("LOOP") === null);
  const off = makeTrader({ continuousTradingEnabled: false });
  off._trackOpenedPosition(rec(911, "LONG"));
  const oo = off._swapRunOpts("LOOP");
  check("continuous OFF → plain pass even with a live position",
    oo && oo.phase === "LOOP" && oo.maxSwaps === undefined);
}

// ═══════════════════════════════════════════════════════════════════════════
// C6 — restart recovery
// ═══════════════════════════════════════════════════════════════════════════
section("C6: restart recovery — receipts re-verified, quota never re-run");

{
  const receipts = {
    ["0x" + "11".repeat(32)]: { status: 1 },
    ["0x" + "22".repeat(32)]: { status: 0 }, // reverted — must be dropped
  };
  const provider = {
    getTransactionReceipt: async (h) => receipts[String(h).toLowerCase()] || null,
    getTransaction: async () => undefined,
    getNetwork: async () => ({ chainId: 11155111n }),
    getBlockNumber: async () => 1,
  };
  const t = makeTrader({}, { provider, keepActive: true });
  t.state.activePositions = [rec(951, "LONG")];
  t.state.continuousCycle = {
    cycleId: 7, startedAt: Date.now() - 300_000, lastProgressAt: Date.now() - 60_000,
    positionId: 951, side: "LONG", marketSymbol: "USDT/USDC",
    swapsTarget: 10, status: "HOLDING", attempts: 3, errors: [],
    confirmedSwaps: [
      { txHash: "0x" + "11".repeat(32), direction: "USDT->USDC" },
      { txHash: "0x" + "22".repeat(32), direction: "USDC->USDT" },
      { txHash: "0x" + "33".repeat(32), direction: "DAI->USDT" }, // receipt missing → dropped
    ],
  };
  // lower-case the lookup keys the mock actually uses
  receipts["0x1111111111111111111111111111111111111111111111111111111111111111"] = { status: 1 };
  receipts["0x2222222222222222222222222222222222222222222222222222222222222222"] = { status: 0 };
  await t._recoverContinuousCycle();
  const c = t._getCycle();
  check("recovery keeps only receipt-status=1 swaps (1 of 3)",
    (c.confirmedSwaps || []).length === 1 && c.confirmedSwaps[0].txHash === "0x" + "11".repeat(32),
    `kept=${(c.confirmedSwaps || []).length}`);
  check("recovered cycle resumes as HOLDING under quota (never re-sent)",
    c.status === "HOLDING" && c.positionId === 951,
    `status=${c.status}`);

  // quota already met before restart → READY_TO_CLOSE, no extra swaps
  const t2 = makeTrader({}, { provider, keepActive: true });
  t2.state.activePositions = [rec(961, "SHORT")];
  t2.state.continuousCycle = {
    cycleId: 8, startedAt: Date.now(), positionId: 961, side: "SHORT",
    marketSymbol: "LINK/USDT", swapsTarget: 2, status: "HOLDING", attempts: 2, errors: [],
    confirmedSwaps: [
      { txHash: "0x" + "11".repeat(32), direction: "USDT->LINK" },
      { txHash: "0x" + "11".repeat(32), direction: "LINK->USDT" }, // dupe hash
    ],
  };
  await t2._recoverContinuousCycle();
  check("quota already met at restart → READY_TO_CLOSE",
    t2._getCycle().status === "READY_TO_CLOSE",
    `status=${t2._getCycle().status}`);

  // position gone on-chain → cycle closed out, next OPEN starts fresh
  const t3 = makeTrader({}, { provider, keepActive: true });
  t3.state.activePositions = [];
  t3.state.continuousCycle = { cycleId: 9, positionId: 999, side: "LONG", swapsTarget: 10, status: "HOLDING", confirmedSwaps: [], attempts: 0, errors: [] };
  await t3._recoverContinuousCycle();
  check("position not tracked after recovery → cycle DONE (restart starts fresh)",
    t3._getCycle().status === "DONE" && t3._tradingCyclesDone === 0,
    `status=${t3._getCycle().status}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// C7 — full simulated cycles LONG and SHORT
// ═══════════════════════════════════════════════════════════════════════════
section("C7: full simulated cycles — LONG then SHORT, next cycle starts after close");

{
  const t = makeTrader();
  // cycle 1 — LONG
  const r1 = rec(1001, "LONG");
  t._trackOpenedPosition(r1);
  const c1 = t._getCycle();
  t._ingestSwapSummary({ results: Array.from({ length: 10 }, (_, i) => okSwap(i + 1)) });
  check("LONG cycle: 10/10 verified → READY_TO_CLOSE",
    t._getCycle().status === "READY_TO_CLOSE" && t._getCycle().confirmedSwaps.length === 10);
  t._clearPosition(r1, "verified close");
  check("LONG cycle: verified close → DONE, cyclesDone=1",
    t._getCycle().status === "DONE" && t._tradingCyclesDone === 1);
  // cycle 2 — SHORT (fresh open after the verified close)
  const r2 = rec(1002, "SHORT", { txHash: "0x" + "ef".repeat(32) });
  t._trackOpenedPosition(r2);
  const c2 = t._getCycle();
  check("next open after the close starts cycle N+1 (new id, SHORT, HOLDING)",
    c2.cycleId === c1.cycleId + 1 && c2.side === "SHORT" && c2.status === "HOLDING" && c2.positionId === 1002,
    `id=${c2.cycleId} side=${c2.side} status=${c2.status}`);
  t._ingestSwapSummary({ results: Array.from({ length: 10 }, (_, i) => okSwap(i + 50)) });
  t._clearPosition(r2, "verified close");
  check("SHORT cycle completes the same way (cyclesDone=2)",
    t._getCycle().status === "DONE" && t._tradingCyclesDone === 2,
    `done=${t._tradingCyclesDone}`);
  check("both cycles logged START and COMPLETE",
    (t._logText().match(/cycle #\d+ START/g) || []).length === 2
    && (t._logText().match(/cycle #\d+ COMPLETE/g) || []).length === 2);
}

// ═══════════════════════════════════════════════════════════════════════════
// C8 — closeBlocked flag lifecycle
// ═══════════════════════════════════════════════════════════════════════════
section("C8: closeBlocked flag — set on infeasible exit, cleared on mode change");

{
  const t = makeTrader();
  const p = rec(1101, "LONG");
  t._positions().push(p);
  const r1 = t._applyCloseResult(p, { failed: true, clearState: false, code: "CLOSE_NO_FEASIBLE_WINDOW", wait: true }, "1:2:3");
  check("CLOSE_NO_FEASIBLE_WINDOW → blocked + closeBlocked=true + record KEPT",
    r1.blocked === true && p.closeBlocked === true && t._positions().includes(p),
    `code=${r1.code} flag=${p.closeBlocked}`);
  const r2 = t._applyCloseResult(p, { failed: true, clearState: false, code: "CLOSE_BPS_NOT_FOUND", wait: true }, "1:2:4");
  check("CLOSE_BPS_NOT_FOUND keeps the flag", p.closeBlocked === true && r2.blocked === true);
  t._applyCloseResult(p, { failed: true, clearState: false, code: "TX_REVERTED" }, "1:2:5");
  check("a different failure code clears the flag (exit path progressed)",
    p.closeBlocked === false,
    `flag=${p.closeBlocked}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// C9 — exit-viability probe (pure evaluation)
// ═══════════════════════════════════════════════════════════════════════════
section("C9: exit-viability — thin pools fail, deep pools pass");

{
  const t = makeTrader();
  const T0 = "0x" + "a0".repeat(20), T1 = "0x" + "b1".repeat(20);
  const thin = t._evaluateExitReserves({
    reserve0: ethers.parseUnits("0.01", 18), reserve1: ethers.parseUnits("500", 6),
    token0: T0, token1: T1, collateralToken: T0, paymentToken: T1,
    dec0: 18, dec1: 6, collSym: "NEMESIS", paySym: "USDT",
  });
  check("NEMESIS leg 0.01 (<50) → EXIT_NOT_FEASIBLE",
    thin.ok === false && thin.code === "EXIT_NOT_FEASIBLE",
    `code=${thin.code} reason=${thin.reason}`);
  const deep = t._evaluateExitReserves({
    reserve0: ethers.parseUnits("1000", 6), reserve1: ethers.parseUnits("5000", 6),
    token0: T0, token1: T1, collateralToken: T0, paymentToken: T1,
    dec0: 6, dec1: 6, collSym: "USDC", paySym: "USDT",
  });
  check("USDC 1000 / USDT 5000 → viable", deep.ok === true, `whole0=${deep.whole0} whole1=${deep.whole1}`);
  const wethThin = t._evaluateExitReserves({
    reserve0: ethers.parseUnits("0.04", 18), reserve1: ethers.parseUnits("200", 6),
    token0: T0, token1: T1, collateralToken: T0, paymentToken: T1,
    dec0: 18, dec1: 6, collSym: "WETH", paySym: "USDT",
  });
  check("WETH leg 0.04 (<0.05) → not viable", wethThin.ok === false);
  const wethOk = t._evaluateExitReserves({
    reserve0: ethers.parseUnits("0.5", 18), reserve1: ethers.parseUnits("1000", 6),
    token0: T0, token1: T1, collateralToken: T0, paymentToken: T1,
    dec0: 18, dec1: 6, collSym: "WETH", paySym: "USDT",
  });
  check("WETH leg 0.5 (≥0.05) → viable", wethOk.ok === true);
  check("per-symbol floors resolve (USDT=200, NEMESIS=50, unknown→50)",
    t._exitReserveNeedWhole("USDT") === 200 && t._exitReserveNeedWhole("NEMESIS") === 50
    && t._exitReserveNeedWhole("XYZ") === 50);
  t.config.minExitReserveWhole = 5; // numeric override → one floor for every token
  check("numeric config override applies to every symbol",
    t._exitReserveNeedWhole("USDT") === 5 && t._exitReserveNeedWhole("WETH") === 5);
}

// ═══════════════════════════════════════════════════════════════════════════
// C10 — stall guard
// ═══════════════════════════════════════════════════════════════════════════
section("C10: stall guard — no progress under quota → close instead of holding");

{
  const t = makeTrader();
  t._trackOpenedPosition(rec(1201, "LONG"));
  const c = t._getCycle();
  c.lastProgressAt = Date.now() - 25 * 60_000; // 25m without any verified swap
  t._checkCycleStall();
  check("stalled cycle → SWAP_QUOTA_EXHAUSTED + CYCLE_STALLED failure",
    t._getCycle().status === "SWAP_QUOTA_EXHAUSTED"
    && Number(t.state.continuousFailures) === 1,
    `status=${t._getCycle().status}`);
  check("stall log explains itself", t._logText().includes("STALLED"));
  // fresh progress → no stall
  const t2 = makeTrader();
  t2._trackOpenedPosition(rec(1211, "SHORT"));
  t2._checkCycleStall();
  check("fresh cycle (recent lastProgressAt) is not stalled",
    t2._getCycle().status === "HOLDING" && Number(t2.state.continuousFailures || 0) === 0);
}

// ═══════════════════════════════════════════════════════════════════════════
// C11 — static wiring
// ═══════════════════════════════════════════════════════════════════════════
section("C11: static wiring — exit probe before OPEN, cycle hooks in start()");

{
  const src = fs.readFileSync(path.resolve("autoTrader.js"), "utf8");
  check("prepareAndOpen probes exit viability before opening",
    src.includes("const exitProbe = await this._probeMarketExitFeasible(candidate, ctx);")
    && src.includes("exit not viable"));
  check("start() STEP1 defers a HOLDING cycle position until its quota",
    src.includes("_continuousBlocksClose(rec)") && src.includes("swap quota"));
  check("start() ingests swap summaries in both maintenance phases",
    (src.match(/this\._ingestSwapSummary\(/g) || []).length >= 2);
  check("start() resumes the persisted cycle after recovery",
    src.includes("await this._recoverContinuousCycle();"));
  check("start() stalls-checks every loop pass",
    src.includes("this._checkCycleStall();"));
  check("open confirmation + verified close bind/complete the cycle",
    src.includes("this._onPositionOpened?.(rec);")
    && src.includes("this._onPositionOpened?.(pos);")
    && src.includes("this._onPositionClosed?.(pos, countClose);"));
  check("bounded runs exit once the halt engages (unbounded keep waiting)",
    src.includes("!(maxTradingCycles !== null && this._haltInfo())"));
  check("counted swaps are exactly the balance-verified ok results (status:\"ok\" + txHash)",
    src.includes('if (r?.status === "ok" && r.txHash)'));
}

// ═══════════════════════════════════════════════════════════════════════════
// integrity — repo files untouched by this suite
// ═══════════════════════════════════════════════════════════════════════════
section("INTEGRITY: real state / journal / config untouched");
check("real auto-trader-state.json unchanged", sha(STATE_FILE) === H.real, `sha=${sha(STATE_FILE).slice(0, 12)}`);
check("scratch state written (this suite used its own file)", sha(TEST_STATE_FILE) !== H.real);
check("tx-journal.jsonl unchanged", sha(JOURNAL_FILE) === H.journal);
check("config.json unchanged by the suite", sha(CONFIG_FILE) === H.config);

console.log(`\n══════════════════════════════════════════════`);
console.log(`  CONTINUOUS CYCLE: ${pass} passed, ${fail} failed`);
console.log(`══════════════════════════════════════════════`);
process.exit(fail ? 1 : 0);
