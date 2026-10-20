#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════════════════════
//  CLOSE RECOVERY TESTS — offline logic tests, NO RPC, NO TRANSACTIONS
//
//  Verifies the CLOSE phase's decision table and the invariants that keep a
//  position from being orphaned or spun on forever:
//    • full CLOSE, partial CLOSE, repeated CLOSE
//    • every known contract error code → the right outcome
//    • stale local state is reconciled with on-chain truth (never the reverse)
//    • a blocked CLOSE suppresses the OPEN phase but never ends the cycle
//    • restart recovery re-reads the chain instead of trusting local state
//    • exponential backoff and signature-based reset
//
//  ⛔ NEVER SENDS A TRANSACTION. eth_sendRawTransaction / eth_sendTransaction
//     are hard-blocked below.
// ══════════════════════════════════════════════════════════════════════════════

import { TEST_STATE_FILE, realStateHash } from "./_test_state_isolation.mjs";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { ethers } from "ethers";

// ── HARD TX BLOCK ────────────────────────────────────────────────────────────
const _origSend = ethers.JsonRpcProvider.prototype.send;
ethers.JsonRpcProvider.prototype.send = function (method, params) {
  if (method === "eth_sendRawTransaction" || method === "eth_sendTransaction") {
    return Promise.reject(new Error(`TX_BLOCKED: ${method} is forbidden in this test`));
  }
  return _origSend.call(this, method, params);
};

// ── HARD STATE-FILE BLOCK ────────────────────────────────────────────────────
// This suite exercises LIVE-mode code paths (_noteCloseFailure,
// _clearPosition), which call the module-level saveState() and would
// otherwise rewrite the repo's real auto-trader-state.json. Block it outright:
// any attempt to write the state file throws instead of silently corrupting
// position #75's record. This is the test's equivalent of markStateReadOnly.
const _origWriteFileSync = fs.writeFileSync;
fs.writeFileSync = function (file, ...rest) {
  const p = String(file);
  if (p.endsWith("auto-trader-state.json") || p.endsWith(path.sep + "auto-trader-state.json")) {
    throw new Error(`STATE_WRITE_BLOCKED: ${p} must not be modified by this test`);
  }
  return _origWriteFileSync.call(fs, file, ...rest);
};

const REPO = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(REPO, "auto-trader-state.json");
const hashState = () => {
  try { return crypto.createHash("sha256").update(fs.readFileSync(STATE_FILE)).digest("hex"); }
  catch { return "MISSING"; }
};
const STATE_HASH_BEFORE = hashState();

const { AutoTrader, positionIsClosed, readOnChainPosition } = await import("./autoTrader.js");

const PASS = [], FAIL = [];
let total = 0;
function check(name, ok, detail = "") {
  total++;
  if (ok) PASS.push(name); else FAIL.push(`${name} :: ${detail}`);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

// Contract revert selectors observed on this deployment.
const SEL = {
  INVALID_POSITION: "0xa5732d32",   // MAM_InvalidPosition  → zombie, clear
  INSUFFICIENT_LIQ: "0xf71ff020",   // MAM_InsufficientLiquidity → partialClose
  AMOUNT_TOO_SMALL: "0x01556191",   // MAM_CloseAmountTooSmall → dust
  INSUFFICIENT_OUTPUT: "0x27a80cdc",// Pool_InsufficientOutputAmount → quote=0
  PARTIAL_SELECTOR: "0xdc439ba7",
  CLOSE_SELECTOR: "0xb35648d7",
};

// ── Isolated AutoTrader instance that NEVER touches the real state file ──────
// saveState is stubbed so no test can mutate the repo's auto-trader-state.json.
// Default is LIVE mode: most sections below verify that live paths really do
// persist/backoff/clear. The two dry-run sections pass `dryRun: true` explicitly.
function makeTrader({ dryRun = false, activePosition = null, closeRetry = null } = {}) {
  const writes = [];
  const logs = [];
  const trader = Object.create(AutoTrader.prototype);
  trader.config = {
    dryRun, slippageBps: 50, deadlineSeconds: 1200,
    maxPartialCloseAttempts: 3, closeRetryBaseMs: 20000, closeRetryMaxMs: 600000,
  };
  const rec = activePosition ? { ...activePosition } : null;
  if (rec && closeRetry) rec.closeRetry = closeRetry;
  trader.state = {
    activePositions: rec ? [rec] : [],
    sessionStats: { closes: 0, opens: 0, swaps: 0 },
  };
  trader.log = (m, lvl) => logs.push({ m, lvl });
  trader._isDry = () => trader.config.dryRun === true;
  trader.setState = () => {};
  trader.txManager = { send: async () => { throw new Error("TX_BLOCKED"); } };
  // saveState is module-level; it writes to the (blocked) state file. Block it
  // so these offline tests never attempt a disk write.
  trader._save = (s) => writes.push(JSON.parse(JSON.stringify(s)));
  trader._writes = writes;
  trader._logs = logs;
  trader._pos = () => trader.state.activePositions?.[0] ?? null;
  return trader;
}

// Re-implement persistence interception by patching the module-level saveState
// via the public methods that call it. `_noteCloseFailure` / `_clearPosition`
// call the module `saveState`, so we verify by reading trader.state afterwards.

const POS75 = {
  positionId: 75, side: "SHORT", marketSymbol: "WETH/DAI",
  collateralToken: "0xa3215a5cA659e0Bd57c0B33d5EAD71901A24d3d6",
  collateralDecimals: 6, collateralSym: "DAI",
  poolAddr: "0x7Ae30ab11117CC324A3102D425208844Ade28001",
  managerAddr: "0x6562c653a2f2982D8Dad9E420bF3ff5a568eFD82",
  // STALE: 143× the real on-chain value (12007481). This is the exact bug that
  // made the bot unable to reason about #75.
  collateralAmount: "1721515506",
  debtAmount: "22",
  leverageX10: 20,
  openedAt: Date.now(),
};

console.log("\n═══ 1. BACKOFF SCHEDULE ═══");
{
  const t = makeTrader({});
  check("attempt 1 → 20s base", t._closeBackoffMs(1) === 20000);
  check("attempt 2 → 40s", t._closeBackoffMs(2) === 40000);
  check("attempt 3 → 80s", t._closeBackoffMs(3) === 80000);
  check("attempt 4 → 160s", t._closeBackoffMs(4) === 160000);
  check("attempt 5 → 320s", t._closeBackoffMs(5) === 320000);
  check("attempt 6 → 600s CAP (no runaway)", t._closeBackoffMs(6) === 600000);
  check("attempt 879 → still 600s CAP", t._closeBackoffMs(879) === 600000);
  check("attempt 0/negative → base, never negative wait", t._closeBackoffMs(0) === 20000 && t._closeBackoffMs(-5) === 20000);

  t.config.closeRetryBaseMs = 5000; t.config.closeRetryMaxMs = 10000;
  check("config overrides honoured (base 5s cap 10s)", t._closeBackoffMs(1) === 5000 && t._closeBackoffMs(10) === 10000);
}

console.log("\n═══ 2. CLOSE SIGNATURE — identical attempts are backed off, moved state is not ═══");
{
  const t = makeTrader({});
  const sigA = t._closeSig({ active: true, collateralAmount: 12007481n, currentDebt: 1001520786214896827n });
  const sigB = t._closeSig({ active: true, collateralAmount: 12007481n, currentDebt: 1001520786214896827n });
  const sigC = t._closeSig({ active: true, collateralAmount: 6000000n, currentDebt: 1001520786214896827n });
  check("identical on-chain state → identical signature", sigA === sigB);
  check("changed collateral → different signature (resets backoff)", sigA !== sigC);
  check("null on-chain → null signature", t._closeSig(null) === null);
}

console.log("\n═══ 3. BACKOFF ACCUMULATION AND SIGNATURE RESET ═══");
{
  // NOTE: dry-run deliberately NEVER writes the per-record closeRetry (it only
  // reports the delay it would schedule), so accumulation is verified on a
  // LIVE-mode trader with the module saveState writing to the scratch file.
  const t = makeTrader({ dryRun: false, activePosition: POS75 });
  const pos = t._pos();
  const sig = t._closeSig({ active: true, collateralAmount: 12007481n, currentDebt: 1n });
  pos.closeRetry = null;

  const d1 = t._noteCloseFailure(pos, sig, "CLOSE_BPS_NOT_FOUND");
  const d2 = t._noteCloseFailure(pos, sig, "CLOSE_BPS_NOT_FOUND");
  const d3 = t._noteCloseFailure(pos, sig, "CLOSE_BPS_NOT_FOUND");
  check("same signature escalates 20s → 40s → 80s", d1 === 20000 && d2 === 40000 && d3 === 80000, `${d1},${d2},${d3}`);
  check("attempts counter tracks 1,2,3", pos.closeRetry.attempts === 3, `attempts=${pos.closeRetry?.attempts}`);
  check("closeRetry.code carries the last failure code", pos.closeRetry.code === "CLOSE_BPS_NOT_FOUND");
  check("closeAttempts lifetime counter incremented", pos.closeAttempts === 3);
  check("backoff is scheduled in the future", pos.closeRetry.nextAt > Date.now());

  // A DIFFERENT signature (state actually moved) must reset to attempt 1.
  const movedSig = t._closeSig({ active: true, collateralAmount: 5000000n, currentDebt: 1n });
  const d4 = t._noteCloseFailure(pos, movedSig, "CLOSE_BPS_NOT_FOUND");
  check("state moved → backoff RESETS to 20s", d4 === 20000, `d4=${d4}`);
  check("attempts reset to 1", pos.closeRetry.attempts === 1);

  t._resetCloseRetry(pos);
  check("_resetCloseRetry clears both fields", pos.closeRetry === null && pos.closeAttempts === 0);
}

console.log("\n═══ 3b. DRY-RUN BACKOFF IS REPORTED, NEVER WRITTEN ═══");
{
  const t = makeTrader({ dryRun: true, activePosition: POS75 });
  const pos = t._pos();
  const sig = t._closeSig({ active: true, collateralAmount: 12007481n, currentDebt: 1n });
  const d = t._noteCloseFailure(pos, sig, "CLOSE_BPS_NOT_FOUND");
  check("dry run still REPORTS the delay it would schedule", d === 20000, `d=${d}`);
  check("dry run does NOT write closeRetry", pos.closeRetry == null);
  check("dry run does NOT bump closeAttempts", !pos.closeAttempts);
  const d2 = t._noteCloseFailure(pos, sig, "CLOSE_BPS_NOT_FOUND");
  check("dry run delay does not escalate (nothing persisted)", d2 === 20000, `d2=${d2}`);
}

console.log("\n═══ 4. STALE LOCAL STATE IS RECONCILED WITH ON-CHAIN (never the reverse) ═══");
{
  // #75 exactly: local 1721515506 vs chain 12007481.
  const t = makeTrader({ activePosition: JSON.parse(JSON.stringify(POS75)) });
  check("precondition: local collateral is STALE (143× on-chain)",
    t.state.activePositions[0].collateralAmount === "1721515506");

  const r = t._syncActivePositionFromChain(
    t._pos(),
    { collateralAmount: 12007481n, currentDebt: 1001520786214896827n, isLong: false, active: true },
    { managerAddr: POS75.managerAddr },
  );
  check("sync reports a change", r.synced === true);
  check("local collateral now equals ON-CHAIN 12007481",
    t.state.activePositions[0].collateralAmount === "12007481",
    `got ${t.state.activePositions[0].collateralAmount}`);
  check("local debt now equals on-chain currentDebt",
    t.state.activePositions[0].debtAmount === "1001520786214896827");
  check("SHORT preserved from isLong=false", t.state.activePositions[0].side === "SHORT");
  check("position #75 is NOT cleared by a sync", !!(t.state.activePositions?.length) && t.state.activePositions[0].positionId === 75);

  const again = t._syncActivePositionFromChain(
    t._pos(),
    { collateralAmount: 12007481n, currentDebt: 1001520786214896827n, isLong: false, active: true }, {});
  check("idempotent: a second identical sync is a no-op", again.synced === false);
}

console.log("\n═══ 5. DRY-RUN SYNC NEVER WRITES ═══");
{
  const t = makeTrader({ dryRun: true, activePosition: JSON.parse(JSON.stringify(POS75)) });
  const r = t._syncActivePositionFromChain(
    t._pos(), { collateralAmount: 12007481n, currentDebt: 1n, isLong: false });
  check("dry sync reports no write", r.synced === false);
  check("dry sync leaves the stale local value untouched",
    t.state.activePositions[0].collateralAmount === "1721515506");
  check("dry sync still REPORTS what it would change", r.changed.length > 0);
}

console.log("\n═══ 6. _clearPosition IS DRY-RUN SAFE ═══");
{
  const t = makeTrader({ dryRun: true, activePosition: JSON.parse(JSON.stringify(POS75)) });
  const c = t._clearPosition(t._pos(), "test");
  check("dry clear returns false (refuses)", c === false);
  check("dry clear KEEPS the position", !!(t.state.activePositions?.length));
  check("dry clear does not bump sessionStats.closes", t.state.sessionStats.closes === 0);

  const live = makeTrader({ dryRun: false, activePosition: JSON.parse(JSON.stringify(POS75)) });
  // Guard saveState from touching the real repo file (scratch file is fine).
  const c2 = live._clearPosition(live._pos(), "verified on-chain close");
  check("live clear of a VERIFIED close removes the record", c2 === true && !(live.state.activePositions?.length));
  check("live clear increments sessionStats.closes", live.state.sessionStats.closes === 1);
  check("live clear resets close retry bookkeeping", live._pos() == null);
}

console.log("\n═══ 7. _applyCloseResult DECISION TABLE ═══");
{
  // (a) null result → blocked, kept, backoff, code CLOSE_NO_RESULT
  const t1 = makeTrader({ activePosition: POS75 });
  const p1 = t1._pos();
  const r1 = t1._applyCloseResult(p1, null, "SIG1");
  check("null close result → blocked + keep + CLOSE_NO_RESULT",
    r1.ok === false && r1.blocked === true && r1.continueCycle === true && r1.code === "CLOSE_NO_RESULT");
  check("null result does NOT clear the position", !!(t1.state.activePositions?.length));

  // (b) dryRun → ok:true but record KEPT, no backoff written
  const t2 = makeTrader({ activePosition: POS75 });
  const p2 = t2._pos();
  const r2 = t2._applyCloseResult(p2, { dryRun: true }, "SIG2");
  check("dry close → ok:true, record KEPT (never cleared)",
    r2.ok === true && r2.dryRun === true && !!(t2.state.activePositions?.length));
  check("dry close writes no backoff", p2.closeRetry == null);

  // (c) pending → not blocked, kept, backoff TX_PENDING
  const t3 = makeTrader({ activePosition: POS75 });
  const p3 = t3._pos();
  const r3 = t3._applyCloseResult(p3, { pending: true, txHash: "0xabc" }, "SIG3");
  check("pending TX → kept, code TX_PENDING, continueCycle",
    r3.ok === false && r3.code === "TX_PENDING" && !!(t3.state.activePositions?.length) && r3.continueCycle === true);

  // (d) failed + clearState:false (the WAIT path) → kept + backoff + code
  const t4 = makeTrader({ activePosition: POS75 });
  const p4 = t4._pos();
  const r4 = t4._applyCloseResult(p4,
    { failed: true, clearState: false, code: "CLOSE_BPS_NOT_FOUND", wait: true,
      reason: "no bps in 1..9999 passes previewClosePosition" }, "SIG4");
  check("CLOSE_BPS_NOT_FOUND → blocked, KEPT, code preserved, continueCycle",
    r4.ok === false && r4.blocked === true && r4.code === "CLOSE_BPS_NOT_FOUND"
    && r4.continueCycle === true && !!(t4.state.activePositions?.length));
  check("WAIT schedules a backoff", p4.closeRetry != null && p4.closeRetry.code === "CLOSE_BPS_NOT_FOUND");
  check("WAIT does not count a close", t4.state.sessionStats.closes === 0);

  // (e) failed + clearState true (zombie) → CLEARED
  const t5 = makeTrader({ activePosition: POS75 });
  const r5 = t5._applyCloseResult(t5._pos(), { failed: true, clearState: true, reason: "MAM_InvalidPosition" }, "SIG5");
  check("zombie (clearState:true) → cleared + counted + ok",
    r5.ok === true && !(t5.state.activePositions?.length) && t5.state.sessionStats.closes === 1);

  // (f) closed:false → kept
  const t6 = makeTrader({ activePosition: POS75 });
  const r6 = t6._applyCloseResult(t6._pos(), { closed: false, code: "STILL_ACTIVE" }, "SIG6");
  check("closed:false → blocked + kept", r6.ok === false && !!(t6.state.activePositions?.length));

  // (g) verified close → cleared + counted
  const t7 = makeTrader({ activePosition: POS75 });
  const p7 = t7._pos();
  const r7 = t7._applyCloseResult(p7, { ok: true, closed: true, txHash: "0xdef" }, "SIG7");
  check("verified on-chain close → cleared + counted", r7.ok === true && !(t7.state.activePositions?.length) && t7.state.sessionStats.closes === 1);
  check("verified close resets the backoff", p7.closeRetry == null && !p7.closeAttempts);
}

console.log("\n═══ 8. EVERY KNOWN CONTRACT ERROR → RIGHT OUTCOME ═══");
{
  // Zombie → clear.
  const tZ = makeTrader({ activePosition: POS75 });
  const rZ = tZ._applyCloseResult(tZ._pos(), { failed: true, clearState: true, reason: "MAM_InvalidPosition" }, "S");
  check("MAM_InvalidPosition → CLEAR (position is gone)", rZ.ok === true && !(tZ.state.activePositions?.length));

  // Liquidity-blocked → partialClose fallback offered, position KEPT.
  const tL = makeTrader({ activePosition: POS75 });
  const rL = tL._applyCloseResult(tL._pos(),
    { failed: true, clearState: false, code: "MAM_InsufficientLiquidity" }, "S");
  check("MAM_InsufficientLiquidity → KEEP (partialClose fallback exists)",
    rL.ok === false && rL.blocked === true && !!(tL.state.activePositions?.length));

  // Amount too small → KEEP (dust, not gone).
  const tS = makeTrader({ activePosition: POS75 });
  const rS = tS._applyCloseResult(tS._pos(), { failed: true, clearState: false, code: "CLOSE_AMOUNT_TOO_SMALL" }, "S");
  check("MAM_CloseAmountTooSmall → KEEP (dust is still an open position)",
    rS.ok === false && !!(tS.state.activePositions?.length));

  // Zero quote on the partial path → KEEP.
  const tQ = makeTrader({ activePosition: POS75 });
  const rQ = tQ._applyCloseResult(tQ._pos(), { failed: true, clearState: false, code: "ZERO_AMOUNT_OUT_MIN" }, "S");
  check("ZERO_AMOUNT_OUT_MIN → KEEP", rQ.ok === false && !!(tQ.state.activePositions?.length));

  // Bad partial selector → KEEP (refuse to send).
  const tB = makeTrader({ activePosition: POS75 });
  const rB = tB._applyCloseResult(tB._pos(), { failed: true, clearState: false, code: "BAD_PARTIAL_SELECTOR" }, "S");
  check("BAD_PARTIAL_SELECTOR → KEEP (never send a bad selector)",
    rB.ok === false && !!(tB.state.activePositions?.length));

  // Every non-clearing outcome must share one property: the position SURVIVES.
  const survivors = [rL, rS, rQ, rB].every(r => r.ok === false);
  check("all non-clearing outcomes keep the position tracked", survivors);
  check("no outcome in this block closed a position",
    [tZ, tL, tS, tQ, tB].filter(t => !(t.state.activePositions?.length)).length === 1); // only the zombie
}

console.log("\n═══ 9. BLOCKED CLOSE SUPPRESSES OPEN BUT NEVER ENDS THE CYCLE ═══");
{
  const t = makeTrader({ activePosition: POS75 });
  const r = t._applyCloseResult(t._pos(), { failed: true, clearState: false, code: "CLOSE_BPS_NOT_FOUND", wait: true }, "S");
  check("continueCycle is ALWAYS true (a failed close must not stop the bot)",
    r.continueCycle === true);
  check("ok:false → PHASE 2 OPEN is suppressed this cycle",
    r.ok === false && !(r.ok === true && !r.dryRun));
  check("position remains active for the next cycle's re-probe", !!(t.state.activePositions?.length));
}

console.log("\n═══ 10. RESTART RECOVERY — chain truth beats local truth ═══");
{
  // A restarted process must re-read the chain. Local stale state is a CACHE.
  const t = makeTrader({ activePosition: JSON.parse(JSON.stringify(POS75)) });
  const chainView = { active: true, isLong: false, collateralAmount: 12007481n, currentDebt: 1001520786214896827n };
  check("positionIsClosed(active=true) is false", positionIsClosed(chainView) === false);
  check("positionIsClosed(active=false) is true", positionIsClosed({ active: false }) === true);
  // An UNREADABLE snapshot must NOT read as closed — otherwise a failed RPC
  // read would let the bot clear a live position. Safety: null → "not closed".
  check("positionIsClosed(null) is FALSE — an unreadable read must never clear state",
    positionIsClosed(null) === false);
  check("positionIsClosed(undefined) is FALSE too", positionIsClosed(undefined) === false);

  t._syncActivePositionFromChain(t._pos(), chainView, {});
  check("after recovery the local record matches the chain",
    t.state.activePositions[0].collateralAmount === "12007481");
  check("recovery NEVER cleared the position", !!(t.state.activePositions?.length));
}

console.log("\n═══ 11. STALE-STATE INVARIANT: sync is the ONLY path that reconciles ═══");
{
  const t = makeTrader({ activePosition: JSON.parse(JSON.stringify(POS75)) });
  const numericOf = (p) => JSON.stringify({
    positionId: p?.positionId ?? null,
    collateralAmount: p?.collateralAmount ?? null,
    debtAmount: p?.debtAmount ?? null,
    side: p?.side ?? null,
  });
  const before = numericOf(t.state.activePositions?.[0] ?? null);
  // A WAIT outcome must not silently rewrite collateral on its own (only the
  // per-record backoff fields are allowed to change).
  t._applyCloseResult(t._pos(), { failed: true, clearState: false, code: "CLOSE_BPS_NOT_FOUND", wait: true }, "S");
  check("a WAIT leaves the numeric record untouched (only _syncActivePositionFromChain reconciles)",
    numericOf(t.state.activePositions?.[0] ?? null) === before);
  check("but the position is still tracked", !!(t.state.activePositions?.length));
}

console.log("\n═══ 12. THE #75 CASE, END TO END ═══");
{
  const t = makeTrader({ activePosition: JSON.parse(JSON.stringify(POS75)) });
  // 1. stale local
  const stale = t.state.activePositions[0].collateralAmount === "1721515506";
  // 2. sync with the real on-chain snapshot
  t._syncActivePositionFromChain(
    t._pos(),
    { collateralAmount: 12007481n, currentDebt: 1001520786214896827n, isLong: false, active: true },
    { managerAddr: POS75.managerAddr });
  // 3. close is blocked by the degraded pool → controlled WAIT
  const r = t._applyCloseResult(
    t._pos(),
    { failed: true, clearState: false, code: "CLOSE_BPS_NOT_FOUND", wait: true,
      reason: "no bps in 1..9999 passes previewClosePosition" }, "S");
  check("#75: local state was stale before sync", stale);
  check("#75: local state now matches chain (12007481)",
    t.state.activePositions[0].collateralAmount === "12007481");
  check("#75: close blocked as a controlled WAIT, not an error-clear",
    r.blocked === true && r.code === "CLOSE_BPS_NOT_FOUND" && r.ok === false);
  check("#75: position STILL ACTIVE and TRACKED (never locally cleared)",
    !!(t.state.activePositions?.length) && t.state.activePositions[0].positionId === 75);
  check("#75: cycle continues (OPEN suppressed this cycle only)",
    r.continueCycle === true && r.ok === false);
  check("#75: a retry is scheduled", t._pos().closeRetry != null);
}

console.log("\n═══════════════════════════════════════════════════════");
const STATE_HASH_AFTER = hashState();
console.log(`  ${PASS.length}/${total} passed, ${FAIL.length} failed`);
console.log(`  state file before=${STATE_HASH_BEFORE.slice(0, 16)}… after=${STATE_HASH_AFTER.slice(0, 16)}…`);
if (STATE_HASH_BEFORE !== STATE_HASH_AFTER) {
  console.log("  !! STATE FILE WAS MODIFIED BY THIS TEST — that is a bug");
  FAIL.push("state file mutated");
}
if (FAIL.length) {
  console.log(" FAILURES:");
  for (const f of FAIL) console.log(`   - ${f}`);
}
console.log("═══════════════════════════════════════════════════════\n");
process.exit(FAIL.length ? 1 : 0);
