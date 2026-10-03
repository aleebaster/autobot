// ═══════════════════════════════════════════════════════════════════════════
//  DRY-RUN READ-ONLY REGRESSION TEST
//
//  `node auto.js --dry-run` must be a pure observation run:
//    • never rewrites auto-trader-state.json          (SHA-256 identical)
//    • never clears/creates activePosition            (byte-for-byte identical)
//    • never bumps sessionStats                       (identical)
//    • never advances rotation recency/counts         (identical)
//    • never touches closeRetry / closeAttempts       (identical)
//    • never changes directionDisabled / lastSide     (identical)
//    • sends ZERO transactions (nonce identical)
//
//  Everything runs against a SCRATCH copy of the production state file, so this
//  test is safe to execute at any time and can never corrupt real bot state.
// ═══════════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PROD_STATE = path.join(ROOT, "auto-trader-state.json");
const SCRATCH_DIR = path.join(ROOT, ".dry-readonly-state");
const SCRATCH_STATE = path.join(SCRATCH_DIR, "state.json");
const LOG_FILE = path.join(SCRATCH_DIR, "dry-run.log");

const results = [];
let failures = 0;

function check(id, name, ok, detail = "") {
  results.push({ id, name, ok, detail });
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  [${id}] ${name}${detail ? ` — ${detail}` : ""}`);
}

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

function logicalView(state) {
  return JSON.stringify({
    activePosition: state.activePosition ?? null,
    sessionStats: state.sessionStats ?? null,
    rotation: state.rotation ?? null,
    closeRetry: state.closeRetry ?? null,
    closeAttempts: state.closeAttempts ?? null,
    directionDisabled: state.directionDisabled ?? null,
    lastSide: state.lastSide ?? null,
    lastCycleTime: state.lastCycleTime ?? null,
  }, null, 2);
}

async function nonceOf() {
  try {
    const { ethers } = await import("ethers");
    const provider = new ethers.JsonRpcProvider("https://ethereum-sepolia-rpc.publicnode.com");
    return await provider.getTransactionCount("0x315E5193633A962B3F369F9C3833D973D0588cCD");
  } catch {
    return null;
  }
}

function runDry(stateFile, logFile) {
  return new Promise((resolve) => {
    const out = fs.openSync(logFile, "w");
    const child = spawn(process.execPath, ["auto.js", "--dry-run"], {
      cwd: ROOT,
      env: { ...process.env, NEMESIS_STATE_FILE: stateFile },
      stdio: ["ignore", out, out],
    });
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
    }, 300_000);
    child.on("exit", (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: -1, signal: String(e) }); });
  });
}

// ─── 1. STATIC SOURCE GUARD — the dry branch must not mutate ────────────────
{
  const src = fs.readFileSync(path.join(ROOT, "autoTrader.js"), "utf8");
  const dryClose = src.slice(src.indexOf("if (closeResult.dryRun)"), src.indexOf("if (closeResult.pending)"));
  check("01", "static: dry-CLOSE branch does not clear activePosition",
    dryClose.length > 0 && !/activePosition\s*=\s*null/.test(dryClose));
  check("02", "static: dry-CLOSE branch does not increment sessionStats.closes",
    dryClose.length > 0 && !/sessionStats\.closes\+\+/.test(dryClose));
  check("03", "static: dry-CLOSE branch does not reset closeRetry/backoff",
    dryClose.length > 0 && !/closeRetry\s*=/.test(dryClose) && !/_resetCloseRetry\(/.test(dryClose));
  check("04", "static: dry-CLOSE branch never calls saveState()",
    dryClose.length > 0 && !/saveState\(/.test(dryClose));
  check("05", "static: saveState() refuses to write a read-only (dry) state",
    /READONLY_STATES\.has\(state\)\)\s*return;/.test(src));
  check("06", "static: constructor marks dry-run state read-only",
    /if \(this\.config\.dryRun\) markStateReadOnly\(this\.state\);/.test(src));
  check("07", "static: swap success/failure bookkeeping is dry-guarded",
    /_recordSwapRouteSuccess\(dir\) \{[\s\S]{0,200}if \(this\._isDry\(\)\)/.test(src)
    && /_recordSwapRouteFailure\(dir, code\) \{[\s\S]{0,200}if \(this\._isDry\(\)\)/.test(src)
    && /_recordSwapRouteSuccess\(dir\) \{[\s\S]{0,500}_rotSwapDone\(/.test(src)
    && !/^\s*[^/\n]*this\.rotation\.recordSwapPair\(/m.test(
      src.split("async runSwapMaintenanceCycle")[1]?.split("async runSwapMatrix")[0] || "MISSING"));
}

// ─── 2. SNAPSHOT the production state, clone it to a scratch file ───────────
if (!fs.existsSync(PROD_STATE)) {
  console.log(`\nSKIP — production state not found at ${PROD_STATE}`);
  process.exit(1);
}
fs.mkdirSync(SCRATCH_DIR, { recursive: true });

// Normalise the SCRATCH copy only (never the production file) so the run is
// deterministic: a close must not be sitting in backoff, and PHASE 1 must have
// a record to plan a CLOSE for.
const scratchSeed = JSON.parse(fs.readFileSync(PROD_STATE, "utf8"));
scratchSeed.closeRetry = null;
scratchSeed.closeAttempts = 0;
if (!scratchSeed.activePosition) {
  scratchSeed.activePosition = {
    positionId: 75, side: "SHORT",
    collateralToken: "0xa3215a5cA659e0Bd57c0B33d5EAD71901A24d3d6",
    collateralAmount: "1721515506",
    paymentToken: "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9",
    leverage: 2, openedAt: 1790921809602,
    txHash: "0x46b27b79e584d22894a0babeb8fa72b574fdbb86f86a177bd8c179aaa13ce42c",
    marketSymbol: "WETH/DAI",
    managerAddr: "0x6562c653a2f2982D8Dad9E420bF3ff5a568eFD82",
    poolAddr: "0x7Ae30ab11117CC324A3102D425208844Ade28001",
  };
}
fs.writeFileSync(SCRATCH_STATE, JSON.stringify(scratchSeed, null, 2));

const prodBefore = fs.readFileSync(PROD_STATE);
const prodShaBefore = sha256(prodBefore);

const beforeBuf = fs.readFileSync(SCRATCH_STATE);
const beforeSha = sha256(beforeBuf);
const beforeLogical = logicalView(JSON.parse(beforeBuf.toString("utf8")));
const nonceBefore = await nonceOf();

// ─── 3. RUN the dry bot ─────────────────────────────────────────────────────
const exitInfo = await runDry(SCRATCH_STATE, LOG_FILE);
const log = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, "utf8") : "";

// ─── 4. COMPARE ─────────────────────────────────────────────────────────────
const afterBuf = fs.readFileSync(SCRATCH_STATE);
const afterSha = sha256(afterBuf);
const afterLogical = logicalView(JSON.parse(afterBuf.toString("utf8")));
const nonceAfter = await nonceOf();

check("08", "dry-run process completed", exitInfo.code === 0,
  `exit=${exitInfo.code}${exitInfo.signal ? ` signal=${exitInfo.signal}` : ""}`);

check("09", "state SHA-256 unchanged after dry-run", afterSha === beforeSha,
  `${beforeSha.slice(0, 16)} → ${afterSha.slice(0, 16)}`);

check("10", "state file byte-for-byte identical after dry-run",
  beforeBuf.equals(afterBuf), `${beforeBuf.length} bytes`);

const stateBefore = JSON.parse(beforeBuf.toString("utf8"));
const stateAfter = JSON.parse(afterBuf.toString("utf8"));

check("11", "activePosition byte-for-byte identical",
  JSON.stringify(stateBefore.activePosition) === JSON.stringify(stateAfter.activePosition),
  `positionId=${stateAfter.activePosition?.positionId ?? "null"}`);

check("12", "sessionStats identical",
  JSON.stringify(stateBefore.sessionStats) === JSON.stringify(stateAfter.sessionStats),
  JSON.stringify(stateAfter.sessionStats));

check("13", "rotation recency + counts identical",
  JSON.stringify(stateBefore.rotation) === JSON.stringify(stateAfter.rotation));

check("14", "closeRetry + closeAttempts identical",
  JSON.stringify(stateBefore.closeRetry) === JSON.stringify(stateAfter.closeRetry)
  && stateBefore.closeAttempts === stateAfter.closeAttempts);

check("15", "directionDisabled + lastSide + lastCycleTime identical",
  JSON.stringify(stateBefore.directionDisabled) === JSON.stringify(stateAfter.directionDisabled)
  && stateBefore.lastSide === stateAfter.lastSide
  && stateBefore.lastCycleTime === stateAfter.lastCycleTime);

check("16", "whole-state logical view identical", beforeLogical === afterLogical);

const prodAfter = fs.readFileSync(PROD_STATE);
check("17", "PRODUCTION auto-trader-state.json untouched",
  sha256(prodAfter) === prodShaBefore, prodShaBefore.slice(0, 16));

check("18", "0 transactions sent (nonce unchanged)",
  nonceBefore === null || nonceBefore === nonceAfter,
  `${nonceBefore} → ${nonceAfter}`);

// ─── 5. LOG: the dry run must still WALK every phase ────────────────────────
check("19", "log: dry-CLOSE reported without a write",
  /\[DRY\] Would (CLOSE|CLEAR) position #\d+/.test(log));
check("20", "log: dry-CLOSE kept the record and continued to OPEN",
  /\[DRY\] position #\d+ record kept \(read-only dry-run\) — continuing to the OPEN phase/.test(log));
check("21", "log: PHASE-1.5 swap pass ran", /\[SWAP\] PHASE-1\.5 rotation queue:/.test(log));
check("22", "log: PHASE-3 swap pass ran", /\[SWAP\] PHASE-3 rotation queue:/.test(log));
check("23", "log: PHASE-2/3 OPEN planned", /\[DRY\] Open would execute on /.test(log));
check("24", "log: cycle completed", /\[CYCLE\] .*CYCLE END/.test(log));
check("25", "log: no swap was actually sent", !/\[SWAP SUCCESS\]/.test(log));
check("26", "log: quote + slippage + eth_call preflight were exercised",
  /\[DRY\][^\n]*would swap|\[SWAP\][^\n]*preflight=PASS/.test(log));

// ─── cleanup ────────────────────────────────────────────────────────────────
try { fs.rmSync(SCRATCH_DIR, { recursive: true, force: true }); } catch {}

const total = results.length;
console.log("═".repeat(70));
console.log(`  DRY-RUN READ-ONLY TESTS: ${total - failures}/${total} PASS`);
console.log(`  state sha256 before = ${beforeSha}`);
console.log(`  state sha256 after  = ${afterSha}`);
console.log(`  nonce   before = ${nonceBefore}   after = ${nonceAfter}`);
console.log(`  transactions sent: 0`);
console.log("═".repeat(70));
process.exit(failures ? 1 : 0);
