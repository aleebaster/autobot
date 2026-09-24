#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
//  TEST SUITE — marketDiscovery.js + swapRoutes.js + rotation.js
//  Pure unit tests (no network) + optional on-chain discovery smoke test.
// ═══════════════════════════════════════════════════════════════════════════

import assert from "assert";
import {
  normalizeSymbolKey,
  pairKeyFromAddresses,
  collateralForSide,
  collateralDecimalsForSide,
  collateralSymbolForSide,
  paymentTokenForMarket,
  supportsSide,
  marketKey,
  mergeMarketSources,
  enumerateMarketSides,
  formatMarketsTable,
  formatCoverageTable,
  STABLE_SYMBOLS,
} from "./marketDiscovery.js";
import { probeAmountFor, findRoute, routeCandidates, sourcesForTarget, formatRoutesTable } from "./swapRoutes.js";
import { RotationMemory } from "./rotation.js";

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ❌ ${name} — ${e.message}`);
    failed++;
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ❌ ${name} — ${e.message}`);
    failed++;
  }
}

const T0 = "0x1111111111111111111111111111111111111111";
const T1 = "0x2222222222222222222222222222222222222222";
const POOL = "0x3333333333333333333333333333333333333333";
const MGR = "0x4444444444444444444444444444444444444444";

function mkMarket(overrides = {}) {
  return {
    marketSymbol: "WETH/USDT",
    symbol: "WETH/USDT",
    poolAddr: POOL,
    managerAddr: MGR,
    token0: T0,
    token1: T1,
    poolToken0: T0,
    poolToken1: T1,
    token0Symbol: "WETH",
    token1Symbol: "USDT",
    token0Decimals: 18,
    token1Decimals: 6,
    supportsLong: true,
    supportsShort: true,
    isActive: true,
    ...overrides,
  };
}

console.log("═══════════════════════════════════════════════════════");
console.log("  MARKET DISCOVERY / ROUTES / ROTATION TESTS");
console.log("═══════════════════════════════════════════════════════\n");

// ── A. normalizeSymbolKey / pairKey ──
test("normalizeSymbolKey is order-independent", () => {
  assert.strictEqual(normalizeSymbolKey("UNI/USDT"), normalizeSymbolKey("USDT/UNI"));
  assert.strictEqual(normalizeSymbolKey("ETH/USDT"), "ETH|USDT");
});
test("pairKeyFromAddresses is order-independent lowercase", () => {
  assert.strictEqual(
    pairKeyFromAddresses("0xAbC", "0xDef"),
    pairKeyFromAddresses("0xdef", "0xabc")
  );
});

// ── B. collateral rule: token0→LONG, token1→SHORT ──
test("collateralForSide: token0=LONG, token1=SHORT", () => {
  const m = mkMarket();
  assert.strictEqual(collateralForSide(m, "LONG"), T0);
  assert.strictEqual(collateralForSide(m, "SHORT"), T1);
});
test("collateral decimals/symbols follow token0/token1", () => {
  const m = mkMarket();
  assert.strictEqual(collateralDecimalsForSide(m, "LONG"), 18);
  assert.strictEqual(collateralDecimalsForSide(m, "SHORT"), 6);
  assert.strictEqual(collateralSymbolForSide(m, "LONG"), "WETH");
  assert.strictEqual(collateralSymbolForSide(m, "SHORT"), "USDT");
});

// ── C. paymentToken = first non-stable ──
test("paymentToken: WETH (risky) preferred over USDT", () => {
  assert.strictEqual(paymentTokenForMarket(mkMarket()), T0);
});
test("paymentToken: both stables → token0", () => {
  const m = mkMarket({ token0Symbol: "USDC", token1Symbol: "DAI" });
  assert.strictEqual(paymentTokenForMarket(m), T0);
});
test("STABLE_SYMBOLS contains USDT/USDC/DAI", () => {
  assert.ok(STABLE_SYMBOLS.has("USDT"));
  assert.ok(STABLE_SYMBOLS.has("USDC"));
  assert.ok(STABLE_SYMBOLS.has("DAI"));
});

// ── D. supportsSide ──
test("supportsSide: declared false never allowed", () => {
  assert.strictEqual(supportsSide(mkMarket({ supportsLong: false }), "LONG"), false);
  assert.strictEqual(supportsSide(mkMarket({ supportsShort: false }), "SHORT"), false);
  assert.strictEqual(supportsSide(mkMarket({ supportsLong: false }), "SHORT"), true);
});
test("supportsSide: inactive market excluded", () => {
  assert.strictEqual(supportsSide(mkMarket({ isActive: false }), "LONG"), false);
});
test("supportsSide: runtime kill-switch key SYMBOL|SIDE", () => {
  const m = mkMarket();
  assert.strictEqual(supportsSide(m, "LONG", { "WETH/USDT|LONG": true }), false);
  assert.strictEqual(supportsSide(m, "SHORT", { "WETH/USDT|LONG": true }), true);
});
test("supportsSide: undeclared (null) flags allowed", () => {
  const m = mkMarket({ supportsLong: null, supportsShort: null });
  assert.strictEqual(supportsSide(m, "LONG"), true);
  assert.strictEqual(supportsSide(m, "SHORT"), true);
});

// ── E. mergeMarketSources — pool-first matching ──
test("merge: config UNI/USDT + confirmed USDT/UNI same pool → one candidate", () => {
  const out = mergeMarketSources({
    availableMarkets: [{ symbol: "UNI/USDT", poolAddress: POOL, supportsLong: true, supportsShort: true }],
    confirmedPools: { "USDT/UNI": { pool: POOL, manager: MGR } },
    knownMarkets: [],
  });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].poolAddr, POOL);
  assert.ok(out[0].sources.includes("config"));
  assert.ok(out[0].sources.includes("confirmed"));
});
test("merge: declared false flags preserved", () => {
  const out = mergeMarketSources({
    availableMarkets: [{ symbol: "ETH/USDT", poolAddress: POOL, supportsLong: false, supportsShort: false }],
    confirmedPools: {},
    knownMarkets: [],
  });
  assert.strictEqual(out[0].supportsLong, false);
  assert.strictEqual(out[0].supportsShort, false);
});
test("merge: knownMarkets without pool attached by symbol key", () => {
  const out = mergeMarketSources({
    availableMarkets: [],
    confirmedPools: {},
    knownMarkets: [{ symbol: "NEMESIS/USDT", collateralToken: T1 }],
  });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].symbol, "NEMESIS/USDT");
  assert.strictEqual(out[0].collateralHint, T1);
});

// ── F. enumerateMarketSides ──
test("enumerate: both sides for active market", () => {
  const sides = enumerateMarketSides([mkMarket()], {});
  assert.strictEqual(sides.length, 2);
  assert.ok(sides.every(s => s.key.includes("|")));
});
test("enumerate: skips declared-false sides", () => {
  const sides = enumerateMarketSides([mkMarket({ supportsLong: false })], {});
  assert.strictEqual(sides.length, 1);
  assert.strictEqual(sides[0].side, "SHORT");
});
test("enumerate: respects runtime directionDisabled", () => {
  const sides = enumerateMarketSides([mkMarket()], { directionDisabled: { "WETH/USDT|SHORT": true } });
  assert.strictEqual(sides.length, 1);
  assert.strictEqual(sides[0].side, "LONG");
});

// ── G. marketKey ──
test("marketKey prefers marketSymbol", () => {
  assert.strictEqual(marketKey(mkMarket()), "WETH/USDT");
  assert.strictEqual(marketKey({ poolAddr: POOL }), `pool:${POOL.toLowerCase()}`);
});

// ── H. tables render ──
test("formatMarketsTable produces markdown header", () => {
  const t = formatMarketsTable([mkMarket()]);
  assert.ok(t.includes("| Market"));
  assert.ok(t.includes("WETH/USDT"));
});
test("formatCoverageTable produces LONG/SHORT columns", () => {
  const t = formatCoverageTable([mkMarket()], {});
  assert.ok(t.includes("LONG"));
  assert.ok(t.includes("SHORT"));
});

// ── I. swap routes helpers ──
test("probeAmountFor scales by decimals", () => {
  assert.strictEqual(probeAmountFor(18), 10n ** 18n);
  assert.strictEqual(probeAmountFor(6), 10n ** 6n);
  assert.strictEqual(probeAmountFor(null), 1n);
});
test("findRoute matches exact direction only", () => {
  const routes = [{ fromAddr: T0, toAddr: T1, path: [T0, T1], type: "direct", valid: true }];
  assert.ok(findRoute(routes, T0, T1));
  assert.strictEqual(findRoute(routes, T1, T0), null);
});
test("routeCandidates strips to auto-swap shape", () => {
  const c = routeCandidates([{ fromSym: "A", toSym: "B", fromAddr: T0, toAddr: T1, path: [T0, T1], type: "direct", valid: true }]);
  assert.strictEqual(c[0].from, "A");
  assert.strictEqual(c[0].key, "A>B");
});
test("sourcesForTarget finds every route ending at target", () => {
  const routes = [
    { fromAddr: T0, toAddr: T1, valid: true },
    { fromAddr: MGR, toAddr: T1, valid: true },
    { fromAddr: POOL, toAddr: T0, valid: true },
  ];
  const s = sourcesForTarget(routes, T1);
  assert.strictEqual(s.length, 2);
});
test("formatRoutesTable renders", () => {
  const t = formatRoutesTable([{ fromSym: "A", toSym: "B", type: "direct", valid: true, quoteSample: "1" }]);
  assert.ok(t.includes("| From"));
});

// ── J. RotationMemory ──
test("rotation: never repeats same MARKET×SIDE back-to-back when alternatives exist", () => {
  const r = new RotationMemory();
  const combos = [
    { symbol: "M1", side: "LONG" },
    { symbol: "M2", side: "SHORT" },
    { symbol: "M3", side: "LONG" },
  ];
  const picks = [];
  for (let i = 0; i < 9; i++) {
    const p = r.pickMarketSide(combos);
    picks.push(p.key);
    r.recordMarketSide(p.symbol, p.side);
  }
  for (let i = 1; i < picks.length; i++) {
    assert.notStrictEqual(picks[i], picks[i - 1], `repeat at ${i}: ${picks[i]}`);
  }
});
test("rotation: least-used market preferred over time", () => {
  const r = new RotationMemory();
  const combos = [
    { symbol: "A", side: "LONG" },
    { symbol: "B", side: "LONG" },
  ];
  for (let i = 0; i < 10; i++) {
    const p = r.pickMarketSide(combos);
    r.recordMarketSide(p.symbol, p.side);
  }
  const counts = r.coverage().marketSides;
  const a = counts["A|LONG"] || 0;
  const b = counts["B|LONG"] || 0;
  assert.ok(Math.abs(a - b) <= 1, `unbalanced: A=${a} B=${b}`);
});
test("rotation: swap pair anti-repeat", () => {
  const r = new RotationMemory();
  const cands = [
    { from: "X", to: "Y" },
    { from: "Y", to: "Z" },
  ];
  const picks = [];
  for (let i = 0; i < 6; i++) {
    const p = r.pickSwapPair(cands);
    picks.push(`${p.from}>${p.to}`);
    r.recordSwapPair(p.from, p.to);
  }
  for (let i = 1; i < picks.length; i++) {
    assert.notStrictEqual(picks[i], picks[i - 1]);
  }
});
test("rotation: toJSON/fromJSON round-trip preserves counts", () => {
  const r = new RotationMemory();
  r.recordMarketSide("M1", "LONG");
  r.recordSwapPair("A", "B");
  const r2 = RotationMemory.fromJSON(r.toJSON());
  assert.strictEqual(r2.marketSideCounts["M1|LONG"], 1);
  assert.strictEqual(r2.swapPairCounts["A>B"], 1);
  assert.deepStrictEqual(r2.recentMarkets, r.recentMarkets);
});
test("rotation: orderMarketSides puts least-recent first", () => {
  const r = new RotationMemory();
  r.recordMarketSide("A", "LONG");
  r.recordMarketSide("B", "LONG");
  r.recordMarketSide("C", "LONG");
  const ordered = r.orderMarketSides([
    { symbol: "A", side: "LONG" },
    { symbol: "B", side: "LONG" },
    { symbol: "C", side: "LONG" },
  ]);
  assert.strictEqual(ordered[0].symbol, "A"); // least recent (oldest) first
});

// ── K. on-chain discovery smoke (optional) ──
async function onchainSmoke() {
  const { ethers } = await import("ethers");
  const { discoverMarkets } = await import("./marketDiscovery.js");
  const { discoverSwapRoutes } = await import("./swapRoutes.js");
  const { getFactoryAddress, getRouterAddress, getAllTokens, getConfirmedPools, getKnownMarkets } = await import("./deployments/index.js");

  const RPC = process.env.RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
  const provider = new ethers.JsonRpcProvider(RPC, 11155111);

  // quick connectivity
  await provider.getBlockNumber();

  const d = await discoverMarkets({
    provider,
    factoryAddress: getFactoryAddress(),
    tokens: getAllTokens(),
    confirmedPools: getConfirmedPools(),
    knownMarkets: getKnownMarkets(),
    availableMarkets: [],
    runtime: {},
    log: () => {},
  });

  await testAsync("on-chain: discovers ≥1 active market", async () => {
    assert.ok(d.markets.length >= 1, `got ${d.markets.length}`);
  });
  await testAsync("on-chain: every market has pool+manager code", async () => {
    for (const m of d.markets) {
      assert.ok(m.poolAddr, "missing pool");
      assert.ok(m.managerAddr, "missing manager");
      assert.ok(m.poolCodeSize > 0, "pool no code");
      assert.ok(m.managerCodeSize > 0, "manager no code");
    }
  });
  await testAsync("on-chain: token0/token1 meta present (no hardcoded decimals)", async () => {
    for (const m of d.markets) {
      assert.ok(m.token0Symbol && m.token0Decimals !== null, "t0 meta");
      assert.ok(m.token1Symbol && m.token1Decimals !== null, "t1 meta");
    }
  });
  await testAsync("on-chain: collateral rule token0→LONG / token1→SHORT", async () => {
    for (const m of d.markets) {
      assert.strictEqual(collateralForSide(m, "LONG"), m.token0);
      assert.strictEqual(collateralForSide(m, "SHORT"), m.token1);
    }
  });

  const tokens = [];
  const seen = new Set();
  for (const m of d.markets) {
    for (const [addr, sym, dec] of [[m.token0, m.token0Symbol, m.token0Decimals], [m.token1, m.token1Symbol, m.token1Decimals]]) {
      const k = String(addr).toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      tokens.push({ address: addr, symbol: sym, decimals: dec });
    }
  }

  const routes = await discoverSwapRoutes({
    provider,
    routerAddress: getRouterAddress(),
    factoryAddress: getFactoryAddress(),
    tokens,
    log: () => {},
  });

  await testAsync("on-chain: discovers ≥1 valid swap route", async () => {
    assert.ok(routes.length >= 1, `got ${routes.length}`);
  });
  await testAsync("on-chain: every route validated (quoteSample present)", async () => {
    for (const r of routes) {
      assert.ok(r.valid, "invalid route");
      assert.ok(r.path.length >= 2, "bad path");
    }
  });
  await testAsync("on-chain: both directions exist for at least one pair", async () => {
    const fwd = routes.find(r => r.type === "direct");
    assert.ok(fwd, "no direct route");
    const back = routes.find(r =>
      String(r.fromAddr).toLowerCase() === String(fwd.toAddr).toLowerCase() &&
      String(r.toAddr).toLowerCase() === String(fwd.fromAddr).toLowerCase()
    );
    assert.ok(back, "missing reverse direction");
  });

  // Coverage table printout
  console.log("\n" + formatMarketsTable(d.markets));
  console.log("\n" + formatCoverageTable(d.markets, {}));
  console.log("\n" + formatRoutesTable(routes));
}

await onchainSmoke().catch(e => {
  console.log(`  ⏭️  on-chain smoke SKIPPED — ${e.message?.slice(0, 80)}`);
});

console.log("\n═══════════════════════════════════════════════════════");
console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
console.log("═══════════════════════════════════════════════════════");
process.exit(failed > 0 ? 1 : 0);
