// ═══════════════════════════════════════════════════════════════════════════
//  HOLD WINDOW / SIDE RATIO / TRADE CAP / DISPLAY — regression tests
//
//  Covers the LIVE-trading-cycle work:
//    • hold window 60–300s: deferred auto-close + emergency-risk override
//    • holdUntil at every confirmed-open path + restart recovery
//    • ratio-based LONG/SHORT selection (never a disabled side)
//    • maxTradesPerRun cap + --max-cycles=N run bound
//    • display fixes (realizedPnl in COLLATERAL dec, projectedHealthBps sentinel)
//
//  • NO transactions: eth_sendRawTransaction / eth_sendTransaction blocked.
//    (All live send paths are additionally stubbed/never reached.)
//  • Real auto-trader-state.json untouched (state isolation FIRST import).
//  • Fully OFFLINE — every chain read is answered by a local mock provider.
//
//      node test_hold_window.mjs
// ═══════════════════════════════════════════════════════════════════════════

import { TEST_STATE_FILE, realStateHash } from "./_test_state_isolation.mjs"; // MUST be first
import fs from "fs";
import path from "path";
import crypto from "crypto";
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

import AutoTrader, { MAM_POSITION_CREATED_TOPIC } from "./autoTrader.js";

// ── constants (v5 Sepolia) ──────────────────────────────────────────────────
const DUMMY_PK = "0x" + "11".repeat(32);
const WALLET_ADDR = new ethers.Wallet(DUMMY_PK).address;
const MGR = "0x186eA8d6c4CBbcEd1466338B1Ed41C7EF331f480";
const USDT = "0x3A1fF83BFD63E5e2564aEc95ade244234773049f";
const POOL = "0xccA34A36A37941bF54eE0eEFe5a86f98d93ACDd0";
const UINT256_MAX = 2n ** 256n - 1n;

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

// ── ABIs (exact fragments from autoTrader.js) ───────────────────────────────
const VIEW_ABI = [
  "function positions(uint256) view returns (bool isLong, address user, address collateralToken, uint256 collateralAmount, uint256 debtAmount, uint256 borrowIndex, bool active)",
  "function getPositionDebt(uint256) view returns (uint256)",
  "function getPositionRisk(uint256) view returns (tuple(uint256 positionId, bool isActive, bool isLong, address user, address collateralToken, uint256 collateralAmount, uint256 storedDebt, uint256 currentDebt, address debtAsset, uint256 lpTokenPriceToken1X18, uint256 currentDebtValueToken1, uint256 notionalValue, int256 equityValue, uint256 healthBps, uint256 liquidationPrice, bool liquidatable, bool oracleReady))",
  "function previewClosePosition(uint256 positionId, uint256 closeBps) view returns (tuple(uint256 repayAmount, uint256 collateralReduced, uint256 collateralReturned, uint256 protocolFee, uint256 costBasisReduced, int256 realizedPnl, uint256 closePrice, uint256 projectedHealthBps))",
  "function getHealthFactor(uint256 positionId) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];
const iface = new ethers.Interface(VIEW_ABI);
const SEL = {};
for (const n of ["positions", "getPositionDebt", "getPositionRisk", "previewClosePosition", "getHealthFactor", "decimals", "symbol"]) {
  SEL[n] = iface.getFunction(n).selector;
}

const riskTuple = (o = {}) => [
  o.positionId ?? 101n,
  o.isActive ?? true,
  o.isLong ?? false,
  o.user ?? WALLET_ADDR,
  o.collateralToken ?? USDT,
  o.collateralAmount ?? 1000000n,
  o.storedDebt ?? 4060439166n,
  o.currentDebt ?? 4060439166n,
  o.debtAsset ?? POOL,
  1000000000000000000n,
  o.currentDebtValueToken1 ?? 4060439166n,
  o.notionalValue ?? 5000000000n,
  o.equityValue ?? 939560834n,
  o.healthBps ?? 11500n,
  0n,
  o.liquidatable ?? false,
  true,
];
const posTuple = (o = {}) => [
  o.isLong ?? false,
  o.user ?? WALLET_ADDR,
  o.collateralToken ?? USDT,
  o.collateralAmount ?? 1000000n,
  o.debtAmount ?? 4060439166n,
  1000000000000000000n,
  o.active ?? true,
];
const previewTuple = (o = {}) => [
  o.repayAmount ?? 4060439166n,
  o.collateralReduced ?? 1000000n,
  o.collateralReturned ?? 1000000n,
  o.protocolFee ?? 0n,
  o.costBasisReduced ?? 1000000n,
  o.realizedPnl ?? 1234567n,          // COLLATERAL (6-dec) units
  o.closePrice ?? 8120n,
  o.projectedHealthBps ?? UINT256_MAX, // full-close sentinel by default
];

// ── mock provider — answers by (to, selector), throws on anything else ─────
const makeProvider = (opts = {}) => {
  const counters = { positions: 0, debt: 0, risk: 0, preview: 0, decimals: 0, symbol: 0, unknown: [] };
  const tokenMeta = opts.tokenMeta || {
    [USDT.toLowerCase()]: { symbol: "USDT", decimals: 6 },
    [POOL.toLowerCase()]: { symbol: "NLP", decimals: 18 },
  };
  return {
    counters,
    call: async ({ to, data }) => {
      const sel = String(data).slice(0, 10);
      const toL = String(to || "").toLowerCase();
      if (toL === USDT.toLowerCase() || toL === POOL.toLowerCase()) {
        const meta = tokenMeta[toL];
        if (!meta) throw new Error("mock: no token meta");
        if (sel === SEL.decimals) { counters.decimals++; return iface.encodeFunctionResult("decimals", [meta.decimals]); }
        if (sel === SEL.symbol) { counters.symbol++; return iface.encodeFunctionResult("symbol", [meta.symbol]); }
        throw new Error(`mock: unexpected token selector ${sel}`);
      }
      if (toL !== MGR.toLowerCase()) { counters.unknown.push(`${toL}:${sel}`); throw new Error(`mock: unexpected to ${toL}`); }
      if (sel === SEL.positions) {
        counters.positions++;
        // returns (bool,address,address,uint256,uint256,uint256,bool) — 7 SEPARATE
        // outputs, not one tuple → encode as flat values.
        return iface.encodeFunctionResult("positions", opts.positions ?? posTuple(opts.positionsOver));
      }
      if (sel === SEL.getPositionDebt) {
        counters.debt++;
        return iface.encodeFunctionResult("getPositionDebt", [opts.debt ?? 4060439166n]);
      }
      if (sel === SEL.getPositionRisk) {
        counters.risk++;
        if (opts.riskThrows) throw new Error("mock: risk probe down");
        return iface.encodeFunctionResult("getPositionRisk", [riskTuple(opts.riskOver)]);
      }
      if (sel === SEL.previewClosePosition) {
        counters.preview++;
        return iface.encodeFunctionResult("previewClosePosition", [previewTuple(opts.previewOver)]);
      }
      if (sel === SEL.getHealthFactor) throw new Error("mock: getHealthFactor unsupported (hf → null)");
      counters.unknown.push(`${toL}:${sel}`);
      throw new Error(`mock: unexpected selector ${sel}`);
    },
    getTransactionReceipt: async () => opts.receipt ?? null,
    getTransaction: async () => opts.tx ?? undefined,
    getNetwork: async () => ({ chainId: 11155111n }),
    getBlockNumber: async () => 1,
    getCode: async () => "0x6080",
  };
};

// ── trader factory (full constructor; state lives in the SCRATCH file) ─────
const makeTrader = (cfg = {}, provider = null, { keepActive = false } = {}) => {
  const logs = [];
  let p = provider;
  const t = new AutoTrader({
    accounts: [{ address: WALLET_ADDR, privateKey: DUMMY_PK }],
    selectedWalletIndex: 0,
    proxies: [],
    rpcUrl: "http://127.0.0.1:9",
    chainId: 11155111,
    config: { dryRun: false, maxLeverage: 5, leverageMax: 10, deadlineSeconds: 1200, slippageBps: 50, ...cfg },
    confirmedPools: {},
    getProvider: () => (p ?? (p = makeProvider())),
    log: (m, lvl) => logs.push({ m: String(m), lvl }),
  });
  if (!keepActive) t.state.activePositions = []; // determinism — unless a restart test needs the loaded record
  t._logs = logs;
  t._logText = () => logs.map(l => l.m).join("\n");
  return t;
};

const basePos = (id = 101, over = {}) => ({
  positionId: id, side: "SHORT", collateralToken: USDT,
  collateralAmount: "1000000", debtAmount: "4060439166", leverage: 6,
  managerAddr: MGR, openedAt: Date.now() - 60_000,
  txHash: "0x" + "ab".repeat(32), marketSymbol: "NEMESIS/USDT",
  poolAddr: POOL, ...over,
});

const HOLD_CFG = { minHoldSeconds: 60, maxHoldSeconds: 300 };
const EMER_CFG = { ...HOLD_CFG, emergencyCloseEnabled: true, emergencyCloseHealthBps: 10500 };

// ═══════════════════════════════════════════════════════════════════════════
// 1. window math + timestamp plausibility
// ═══════════════════════════════════════════════════════════════════════════
section("1. _holdWindowMs / _isPlausibleOpenedAt");

{
  const d = makeTrader(); // defaults: minHold=0 maxHold=0
  check("hold disabled by default (0/0 → 0ms)", d._holdWindowMs() === 0, `got ${d._holdWindowMs()}`);

  const h = makeTrader(HOLD_CFG);
  let lo = Infinity, hi = 0;
  for (let i = 0; i < 200; i++) {
    const v = h._holdWindowMs();
    lo = Math.min(lo, v); hi = Math.max(hi, v);
  }
  check("60..300 window: 200 samples all inside [60000, 300000]", lo >= 60000 && hi <= 300000, `lo=${lo} hi=${hi}`);
  check("60..300 window: span actually varies (not a constant)", hi - lo > 5000, `span=${hi - lo}`);

  const c = makeTrader({ minHoldSeconds: 60, maxHoldSeconds: 0 }); // max < min → clamp
  check("max<min clamps to fixed min (60000)", c._holdWindowMs() === 60000);

  const n = makeTrader({ minHoldSeconds: -1, maxHoldSeconds: -2 });
  check("negative/invalid values → disabled (0)", n._holdWindowMs() === 0);

  const now = Date.now();
  check("plausible: epoch-ms now", d._isPlausibleOpenedAt(now, now) === true);
  check("plausible: now−60s", d._isPlausibleOpenedAt(now - 60_000, now) === true);
  check("plausible: now+30s (clock skew allowance)", d._isPlausibleOpenedAt(now + 30_000, now) === true);
  check("implausible: seconds era (1721515506)", d._isPlausibleOpenedAt(1721515506, now) === false);
  check("implausible: block number (8000000)", d._isPlausibleOpenedAt(8000000, now) === false);
  check("implausible: 0 / NaN / future+120s", d._isPlausibleOpenedAt(0, now) === false
    && d._isPlausibleOpenedAt("abc", now) === false
    && d._isPlausibleOpenedAt(now + 120_000, now) === false);
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. _ensureHoldScheduled — back-compat, dry, implausible, window, existing
// ═══════════════════════════════════════════════════════════════════════════
section("2. _ensureHoldScheduled — scheduling rules");

{
  // back-compat: hold disabled → 0 and NO new field on the record
  const t = makeTrader();
  const pos = basePos();
  const r = t._ensureHoldScheduled(pos);
  check("disabled: returns 0, record untouched (no holdUntil field)",
    r === 0 && !("holdUntil" in pos), `holdUntil=${pos.holdUntil}`);

  // dry run: enabled window but dry → 0, no mutation (read-only guarantee)
  const td = makeTrader({ ...HOLD_CFG, dryRun: true });
  const pd = basePos();
  const rd = td._ensureHoldScheduled(pd);
  check("dry-run: returns 0, record untouched even with a window",
    rd === 0 && !("holdUntil" in pd));

  // implausible openedAt → holdUntil=0 (closeable now — never invent time)
  const ti = makeTrader(HOLD_CFG);
  const pi = basePos(101, { openedAt: 8000000 }); // block number, not epoch-ms
  const ri = ti._ensureHoldScheduled(pi);
  check("implausible openedAt (block number) → holdUntil=0 explicitly set",
    ri === 0 && pi.holdUntil === 0);

  // plausible → openedAt + rand(60..300s), persisted
  const tw = makeTrader(HOLD_CFG);
  const pw = basePos(101, { openedAt: Date.now() - 5_000 });
  const rw = tw._ensureHoldScheduled(pw);
  check("plausible openedAt → holdUntil inside [openedAt+60s, openedAt+300s]",
    Number.isFinite(rw) && rw === pw.holdUntil
    && rw >= pw.openedAt + 60_000 && rw <= pw.openedAt + 300_000,
    `holdUntil-openedAt=${rw - pw.openedAt}ms`);

  // existing holdUntil → returned untouched (restart-safe, never re-rolled)
  const before = Date.now() + 999_999;
  const pe = basePos(101, { holdUntil: before });
  const re = tw._ensureHoldScheduled(pe);
  check("existing holdUntil returned untouched (no re-roll)", re === before && pe.holdUntil === before);
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. _evaluateHoldGate — unit shape
// ═══════════════════════════════════════════════════════════════════════════
section("3. _evaluateHoldGate — return contract");

{
  const t = makeTrader(HOLD_CFG);
  const pos = basePos(101, { holdUntil: Date.now() + 120_000 });
  const g = await t._evaluateHoldGate(pos, { provider: makeProvider(), managerAddr: MGR, positionId: 101 });
  check("future hold → HOLD_UNTIL result (ok:false, blocked:false, continueCycle:true)",
    g && g.ok === false && g.blocked === false && g.continueCycle === true
    && g.code === "HOLD_UNTIL" && g.holdUntil === pos.holdUntil,
    `code=${g?.code}`);

  const off = makeTrader(); // hold disabled
  const po = basePos(101, { openedAt: Date.now() }); // no holdUntil
  const go = await off._evaluateHoldGate(po, { provider: makeProvider(), managerAddr: MGR, positionId: 101 });
  check("hold disabled → null (close proceeds), no field written", go === null && !("holdUntil" in po));

  const past = basePos(101, { holdUntil: Date.now() - 1_000 });
  const gp = await t._evaluateHoldGate(past, { provider: makeProvider(), managerAddr: MGR, positionId: 101 });
  check("expired hold (holdUntil in the past) → null (close proceeds)", gp === null);
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. closeActivePosition — the hold gate BLOCKS the automatic close
// ═══════════════════════════════════════════════════════════════════════════
section("4. closeActivePosition — HOLD blocks (live, emergency off, no send)");

{
  const provider = makeProvider(); // answers positions/getPositionDebt
  const t = makeTrader(HOLD_CFG, provider);
  const hold = Date.now() + 180_000;
  const pos = basePos(101, { holdUntil: hold });
  t.state.activePositions = [pos];
  const retryBefore = JSON.stringify(pos.closeRetry ?? null); // may be inherited from state

  const r = await t.closeActivePosition(pos);
  const logs = t._logText();
  check("close returns HOLD_UNTIL (ok:false, blocked:false, continueCycle:true, holdUntil kept)",
    r?.code === "HOLD_UNTIL" && r.ok === false && r.blocked === false
    && r.continueCycle === true && r.holdUntil === hold, `code=${r?.code}`);
  check("no close attempt reached (no CLOSING / Would CLOSE log)",
    !logs.includes("[AUTO] CLOSING") && !logs.includes("[DRY] Would CLOSE"));
  check("no backoff scheduled by the hold (record closeRetry byte-identical to before)",
    JSON.stringify(pos.closeRetry ?? null) === retryBefore,
    `before=${retryBefore} after=${JSON.stringify(pos.closeRetry ?? null)}`);
  check("record kept (primary intact)", t.state.activePositions?.[0] === pos);
  check("emergency disabled → risk probe never called", provider.counters.risk === 0, `risk=${provider.counters.risk}`);
  check("gate logged the deferral with remaining seconds", logs.includes("[HOLD] position #101 inside hold window"));
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. pending open settles BEFORE the hold gate (no double-open, no hold mix)
// ═══════════════════════════════════════════════════════════════════════════
section("5. pendingOpen → settle first (OPEN_PENDING / OPEN_UNKNOWN)");

{
  const t = makeTrader(HOLD_CFG);
  t.state.activePositions = [{ ...basePos(null), positionId: null, pendingOpen: true, txHash: "0x" + "ee".repeat(32) }];
  t.getRuntime = () => ({
    provider: {
      getTransactionReceipt: async () => null,
      getTransaction: async () => ({ hash: "0x" + "ee".repeat(32), blockNumber: null, nonce: 7 }),
    },
    wallet: { address: WALLET_ADDR },
  });
  const r = await t.closeActivePosition(t.state.activePositions[0]);
  check("receipt-less pending open → OPEN_PENDING, record kept (never dropped)",
    r?.code === "OPEN_PENDING" && t.state.activePositions?.[0]?.pendingOpen === true, `code=${r?.code}`);
  check("hold gate not involved (no [HOLD] log, no holdUntil)", !t._logText().includes("[HOLD]")
    && !("holdUntil" in t.state.activePositions?.[0] ?? null));

  const t2 = makeTrader(HOLD_CFG);
  t2.state.activePositions = [{ ...basePos(null), positionId: null, pendingOpen: true, txHash: "0x" + "ef".repeat(32) }];
  t2.getRuntime = () => ({
    provider: {
      getTransactionReceipt: async () => null,
      getTransaction: async () => ({ hash: "0x" + "ef".repeat(32), blockNumber: 101, nonce: 7 }), // mined, no receipt
    },
    wallet: { address: WALLET_ADDR },
  });
  const r2 = await t2.closeActivePosition(t2.state.activePositions[0]);
  check("mined-but-unreceipted open → OPEN_UNKNOWN, record kept",
    r2?.code === "OPEN_UNKNOWN" && t2.state.activePositions?.[0]?.pendingOpen === true, `code=${r2?.code}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. dry close never schedules a hold (read-only) and still passes the gate
// ═══════════════════════════════════════════════════════════════════════════
section("6. dry close — gate passes, no hold field ever written");

{
  const provider = makeProvider();
  const t = makeTrader({ ...HOLD_CFG, dryRun: true }, provider);
  const pos = basePos(101, { openedAt: Date.now() }); // plausible, no holdUntil
  t.state.activePositions = [pos];

  const r = await t.closeActivePosition(pos);
  check("dry close proceeds (ok:true, dryRun:true)", r?.ok === true && r.dryRun === true,
    `code=${r?.code} dryRun=${r?.dryRun}`);
  check("record untouched by dry close", t.state.activePositions?.[0] === pos);
  check("no holdUntil written in dry-run", !("holdUntil" in pos));
  check("no [HOLD] scheduling log in dry-run", !t._logText().includes("[HOLD]"));
}

// ═══════════════════════════════════════════════════════════════════════════
// 7. emergency-risk override — the hold is ignored when the chain is at risk
// ═══════════════════════════════════════════════════════════════════════════
section("7. emergency override — healthBps ≤ threshold forces the close");

{
  const provider = makeProvider({ riskOver: { healthBps: 10000n, liquidatable: false } }); // ≤ 10500
  const t = makeTrader({ ...EMER_CFG, dryRun: true }, provider);
  const hold = Date.now() + 240_000;
  const pos = basePos(101, { holdUntil: hold });
  t.state.activePositions = [pos];

  const r = await t.closeActivePosition(pos);
  const logs = t._logText();
  check("healthBps below threshold → close proceeds despite future holdUntil",
    r?.ok === true && r.dryRun === true, `code=${r?.code}`);
  check("EMERGENCY override logged", logs.includes("EMERGENCY override"));
  check("risk probe ran exactly once", provider.counters.risk === 1, `risk=${provider.counters.risk}`);
  check("holdUntil untouched by the override", pos.holdUntil === hold);
}

// ═══════════════════════════════════════════════════════════════════════════
// 8. probe behaviors — throttle, failure-keeps-hold, sentinel, liquidatable
// ═══════════════════════════════════════════════════════════════════════════
section("8. emergency probe — throttle / failure / sentinel / liquidatable");

{
  // throttle: same position within 15s → ONE read; another id → second read
  const provider = makeProvider({ riskOver: { healthBps: 11000n } }); // > 10500 → hold stands
  const t = makeTrader(EMER_CFG, provider);
  const p1 = basePos(101, { holdUntil: Date.now() + 60_000 });
  const g1 = await t._evaluateHoldGate(p1, { provider, managerAddr: MGR, positionId: 101 });
  const g2 = await t._evaluateHoldGate(p1, { provider, managerAddr: MGR, positionId: 101 });
  check("healthy position (11000 > 10500) → hold stands", g1?.code === "HOLD_UNTIL" && g2?.code === "HOLD_UNTIL");
  check("probe throttled: two gate calls, ONE getPositionRisk", provider.counters.risk === 1, `risk=${provider.counters.risk}`);
  const p2 = basePos(102, { holdUntil: Date.now() + 60_000 });
  await t._evaluateHoldGate(p2, { provider, managerAddr: MGR, positionId: 102 });
  check("different positionId → second probe", provider.counters.risk === 2, `risk=${provider.counters.risk}`);

  // failure → hold stands (never close on unknown risk)
  const pf = makeProvider({ riskThrows: true });
  const tf = makeTrader(EMER_CFG, pf);
  const gp = await tf._evaluateHoldGate(basePos(101, { holdUntil: Date.now() + 60_000 }),
    { provider: pf, managerAddr: MGR, positionId: 101 });
  check("probe failure → hold stands", gp?.code === "HOLD_UNTIL");
  check("probe failure logged as warning", tf._logText().includes("risk probe #101 failed"));
  check("failure still throttled (cached)", (await tf._evaluateHoldGate(basePos(101, { holdUntil: Date.now() + 60_000 }),
    { provider: pf, managerAddr: MGR, positionId: 101 }))?.code === "HOLD_UNTIL" && pf.counters.risk === 1);

  // sentinel health value (2^256−1) is NOT an emergency
  const ps = makeProvider({ riskOver: { healthBps: UINT256_MAX } });
  const ts = makeTrader(EMER_CFG, ps);
  const gs = await ts._evaluateHoldGate(basePos(101, { holdUntil: Date.now() + 60_000 }),
    { provider: ps, managerAddr: MGR, positionId: 101 });
  check("sentinel healthBps (2^256−1) → not an emergency, hold stands", gs?.code === "HOLD_UNTIL");

  // liquidatable = true → emergency regardless of healthBps
  const pl = makeProvider({ riskOver: { healthBps: 99999n, liquidatable: true } });
  const tl = makeTrader(EMER_CFG, pl);
  const gl = await tl._evaluateHoldGate(basePos(101, { holdUntil: Date.now() + 60_000 }),
    { provider: pl, managerAddr: MGR, positionId: 101 });
  check("liquidatable=true → override (gate returns null)", gl === null);

  // emergency disabled → probe never fires
  const pd = makeProvider({ riskOver: { healthBps: 1n, liquidatable: true } }); // would be due…
  const td = makeTrader(HOLD_CFG, pd); // …but emergencyCloseEnabled is false
  const gd = await td._evaluateHoldGate(basePos(101, { holdUntil: Date.now() + 60_000 }),
    { provider: pd, managerAddr: MGR, positionId: 101 });
  check("emergencyCloseEnabled=false → zero probes, hold stands", gd?.code === "HOLD_UNTIL" && pd.counters.risk === 0,
    `risk=${pd.counters.risk}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// 9. confirmed open → holdUntil scheduled + persisted + counters
// ═══════════════════════════════════════════════════════════════════════════
section("9. _settlePendingOpen — CONFIRMED schedules and persists the hold");

let SETTLED = null;
{
  const t = makeTrader(HOLD_CFG);
  t.state.activePositions = [{ ...basePos(null), positionId: null, pendingOpen: true, txHash: "0x" + "cd".repeat(32) }];
  t._recordDirectionSuccess = () => {};
  t._rotMarketDone = () => {};
  const opensBefore = t.state.sessionStats.opens;
  const receipt = {
    status: 1, blockNumber: 101,
    logs: [{ address: MGR, topics: [MAM_POSITION_CREATED_TOPIC, ethers.toBeHex(101n, 32), ethers.zeroPadValue(WALLET_ADDR, 32)], data: "0x" }],
  };
  t.getRuntime = () => ({
    provider: {
      getTransactionReceipt: async () => receipt,
      getTransaction: async () => ({ hash: "0x" + "cd".repeat(32), blockNumber: 101, nonce: 7 }),
    },
    wallet: { address: WALLET_ADDR },
  });

  const r = await t._settlePendingOpen(t.state.activePositions[0]);
  const pos = t.state.activePositions?.[0] ?? null;
  check("confirmed → positionId 101, pendingOpen=false, opens++, _opensThisRun++",
    r.status === "CONFIRMED" && r.done === true && pos.positionId === 101
    && pos.pendingOpen === false
    && t.state.sessionStats.opens === opensBefore + 1 && t._opensThisRun === 1,
    `id=${pos.positionId} opens=${t.state.sessionStats.opens} run=${t._opensThisRun}`);
  check("holdUntil scheduled from the confirmed open (inside 60..300s window)",
    Number.isFinite(pos.holdUntil) && pos.holdUntil >= pos.openedAt + 60_000
    && pos.holdUntil <= pos.openedAt + 300_000, `+${pos.holdUntil - pos.openedAt}ms`);

  const onDisk = JSON.parse(fs.readFileSync(TEST_STATE_FILE, "utf8"));
  check("holdUntil + positionId persisted to state file (restart-safe)",
    onDisk?.activePositions?.[0]?.holdUntil === pos.holdUntil
    && onDisk?.activePositions?.[0]?.positionId === 101);
  SETTLED = pos.holdUntil;
}

// ═══════════════════════════════════════════════════════════════════════════
// 10. restart recovery — a persisted hold survives a new process (reload)
// ═══════════════════════════════════════════════════════════════════════════
section("10. restart — persisted holdUntil is loaded and still blocks");

{
  const t2 = makeTrader(HOLD_CFG, null, { keepActive: true }); // constructor loadState() re-reads the scratch file
  const loaded = t2.state.activePositions?.[0] ?? null;
  check("new instance loads the record WITH its holdUntil", loaded?.holdUntil === SETTLED
    && loaded?.positionId === 101, `holdUntil=${loaded?.holdUntil}`);
  const again = t2._ensureHoldScheduled(loaded);
  check("re-ensure returns the persisted value (never re-rolls)", again === SETTLED);
  const g = await t2._evaluateHoldGate(loaded, { provider: makeProvider(), managerAddr: MGR, positionId: 101 });
  check("gate after restart still returns HOLD_UNTIL", g?.code === "HOLD_UNTIL" && g.holdUntil === SETTLED);
}

// ═══════════════════════════════════════════════════════════════════════════
// 11. _pickOpenSide — ratio + disabled sides
// ═══════════════════════════════════════════════════════════════════════════
section("11. _pickOpenSide — ratio weights, disabled sides, hints");

{
  const both = makeTrader({ enableLong: false, enableShort: false });
  check("both disabled → null (no legal side)", both._pickOpenSide("LONG", "LONG") === null
    && both._pickOpenSide(null, "SHORT") === null);

  const longOff = makeTrader({ ...HOLD_CFG, enableLong: false, enableShort: true, longPercent: 100, shortPercent: 0 });
  let allShort = true;
  for (let i = 0; i < 40; i++) if (longOff._pickOpenSide(i % 2 ? "LONG" : null, "LONG") !== "SHORT") allShort = false;
  check("enableLong=false → SHORT 40/40 (hint and ratio never pick the disabled side)", allShort);

  const shortOff = makeTrader({ enableShort: false, enableLong: true, longPercent: 0, shortPercent: 100 });
  let allLong = true;
  for (let i = 0; i < 40; i++) if (shortOff._pickOpenSide(null, "SHORT") !== "LONG") allLong = false;
  check("enableShort=false → LONG 40/40", allLong);

  const w100 = makeTrader({ longPercent: 100, shortPercent: 0 });
  let wOk = true;
  for (let i = 0; i < 60; i++) if (w100._pickOpenSide(null, "SHORT") !== "LONG") wOk = false;
  check("longPercent=100 → LONG 60/60 (planned side overridden by ratio)", wOk);

  const w00 = makeTrader({ longPercent: 0, shortPercent: 0 });
  check("weights 0/0 → planned side honored", w00._pickOpenSide(null, "SHORT") === "SHORT");
  const fall = w00._pickOpenSide(null, null);
  check("weights 0/0 + no plan → alternation side (LONG|SHORT)", fall === "LONG" || fall === "SHORT");

  const hinted = makeTrader({ longPercent: 50, shortPercent: 50 });
  check("RSI hint wins when both sides enabled", hinted._pickOpenSide("LONG", "SHORT") === "LONG"
    && hinted._pickOpenSide("SHORT", "LONG") === "SHORT");

  const rand = makeTrader({ longPercent: 50, shortPercent: 50 });
  let l = 0, s = 0;
  for (let i = 0; i < 200; i++) (rand._pickOpenSide(null, null) === "LONG" ? l++ : s++);
  check("50/50 ratio: both sides appear across 200 draws", l > 0 && s > 0, `LONG=${l} SHORT=${s}`);
  check("50/50 ratio: roughly balanced (40..160 each)", l >= 40 && l <= 160 && s >= 40 && s <= 160, `LONG=${l} SHORT=${s}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// 12. maxTradesPerRun cap
// ═══════════════════════════════════════════════════════════════════════════
section("12. maxTradesPerRun — _tradeCapReached + counter integrity");

{
  const t = makeTrader();
  check("fresh run: cap not reached (maxTradesPerRun=0 → unlimited)", t._tradeCapReached() === false);

  t.config.maxTradesPerRun = 1;
  check("max=1, opens=0 → false", t._tradeCapReached() === false);
  t._opensThisRun = 1;
  check("max=1, opens=1 → true", t._tradeCapReached() === true);

  t.config.maxTradesPerRun = 2;
  check("max=2, opens=1 → false", t._tradeCapReached() === false);
  t._opensThisRun = 2;
  check("max=2, opens=2 → true", t._tradeCapReached() === true);

  t.config.maxTradesPerRun = 0;
  t._opensThisRun = 999;
  check("max=0 (unlimited) → false even with many opens", t._tradeCapReached() === false);

  const src = fs.readFileSync(new URL("./autoTrader.js", import.meta.url), "utf8");
  check("_opensThisRun incremented at the 2 confirmed-open sites (track + settle)",
    (src.match(/this\._opensThisRun\+\+/g) || []).length === 2,
    `found ${(src.match(/this\._opensThisRun\+\+/g) || []).length}`);
  check("_canOpenNew() gates both OPEN sites (runCycle + start STEP 3)",
    (src.match(/this\._canOpenNew\(/g) || []).length >= 2
    && src.includes("if (this._tradeCapReached())"));
  check("_pickOpenSide() used at both OPEN decision points",
    (src.match(/this\._pickOpenSide\(/g) || []).length === 2);
}

// ═══════════════════════════════════════════════════════════════════════════
// 13. operator bypass — --single=close --confirm is never hold-gated
// ═══════════════════════════════════════════════════════════════════════════
section("13. operator --single=close --confirm bypasses the hold gate");

{
  const t = makeTrader(HOLD_CFG); // LIVE (dryRun:false) + hold configured
  const hold = Date.now() + 600_000;
  t.state.activePositions = [basePos(101, { holdUntil: hold })];
  let closeCalls = 0, descN = 0;
  t._closePositionImpl = async () => { closeCalls++; return { ok: true, closed: true }; };
  t.describePosition = async () => (++descN === 1
    ? { ok: true, found: true, active: true, positionId: "101", managerAddr: MGR, ours: true, user: WALLET_ADDR,
        side: "SHORT", isLong: false, collateralAmount: "1000000", currentDebt: "4060439166", healthBps: 11500,
        closeFull: { closeBps: 10000, collateralReturned: "1000000", repayAmount: "4060439166",
          realizedPnl: "1234567", realizedPnlHuman: "1.234567", closePrice: "8120", projectedHealthBps: 11500 },
        status: "ACTIVE" }
    : { ok: true, found: true, active: false, positionId: "101", managerAddr: MGR, ours: true, user: WALLET_ADDR,
        side: "SHORT", isLong: false, collateralAmount: "0", currentDebt: "0", healthBps: null,
        closeFull: null, status: "CLOSED" });

  const r = await t.runSingleAction({ action: "close", confirm: true });
  check("future holdUntil did NOT block the operator close (impl reached)",
    closeCalls === 1 && descN === 2, `closeCalls=${closeCalls} desc=${descN}`);
  check("operator result is not HOLD_UNTIL", r?.code !== "HOLD_UNTIL", `code=${r?.code}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// 14. display fixes — realizedPnl in COLLATERAL dec + projected-health sentinel
// ═══════════════════════════════════════════════════════════════════════════
section("14. describePosition — realizedPnlHuman + projectedHealthBps sentinel");

{
  // full close preview answers the type(uint256).max sentinel
  const p1 = makeProvider({ previewOver: { realizedPnl: 1234567n, projectedHealthBps: UINT256_MAX } });
  const t1 = makeTrader({}, p1);
  const rep = await t1.describePosition(101, MGR);
  check("report built (ACTIVE, ours)", rep.ok === true && rep.active === true && rep.status === "ACTIVE",
    `status=${rep.status}`);
  check("realizedPnlHuman formatted with COLLATERAL decimals (6), not debt (18)",
    rep.closeFull?.realizedPnlHuman === "1.234567",
    `got ${rep.closeFull?.realizedPnlHuman} (18-dec would be 0.000000001234567)`);
  check("full-close sentinel projectedHealthBps surfaced as NULL, not 1.15e77",
    rep.closeFull?.projectedHealthBps === null, `got ${rep.closeFull?.projectedHealthBps}`);
  check("sentinel explained via projectedHealthNote",
    rep.closeFull?.projectedHealthNote === "N/A (position fully closed)", `note=${rep.closeFull?.projectedHealthNote}`);
  check("decimals read on-chain (collateral 6 / debt 18)",
    rep.collateralDecimals === 6 && rep.debtDecimals === 18,
    `coll=${rep.collateralDecimals} debt=${rep.debtDecimals}`);

  // a REAL partial-close health value must stay a number with no note
  const p2 = makeProvider({ previewOver: { realizedPnl: -300000n, projectedHealthBps: 11500n } });
  const t2 = makeTrader({}, p2);
  const rep2 = await t2.describePosition(101, MGR);
  check("real healthBps stays numeric with no note",
    rep2.closeFull?.projectedHealthBps === 11500 && rep2.closeFull?.projectedHealthNote === null,
    `bps=${rep2.closeFull?.projectedHealthBps} note=${rep2.closeFull?.projectedHealthNote}`);
  check("negative pnl still formatted in collateral decimals",
    rep2.closeFull?.realizedPnlHuman === "-0.3", `got ${rep2.closeFull?.realizedPnlHuman}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// 15. start({ maxCycles }) — bounded run, offline
// ═══════════════════════════════════════════════════════════════════════════
section("15. start({ maxCycles }) — run bound + clean stop");

{
  const t = makeTrader({ enableLong: false, enableShort: false }); // OPEN can never fire
  t.sleep = async () => {};      // no waiting in tests
  t.randomDelay = () => 0;
  await t.start({ maxCycles: 1 });
  const logs = t._logText();
  check("maxCycles=1 → exactly one cycle, clean exit (running=false)",
    t._cycleNo === 1 && t.running === false, `cycles=${t._cycleNo} running=${t.running}`);
  check("banner logs 'Max cycles: 1'", logs.includes("Max cycles: 1"));
  check("cycle marker #1 present, #2 never reached",
    logs.includes("[CYCLE] #1") && !logs.includes("[CYCLE] #2"));
  check("STEP 3 refused (both sides disabled → no OPEN)",
    logs.includes("OPEN_SKIPPED reason=SIDE_DISABLED phase=STEP3"));
  check("loop stopped message present", logs.includes("Trading loop stopped."));

  const t2 = makeTrader({ maxTradesPerRun: 1 });
  t2._opensThisRun = 1; // cap already reached (1 confirmed open this run)
  t2.sleep = async () => {};
  t2.randomDelay = () => 0;
  await t2.start({ maxCycles: 5 });
  const logs2 = t2._logText();
  check("cap reached + no position → run stops after 1 cycle (before maxCycles=5)",
    t2._cycleNo === 1 && t2.running === false, `cycles=${t2._cycleNo}`);
  check("cap stop logged with reason", logs2.includes("[LIMIT] maxTradesPerRun=1 reached")
    && logs2.includes("stopping the run"));
  check("no side was ever picked (cap precedes the side selection)",
    !logs2.includes("[AUTO] NEXT ACTION: OPEN"));
}

// ═══════════════════════════════════════════════════════════════════════════
// 16. static source invariants (production wiring)
// ═══════════════════════════════════════════════════════════════════════════
section("16. production source invariants");

{
  const src = fs.readFileSync(new URL("./autoTrader.js", import.meta.url), "utf8");
  const iSync = src.indexOf("this._syncActivePositionFromChain(pos, onChain, { managerAddr });");
  const iGate = src.indexOf("const heldOutcome = await this._evaluateHoldGate(");
  const iBack = src.indexOf("const retry = pos.closeRetry || null;");
  check("gate placed after on-chain sync, before the backoff (closeActivePosition)",
    iSync > 0 && iGate > iSync && iBack > iGate, `sync=${iSync} gate=${iGate} backoff=${iBack}`);

  check("hold scheduled via _trackOpenedPosition + settle + gate",
    (src.match(/this\._ensureHoldScheduled\(/g) || []).length >= 3,
    `found ${(src.match(/this\._ensureHoldScheduled\(/g) || []).length}`);
  check("hold scheduled in _settlePendingOpen + inside the gate",
    (src.match(/this\._ensureHoldScheduled\(pos\)/g) || []).length >= 2);

  check("DEFAULT_AUTO_CONFIG carries all new keys",
    src.includes("minHoldSeconds: 0,") && src.includes("maxHoldSeconds: 0,")
    && src.includes("emergencyCloseEnabled: false,") && src.includes("emergencyCloseHealthBps: 10500,")
    && src.includes("maxTradesPerRun: 0,") && src.includes("longPercent: 50,") && src.includes("shortPercent: 50,"));

  check("start(opts) bounds the loop by _cycleNo",
    src.includes("async start(opts = {})")
    && src.includes("maxCycles === null || this._cycleNo < maxCycles")
    && src.includes("Number.isFinite(maxCyclesRaw) && maxCyclesRaw > 0"));

  check("realizedPnlHuman uses collateralDecimals (debtDecimals variant gone)",
    src.includes("realizedPnlHuman: collateralDec !== null ? ethers.formatUnits(closeFull.realizedPnl, collateralDec) : null")
    && !src.includes("realizedPnlHuman: debtDec !== null"));
  check("projectedHealthBps sentinel collapsed + note present",
    src.includes("closeFullHealthBps = v >= 2n ** 255n ? null : Number(v)")
    && src.includes('projectedHealthNote: closeFullHealthBps === null ? "N/A (position fully closed)" : null'));

  const js = fs.readFileSync(new URL("./auto.js", import.meta.url), "utf8");
  check("auto.js wires all 7 config keys into autoConfig",
    js.includes("minHoldSeconds: Number(config.minHoldSeconds ?? 0),")
    && js.includes("maxHoldSeconds: Number(config.maxHoldSeconds ?? 0),")
    && js.includes("emergencyCloseEnabled: config.emergencyCloseEnabled === true,")
    && js.includes("emergencyCloseHealthBps: Number(config.emergencyCloseHealthBps ?? 10500),")
    && js.includes("maxTradesPerRun: Number(config.maxTradesPerRun ?? 0),")
    && js.includes("longPercent: Number(config.longPercent ?? 50),")
    && js.includes("shortPercent: Number(config.shortPercent ?? 50),"));
  check("auto.js documents --max-cycles in help",
    js.includes("node auto.js [--max-cycles=N]"));
  check("auto.js parses and forwards maxCycles to start()",
    js.includes('argValue("--max-cycles")') && js.includes("await trader.start({ maxCycles, maxTradingCycles, resetHalt });")
    && js.includes("Number.isFinite(maxCyclesNum) && maxCyclesNum > 0"));

  const idx = fs.readFileSync(new URL("./index.js", import.meta.url), "utf8");
  check("index.js still calls start() with no args (backward compat)",
    idx.includes("autoTrader.start().catch("));

  const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  check("config.json: hold window 60..300 enabled",
    cfg.minHoldSeconds === 60 && cfg.maxHoldSeconds === 300);
  check("config.json: emergency override enabled at 10500 bps",
    cfg.emergencyCloseEnabled === true && cfg.emergencyCloseHealthBps === 10500);
  check("config.json: maxTradesPerRun finite, ratio 50/50",
    Number.isFinite(cfg.maxTradesPerRun) && cfg.longPercent === 50 && cfg.shortPercent === 50,
    `maxTradesPerRun=${cfg.maxTradesPerRun}`);
  check("config.json: both sides enabled", cfg.enableLong === true && cfg.enableShort === true);
}

// ═══════════════════════════════════════════════════════════════════════════
// 17. purity — real state / journal / config untouched, isolation intact
// ═══════════════════════════════════════════════════════════════════════════
section("17. purity: repo state, journal and config unchanged");

check("auto-trader-state.json unchanged", sha(STATE_FILE) === H.state);
check("tx-journal.jsonl unchanged", sha(JOURNAL_FILE) === H.journal);
check("config.json unchanged by this run", sha(CONFIG_FILE) === H.config);
check("real state hash helper agrees", realStateHash() === H.real);
check("test state file is a SCRATCH path (isolated from the real one)",
  path.resolve(TEST_STATE_FILE) !== path.resolve("auto-trader-state.json"), TEST_STATE_FILE);

console.log(`\nRESULT: ${pass}/${pass + fail} passed, ${fail} failed`);
if (fail) { console.log("FAILURES:"); process.exitCode = 1; }
