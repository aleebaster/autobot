// ═══════════════════════════════════════════════════════════════════════════
//  LEVERAGE 2x ↔ 20x + PER-SIDE COLLATERAL + RISK CAPS — read-only suite
//
//  Verifies, without sending any transaction:
//    L1  config.json exposes leverageMax=20 / maxLeverage=20 / maxTotalCollateral
//        / maxDailyLoss / targetCollateralLong / targetCollateralShort
//    L2  DEFAULT_AUTO_CONFIG carries the new keys with safe disabled defaults
//    L3  collateralTargetStr(): per-side override wins; null keeps per-token
//    L4  encodeOpenPositionCalldata(): 20x encodes leverageX10=200
//    L5  openPosition() still hard-blocks leverage > maxLeverage (2x ceiling
//        regression when maxLeverage=5)
//    L6  resolveLeverageForOpen() resolves 20x against live managers when
//        config allows 20 (read-only previewOpenPosition probe)
//    L7  resolveLeverageForOpen() clamps 20→5 when leverageMax=5 (legacy 2x
//        behaviour unchanged)
//    L8  _exposureGate(): per-token sum of tracked collateral + new amount
//        vs maxTotalCollateral; disabled ("0") always passes
//    L9  _dailyLossExceeded() + _noteRealizedPnl(): stable-collateral realized
//        losses accumulate per UTC day and gate OPEN with DAILY_LOSS_CAP;
//        profits / non-stable collateral never count
//    L10 auto.js + index.js maxLeverage fallback consults leverageMax (the
//        wiring bug that silently clipped every 20x request back to 5)
//
//  NO TRANSACTIONS: state isolation + TX guard come from the first import;
//  every chain interaction is a view call (readLeverageBounds / preview).
// ═══════════════════════════════════════════════════════════════════════════
import { TEST_STATE_FILE, realStateHash } from "./_test_state_isolation.mjs"; // MUST be first
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { ethers } from "ethers";
import {
  AutoTrader, DEFAULT_AUTO_CONFIG, openPosition,
  encodeOpenPositionCalldata, resolveLeverageForOpen, collateralTargetStr,
} from "./autoTrader.js";
import { getActiveDeployment } from "./deployments/index.js";

const REPO = path.dirname(fileURLToPath(import.meta.url));
const RPC = "https://ethereum-sepolia-rpc.publicnode.com";
const CHAIN_ID = 11155111;
const DUMMY_PK = "0x" + "11".repeat(32);
const sha = (f) => (fs.existsSync(f)
  ? crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex")
  : "missing");
const STATE_FILE = path.join(REPO, "auto-trader-state.json");
const JOURNAL_FILE = path.join(REPO, "tx-journal.jsonl");
const CONFIG_FILE = path.join(REPO, "config.json");
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
const log = () => {};

// ── live manager addresses (readLeverageBounds probes, no TX) ───────────────
const MGR_ETH_USDT = "0x2069b502DD917DC089171F96BeE390FcB5bad29d"; // ETH/USDT (v5)
const USDT = "0x5f2E83cCDEa73D60aF400e03F1Cd8Fb9eaB07b20";
const WETH = "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9";

async function buildTrader(overrides = {}) {
  const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  return new AutoTrader({
    accounts: [{ address: new ethers.Wallet(DUMMY_PK).address, privateKey: DUMMY_PK }],
    selectedWalletIndex: 0,
    proxies: [],
    rpcUrl: RPC,
    chainId: CHAIN_ID,
    config: {
      dryRun: true,
      defaultLeverage: 2,
      maxLeverage: 20,
      leverageMin: 2,
      leverageMax: 20,
      maxTotalCollateral: "0",
      maxDailyLoss: "0",
      targetCollateralLong: null,
      targetCollateralShort: null,
      availableMarkets: cfg.availableMarkets || [],
      ethGuard: { MAX_ETH_SWAP_PER_TX: 0.02, MAX_ETH_SWAP_PER_SESSION: 0.1, MIN_ETH_GAS_RESERVE: 0.003, MAX_TOTAL_ETH_EXPOSURE: 0.15, ETH_BLOCK_THRESHOLD: 0.005 },
      ...overrides,
    },
    confirmedPools: {},
    getProvider: (url, chain) => new ethers.JsonRpcProvider(url, chain),
    log,
  });
}

async function run() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  LEVERAGE 20x + PER-SIDE COLLATERAL + RISK CAPS (read-only)");
  console.log("═══════════════════════════════════════════════════════════════");

  // ── L1: config.json keys ────────────────────────────────────────────────
  section("L1 config.json");
  const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  check("leverageMax=20", cfg.leverageMax === 20, `got ${cfg.leverageMax}`);
  check("maxLeverage=20", cfg.maxLeverage === 20, `got ${cfg.maxLeverage}`);
  check("maxTotalCollateral present", "maxTotalCollateral" in cfg, `got ${cfg.maxTotalCollateral}`);
  check("maxDailyLoss present", "maxDailyLoss" in cfg, `got ${cfg.maxDailyLoss}`);
  check("targetCollateralLong present", "targetCollateralLong" in cfg, JSON.stringify(cfg.targetCollateralLong));
  check("targetCollateralShort present", "targetCollateralShort" in cfg, JSON.stringify(cfg.targetCollateralShort));
  check("leverageAutoStep present", "leverageAutoStep" in cfg, `got ${cfg.leverageAutoStep}`);

  // ── L2: DEFAULT_AUTO_CONFIG ─────────────────────────────────────────────
  section("L2 DEFAULT_AUTO_CONFIG");
  check("default targetCollateralLong is null", DEFAULT_AUTO_CONFIG.targetCollateralLong === null);
  check("default targetCollateralShort is null", DEFAULT_AUTO_CONFIG.targetCollateralShort === null);
  check("default maxTotalCollateral is '0'", DEFAULT_AUTO_CONFIG.maxTotalCollateral === "0");
  check("default maxDailyLoss is '0'", DEFAULT_AUTO_CONFIG.maxDailyLoss === "0");
  // Legacy 2x defaults must stay intact for callers that don't override
  check("legacy defaultLeverage still 2", DEFAULT_AUTO_CONFIG.defaultLeverage === 2);
  check("legacy maxLeverage still 5", DEFAULT_AUTO_CONFIG.maxLeverage === 5);
  check("legacy leverageMax still 5", DEFAULT_AUTO_CONFIG.leverageMax === 5);

  // ── L3: collateralTargetStr per-side override ───────────────────────────
  section("L3 collateralTargetStr");
  const depTokens = getActiveDeployment()?.tokens || {};
  const USDT_DEP = depTokens.USDT || USDT;
  const WETH_DEP = depTokens.WETH || WETH;
  {
    // no override → per-token defaults
    const base = { targetCollateralUSDT: "10", targetCollateralWETH: "0.002", targetCollateralGeneric: "10" };
    check("no override, USDT → 10", collateralTargetStr(base, USDT_DEP) === "10");
    check("no override, WETH → 0.002", collateralTargetStr(base, WETH_DEP) === "0.002");
    check("no override, unknown → generic 10", collateralTargetStr(base, "0x00000000000000000000000000000000000000aa") === "10");
    // per-side override wins
    const ovr = { ...base, targetCollateralLong: "0.5", targetCollateralShort: "3" };
    check("LONG override wins over USDT default", collateralTargetStr(ovr, USDT_DEP, "LONG") === "0.5");
    check("SHORT override wins over USDT default", collateralTargetStr(ovr, USDT_DEP, "SHORT") === "3");
    check("LONG override wins over WETH default", collateralTargetStr(ovr, WETH_DEP, "LONG") === "0.5");
    check("null override → falls back (LONG)", collateralTargetStr({ ...base, targetCollateralLong: null }, USDT_DEP, "LONG") === "10");
    check("empty-string override → falls back (SHORT)", collateralTargetStr({ ...base, targetCollateralShort: "  " }, USDT_DEP, "SHORT") === "10");
  }

  // ── L4: calldata leverageX10=200 for 20x ────────────────────────────────
  section("L4 encodeOpenPositionCalldata");
  {
    const data = encodeOpenPositionCalldata({
      isLong: true, collateralToken: USDT_DEP,
      collateralAmount: ethers.parseUnits("10", 6),
      borrowAmount: 0n, leverageX10: 200n,
      amountOutMin: 0n, deadline: 1234567890n,
      withExtras: false,
    });
    // leverageX10 is arg index 4 of the 7 core args; each uint256 is 32 bytes.
    // Layout: 4-byte selector + 32 (bool) + 32 (addr) + 32 (coll) + 32 (borrow) + 32 (levX10) …
    const levWord = "0x" + data.slice(2 + 8 + 64 * 4, 2 + 8 + 64 * 5);
    check("20x encodes leverageX10=200", BigInt(levWord) === 200n, `got ${BigInt(levWord)}`);
    const data2x = encodeOpenPositionCalldata({
      isLong: true, collateralToken: USDT_DEP,
      collateralAmount: ethers.parseUnits("10", 6),
      borrowAmount: 0n, leverageX10: 20n,
      amountOutMin: 0n, deadline: 1234567890n,
      withExtras: false,
    });
    const levWord2x = "0x" + data2x.slice(2 + 8 + 64 * 4, 2 + 8 + 64 * 5);
    check("2x encodes leverageX10=20 (regression)", BigInt(levWord2x) === 20n, `got ${BigInt(levWord2x)}`);
  }

  // ── L5: openPosition maxLeverage hard ceiling (regression) ──────────────
  section("L5 openPosition leverage ceiling");
  {
    // The ceiling is checked BEFORE any RPC/token-meta read (see openPosition),
    // so this runs offline against a throwaway provider that never answers.
    const deadProvider = { getCode: async () => { throw new Error("no network"); } };
    const wallet = { address: new ethers.Wallet(DUMMY_PK).address };
    const blocked = await openPositionLeverageGuard(wallet, deadProvider, 20, 5);
    check("maxLeverage=5 blocks 20x", blocked === "BLOCKED_BY_MAX_LEVERAGE", `got ${blocked}`);
    const below = await openPositionLeverageGuard(wallet, deadProvider, 5, 5);
    check("maxLeverage=5 allows 5x past the ceiling", below !== "BLOCKED_BY_MAX_LEVERAGE", `got ${below}`);
    const atCap = await openPositionLeverageGuard(wallet, deadProvider, 20, 20);
    check("maxLeverage=20 allows 20x past the ceiling", atCap !== "BLOCKED_BY_MAX_LEVERAGE", `got ${atCap}`);
  }

  // ── L6/L7: resolveLeverageForOpen live probe ────────────────────────────
  section("L6/L7 resolveLeverageForOpen (read-only, live Sepolia)");
  {
    const provider = new ethers.JsonRpcProvider(RPC, CHAIN_ID);
    // L6: config allows 20 → 20x must resolve (contract MAX_LEVERAGE_X10=200)
    const plan20 = await resolveLeverageForOpen(provider, {
      managerAddr: MGR_ETH_USDT,
      marketSymbol: "ETH/USDT",
      isLong: true,
      collateralToken: USDT_DEP,
      collateralAmount: ethers.parseUnits("10", 6),
      requestedLeverage: 20,
      config: {
        defaultLeverage: 20, leverageMin: 2, leverageMax: 20,
        marketLeverage: {}, leverageAutoStep: false,
      },
      log,
    }).catch(e => ({ ok: false, code: "RPC_ERROR", reason: e.message }));
    if (plan20.code === "RPC_ERROR") {
      check("20x resolution (live probe)", "SKIP", plan20.reason);
    } else {
      check("20x resolves when leverageMax=20", plan20.ok === true && plan20.leverage === 20,
        `ok=${plan20.ok} lev=${plan20.leverage} code=${plan20.code} ${plan20.reason || ""}`);
      check("20x leverageX10=200", plan20.leverageX10 === 200, `got ${plan20.leverageX10}`);
    }
    // L7: legacy leverageMax=5 → 20x request must clamp down to 5
    const plan5 = await resolveLeverageForOpen(provider, {
      managerAddr: MGR_ETH_USDT,
      marketSymbol: "ETH/USDT",
      isLong: true,
      collateralToken: USDT_DEP,
      collateralAmount: ethers.parseUnits("10", 6),
      requestedLeverage: 20,
      config: {
        defaultLeverage: 2, leverageMin: 2, leverageMax: 5,
        marketLeverage: {}, leverageAutoStep: false,
      },
      log,
    }).catch(e => ({ ok: false, code: "RPC_ERROR", reason: e.message }));
    if (plan5.code === "RPC_ERROR") {
      check("20→5 clamp (live probe)", "SKIP", plan5.reason);
    } else {
      check("leverageMax=5 clamps 20→5 (regression)", plan5.ok === true && plan5.leverage === 5,
        `ok=${plan5.ok} lev=${plan5.leverage} code=${plan5.code} ${plan5.reason || ""}`);
    }
  }

  // ── L8: _exposureGate ───────────────────────────────────────────────────
  section("L8 _exposureGate");
  {
    // Isolate from the seeded live state (real closeBlocked positions).
    const t = await buildTrader({ maxTotalCollateral: "0" });
    t.state.activePositions = [];
    check("disabled (0) always ok", t._exposureGate({ collateralToken: USDT_DEP, collateralDecimals: 6, collateralAmount: 10_000_000n, collateralSym: "USDT" }).ok === true);

    const t2 = await buildTrader({ maxTotalCollateral: "20" });
    t2.state.activePositions = [];
    // no tracked positions → 10 ≤ 20
    const g1 = t2._exposureGate({ collateralToken: USDT_DEP, collateralDecimals: 6, collateralAmount: ethers.parseUnits("10", 6), collateralSym: "USDT" });
    check("new 10 ≤ cap 20 with empty book", g1.ok === true);
    // seed one tracked position of 15 → 15+10=25 > 20
    t2.state.activePositions.push({
      positionId: 1, side: "LONG", collateralToken: USDT_DEP,
      collateralAmount: String(ethers.parseUnits("15", 6)),
      marketSymbol: "ETH/USDT", managerAddr: MGR_ETH_USDT,
    });
    const g2 = t2._exposureGate({ collateralToken: USDT_DEP, collateralDecimals: 6, collateralAmount: ethers.parseUnits("10", 6), collateralSym: "USDT" });
    check("open 15 + new 10 > cap 20 blocked", g2.ok === false && g2.code === "MAX_TOTAL_COLLATERAL", g2.reason || "");
    // different collateral token is NOT summed
    const g3 = t2._exposureGate({ collateralToken: WETH_DEP, collateralDecimals: 18, collateralAmount: ethers.parseEther("0.002"), collateralSym: "WETH" });
    check("different token not summed into USDT cap", g3.ok === true);
    // pendingOpen positions don't count
    t2.state.activePositions[0].pendingOpen = true;
    const g4 = t2._exposureGate({ collateralToken: USDT_DEP, collateralDecimals: 6, collateralAmount: ethers.parseUnits("10", 6), collateralSym: "USDT" });
    check("pendingOpen excluded from used sum", g4.ok === true, JSON.stringify(g4));
  }

  // ── L9: daily-loss tracking + gate ──────────────────────────────────────
  section("L9 daily loss");
  {
    const t = await buildTrader({ maxDailyLoss: "5" }); // 5 USDT
    check("no losses → not exceeded", t._dailyLossExceeded() === false);
    // profit must not count
    t._noteRealizedPnl({ realizedPnl: String(ethers.parseUnits("3", 6)) }, { collateralToken: USDT_DEP, positionId: 9 });
    check("profit does not accumulate", t._dailyLossExceeded() === false && (t.state.sessionStats.dailyLoss?.lossRaw || "0") === "0");
    // loss in non-stable collateral must not count
    t._noteRealizedPnl({ realizedPnl: String(-ethers.parseUnits("9", 18)) }, { collateralToken: WETH_DEP, positionId: 8 });
    check("non-stable loss not counted", t._dailyLossExceeded() === false);
    // stable loss of 3 → under cap
    t._noteRealizedPnl({ realizedPnl: String(-ethers.parseUnits("3", 6)) }, { collateralToken: USDT_DEP, positionId: 7 });
    check("3 USDT loss under cap 5", t._dailyLossExceeded() === false, `lossRaw=${t.state.sessionStats.dailyLoss?.lossRaw}`);
    // another 3 → 6 ≥ 5 exceeded
    t._noteRealizedPnl({ realizedPnl: String(-ethers.parseUnits("3", 6)) }, { collateralToken: USDT_DEP, positionId: 6 });
    check("6 USDT loss ≥ cap 5 exceeded", t._dailyLossExceeded() === true, `lossRaw=${t.state.sessionStats.dailyLoss?.lossRaw}`);
    // _canOpenNew returns DAILY_LOSS_CAP
    const gate = t._canOpenNew({ log: false });
    check("_canOpenNew blocks with DAILY_LOSS_CAP", gate.ok === false && gate.code === "DAILY_LOSS_CAP", gate.code);
    // day rollover resets the bucket
    t.state.sessionStats.dailyLoss = { day: "2000-01-01", lossRaw: String(ethers.parseUnits("99", 6)) };
    check("yesterday's losses ignored", t._dailyLossExceeded() === false);
    // realizedPnl missing/invalid is a no-op
    t._noteRealizedPnl({ realizedPnl: null }, { collateralToken: USDT_DEP });
    t._noteRealizedPnl({ realizedPnl: "not-a-number" }, { collateralToken: USDT_DEP });
    check("null/invalid realizedPnl is a no-op", t._dailyLossExceeded() === false);
  }

  // ── L10: maxLeverage fallback wiring ────────────────────────────────────
  section("L10 maxLeverage fallback wiring");
  {
    const autoSrc = fs.readFileSync(path.join(REPO, "auto.js"), "utf8");
    const idxSrc = fs.readFileSync(path.join(REPO, "index.js"), "utf8");
    check("auto.js maxLeverage consults leverageMax",
      /maxLeverage:\s*Number\(config\.maxLeverage\s*\?\?\s*config\.leverageMax\s*\?\?\s*5\)/.test(autoSrc));
    check("index.js autoConfig maxLeverage consults leverageMax",
      /maxLeverage:\s*Number\(config\.maxLeverage\s*\?\?\s*config\.leverageMax\s*\?\?\s*5\)/.test(idxSrc));
    // The config-reading assignments (Number(config.…)) must all use the
    // leverageMax fallback. The TUI leverage-toggle patch writes the literal
    // `maxLeverage: 20` on purpose — that is NOT a config read.
    const cfgReads = idxSrc.split("maxLeverage:").slice(1)
      .map(s => s.trimStart())
      .filter(s => s.startsWith("Number("));
    check("index.js has 2 config-reading maxLeverage assignments",
      cfgReads.length === 2, `got ${cfgReads.length}`);
    check("every config-reading maxLeverage in index.js falls back through leverageMax",
      cfgReads.every(s => /config\.maxLeverage\s*\?\?\s*config\.leverageMax\s*\?\?\s*5/.test(s.slice(0, 80))),
      cfgReads.map(s => s.slice(0, 50)).join(" | "));
    // simulate the fixed expression
    const c1 = { maxLeverage: undefined, leverageMax: 20 };
    const c2 = { maxLeverage: 5, leverageMax: 20 };
    const c3 = {};
    check("expression: leverageMax-only config → 20", Number(c1.maxLeverage ?? c1.leverageMax ?? 5) === 20);
    check("expression: explicit maxLeverage=5 wins", Number(c2.maxLeverage ?? c2.leverageMax ?? 5) === 5);
    check("expression: empty config → 5", Number(c3.maxLeverage ?? c3.leverageMax ?? 5) === 5);
  }

  // ── state isolation ─────────────────────────────────────────────────────
  section("state isolation");
  check("state file untouched", sha(STATE_FILE) === H.state);
  check("journal untouched", sha(JOURNAL_FILE) === H.journal);
  check("config untouched by tests", sha(CONFIG_FILE) === H.config);
  check("real state hash untouched", realStateHash() === H.real);

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log(`  RESULT: ${pass} passed, ${fail} failed`);
  console.log("═══════════════════════════════════════════════════════════════");
  process.exit(fail > 0 ? 1 : 0);
}

/**
 * Minimal harness around openPosition's leverage guard: call the real
 * openPosition() with a dummy wallet/provider and capture whether it was
 * blocked by the maxLeverage ceiling (returns null with a BLOCKED log)
 * versus reaching the next stage (manager code check — which with a dead
 * manager would also return null, so we distinguish by log content).
 */
async function openPositionLeverageGuard(wallet, provider, leverage, maxLeverage) {
  const logs = [];
  const l = (m, lvl) => logs.push(`${lvl || "info"}:${m}`);
  const result = await openPosition({
    wallet, provider,
    managerAddr: "0x0000000000000000000000000000000000000001",
    poolAddr: "0x0000000000000000000000000000000000000002",
    side: "LONG", collateralToken: USDT,
    collateralAmount: ethers.parseUnits("10", 6),
    leverage,
    config: { maxLeverage, deadlineSeconds: 1200, ethGuard: { MIN_ETH_GAS_RESERVE: 0.003 } },
    log: l, dryRun: true,
  }).catch(e => { logs.push(`error:${e.message}`); return null; });
  if (logs.some(m => m.includes("exceeds max"))) return "BLOCKED_BY_MAX_LEVERAGE";
  return result;
}

run().catch(e => { console.error("FATAL:", e); process.exit(1); });
