// ═══════════════════════════════════════════════════════════════════════════
//  STATUS-LIFECYCLE TEST SUITE  —  read-only, offline, no transaction is sent.
//
//  Covers:
//    • classifyTx()      — the 7 required states + CONFIRMED_STATE_MISMATCH
//    • canTransition()   — CONFIRMED can never fall back to PENDING
//    • TxJournal         — durable append + replay, "off" mode writes nothing
//    • resolveReceipt()  — a null from the primary RPC must not mean "failed"
//    • TxManager         — CONFIRMED / REVERTED / PENDING / UNKNOWN reporting
//    • _settlePendingOpen — a pending open is NOT an open until a receipt says so
//    • static guards     — no `[SWAP SUCCESS]` on failure, no `opens++` on pending
//
//  Never touches the real auto-trader-state.json (NEMESIS_STATE_FILE scratch).
// ═══════════════════════════════════════════════════════════════════════════

import "./_test_state_isolation.mjs"; // state redirect + default-deny live-TX guard
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";

const REPO = path.dirname(fileURLToPath(import.meta.url));
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "nemesis-txstatus-"));

process.env.NEMESIS_STATE_FILE = path.join(SCRATCH, "state.json");
process.env.NEMESIS_TX_JOURNAL = path.join(SCRATCH, "journal.jsonl");
process.env.NEMESIS_FALLBACK_RPCS = "";
process.env.NEMESIS_TX_POLL_ATTEMPTS = "1";
process.env.NEMESIS_TX_POLL_MS = "1";
process.env.NEMESIS_TX_WAIT_MS = "1000";

const { TX_STATE, classifyTx, canTransition, resolveReceipt, TxJournal, isSettledState, isTransientState, stateFromReceipt } =
  await import("./txStatus.js");
const { TxManager } = await import("./autoTrader.js");
const AutoTrader = (await import("./autoTrader.js")).default;

let pass = 0, fail = 0;
const check = (id, cond, detail = "") => {
  if (cond) { pass++; console.log(`  [${id}] PASS ${detail}`); }
  else { fail++; console.log(`  [${id}] FAIL ${detail}`); }
};
const section = (t) => console.log(`\n═══ ${t} ═══`);

const WALLET = "0x315E5193633A962B3F369F9C3833D973D0588cCD";
const MANAGER = "0x6562c653a2f2982D8Dad9E420bF3ff5a568eFD82";
const POSITION_CREATED_TOPIC = "0x2e462fabb57854af0ee2383faf948da3dc380bd08e582513c3e8e1177478c64a";
const topicId = (n) => "0x" + n.toString(16).padStart(64, "0");

// ─── 1. classifyTx ──────────────────────────────────────────────────────────
section("1. classifyTx — every state is reachable and distinct");

check("1.1 receipt.status=1 → CONFIRMED",
  classifyTx({ receipt: { status: 1 } }) === TX_STATE.CONFIRMED);
check("1.2 receipt.status=0 → REVERTED",
  classifyTx({ receipt: { status: 0 } }) === TX_STATE.REVERTED);
check("1.3 mined tx, no receipt, nonce free → UNKNOWN",
  classifyTx({ receipt: null, tx: { blockNumber: 11911376 }, nonce: 5, latestNonce: 5 }) === TX_STATE.UNKNOWN);
check("1.4 unmined tx, no receipt → PENDING",
  classifyTx({ receipt: null, tx: { blockNumber: null }, nonce: 5, latestNonce: 5 }) === TX_STATE.PENDING);
check("1.5 tx absent from chain, nonce free → DROPPED_OR_REPLACED",
  classifyTx({ receipt: null, tx: null, nonce: 5, latestNonce: 5 }) === TX_STATE.DROPPED_OR_REPLACED);
check("1.6 no receipt but nonce consumed → DROPPED_OR_REPLACED (replaced)",
  classifyTx({ receipt: null, tx: { blockNumber: null }, nonce: 5, latestNonce: 6 }) === TX_STATE.DROPPED_OR_REPLACED);
check("1.7 nothing observed → UNKNOWN (never a silent failure)",
  classifyTx({}) === TX_STATE.UNKNOWN);
check("1.8 null receipt alone is NOT REVERTED",
  stateFromReceipt(null) === null && classifyTx({ receipt: null }) === TX_STATE.UNKNOWN);

// ─── 2. transitions ─────────────────────────────────────────────────────────
section("2. canTransition — the lifecycle is enforced");

check("2.1 CONFIRMED cannot regress to PENDING",
  canTransition(TX_STATE.CONFIRMED, TX_STATE.PENDING).ok === false);
check("2.2 CONFIRMED → CONFIRMED_STATE_MISMATCH allowed",
  canTransition(TX_STATE.CONFIRMED, TX_STATE.CONFIRMED_STATE_MISMATCH).ok === true);
check("2.3 UNKNOWN → CONFIRMED allowed (receipt recovered later)",
  canTransition(TX_STATE.UNKNOWN, TX_STATE.CONFIRMED).ok === true);
check("2.4 PENDING → SUBMITTED is backwards",
  canTransition(TX_STATE.PENDING, TX_STATE.SUBMITTED).ok === false);
check("2.5 REVERTED is terminal",
  canTransition(TX_STATE.REVERTED, TX_STATE.CONFIRMED).ok === false);
check("2.6 unknown state name rejected",
  canTransition(TX_STATE.PENDING, "ALL_GOOD").ok === false);
check("2.7 settled/transient classification",
  isSettledState(TX_STATE.CONFIRMED) && isSettledState(TX_STATE.CONFIRMED_STATE_MISMATCH)
  && isTransientState(TX_STATE.PENDING) && isTransientState(TX_STATE.UNKNOWN)
  && !isTransientState(TX_STATE.REVERTED));

// ─── 3. journal durability ──────────────────────────────────────────────────
section("3. TxJournal — durable, append-only, replayable");

{
  const file = path.join(SCRATCH, "j1.jsonl");
  const j = new TxJournal(file);
  j.begin({ hash: "0xaaa", type: "OPEN-LONG", nonce: 1 });
  j.transition("0xaaa", TX_STATE.SUBMITTED);
  j.transition("0xaaa", TX_STATE.CONFIRMED, { blockNumber: 42 });

  const lines = fs.readFileSync(file, "utf8").trim().split("\n");
  check("3.1 one line per transition", lines.length === 3, `got ${lines.length}`);
  check("3.2 first line is PREPARED", JSON.parse(lines[0]).state === TX_STATE.PREPARED);
  check("3.3 last line is CONFIRMED with block", JSON.parse(lines[2]).state === TX_STATE.CONFIRMED && JSON.parse(lines[2]).blockNumber === 42);

  const j2 = new TxJournal(file).load();
  check("3.4 replay survives a restart", j2.get("0xaaa")?.state === TX_STATE.CONFIRMED);
  check("3.5 illegal downgrade is rejected and recorded", j.transition("0xaaa", TX_STATE.PENDING) === null
    && j.get("0xaaa").state === TX_STATE.CONFIRMED);

  j.transition("0xbbb", TX_STATE.PENDING);
  check("3.6 unsettled() lists transient entries", j.unsettled().map(e => e.hash).includes("0xbbb"));
  check("3.7 settled entries are not unsettled", !j.unsettled().some(e => e.hash === "0xaaa"));

  const off = new TxJournal("off");
  const offFile = path.join(SCRATCH, "should-not-exist.jsonl");
  const off2 = new TxJournal(offFile);
  off.enabled = false; off2.enabled = false;
  off.begin({ hash: "0xccc" });
  off2.transition("0xccc", TX_STATE.CONFIRMED);
  check("3.8 NEMESIS_TX_JOURNAL=off writes nothing", !fs.existsSync(offFile));
  check("3.9 'off' constructor is disabled by default", new TxJournal("off").enabled === false);
}

// ─── 4. multi-source receipt resolution ─────────────────────────────────────
section("4. resolveReceipt — a flaky primary RPC cannot fake a failure");

{
  const nullProvider = { getTransactionReceipt: async () => null };
  const goodProvider = { getTransactionReceipt: async () => ({ status: 1, blockNumber: 7 }) };

  const a = await resolveReceipt({ provider: nullProvider, hash: "0xdead", fallbacks: [goodProvider] });
  check("4.1 primary null → fallback receipt used", a.receipt?.status === 1 && a.source === "fallback#1", `source=${a.source}`);

  const b = await resolveReceipt({ provider: nullProvider, hash: "0xdead", fallbacks: [] });
  check("4.2 no fallbacks → receipt null, attempts recorded", b.receipt === null && b.attempts.length === 1 && b.attempts[0].found === false);

  const c = await resolveReceipt({ provider: nullProvider, hash: "0xdead", fallbacks: [nullProvider, goodProvider] });
  check("4.3 walks the whole chain before giving up / finding it", c.receipt?.status === 1);

  const d = await resolveReceipt({ provider: nullProvider, hash: null, fallbacks: [goodProvider] });
  check("4.4 no hash → no calls", d.receipt === null && d.attempts.length === 0);

  const errProvider = { getTransactionReceipt: async () => { throw new Error("rate limited"); } };
  const e = await resolveReceipt({ provider: errProvider, hash: "0xdead", fallbacks: [goodProvider] });
  check("4.5 a throwing endpoint is skipped, not fatal", e.receipt?.status === 1 && e.attempts[0].found === false);
}

// ─── 5. TxManager end-to-end (fakes, no network, no send) ───────────────────
section("5. TxManager — reported state matches the chain");

const mkTx = (hash, waitImpl) => ({ hash, to: MANAGER, wait: waitImpl });
const mkLogs = () => { const l = []; return { l, log: (m) => l.push(String(m)) }; };

async function runManager({ tx, provider, fallbacks = [], journal }) {
  const tm = new TxManager({ journal, fallbacks });
  const { l, log } = mkLogs();
  const wallet = { address: WALLET, sendTransaction: async () => tx };
  const out = await tm.sendAndWait({ wallet, provider, txType: "OPEN-TEST", sendFn: async () => tx, log });
  return { out, logs: l, journal: tm.journal };
}

{
  const file = path.join(SCRATCH, "j5.jsonl");
  const journal = new TxJournal(file);

  // 5.1 primary never returns a receipt, fallback does → CONFIRMED
  const primary = {
    getTransactionCount: async () => 7,
    getTransactionReceipt: async () => null,
    getTransaction: async () => ({ blockNumber: 11911376 }),
  };
  const fallback = { getTransactionReceipt: async () => ({ status: 1, blockNumber: 11911376, gasUsed: 21000n, nonce: 7 }) };
  const tx1 = mkTx("0x1111", async () => { throw new Error("timeout"); });
  const r1 = await runManager({ tx: tx1, provider: primary, fallbacks: [fallback], journal });
  check("5.1 receipt recovered from fallback → status 1", r1.out.status === 1 && r1.out.txState === TX_STATE.CONFIRMED,
    `status=${r1.out.status} state=${r1.out.txState}`);
  check("5.2 journal records CONFIRMED", r1.journal.get("0x1111")?.state === TX_STATE.CONFIRMED);
  check("5.3 log says receipt was recovered", r1.logs.some(m => m.includes("receipt recovered")));

  // 5.2 mined everywhere but NO receipt anywhere → UNKNOWN (not pending, not failed)
  const primary2 = {
    getTransactionCount: async () => 8,
    getTransactionReceipt: async () => null,
    getTransaction: async () => ({ blockNumber: 11911377 }),
  };
  const tx2 = mkTx("0x2222", async () => { throw new Error("timeout"); });
  const r2 = await runManager({ tx: tx2, provider: primary2, fallbacks: [], journal });
  check("5.4 mined but receiptless → UNKNOWN", r2.out.txState === TX_STATE.UNKNOWN && r2.out.pending === true,
    `state=${r2.out.txState}`);
  check("5.5 UNKNOWN is not reported as success", r2.out.status === null && r2.out.receipt === undefined);
  check("5.6 journal records UNKNOWN", r2.journal.get("0x2222")?.state === TX_STATE.UNKNOWN);
  check("5.7 log flags UNKNOWN loudly", r2.logs.some(m => m.includes("UNKNOWN")));

  // 5.3 still in the mempool → PENDING
  const primary3 = {
    getTransactionCount: async () => 9,
    getTransactionReceipt: async () => null,
    getTransaction: async () => ({ blockNumber: null }),
  };
  const tx3 = mkTx("0x3333", async () => { throw new Error("timeout"); });
  const r3 = await runManager({ tx: tx3, provider: primary3, fallbacks: [], journal });
  check("5.8 unmined → PENDING", r3.out.txState === TX_STATE.PENDING && r3.out.pending === true,
    `state=${r3.out.txState}`);
  check("5.9 journal records PENDING (unsettled)", journal.get("0x3333")?.state === TX_STATE.PENDING
    && isTransientState(journal.get("0x3333")?.state));

  // 5.4 reverted receipt → REVERTED
  const primary4 = {
    getTransactionCount: async () => 10,
    getTransactionReceipt: async () => null,
    getTransaction: async () => ({ blockNumber: 11911378 }),
  };
  const revFallback = { getTransactionReceipt: async () => ({ status: 0, blockNumber: 11911378, gasUsed: 30000n, nonce: 10 }) };
  const tx4 = mkTx("0x4444", async () => { throw new Error("timeout"); });
  const r4 = await runManager({ tx: tx4, provider: primary4, fallbacks: [revFallback], journal });
  check("5.10 receipt.status=0 → REVERTED", r4.out.status === 0 && r4.out.txState === TX_STATE.REVERTED,
    `state=${r4.out.txState}`);
  check("5.11 journal records REVERTED", r4.journal.get("0x4444")?.state === TX_STATE.REVERTED);

  // 5.5 nonce collision → retried, not reported as success
  const collide = {
    getTransactionCount: async () => 11,
    getTransactionReceipt: async () => ({ status: 1, blockNumber: 5, gasUsed: 1n, nonce: 11 }),
    getTransaction: async () => ({ blockNumber: 5 }),
  };
  let calls = 0;
  const tx5 = mkTx("0x5555", async () => ({ status: 1, blockNumber: 5, gasUsed: 1n, nonce: 11 }));
  const tm5 = new TxManager({ journal, fallbacks: [] });
  const { log: log5 } = mkLogs();
  const wallet5 = { address: WALLET, sendTransaction: async () => tx5 };
  const r5 = await tm5.sendAndWait({
    wallet: wallet5, provider: collide, txType: "CLOSE-TEST",
    sendFn: async (nonce) => { calls++; if (calls === 1) throw new Error("replacement fee too low"); return tx5; },
    log: log5,
  });
  check("5.12 collision retried then confirmed", calls === 2 && r5.status === 1, `calls=${calls} status=${r5.status}`);
}

// ─── 6. _settlePendingOpen — a submitted open is not an open ────────────────
section("6. _settlePendingOpen — opens are counted only after a receipt");

function fakeAuto(state, provider) {
  const f = {
    state,
    logs: [],
    flagged: 0,
    _opensThisRun: 0,
    // Hold window NOT under test here (covered by test_hold_window) — disabled,
    // but the real helpers must still be reachable from this plain fixture.
    config: { minHoldSeconds: 0, maxHoldSeconds: 0 },
    _isDry: () => false,
    getRuntime: () => ({ provider, wallet: { address: WALLET } }),
    log(m) { this.logs.push(String(m)); },
    _positions() {
      if (!Array.isArray(this.state.activePositions)) this.state.activePositions = [];
      return this.state.activePositions;
    },
    _clearPosition(rec, reason, countClose = true) {
      const arr = this._positions();
      const i = arr.indexOf(rec);
      if (i >= 0) arr.splice(i, 1);
      if (countClose) this.state.sessionStats.closes++;
      return true;
    },
    _recordDirectionSuccess() { this.flagged++; },
    _rotMarketDone() { this.flagged++; },
  };
  f._settlePendingOpen = (pos) => AutoTrader.prototype._settlePendingOpen.call(f, pos);
  f._holdWindowMs = () => AutoTrader.prototype._holdWindowMs.call(f);
  f._isPlausibleOpenedAt = (ts, now) => AutoTrader.prototype._isPlausibleOpenedAt.call(f, ts, now);
  f._ensureHoldScheduled = (pos) => AutoTrader.prototype._ensureHoldScheduled.call(f, pos);
  return f;
}
const pendingState = () => ({
  activePositions: [{
    positionId: null, side: "SHORT", marketSymbol: "ETH/USDT", managerAddr: MANAGER,
    txHash: "0xfeed", pendingOpen: true, openedAt: 1,
  }],
  sessionStats: { opens: 3, closes: 1 },
});

{
  // 6.1 no pending record → no-op
  const f = fakeAuto({ activePositions: [], sessionStats: { opens: 0, closes: 0 } }, {});
  const r = await AutoTrader.prototype._settlePendingOpen.call(f, undefined);
  check("6.1 nothing pending → none/done", r.status === "none" && r.done === true);

  // 6.2 still unmined → stays pending, opens untouched
  const f2 = fakeAuto(pendingState(), {
    getTransactionReceipt: async () => null,
    getTransaction: async () => ({ blockNumber: null }),
  });
  const r2 = await AutoTrader.prototype._settlePendingOpen.call(f2, f2.state.activePositions[0]);
  check("6.2 unmined → PENDING, not done, opens unchanged",
    r2.status === TX_STATE.PENDING && r2.done === false && f2.state.sessionStats.opens === 3,
    `opens=${f2.state.sessionStats.opens}`);
  check("6.3 record still flagged pendingOpen", f2.state.activePositions[0].pendingOpen === true);

  // 6.3 mined but receiptless → UNKNOWN, opens untouched, still not done
  const f3 = fakeAuto(pendingState(), {
    getTransactionReceipt: async () => null,
    getTransaction: async () => ({ blockNumber: 11911390 }),
  });
  const r3 = await AutoTrader.prototype._settlePendingOpen.call(f3, f3.state.activePositions[0]);
  check("6.4 mined, no receipt → UNKNOWN, opens unchanged",
    r3.status === TX_STATE.UNKNOWN && r3.done === false && f3.state.sessionStats.opens === 3
    && f3.logs.some(m => m.includes("UNKNOWN")));

  // 6.4 dropped → record cleared, opens untouched
  const f4 = fakeAuto(pendingState(), {
    getTransactionReceipt: async () => null,
    getTransaction: async () => null,
  });
  const r4 = await AutoTrader.prototype._settlePendingOpen.call(f4, f4.state.activePositions[0]);
  check("6.5 dropped → DROPPED_OR_REPLACED, cleared, opens unchanged",
    r4.status === TX_STATE.DROPPED_OR_REPLACED && r4.done === true
    && !(f4.state.activePositions?.length) && f4.state.sessionStats.opens === 3);

  // 6.5 reverted → cleared, opens untouched, closes NOT counted (countClose=false)
  const f5 = fakeAuto(pendingState(), {
    getTransactionReceipt: async () => ({ status: 0, blockNumber: 11911391, logs: [] }),
    getTransaction: async () => ({ blockNumber: 11911391 }),
  });
  const r5 = await AutoTrader.prototype._settlePendingOpen.call(f5, f5.state.activePositions[0]);
  check("6.6 reverted → cleared without counting a close",
    r5.status === TX_STATE.REVERTED && !(f5.state.activePositions?.length)
    && f5.state.sessionStats.opens === 3 && f5.state.sessionStats.closes === 1);

  // 6.6 confirmed WITH PositionCreated → the ONLY place opens is incremented
  const f6 = fakeAuto(pendingState(), {
    getTransactionReceipt: async () => ({
      status: 1, blockNumber: 11911392,
      // MAM_MarginFeeAssessed has THREE indexed args (manager, positionId,
      // action) — a real receipt always carries topics[3]; action 0 = OPEN.
      logs: [{ address: MANAGER, topics: [POSITION_CREATED_TOPIC, topicId(9), topicId(77), topicId(0)] }],
    }),
    getTransaction: async () => ({ blockNumber: 11911392 }),
  });
  const r6 = await AutoTrader.prototype._settlePendingOpen.call(f6, f6.state.activePositions[0]);
  check("6.7 confirmed → exactly one open counted", r6.status === TX_STATE.CONFIRMED && f6.state.sessionStats.opens === 4,
    `opens=${f6.state.sessionStats.opens}`);
  check("6.8 positionId resolved from the event", f6.state.activePositions[0].positionId === 77);
  check("6.9 pendingOpen cleared, direction success recorded",
    f6.state.activePositions[0].pendingOpen === false && f6.flagged === 2, `flagged=${f6.flagged}`);
  check("6.10 log reports CONFIRMED with the position id",
    f6.logs.some(m => m.includes("CONFIRMED") && m.includes("#77")));

  // 6.7 confirmed but NO PositionCreated event → mismatch, opens untouched
  const f7 = fakeAuto(pendingState(), {
    getTransactionReceipt: async () => ({ status: 1, blockNumber: 11911393, logs: [] }),
    getTransaction: async () => ({ blockNumber: 11911393 }),
  });
  const r7 = await AutoTrader.prototype._settlePendingOpen.call(f7, f7.state.activePositions[0]);
  check("6.11 receipt OK but no event → CONFIRMED_STATE_MISMATCH",
    r7.status === TX_STATE.CONFIRMED_STATE_MISMATCH && f7.state.sessionStats.opens === 3,
    `status=${r7.status}`);
  check("6.12 mismatch recorded on the record", f7.state.activePositions[0].mismatch === true);
  check("6.13 mismatch is a settled state", isSettledState(TX_STATE.CONFIRMED_STATE_MISMATCH));

  // 6.8 dry run never mutates
  const f8 = fakeAuto(pendingState(), {});
  f8._isDry = () => true;
  const r8 = await AutoTrader.prototype._settlePendingOpen.call(f8, f8.state.activePositions[0]);
  check("6.14 dry-run leaves everything alone", r8.status === "none" && f8.state.sessionStats.opens === 3);
}

// ─── 7. closeActivePosition guard ───────────────────────────────────────────
section("7. a pending open is never dropped as a failed-open leftover");

{
  const f = fakeAuto(pendingState(), {
    getTransactionReceipt: async () => null,
    getTransaction: async () => ({ blockNumber: null }),
  });
  f.lastCloseTxHash = null;
  const r = await AutoTrader.prototype.closeActivePosition.call(f, f.state.activePositions[0]);
  check("7.1 close deferred while the open is unconfirmed",
    r.ok === false && r.code === "OPEN_PENDING" && !!(f.state.activePositions?.length),
    `code=${r.code}`);
  check("7.2 no close was counted", f.state.sessionStats.closes === 1);
}

// ─── 8. static regression guards ────────────────────────────────────────────
section("8. static guards — success text and counters");

{
  const src = fs.readFileSync(path.join(REPO, "autoTrader.js"), "utf8");
  const idx = fs.readFileSync(path.join(REPO, "index.js"), "utf8");

  check("8.1 no `[SWAP SUCCESS]` string anywhere", !src.includes("[SWAP SUCCESS]"));
  check("8.2 swap verify failure uses a MISMATCH label", src.includes("[SWAP ${ok ? \"CONFIRMED\" : \"MISMATCH\"}]"));

  const opens = (src.match(/sessionStats\.opens\+\+/g) || []).length;
  check("8.3 opens++ centralized to 2 sites (_trackOpenedPosition + settle)", opens === 2, `found ${opens}`);
  check("8.4b one of them lives in _settlePendingOpen",
    /async _settlePendingOpen\([^)]*\) \{[\s\S]{0,9000}?sessionStats\.opens\+\+/.test(src));

  const pendingBranches = src.split("openResult?.pending").slice(1);
  check("8.4 pending-open branches never increment opens",
    pendingBranches.length === 2 && pendingBranches.every(b => b.split("else if")[0].indexOf("sessionStats.opens++") === -1),
    `branches=${pendingBranches.length}`);
  check("8.5 pending-open branches create a pendingOpen record via _trackOpenedPosition",
    pendingBranches.length === 2 && pendingBranches.every(b => b.split("else if")[0].includes("pending: true")));

  check("8.6 TUI shows PENDING instead of success for an unconfirmed open",
    idx.includes("[OPEN]") && idx.includes('"PENDING"') && idx.includes("not counted"));
  check("8.7 TUI has a CONFIRMED branch", idx.includes('msg.includes("[OPEN]") && msg.includes("CONFIRMED")'));

  const txStatus = fs.readFileSync(path.join(REPO, "txStatus.js"), "utf8");
  check("8.8 all 8 states are declared",
    ["PREPARED", "SUBMITTED", "PENDING", "CONFIRMED", "REVERTED", "DROPPED_OR_REPLACED", "UNKNOWN", "CONFIRMED_STATE_MISMATCH"]
      .every(s => txStatus.includes(`${s}: "${s}"`)));
}

// ─── summary ────────────────────────────────────────────────────────────────
console.log(`\n═══ RESULT ═══`);
console.log(`  pass=${pass} fail=${fail}`);
if (fail > 0) {
  console.log(`\nFAILED`);
  process.exitCode = 1;
} else {
  console.log(`\nALL PASSED`);
}
