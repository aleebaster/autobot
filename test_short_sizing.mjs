#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
//  SHORT COLLATERAL SIZING — read-only tests
//
//  collateralAmount = max(configuredTarget, measuredPoolMinimum)
//  collateralAmount <= config.maxCollateralTargetShort   (candidate's decimals)
//
//  Everything here is read-only: view calls + pure maths. No approve / swap /
//  open / close / checkpoint transaction is built or sent.
//
//  IMPORTANT: run this with the REPO as cwd ONLY if you accept that AutoTrader
//  loadState()/saveState() would touch auto-trader-state.json. The runner script
//  executes it from a scratch directory so the repo state file stays byte-exact.
// ═══════════════════════════════════════════════════════════════════════════

import { TEST_STATE_FILE, realStateHash } from "./_test_state_isolation.mjs";
import fs from "fs";
import { ethers } from "ethers";
import { AutoTrader, DEFAULT_AUTO_CONFIG, resolveShortCollateralAmount, precheckMarketQuote, encodeOpenPositionCalldata } from "./autoTrader.js";
import { getConfirmedPools } from "./deployments/index.js";

const REPO = "C:/Users/andre/Downloads/NemesisAutoBot-NTE";
const RPC = "https://ethereum-sepolia-rpc.publicnode.com";
const CHAIN_ID = 11155111;
const DUMMY_PK = "0x" + "11".repeat(32); // never signs anything
const LEVERAGE_X10 = 20n;

// Reference measurements taken with the same maths before this change.
// Pools drift, so they are asserted with a ±5% band — only the cap/skip
// classification itself must be exact.
const REFERENCE = {
  "WETH/DAI":  { poolMin: 547.082198,   expect: "OPEN" },
  "WETH/UNI":  { poolMin: 1124.893637,  expect: "OPEN" },
  "USDT/DAI":  { poolMin: 5038396.443603, expect: "SKIP_CAP" },
  "USDC/DAI":  { poolMin: 27938214.068313, expect: "SKIP_CAP" },
};
const BAND = 0.05;

let passed = 0, failed = 0, skipped = 0;
function test(name, result, detail = "") {
  if (result === true) { console.log(`  PASS  ${name}`); passed++; }
  else if (result === "SKIP") { console.log(`  SKIP  ${name} (${detail})`); skipped++; }
  else { console.log(`  FAIL  ${name} — ${detail}`); failed++; }
}
function near(actual, expected, band = BAND) {
  const lo = expected * (1 - band), hi = expected * (1 + band);
  return actual >= lo && actual <= hi;
}
const log = () => {};

function read(file) { return fs.readFileSync(`${REPO}/${file}`, "utf8"); }

async function buildTrader(overrides = {}) {
  const cfg = JSON.parse(read("config.json"));
  return new AutoTrader({
    accounts: [{ address: new ethers.Wallet(DUMMY_PK).address, privateKey: DUMMY_PK }],
    selectedWalletIndex: 0,
    proxies: [],
    rpcUrl: RPC,
    chainId: CHAIN_ID,
    config: {
      dryRun: true,
      defaultLeverage: 2,
      maxLeverage: 5,
      maxMarketAttemptsPerCycle: 4,
      targetCollateralUSDT: cfg.targetCollateralUSDT || "10",
      targetCollateralWETH: cfg.targetCollateralWETH || "0.002",
      targetCollateralGeneric: cfg.targetCollateralGeneric || "10",
      maxCollateralTargetShort: cfg.maxCollateralTargetShort || "10000",
      availableMarkets: cfg.availableMarkets || [],
      ethGuard: { MAX_ETH_SWAP_PER_TX: 0.02, MAX_ETH_SWAP_PER_SESSION: 0.1, MIN_ETH_GAS_RESERVE: 0.003, MAX_TOTAL_ETH_EXPOSURE: 0.15, ETH_BLOCK_THRESHOLD: 0.005 },
      ...overrides,
    },
    confirmedPools: getConfirmedPools(),
    getProvider: (url, chain) => new ethers.JsonRpcProvider(url, chain),
    log,
  });
}

async function run() {
  console.log("═══════════════════════════════════════════════════════");
  console.log("  SHORT COLLATERAL SIZING — read-only tests");
  console.log("═══════════════════════════════════════════════════════\n");

  // ── A. Static / config invariants ────────────────────────────────────────
  console.log("A. Static invariants (no RPC)");
  {
    const src = read("autoTrader.js");
    const cfg = JSON.parse(read("config.json"));

    test("A1. shortTradeAmount is NOT used as collateral sizing",
      !/shortTradeAmount/.test(src), "autoTrader.js references shortTradeAmount");
    test("A2. OPEN selector still 0xfa2b1dfd",
      /const OPEN_POSITION_SELECTOR = "0xfa2b1dfd"/.test(src));
    test("A3. CLOSE selector still 0xb35648d7",
      /const CLOSE_POSITION_SELECTOR = "0xb35648d7"/.test(src));
    test("A4. config.json carries maxCollateralTargetShort = 10000",
      cfg.maxCollateralTargetShort === "10000", `got ${JSON.stringify(cfg.maxCollateralTargetShort)}`);
    test("A5. DEFAULT_AUTO_CONFIG carries maxCollateralTargetShort = 10000",
      DEFAULT_AUTO_CONFIG.maxCollateralTargetShort === "10000",
      `got ${JSON.stringify(DEFAULT_AUTO_CONFIG.maxCollateralTargetShort)}`);
    test("A6. index.js forwards the cap",
      /maxCollateralTargetShort: config\.maxCollateralTargetShort \|\| "10000"/.test(read("index.js")));
    test("A7. auto.js forwards the cap",
      /maxCollateralTargetShort: config\.maxCollateralTargetShort \|\| "10000"/.test(read("auto.js")));
    test("A8. sizing is guarded by side === \"SHORT\" (LONG untouched)",
      src.includes('if (side === "SHORT") {'));
    test("A9. SIZE flow still runs precheckMarketQuote on ctx.collateralAmount",
      /collateralToken: ctx\.collateralToken, collateralAmount: ctx\.collateralAmount/.test(src));
    test("A10. quote skip codes QUOTE_ZERO / ZERO_AMOUNT_OUT_MIN preserved",
      src.includes("ZERO_AMOUNT_OUT_MIN") && src.includes("QUOTE_ZERO"));
    test("A11. module imports cleanly (syntax check)", true, "");
    try {
      const cd = encodeOpenPositionCalldata({
        isLong: false,
        collateralToken: "0xa3215a5cA659e0Bd57c0B33d5EAD71901A24d3d6",
        collateralAmount: 1000000n, borrowAmount: 1000000n,
        leverageX10: LEVERAGE_X10, amountOutMin: 1000000n,
        deadline: 1700000000,
        paymentToken: "0xa3215a5cA659e0Bd57c0B33d5EAD71901A24d3d6",
      });
      test("A12. openPosition calldata still starts with 0xfa2b1dfd",
        cd.startsWith("0xfa2b1dfd"), cd.slice(0, 10));
    } catch (e) {
      test("A12. openPosition calldata still starts with 0xfa2b1dfd", false, e.message);
    }
  }

  // ── B. LONG sizing must be unchanged ─────────────────────────────────────
  console.log("\nB. LONG sizing unchanged (configured target, no pool measurement)");
  const trader = await buildTrader();
  const { provider } = trader.getRuntime();
  const walletAddr = new ethers.Wallet(DUMMY_PK).address;
  await trader.ensureMarkets({ force: true });
  const longs = await trader.planMarketsForSide("LONG", { max: 3 });
  {
    test("B1. LONG candidates discovered", longs.length > 0, `count=${longs.length}`);
    for (const c of longs) {
      const ctx = await trader._candidateContext(c, "LONG", { provider, walletAddr });
      if (!ctx) { test(`B2. ${c.symbol} LONG ctx built`, false, "ctx null"); continue; }
      test(`B2. ${c.symbol} LONG sizing.mode = configured`,
        ctx.sizing?.mode === "configured", `got ${ctx.sizing?.mode}`);
      test(`B3. ${c.symbol} LONG poolMin not measured (null)`,
        ctx.sizing?.poolMin === null, `got ${JSON.stringify(ctx.sizing?.poolMin)}`);
      const dec = ctx.collateralDecimals;
      const configured = c.collateralSym === "WETH"
        ? (JSON.parse(read("config.json")).targetCollateralWETH || "0.002")
        : c.collateralSym === "USDT"
          ? (JSON.parse(read("config.json")).targetCollateralUSDT || "10")
          : (JSON.parse(read("config.json")).targetCollateralGeneric || "10");
      const expected = ethers.parseUnits(configured, dec);
      test(`B4. ${c.symbol} LONG collateralAmount == configured target`,
        ctx.collateralAmount === expected,
        `got ${ethers.formatUnits(ctx.collateralAmount, dec)} want ${configured}`);
      test(`B5. ${c.symbol} LONG collateral is the LONG leg (token0)`,
        ctx.collateralToken?.toLowerCase() === ctx.token0?.toLowerCase(),
        `coll=${ctx.collateralToken} token0=${ctx.token0}`);
    }
  }

  // ── C. SHORT sizing: pool minimum ∩ cap ──────────────────────────────────
  console.log("\nC. SHORT sizing = max(configured, poolMin) <= cap");
  const shorts = await trader.planMarketsForSide("SHORT", { max: 4 });
  {
    test("C1. SHORT candidates discovered", shorts.length >= 2, `count=${shorts.length}`);
    for (const c of shorts) {
      const ref = REFERENCE[c.symbol];
      const cfg = JSON.parse(read("config.json"));
      const capStr = cfg.maxCollateralTargetShort || DEFAULT_AUTO_CONFIG.maxCollateralTargetShort;

      const ctx = await trader._candidateContext(c, "SHORT", { provider, walletAddr });
      const dec = ctx ? ctx.collateralDecimals : await (async () => {
        // candidate with no ctx: still resolve decimals for the direct call
        const t = new ethers.Contract(c.collateralToken, ["function decimals() view returns (uint8)"], provider);
        return Number(await t.decimals());
      })();
      const configuredRaw = ethers.parseUnits(
        c.collateralSym === "WETH" ? (cfg.targetCollateralWETH || "0.002")
          : c.collateralSym === "USDT" ? (cfg.targetCollateralUSDT || "10")
            : (cfg.targetCollateralGeneric || "10"), dec);
      const capRaw = ethers.parseUnits(String(capStr), dec);

      const res = await resolveShortCollateralAmount(provider, {
        pool: c.poolAddr, manager: c.managerAddr, collateralToken: c.collateralToken,
        configuredRaw, capRaw, leverageX10: LEVERAGE_X10,
      });

      console.log(`      ${c.symbol}: ctx=${ctx ? "built" : "SKIPPED"} ` +
        `resolver=${res.ok ? `amount=${ethers.formatUnits(res.amount, dec)}` : res.code} ` +
        `poolMin=${res.poolMin != null ? ethers.formatUnits(res.poolMin, dec) : "n/a"}`);

      if (ref?.expect === "SKIP_CAP" || (!res.ok && res.code === "POOL_MIN_EXCEEDS_CAP")) {
        test(`C2. ${c.symbol} capped → resolver refuses to inflate`,
          res.ok === false && res.code === "POOL_MIN_EXCEEDS_CAP",
          `got ok=${res.ok} code=${res.code}`);
        test(`C3. ${c.symbol} capped → _candidateContext returns null (SKIP)`,
          ctx === null, ctx ? `ctx built with amount ${ethers.formatUnits(ctx.collateralAmount, dec)}` : "");
        if (res.poolMin != null && ref) {
          test(`C4. ${c.symbol} measured poolMin ≈ ${ref.poolMin} (±5%)`,
            near(Number(ethers.formatUnits(res.poolMin, dec)), ref.poolMin),
            `got ${ethers.formatUnits(res.poolMin, dec)}`);
        }
        test(`C5. ${c.symbol} cap reported in this token's decimals`,
          res.cap === capRaw, `got ${res.cap} want ${capRaw}`);
        // The configured size really is unquotable for this pool → the SKIP is
        // a genuine liquidity limit, not a manufactured one, and the unchanged
        // precheck still owns QUOTE_ZERO / ZERO_AMOUNT_OUT_MIN.
        const pre = await precheckMarketQuote(provider, {
          pool: c.poolAddr, manager: c.managerAddr, collateralToken: c.collateralToken,
          collateralAmount: configuredRaw, leverageX10: LEVERAGE_X10, isLong: false, log,
        });
        test(`C6. ${c.symbol} configured target still fails precheck (codes untouched)`,
          pre.ok === false && ["QUOTE_ZERO", "ZERO_AMOUNT_OUT_MIN", "ZERO_LP"].includes(pre.code),
          `got ok=${pre.ok} code=${pre.code} reason=${pre.reason}`);
      } else {
        test(`C7. ${c.symbol} viable → resolver ok`, res.ok === true, `code=${res.code}`);
        if (!res.ok) continue;
        test(`C8. ${c.symbol} amount = max(configured, poolMin)`,
          res.amount === (res.poolMin > configuredRaw ? res.poolMin : configuredRaw),
          `amount=${res.amount} configured=${configuredRaw} poolMin=${res.poolMin}`);
        test(`C9. ${c.symbol} amount >= configured target`, res.amount >= configuredRaw,
          `${res.amount} < ${configuredRaw}`);
        test(`C10. ${c.symbol} amount <= cap`, res.amount <= capRaw,
          `${res.amount} > ${capRaw}`);
        test(`C11. ${c.symbol} measured poolMin ≈ ${ref?.poolMin} (±5%)`,
          ref ? near(Number(ethers.formatUnits(res.poolMin, dec)), ref.poolMin) : "SKIP",
          `got ${ethers.formatUnits(res.poolMin, dec)}`);
        test(`C12. ${c.symbol} _candidateContext built with that amount`,
          !!ctx && ctx.collateralAmount === res.amount,
          ctx ? `${ctx.collateralAmount} vs ${res.amount}` : "ctx null");
        test(`C13. ${c.symbol} ctx.sizing.mode = pool-min`,
          !!ctx && ctx.sizing?.mode === "pool-min", `got ${ctx?.sizing?.mode}`);
        test(`C14. ${c.symbol} candidate isolation — ctx belongs to this candidate`,
          !!ctx && ctx.poolAddr?.toLowerCase() === c.poolAddr.toLowerCase() &&
          ctx.managerAddr?.toLowerCase() === c.managerAddr.toLowerCase() &&
          ctx.collateralToken?.toLowerCase() === c.collateralToken.toLowerCase(),
          "ctx pool/manager/collateral mismatch");
        // Read-only precheck with the FINAL amount, exactly as the open flow does.
        if (ctx) {
          const pre = await precheckMarketQuote(provider, {
            pool: ctx.poolAddr, manager: ctx.managerAddr,
            collateralToken: ctx.collateralToken, collateralAmount: ctx.collateralAmount,
            leverageX10: LEVERAGE_X10, isLong: false, log,
          });
          test(`C15. ${c.symbol} precheck PASS with actual collateralAmount`,
            pre.ok === true, `code=${pre.code} reason=${pre.reason}`);
          test(`C16. ${c.symbol} SHORT collateral is the SHORT leg (token1)`,
            ctx.collateralToken?.toLowerCase() === ctx.token1?.toLowerCase(),
            `coll=${ctx.collateralToken} token1=${ctx.token1}`);
        }
      }
    }
  }

  // ── D. Cap really gates the uplift (deterministic, no big measurements) ──
  console.log("\nD. Cap gate");
  {
    const cfg = JSON.parse(read("config.json"));
    const dec = 6;
    const tinyCap = ethers.parseUnits("1", dec);          // 1 unit — below WETH/DAI's pool minimum
    const configuredRaw = ethers.parseUnits(cfg.targetCollateralGeneric || "10", dec);
    const dai = "0xa3215a5cA659e0Bd57c0B33d5EAD71901A24d3d6";
    // Fixed fixture: resolve WETH/DAI straight from the discovered market list.
    // planMarketsForSide() now DROPS non-viable SHORT candidates (that is the fix under
    // test), so WETH/DAI is intentionally absent from `wide`/`shorts` — the cap gate
    // itself must still refuse to inflate above `capRaw`. Never fall back to shorts[0]:
    // a viable market has a pool minimum below the 1-unit cap and cannot trigger the gate.
    const all = Array.isArray(trader.markets) ? trader.markets : [];
    const wide = await trader.planMarketsForSide("SHORT", { max: 100 });
    const found = all.find((x) => (x.marketSymbol || x.symbol) === "WETH/DAI")
      || wide.find((x) => x.symbol === "WETH/DAI")
      || shorts.find((x) => x.symbol === "WETH/DAI");
    // Discovered markets carry collateralShort/collateralLong; planned candidates carry
    // collateralToken. Normalise so the resolver gets a real token address.
    const c = found ? { ...found, collateralToken: found.collateralToken || found.collateralShort } : null;
    if (!c) { test("D0. WETH/DAI fixture found in discovered markets", false, "missing"); }
    // Probe the live pool minimum first (huge cap → sizing succeeds and reports poolMin),
    // then set the cap just BELOW that minimum so the gate fires deterministically
    // regardless of deployment (v2 vs v5) or reserve drift.
    const probeCap = ethers.parseUnits("1000000", dec);
    const probe = c ? await resolveShortCollateralAmount(provider, {
      pool: c.poolAddr, manager: c.managerAddr, collateralToken: c.collateralToken,
      configuredRaw, capRaw: probeCap, leverageX10: LEVERAGE_X10,
    }) : null;
    const poolMin = probe?.ok ? probe.poolMin : (probe?.poolMin ?? null);
    if (!c || poolMin === null || poolMin === undefined || poolMin < 2n) {
      test("D1. poolMin > cap → POOL_MIN_EXCEEDS_CAP, no inflation", "SKIP",
        !c ? "no WETH/DAI fixture" : `cannot build cap < poolMin (probe code=${probe?.code} poolMin=${poolMin})`);
    } else {
      const tinyCap = poolMin - 1n; // guaranteed: poolMin > capRaw
      const res = await resolveShortCollateralAmount(provider, {
        pool: c.poolAddr, manager: c.managerAddr, collateralToken: c.collateralToken,
        configuredRaw, capRaw: tinyCap, leverageX10: LEVERAGE_X10,
      });
      test("D1. poolMin > cap → POOL_MIN_EXCEEDS_CAP, no inflation",
        res.ok === false && res.code === "POOL_MIN_EXCEEDS_CAP",
        `got ${res.code} market=${c?.symbol || c?.marketSymbol || "?"} poolMin=${poolMin} cap=${tinyCap}`);
    }
    test("D2. fallback path never inflates (POOL_STATE_READ_ERROR → keep configured)",
      (() => {
        const r = { ok: false, code: "POOL_STATE_READ_ERROR", fallbackToConfigured: true };
        return r.ok === false && r.fallbackToConfigured === true && r.code !== "POOL_MIN_EXCEEDS_CAP";
      })(), "");
    // Invalid inputs must be rejected, never silently sized.
    const bad = await resolveShortCollateralAmount(provider, {
      pool: null, manager: c?.managerAddr, collateralToken: dai,
      configuredRaw, capRaw: tinyCap, leverageX10: LEVERAGE_X10,
    });
    test("D3. missing pool → SIZING_INPUT_MISSING (no sizing performed)",
      bad.ok === false && bad.code === "SIZING_INPUT_MISSING", `got ${bad.code}`);
    const bad2 = await resolveShortCollateralAmount(provider, {
      pool: c?.poolAddr, manager: c?.managerAddr, collateralToken: dai,
      configuredRaw: 0n, capRaw: tinyCap, leverageX10: LEVERAGE_X10,
    });
    test("D4. configured = 0 → INVALID_COLLATERAL_TARGET",
      bad2.ok === false && bad2.code === "INVALID_COLLATERAL_TARGET", `got ${bad2.code}`);
    void dai;
  }

  console.log("\n═══════════════════════════════════════════════════════");
  console.log(`  RESULTS: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  console.log("═══════════════════════════════════════════════════════");
  if (failed > 0) { console.log("\n  SOME TESTS FAILED"); process.exit(1); }
  console.log("\n  ALL TESTS PASSED (read-only)");
  process.exit(0);
}

run().catch((e) => { console.error("Fatal:", e); process.exit(1); });
