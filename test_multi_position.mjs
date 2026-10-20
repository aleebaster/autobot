// ═══════════════════════════════════════════════════════════════════════════
//  MULTI-POSITION SUITE — state.activePositions[] (array model)
//
//  Covers the four required areas for the activePositions refactor, OFFLINE:
//    M1  legacy state migration on load + saveState writes ONLY the new shape
//    M2  _canOpenNew gate unit tests (max cap / per-market slot / pending /
//        trade-cap precedence) with LONG+SHORT records on different Managers
//    M3  runSingleAction(open) multi-position behaviour: positions on other
//        markets do NOT block, stale records free their slot, cap/pending codes
//    M4  independent per-position CLOSES across different Managers: verified
//        close clears only its own record, a blocked sibling is kept untouched
//    M5  PHASE-1 style auto-close loop (closeActivePosition) processes each
//        record independently on a multi-manager provider (dry — no TX)
//
//  NO TRANSACTIONS: state isolation + TX guard come from the first import;
//  close/open impls are stubbed where a send would otherwise be required.
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
// NEMESIS/USDT — the legacy record's market
const MGR_N = "0x186eA8d6c4CBbcEd1466338B1Ed41C7EF331f480";
const POOL_N = "0xccA34A36A37941bF54eE0eEFe5a86f98d93ACDd0";
// market A — ETH/USDT (different Manager)
const MGR_A = "0x4E99476c0124843816E981d0f2279214aebaB177";
const POOL_A = "0xd550e940dc278F224e5D6BaEb7302D696D1A76ca";
// market B — USDC/USDT (different Manager)
const MGR_B = "0xE21255b15529F1BD184A8d982B8Ca8817debcbb5";
const POOL_B = "0x7dF706Db7F8dbb7C32A3e0D6F4d488383522a335";
// market C — DAI/USDT (third market, for gate tests only)
const MGR_C = "0x1bd5b0Fd0C40Ed03f658939f2B5318679519f8b3";
const POOL_C = "0x8f80D497F5E3266e3Adf6a67572878c15B0F7ad4";

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

// ── ABIs (exact fragments from autoTrader.js / hold-window suite) ──────────
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
  o.debtAsset ?? POOL_A,
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
  o.realizedPnl ?? 1234567n,
  o.closePrice ?? 8120n,
  o.projectedHealthBps ?? 2n ** 256n - 1n,
];

// ── provider stubs ─────────────────────────────────────────────────────────
// Offline: ANY provider call is a test bug — fail loud.
const failProvider = {
  call: async () => { throw new Error("network call in offline test"); },
  getBlockNumber: async () => 0,
  getTransactionReceipt: async () => null,
  getTransaction: async () => undefined,
};

// Multi-manager mock (M5): answers chain reads per Manager for its own ids.
const makeMultiProvider = () => {
  const counters = { positions: 0, debt: 0, risk: 0, preview: 0, decimals: 0, symbol: 0, unknown: [] };
  const tokenMeta = {
    [USDT.toLowerCase()]: { symbol: "USDT", decimals: 6 },
    [POOL_A.toLowerCase()]: { symbol: "NLP", decimals: 18 },
    [POOL_B.toLowerCase()]: { symbol: "NLP", decimals: 18 },
  };
  const posTable = {
    [MGR_A.toLowerCase()]: { "401": posTuple({ isLong: true }) },
    [MGR_B.toLowerCase()]: { "402": posTuple({ isLong: false }) },
  };
  const riskTable = {
    "401": { positionId: 401n, isLong: true },
    "402": { positionId: 402n, isLong: false },
  };
  return {
    counters,
    call: async ({ to, data }) => {
      const sel = String(data).slice(0, 10);
      const toL = String(to || "").toLowerCase();
      const meta = tokenMeta[toL];
      if (meta) {
        if (sel === SEL.decimals) { counters.decimals++; return iface.encodeFunctionResult("decimals", [meta.decimals]); }
        if (sel === SEL.symbol) { counters.symbol++; return iface.encodeFunctionResult("symbol", [meta.symbol]); }
        throw new Error(`mock: unexpected token selector ${sel} on ${toL}`);
      }
      const table = posTable[toL];
      if (table) {
        if (sel === SEL.positions) {
          counters.positions++;
          const tx = iface.parseTransaction({ data });
          const id = String(tx.args[0]);
          const tuple = table[id];
          if (!tuple) throw new Error(`mock: positions(${id}) not on manager ${toL}`);
          return iface.encodeFunctionResult("positions", tuple);
        }
        if (sel === SEL.getPositionDebt) { counters.debt++; return iface.encodeFunctionResult("getPositionDebt", [4060439166n]); }
        if (sel === SEL.getPositionRisk) {
          counters.risk++;
          const tx = iface.parseTransaction({ data });
          const id = String(tx.args[0]);
          const over = riskTable[id];
          if (!over) throw new Error(`mock: getPositionRisk(${id}) not on manager ${toL}`);
          return iface.encodeFunctionResult("getPositionRisk", [riskTuple(over)]);
        }
        if (sel === SEL.previewClosePosition) { counters.preview++; return iface.encodeFunctionResult("previewClosePosition", [previewTuple()]); }
        if (sel === SEL.getHealthFactor) throw new Error("mock: getHealthFactor unsupported (hf → null)");
        counters.unknown.push(`${toL}:${sel}`);
        throw new Error(`mock: unexpected manager selector ${sel}`);
      }
      counters.unknown.push(`${toL}:${sel}`);
      throw new Error(`mock: unexpected to ${toL}`);
    },
    getTransactionReceipt: async () => null,
    getTransaction: async () => undefined,
    getNetwork: async () => ({ chainId: 11155111n }),
    getBlockNumber: async () => 1,
    getCode: async () => "0x6080",
  };
};

// ── trader factory (state lives in the SCRATCH file) ───────────────────────
const makeTrader = (cfg = {}, { provider = failProvider, keepActive = false } = {}) => {
  const logs = [];
  let p = provider;
  const t = new AutoTrader({
    accounts: [{ address: WALLET_ADDR, privateKey: DUMMY_PK }],
    selectedWalletIndex: 0,
    proxies: [],
    rpcUrl: "http://127.0.0.1:9",
    chainId: 11155111,
    config: {
      dryRun: false, maxLeverage: 5, leverageMax: 10, deadlineSeconds: 1200, slippageBps: 50,
      maxTradesPerRun: 10, ...cfg,
    },
    confirmedPools: {},
    getProvider: () => (p ?? (p = provider)),
    log: (m, lvl) => logs.push({ m: String(m), lvl }),
  });
  if (!keepActive) t.state.activePositions = []; // determinism — never inherit the seeded record
  t._logs = logs;
  t._logText = () => logs.map(l => l.m).join("\n");
  return t;
};

const rec = (id, side, mgr, pool, market, over = {}) => ({
  positionId: id, side, collateralToken: USDT,
  collateralAmount: "1000000", debtAmount: "4060439166", leverage: 2,
  managerAddr: mgr, poolAddr: pool, marketSymbol: market,
  openedAt: Date.now() - 120_000, txHash: "0x" + "ab".repeat(32),
  closeRetry: null, closeAttempts: 0, ...over,
});

const activeReport = (id, mgr, over = {}) => ({
  ok: true, found: true, active: true, positionId: String(id),
  ours: true, user: WALLET_ADDR,
  side: over.isLong ? "LONG" : "SHORT",
  collateralAmount: "1000000", currentDebt: "4060439166",
  managerAddr: mgr, ...over,
});

// ═══════════════════════════════════════════════════════════════════════════
// M1 — legacy migration on load + persistence of the NEW shape only
// ═══════════════════════════════════════════════════════════════════════════
section("M1: legacy state migrates on load; saveState writes ONLY the new shape");

{
  const legacy = {
    activePosition: {
      positionId: 134, side: "LONG", collateralToken: USDT, collateralAmount: "16873680",
      paymentToken: USDT, leverage: 2, openedAt: Date.now() - 3_600_000,
      txHash: "0x" + "cd".repeat(32), marketSymbol: "NEMESIS/USDT",
      managerAddr: MGR_N, poolAddr: POOL_N,
    },
    closeRetry: { attempts: 5, sig: "1:2:3", code: "CLOSE_BLOCKED", lastAttemptAt: 1760000000000, nextAt: 0 },
    closeAttempts: 76,
    sessionStats: { opens: 2088, closes: 2083 },
    lastCycleTime: 0, lastSide: "LONG",
    rotation: { recentMarkets: [], counts: {} },
    directionDisabled: {},
  };
  fs.writeFileSync(TEST_STATE_FILE, JSON.stringify(legacy, null, 2));

  const t = makeTrader({ maxOpenPositions: 5 }, { keepActive: true });
  check("M1: legacy activePosition → activePositions[0]",
    Array.isArray(t.state.activePositions) && t.state.activePositions.length === 1
    && t.state.activePositions[0].positionId === 134,
    `len=${t.state.activePositions?.length} id=${t.state.activePositions?.[0]?.positionId}`);
  const r0 = t.state.activePositions[0];
  check("M1: global closeRetry/closeAttempts moved onto the record",
    r0.closeRetry?.attempts === 5 && r0.closeRetry?.code === "CLOSE_BLOCKED" && r0.closeAttempts === 76,
    `retry=${JSON.stringify(r0.closeRetry)} attempts=${r0.closeAttempts}`);
  check("M1: legacy top-level keys deleted",
    !("activePosition" in t.state) && !("closeRetry" in t.state) && !("closeAttempts" in t.state));
  check("M1: sessionStats preserved through migration",
    t.state.sessionStats.opens === 2088 && t.state.sessionStats.closes === 2083);

  // Persist through a REAL production path (saveState inside _trackOpenedPosition).
  t._trackOpenedPosition({
    positionId: 555, side: "SHORT", collateralToken: USDT, collateralAmount: "1",
    paymentToken: USDT, leverage: 2, openedAt: Date.now(), txHash: null,
    marketSymbol: "USDC/USDT", managerAddr: MGR_B, poolAddr: POOL_B,
  }, { adopted: true });
  const p = JSON.parse(fs.readFileSync(TEST_STATE_FILE, "utf8"));
  check("M1: saved file is the NEW shape (array, no legacy keys)",
    Array.isArray(p.activePositions) && !("activePosition" in p)
    && !("closeRetry" in p) && !("closeAttempts" in p),
    `keys=${Object.keys(p).join(",")}`);
  check("M1: migrated record + adopted record both persisted",
    p.activePositions?.length === 2
    && p.activePositions[0].positionId === 134
    && p.activePositions[0].closeRetry?.attempts === 5
    && p.activePositions[0].closeAttempts === 76
    && p.activePositions[1].positionId === 555
    && p.activePositions[1].adoptedFromChain === true,
    JSON.stringify(p.activePositions?.map(x => x.positionId)));
  check("M1: adopted open did not bump sessionStats.opens", p.sessionStats.opens === 2088,
    `opens=${p.sessionStats.opens}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// M2 — _canOpenNew gate: cap, per-market slot, pending, trade cap
// ═══════════════════════════════════════════════════════════════════════════
section("M2: _canOpenNew — global cap, per-market slot, pending, trade-cap precedence");

{
  const t = makeTrader({ maxOpenPositions: 2, maxTradesPerRun: 10 });
  t.state.activePositions = [
    rec(201, "LONG", MGR_A, POOL_A, "ETH/USDT"),
    rec(202, "SHORT", MGR_B, POOL_B, "USDC/USDT"),
  ];
  let g = await t._canOpenNew();
  check("M2: cap full (2/2, two Managers, LONG+SHORT) → MAX_OPEN_POSITIONS",
    g?.ok === false && g?.code === "MAX_OPEN_POSITIONS", JSON.stringify(g));

  t.config.maxOpenPositions = 3;
  g = await t._canOpenNew({ market: { poolAddr: POOL_A, symbol: "ETH/USDT" } });
  check("M2: the SAME market already tracked → MARKET_BUSY",
    g?.ok === false && g?.code === "MARKET_BUSY", JSON.stringify(g));

  g = await t._canOpenNew({ market: { poolAddr: POOL_C, symbol: "DAI/USDT" } });
  check("M2: a THIRD market free while2 positions tracked → ok",
    g?.ok === true, JSON.stringify(g));

  t._opensThisRun = 1;
  t.config.maxTradesPerRun = 1;
  g = await t._canOpenNew({ market: { poolAddr: POOL_C, symbol: "DAI/USDT" } });
  check("M2: trade cap takes precedence over a free market → TRADE_CAP",
    g?.ok === false && g?.code === "TRADE_CAP", JSON.stringify(g));

  const tp = makeTrader({ maxOpenPositions: 3, maxTradesPerRun: 10 });
  tp.state.activePositions = [{ ...rec(203, "SHORT", MGR_A, POOL_A, "ETH/USDT"), pendingOpen: true, positionId: null }];
  g = await tp._canOpenNew();
  check("M2: a pending open blocks the next open → OPEN_PENDING",
    g?.ok === false && g?.code === "OPEN_PENDING", JSON.stringify(g));
}

// ═══════════════════════════════════════════════════════════════════════════
// M3 — runSingleAction(open): multi-position gating through the real flow
// ═══════════════════════════════════════════════════════════════════════════
section("M3: runSingleAction(open) — multi-position gating (never a global block)");

{
  // M3a — 2 positions on different Managers do not block a 3rd open.
  const t = makeTrader({ maxOpenPositions: 5, maxTradesPerRun: 10 });
  t.state.activePositions = [
    rec(101, "LONG", MGR_N, POOL_N, "NEMESIS/USDT"),
    rec(102, "SHORT", MGR_A, POOL_A, "ETH/USDT"),
  ];
  t.describePosition = async (id) => activeReport(id, String(id) === "101" ? MGR_N : MGR_A,
    { isLong: String(id) === "101" });
  let openCalled = false;
  t.prepareAndOpen = async () => { openCalled = true; return true; };
  const r = await t.runSingleAction({ action: "open", side: "SHORT", confirm: false });
  check("M3a: cap 5 with 2 tracked → a further open is PLANNED (multi-position)",
    r.code === "OPEN_PLANNED" && openCalled && t.state.activePositions.length === 2,
    `code=${r.code} tracked=${t.state.activePositions.length}`);

  // M3b — cap full → OPEN_EXISTS, prepareAndOpen never called.
  const t2 = makeTrader({ maxOpenPositions: 2, maxTradesPerRun: 10 });
  t2.state.activePositions = [
    rec(111, "LONG", MGR_N, POOL_N, "NEMESIS/USDT"),
    rec(112, "SHORT", MGR_A, POOL_A, "ETH/USDT"),
  ];
  t2.describePosition = async (id) => activeReport(id, String(id) === "111" ? MGR_N : MGR_A);
  let open2 = false;
  t2.prepareAndOpen = async () => { open2 = true; return true; };
  const r2 = await t2.runSingleAction({ action: "open", side: "LONG", confirm: false });
  check("M3b: cap 2/2 → OPEN_EXISTS and prepareAndOpen never called",
    r2.code === "OPEN_EXISTS" && !open2, `code=${r2.code}`);

  // M3c — a pending open serializes a repeat open.
  const t3 = makeTrader({ maxOpenPositions: 5, maxTradesPerRun: 10 });
  t3.state.activePositions = [{ ...rec(121, "SHORT", MGR_A, POOL_A, "ETH/USDT"), pendingOpen: true }];
  t3._settlePendingOpen = async () => ({ status: "PENDING", done: false });
  let open3 = false;
  t3.prepareAndOpen = async () => { open3 = true; return true; };
  const r3 = await t3.runSingleAction({ action: "open", side: "LONG", confirm: false });
  check("M3c: unconfirmed open blocks a repeat → OPEN_PENDING",
    r3.code === "OPEN_PENDING" && !open3, `code=${r3.code}`);

  // M3d — stale record frees its slot (countClose=false); sibling keeps theirs.
  const t4 = makeTrader({ maxOpenPositions: 2, maxTradesPerRun: 10 });
  t4.state.activePositions = [
    rec(131, "SHORT", MGR_A, POOL_A, "ETH/USDT"),
    rec(132, "LONG", MGR_B, POOL_B, "USDC/USDT"),
  ];
  t4.describePosition = async (id) => String(id) === "131"
    ? { ok: true, found: true, active: false, positionId: "131", ours: true, user: WALLET_ADDR }
    : activeReport(id, MGR_B, { isLong: true });
  const closesBefore = t4.state.sessionStats.closes;
  let open4 = false;
  t4.prepareAndOpen = async () => { open4 = true; return true; };
  const r4 = await t4.runSingleAction({ action: "open", side: "LONG", confirm: false });
  check("M3d: stale record cleared, sibling KEEPS its slot",
    t4.state.activePositions.length === 1
    && t4.state.activePositions[0]?.positionId === 132,
    `tracked=${JSON.stringify(t4.state.activePositions.map(x => x.positionId))}`);
  check("M3d: stale clear never counts a close",
    t4.state.sessionStats.closes === closesBefore, `closes=${t4.state.sessionStats.closes}`);
  check("M3d: open proceeds once the stale slot is free → OPEN_PLANNED",
    open4 && r4.code === "OPEN_PLANNED", `code=${r4.code}`);

  // M3e — per-MARKET slot at CLI level: same pinned market refused, free market planned.
  const t5 = makeTrader({ maxOpenPositions: 3, maxTradesPerRun: 10 });
  // marketSymbol-only record (no manager/pool → reconcile skips it safely)
  t5.state.activePositions = [{
    positionId: 141, side: "SHORT", collateralToken: USDT, collateralAmount: "1",
    leverage: 2, openedAt: Date.now() - 60_000, txHash: null, marketSymbol: "ETH/USDT",
  }];
  let open5 = false;
  t5.prepareAndOpen = async () => { open5 = true; return true; };
  const r5a = await t5.runSingleAction({ action: "open", side: "LONG", marketSymbol: "ETH/USDT", confirm: false });
  check("M3e: pinned SAME market (busy) → OPEN_EXISTS, nothing prepared",
    r5a.code === "OPEN_EXISTS" && !open5, `code=${r5a.code}`);
  const r5b = await t5.runSingleAction({ action: "open", side: "LONG", marketSymbol: "DAI/USDT", confirm: false });
  check("M3e: a FREE market opens despite the busy one → OPEN_PLANNED (per-market, not global)",
    r5b.code === "OPEN_PLANNED" && open5, `code=${r5b.code}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// M4 — independent CLOSES across different Managers via runSingleAction
// ═══════════════════════════════════════════════════════════════════════════
section("M4: independent per-position closes across different Managers");

{
  const t = makeTrader({ maxOpenPositions: 5, maxTradesPerRun: 10 });
  const a = rec(301, "LONG", MGR_A, POOL_A, "ETH/USDT");
  const b = rec(302, "SHORT", MGR_B, POOL_B, "USDC/USDT");
  t.state.activePositions = [a, b];
  const ph = {};
  t.describePosition = async (id) => {
    const k = String(id);
    if (k === "301") {
      const n = (ph[k] = (ph[k] ?? 0) + 1);
      return n === 1
        ? activeReport(301, MGR_A, { isLong: true })                                   // pre-gate: active
        : { ok: true, found: true, active: false, positionId: "301", ours: true };      // post-impl: closed
    }
    return activeReport(k, k === "302" ? MGR_B : MGR_A, { isLong: k === "302" ? false : true });
  };
  const closesBefore = t.state.sessionStats.closes;
  t._closePositionImpl = async (args) => {
    const id = Number(args.positionId);
    if (id === 301) return { ok: true, closed: true, verified: true, txHash: "0x" + "ee".repeat(32) };
    return { failed: true, clearState: false, code: "CLOSE_PREFLIGHT_0xf71ff020", reason: "liquidity" };
  };

  const bSnapshot = JSON.stringify(b);
  const r1 = await t.runSingleAction({ action: "close", positionId: 301, confirm: true });
  check("M4: verified close of #301 (mgrA) → ok, only that record cleared, closes++",
    r1.ok === true && t.state.activePositions.length === 1
    && t.state.activePositions[0] === b
    && t.state.sessionStats.closes === closesBefore + 1,
    `ok=${r1.ok} tracked=${JSON.stringify(t.state.activePositions.map(x => x.positionId))} closes=${t.state.sessionStats.closes}`);
  check("M4: sibling #302 (mgrB) byte-identical after #301 closed",
    JSON.stringify(b) === bSnapshot);

  const closesAfter301 = t.state.sessionStats.closes;
  const r2 = await t.runSingleAction({ action: "close", positionId: 302, confirm: true });
  check("M4: liquidity-blocked close of #302 → ok=false, record KEPT, closes unchanged",
    r2.ok === false && t.state.activePositions.length === 1
    && t.state.activePositions[0].positionId === 302
    && t.state.sessionStats.closes === closesAfter301,
    `ok=${r2.ok} code=${r2.applied?.code} closes=${t.state.sessionStats.closes}`);
  check("M4: blocked close surfaced the contract error code",
    r2.applied?.code === "CLOSE_PREFLIGHT_0xf71ff020", `applied=${JSON.stringify(r2.applied)}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// M5 — PHASE-1 style auto-close loop: each record independently (dry, no TX)
// ═══════════════════════════════════════════════════════════════════════════
section("M5: closeActivePosition loops EACH record independently (multi-manager, dry)");

{
  const provider = makeMultiProvider();
  const t = makeTrader(
    { dryRun: true, maxOpenPositions: 5, minHoldSeconds: 0, maxHoldSeconds: 0 },
    { provider },
  );
  const a = rec(401, "LONG", MGR_A, POOL_A, "ETH/USDT", { isLong: true });
  const b = rec(402, "SHORT", MGR_B, POOL_B, "USDC/USDT");
  t.state.activePositions = [a, b];
  const closesBefore = t.state.sessionStats.closes;

  // Same loop shape as runCycle PHASE 1: snapshot + identity includes-check.
  const outcomes = [];
  for (const p of [...t.state.activePositions]) {
    if (!t.state.activePositions.includes(p)) continue;
    outcomes.push({ id: p.positionId, out: await t.closeActivePosition(p) });
  }

  check("M5: both records processed, both outcomes independent → ok (dry)",
    outcomes.length === 2 && outcomes.every(o => o.out?.ok === true && o.out?.dryRun === true),
    JSON.stringify(outcomes.map(o => [o.id, o.out?.code, o.out?.dryRun ?? null])));
  check("M5: log shows Would CLOSE for EACH id",
    /Would CLOSE position #401/.test(t._logText()) && /Would CLOSE position #402/.test(t._logText()),
    t._logText().split("\n").filter(l => l.includes("Would CLOSE")).join(" | "));
  check("M5: chain reads hit the OWN manager for each id (per-position manager)",
    provider.counters.positions >= 2, `positions=${provider.counters.positions}`);
  check("M5: dry keeps BOTH records, no backoff, closes untouched",
    t.state.activePositions.length === 2 && a.closeRetry == null && b.closeRetry == null
    && t.state.sessionStats.closes === closesBefore,
    `tracked=${JSON.stringify(t.state.activePositions.map(x => x.positionId))} closes=${t.state.sessionStats.closes}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// purity — real state / journal / config untouched, isolation intact
// ═══════════════════════════════════════════════════════════════════════════
section("M6: purity: repo state, journal and config unchanged");

check("auto-trader-state.json unchanged", sha(STATE_FILE) === H.state);
check("tx-journal.jsonl unchanged", sha(JOURNAL_FILE) === H.journal);
check("config.json unchanged by this run", sha(CONFIG_FILE) === H.config);
check("real state hash helper agrees", realStateHash() === H.real);
check("test state file is a SCRATCH path (isolated from the real one)",
  path.resolve(TEST_STATE_FILE) !== path.resolve("auto-trader-state.json"), TEST_STATE_FILE);

console.log(`\nRESULT: ${pass}/${pass + fail} passed, ${fail} failed`);
if (fail) { console.log("FAILURES:"); process.exitCode = 1; }
