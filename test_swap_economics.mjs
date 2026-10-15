#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════════════════════
//  SWAP ECONOMICS TESTS — pure, offline, no RPC, NO TRANSACTIONS
//
//  Verifies the per-leg vetoes that run BEFORE anything is signed:
//    POOL_SHARE ≤ 1%, PRICE_IMPACT ≤ 2% (fee removed), ZERO_QUOTE,
//    ZERO_AMOUNT_OUT_MIN, ZERO_RESERVE, RATE_DEVIATION with the (1−f)^(2N)
//    fee-corrected expectation, and the 1%-per-leg fee itself.
//
//  ⛔ NEVER SENDS A TRANSACTION. `eth_sendRawTransaction` and `eth_sendTransaction`
//     are hard-blocked below, so a regression that tried to send would throw
//     instead of moving funds.
// ══════════════════════════════════════════════════════════════════════════════

import { TEST_STATE_FILE, realStateHash } from "./_test_state_isolation.mjs";
import { ethers } from "ethers";

// ── HARD TX BLOCK ────────────────────────────────────────────────────────────
const _origSend = ethers.JsonRpcProvider.prototype.send;
ethers.JsonRpcProvider.prototype.send = function (method, params) {
  if (method === "eth_sendRawTransaction" || method === "eth_sendTransaction") {
    return Promise.reject(new Error(`TX_BLOCKED: ${method} is forbidden in this test`));
  }
  return _origSend.call(this, method, params);
};

const {
  ECONOMY_GATES, DEFAULT_ECONOMY, normalizeEconomyConfig,
  feeFraction, legAmountOut, legSpot,
  evaluateLegEconomics, evaluateRouteEconomics, checkRateConsistency,
} = await import("./swapEconomics.js");

const PASS = [], FAIL = [];
let total = 0;
function check(name, ok, detail = "") {
  total++;
  if (ok) PASS.push(name); else FAIL.push(`${name} :: ${detail}`);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const E18 = 10n ** 18n;
const E17 = 10n ** 17n;
const E16 = 10n ** 16n;
const E6 = 10n ** 6n;
const BPS = 10000n;

// Realistic balanced pool: 100 WETH / 300_000 DAI → spot 3000 DAI/WETH
const R_WETH = 100n * E18;
const R_DAI = 300000n * E6;

console.log("\n═══ 1. DEFAULT THRESHOLDS ═══");
check("maxPoolShareBps default is 1% (100)", DEFAULT_ECONOMY.maxPoolShareBps === 100);
check("maxPriceImpactBps default is 2% (200)", DEFAULT_ECONOMY.maxPriceImpactBps === 200);
check("maxRateDeviation default is 0.05", DEFAULT_ECONOMY.maxRateDeviation === 0.05);
const n = normalizeEconomyConfig({});
check("normalizeEconomyConfig() yields the defaults", n.maxPoolShareBps === 100 && n.maxPriceImpactBps === 200 && n.maxRateDeviation === 0.05);

console.log("\n═══ 2. FEE IS 1% PER LEG, CHARGED ON EVERY LEG ═══");
const f1 = feeFraction(100);
check("feeFraction(100) = 1/100", f1.num === 100n && f1.den === BPS && Math.abs(f1.frac - 0.01) < 1e-12);
check("feeFraction(0) is zero", feeFraction(0).frac === 0);
check("feeFraction(10000) saturates at 1 (never >1)", feeFraction(10000).frac === 1);

// A TINY swap has no size pressure, so it returns exactly spot × (1 − fee).
{
  const amtIn = 10n ** 15n;                     // 0.001 WETH = 0.001% of pool
  const out = legAmountOut({ amountIn: amtIn, reserveIn: R_WETH, reserveOut: R_DAI, swapFeeBps: 100 });
  const outH = Number(out) / 1e6;              // DAI human
  // 0.001 WETH × 3000 DAI/WETH × 0.99 = 2.97 DAI
  check("tiny swap (0.001% of pool) returns ~2.97 DAI (pure 1% fee)",
    Math.abs(outH - 2.97) < 0.001, `got ${outH.toFixed(6)}`);
  check("feeFraction(100).frac === 0.01", Math.abs(feeFraction(100).frac - 0.01) < 1e-12);

  // 1 WETH = exactly 1% of the pool: constant-product price impact applies ON
  // TOP of the fee. out = 0.99 × 300000 / (100 + 0.99) = 2940.8852 DAI.
  // That is the correct answer — and it is precisely why the 2% impact gate exists.
  const one = legAmountOut({ amountIn: 1n * E18, reserveIn: R_WETH, reserveOut: R_DAI, swapFeeBps: 100 });
  const oneH = Number(one) / 1e6;
  check("1 WETH (1% of pool) → 2940.885 DAI — fee AND price impact both present",
    Math.abs(oneH - 2940.8852) < 0.01, `got ${oneH.toFixed(4)}`);
  const ev1 = evaluateLegEconomics({
    amountIn: 1n * E18, amountOut: one, reserveIn: R_WETH, reserveOut: R_DAI,
    swapFeeBps: 100, decimalsIn: 18, decimalsOut: 6,
  });
  // A 1% share moves the pool by ~1/(1+1%) ≈ 0.99% — NEGATIVE (you receive less
  // than the fee-adjusted spot), and well inside the 2% cap.
  check("that 1% share produces ~0.99% price impact ex-fee (inside the 2% cap)",
    ev1.ok && Math.abs(Math.abs(ev1.priceImpactExFee) - 0.0099) < 0.0002,
    `impact=${(ev1.priceImpactExFee * 100).toFixed(4)}%`);
}
{
  // fee charged on EVERY leg: a 2-hop pays it twice → product (0.99)^2 not 0.99
  check("2-hop pays 1% twice: (1−f)^2 = 0.9801",
    Math.abs(Math.pow(1 - 0.01, 2) - 0.9801) < 1e-12);
  check("3-hop pays 1% thrice: (1−f)^3 = 0.970299",
    Math.abs(Math.pow(1 - 0.01, 3) - 0.970299) < 1e-12);
}

console.log("\n═══ 3. ZERO QUOTE / ZERO amountOutMin / ZERO RESERVE ═══");
{
  const ev = evaluateLegEconomics({
    amountIn: E18, amountOut: 0n, reserveIn: R_WETH, reserveOut: R_DAI,
    swapFeeBps: 100, decimalsIn: 18, decimalsOut: 6,
  });
  check("amountOut=0 → ZERO_QUOTE, not ok", !ev.ok && ev.gates.includes(ECONOMY_GATES.ZERO_QUOTE));
}
{
  const ev = evaluateLegEconomics({
    amountIn: 0n, amountOut: E6, reserveIn: R_WETH, reserveOut: R_DAI,
    swapFeeBps: 100, decimalsIn: 18, decimalsOut: 6,
  });
  check("amountIn=0 → ZERO_AMOUNT_IN", !ev.ok && ev.gates.includes(ECONOMY_GATES.ZERO_AMOUNT_IN));
}
{
  const ev = evaluateLegEconomics({
    amountIn: E18, amountOut: E6, reserveIn: 0n, reserveOut: R_DAI,
    swapFeeBps: 100, decimalsIn: 18, decimalsOut: 6,
  });
  check("reserveIn=0 → ZERO_RESERVE", !ev.ok && ev.gates.includes(ECONOMY_GATES.ZERO_RESERVE));
}

console.log("\n═══ 4. POOL SHARE ≤ 1% ═══");
{
  // 1% of 100 WETH = 1 WETH. Exactly at the boundary must PASS.
  const atCap = legAmountOut({ amountIn: 1n * E18, reserveIn: R_WETH, reserveOut: R_DAI, swapFeeBps: 100 });
  const evAt = evaluateLegEconomics({
    amountIn: 1n * E18, amountOut: atCap, reserveIn: R_WETH, reserveOut: R_DAI,
    swapFeeBps: 100, decimalsIn: 18, decimalsOut: 6,
  });
  check("amountIn = exactly 1% of reserve → pool share 1.0000% and PASSES",
    evAt.ok && evAt.poolShare === 0.01, `share=${(evAt.poolShare * 100).toFixed(4)}% gates=${evAt.gates.join(",")}`);

  // Over the cap by a clear margin. NOTE: the comparison is in WHOLE bps via
  // bigint division, so a size that is only slightly over 1% still truncates to
  // exactly 100 bps and correctly passes. 2 WETH = 2% is unambiguously over.
  const over = legAmountOut({ amountIn: 2n * E18, reserveIn: R_WETH, reserveOut: R_DAI, swapFeeBps: 100 });
  const evOver = evaluateLegEconomics({
    amountIn: 2n * E18, amountOut: over, reserveIn: R_WETH, reserveOut: R_DAI,
    swapFeeBps: 100, decimalsIn: 18, decimalsOut: 6,
  });
  check("amountIn = 2% of reserve → POOL_SHARE_HIGH", !evOver.ok && evOver.gates.includes(ECONOMY_GATES.POOL_SHARE_HIGH),
    `share=${(evOver.poolShare * 100).toFixed(4)}%`);

  // 1.001 WETH truncates to exactly 100 bps — documented integer-bps boundary.
  const wei = legAmountOut({ amountIn: 1n * E18 + 10n ** 15n, reserveIn: R_WETH, reserveOut: R_DAI, swapFeeBps: 100 });
  const evWei = evaluateLegEconomics({
    amountIn: 1n * E18 + 10n ** 15n, amountOut: wei, reserveIn: R_WETH, reserveOut: R_DAI,
    swapFeeBps: 100, decimalsIn: 18, decimalsOut: 6,
  });
  check("1.001 WETH truncates to 100 bps → PASSES (documented integer-bps boundary)",
    evWei.ok && evWei.poolShare === 0.01, `share=${(evWei.poolShare * 100).toFixed(6)}%`);

  // Clearly over: 10 WETH = 10% of the pool.
  const big = legAmountOut({ amountIn: 10n * E18, reserveIn: R_WETH, reserveOut: R_DAI, swapFeeBps: 100 });
  const evBig = evaluateLegEconomics({
    amountIn: 10n * E18, amountOut: big, reserveIn: R_WETH, reserveOut: R_DAI,
    swapFeeBps: 100, decimalsIn: 18, decimalsOut: 6,
  });
  check("amountIn = 10% of reserve → POOL_SHARE_HIGH and poolShare≈0.10",
    !evBig.ok && evBig.gates.includes(ECONOMY_GATES.POOL_SHARE_HIGH) && Math.abs(evBig.poolShare - 0.10) < 1e-9,
    `share=${(evBig.poolShare * 100).toFixed(4)}%`);

  // 0.5% must PASS (under the cap).
  const half = legAmountOut({ amountIn: 5n * E17, reserveIn: R_WETH, reserveOut: R_DAI, swapFeeBps: 100 });
  const evHalf = evaluateLegEconomics({
    amountIn: 5n * E17, amountOut: half, reserveIn: R_WETH, reserveOut: R_DAI,
    swapFeeBps: 100, decimalsIn: 18, decimalsOut: 6,
  });
  check("amountIn = 0.5% of reserve → PASSES pool share", evHalf.ok && evHalf.poolShare === 0.005,
    `share=${(evHalf.poolShare * 100).toFixed(4)}%`);
}

console.log("\n═══ 5. PRICE IMPACT ≤ 2% (fee removed) ═══");
{
  // A tiny swap has ~0 price impact ex-fee. Must pass.
  const tinyOut = legAmountOut({ amountIn: E16, reserveIn: R_WETH, reserveOut: R_DAI, swapFeeBps: 100 });
  const evT = evaluateLegEconomics({
    amountIn: E16, amountOut: tinyOut, reserveIn: R_WETH, reserveOut: R_DAI,
    swapFeeBps: 100, decimalsIn: 18, decimalsOut: 6,
  });
  check("tiny swap → price impact ≈ 0 and PASSES",
    evT.ok && Math.abs(evT.priceImpactExFee) < 0.0002,
    `impact=${(evT.priceImpactExFee * 100).toFixed(4)}%`);

  // Fee must NOT be counted as price impact. Feed a quote that is EXACTLY the
  // fee-discounted spot: impact must be ~0, proving the fee is stripped first.
  const exactFeeOnly = legAmountOut({ amountIn: E16, reserveIn: R_WETH, reserveOut: R_DAI, swapFeeBps: 100 });
  const evF = evaluateLegEconomics({
    amountIn: E16, amountOut: exactFeeOnly, reserveIn: R_WETH, reserveOut: R_DAI,
    swapFeeBps: 100, decimalsIn: 18, decimalsOut: 6,
  });
  check("fee is excluded from price impact (1% fee alone ≠ impact)",
    Math.abs(evF.priceImpactExFee) < 0.0002, `impact=${(evF.priceImpactExFee * 100).toFixed(6)}%`);

  // A quote that under-delivers by 5% versus the fee-adjusted expectation is a
  // real 5% impact and must be vetoed. Use a TINY size so the pool's own price
  // impact is ~0 and the shortfall is the only contributor.
  const tinyIn = 10n ** 15n;
  const honest = legAmountOut({ amountIn: tinyIn, reserveIn: R_WETH, reserveOut: R_DAI, swapFeeBps: 100 });
  const short = (honest * 95n) / 100n; // 5% worse than the honest quote
  const evS = evaluateLegEconomics({
    amountIn: tinyIn, amountOut: short, reserveIn: R_WETH, reserveOut: R_DAI,
    swapFeeBps: 100, decimalsIn: 18, decimalsOut: 6,
  });
  check("quote 5% short of honest → PRICE_IMPACT_HIGH",
    !evS.ok && evS.gates.includes(ECONOMY_GATES.PRICE_IMPACT_HIGH),
    `impact=${(evS.priceImpactExFee * 100).toFixed(4)}%`);

  // 1.5% short is inside the 2% band → must PASS.
  const mild = (honest * 985n) / 1000n;
  const evM = evaluateLegEconomics({
    amountIn: tinyIn, amountOut: mild, reserveIn: R_WETH, reserveOut: R_DAI,
    swapFeeBps: 100, decimalsIn: 18, decimalsOut: 6,
  });
  check("quote 1.5% short of honest → PASSES price impact",
    evM.ok && Math.abs(evM.priceImpactExFee) < 0.02,
    `impact=${(evM.priceImpactExFee * 100).toFixed(4)}%`);

  // Exactly at the 2% boundary passes; just past it fails.
  const atCap = (honest * 980n) / 1000n;
  const evCap = evaluateLegEconomics({
    amountIn: tinyIn, amountOut: atCap, reserveIn: R_WETH, reserveOut: R_DAI,
    swapFeeBps: 100, decimalsIn: 18, decimalsOut: 6,
  });
  check("quote exactly 2% short → PASSES (at the cap)", evCap.ok,
    `impact=${(evCap.priceImpactExFee * 100).toFixed(4)}%`);
  const pastCap = (honest * 979n) / 1000n;
  const evPast = evaluateLegEconomics({
    amountIn: tinyIn, amountOut: pastCap, reserveIn: R_WETH, reserveOut: R_DAI,
    swapFeeBps: 100, decimalsIn: 18, decimalsOut: 6,
  });
  check("quote 2.1% short → PRICE_IMPACT_HIGH (just past the cap)",
    !evPast.ok && evPast.gates.includes(ECONOMY_GATES.PRICE_IMPACT_HIGH),
    `impact=${(evPast.priceImpactExFee * 100).toFixed(4)}%`);
}

console.log("\n═══ 6. RATE DEVIATION — (1−f)^(2×legs) EXPECTATION ═══");
{
  // Honest direct pool. Both directions are priced off the SAME reserves and
  // each applies the 1% fee on its own input, so:
  //   rateAB = spot × (1−f)   and   rateBA = (1/spot) × (1−f)
  //   product = (1−f)^2 = 0.9801 exactly.
  const spot = 3000;
  const rateAB = spot * 0.99;      // 2970 DAI per WETH
  const rateBA = (1 / spot) * 0.99; // 0.00033 WETH per DAI
  const rc = checkRateConsistency({ rateAB, rateBA, legs: 1, feeFrac: 0.01, maxDeviation: 0.05 });
  check("honest 1-leg product = (1−f)^2 = 0.9801 → PASSES",
    rc.ok && Math.abs(rc.product - 0.9801) < 1e-12,
    `product=${rc.product.toFixed(6)} expected=${rc.expected.toFixed(6)} deviation=${(rc.deviation * 100).toFixed(4)}%`);

  // Expected value formula for each leg count.
  check("expected(1 leg) = 0.99^2 = 0.9801",
    Math.abs(Math.pow(0.99, 2) - 0.9801) < 1e-12);
  check("expected(2 legs) = 0.99^4 = 0.96059601",
    Math.abs(Math.pow(0.99, 4) - 0.96059601) < 1e-12);
  check("expected(3 legs) = 0.99^6 ≈ 0.941480149",
    Math.abs(Math.pow(0.99, 6) - 0.9414801491) < 1e-9);

  // The observed on-chain anomaly: product 148× → must be vetoed.
  const bad148 = checkRateConsistency({ rateAB: 3.02e21, rateBA: 4.9e-17, legs: 1, feeFrac: 0.01, maxDeviation: 0.05 });
  check("product ≈ 148× → RATE_DEVIATION vetoed",
    !bad148.ok && bad148.gates.includes(ECONOMY_GATES.RATE_DEVIATION),
    `product=${bad148.product.toExponential(3)} deviation=${bad148.deviation.toExponential(3)}`);

  // The worse observed anomaly: product 3.15e5× → must be vetoed.
  const bad3e5 = checkRateConsistency({ rateAB: 3.02e21, rateBA: 1.04e-16, legs: 1, feeFrac: 0.01, maxDeviation: 0.05 });
  check("product ≈ 3.15e5× → RATE_DEVIATION vetoed",
    !bad3e5.ok && bad3e5.gates.includes(ECONOMY_GATES.RATE_DEVIATION),
    `product=${bad3e5.product.toExponential(3)}`);

  // A product of exactly 1.0 means the fee was NOT applied on one side. Against
  // the FEE-CORRECTED expectation that is a 2.03% deviation — inside the 5%
  // band, so it passes. (Against a naive 1.0 baseline it would read as perfect,
  // which is exactly why the raw baseline is wrong.)
  const unity = checkRateConsistency({ rateAB: 3000, rateBA: 1 / 3000, legs: 1, feeFrac: 0.01, maxDeviation: 0.05 });
  check("product = 1.0 (fee missing on one side) → 2.03% deviation, inside 5% band → PASSES",
    unity.ok && Math.abs(unity.deviation - 0.020304) < 1e-5,
    `deviation=${(unity.deviation * 100).toFixed(4)}%`);

  // Zero/NaN rates are never tradable.
  check("rateAB=0 → RATE_DEVIATION", !checkRateConsistency({ rateAB: 0, rateBA: 1, legs: 1, feeFrac: 0.01 }).ok);
  check("rateBA=NaN → RATE_DEVIATION", !checkRateConsistency({ rateAB: 1, rateBA: NaN, legs: 1, feeFrac: 0.01 }).ok);

  // Multi-leg expectation scales with legs: 2 legs → (1−f)^4.
  // Both directions of a 2-hop pay the fee twice, so each rate carries (1−f)^2
  // and the product is (1−f)^4 = 0.96059601.
  const twoLeg = checkRateConsistency({
    rateAB: Math.pow(0.99, 2), rateBA: Math.pow(0.99, 2), legs: 2, feeFrac: 0.01, maxDeviation: 0.05,
  });
  check("honest 2-leg product matches (1−f)^4 → PASSES",
    twoLeg.ok && Math.abs(twoLeg.product - twoLeg.expected) < 1e-12,
    `product=${twoLeg.product.toFixed(8)} expected=${twoLeg.expected.toFixed(8)}`);

  // A 2-leg route whose product only matches the 1-leg expectation is a
  // 4.1% deviation — still inside 5%, but it must be measured against (1−f)^4.
  const mismatched = checkRateConsistency({
    rateAB: 2970, rateBA: 1 / 2970, legs: 2, feeFrac: 0.01, maxDeviation: 0.05,
  });
  check("2-leg route measured against (1−f)^4 (not (1−f)^2) — expectation scales with legs",
    Math.abs(mismatched.expected - 0.96059601) < 1e-9,
    `expected=${mismatched.expected.toFixed(8)} product=${mismatched.product.toFixed(6)}`);
}

console.log("\n═══ 7. WHOLE-ROUTE EVALUATION (per-leg gates compose) ═══");
{
  const goodLeg = {
    amountIn: 5n * E17, reserveIn: R_WETH, reserveOut: R_DAI,
    swapFeeBps: 100, decimalsIn: 18, decimalsOut: 6,
  };
  goodLeg.amountOut = legAmountOut(goodLeg);
  const r = evaluateRouteEconomics({ legs: [goodLeg] });
  check("single good leg → route ok", r.ok && r.worstPoolShare === 0.005);

  const badLeg = { ...goodLeg, amountIn: 10n * E18 };
  badLeg.amountOut = legAmountOut(badLeg);
  const r2 = evaluateRouteEconomics({ legs: [goodLeg, badLeg] });
  check("one bad leg poisons the whole route", !r2.ok && r2.gates.includes(ECONOMY_GATES.POOL_SHARE_HIGH));
  check("worstPoolShare reports the worst leg", Math.abs(r2.worstPoolShare - 0.10) < 1e-9, `worst=${(r2.worstPoolShare * 100).toFixed(4)}%`);

  const empty = evaluateRouteEconomics({ legs: [] });
  check("empty leg list → not ok", !empty.ok);
}

console.log("\n═══ 8. THRESHOLDS ARE CONFIGURABLE BUT NEVER AUTO-WIDENED ═══");
{
  const tight = normalizeEconomyConfig({ maxPoolShareBps: 10 });
  check("maxPoolShareBps override to 10 is honoured", tight.maxPoolShareBps === 10);
  const leg = {
    amountIn: 5n * E17, reserveIn: R_WETH, reserveOut: R_DAI,
    swapFeeBps: 100, decimalsIn: 18, decimalsOut: 6, economy: tight,
  };
  leg.amountOut = legAmountOut(leg);
  const ev = evaluateLegEconomics(leg);
  check("0.5% fails under a 0.1% cap (tight override really applies)",
    !ev.ok && ev.gates.includes(ECONOMY_GATES.POOL_SHARE_HIGH));

  const garbage = normalizeEconomyConfig({ maxPoolShareBps: "abc", maxPriceImpactBps: null, maxRateDeviation: "x" });
  check("garbage overrides fall back to the SAFE defaults",
    garbage.maxPoolShareBps === 100 && garbage.maxPriceImpactBps === 200 && garbage.maxRateDeviation === 0.05);

  const widened = normalizeEconomyConfig({ maxPoolShareBps: 1e9 });
  check("an absurd override is CLAMPED to 100% (never beyond)", widened.maxPoolShareBps === 10000);
}

console.log("\n═══ 9. legSpot NORMALISES DECIMALS ═══");
{
  const s = legSpot({ reserveIn: R_WETH, reserveOut: R_DAI, decimalsIn: 18, decimalsOut: 6 });
  check("spot of 100 WETH / 300000 DAI = 3000 DAI per WETH", Math.abs(s - 3000) < 1e-9);
  const inv = legSpot({ reserveIn: R_DAI, reserveOut: R_WETH, decimalsIn: 6, decimalsOut: 18 });
  check("inverse spot = 1/3000", Math.abs(inv - 1 / 3000) < 1e-12);
  check("zero reserve → null", legSpot({ reserveIn: 0n, reserveOut: R_DAI, decimalsIn: 18, decimalsOut: 6 }) === null);
}

console.log("\n═══════════════════════════════════════════════════════");
console.log(`  ${PASS.length}/${total} passed, ${FAIL.length} failed`);
if (FAIL.length) {
  console.log(" FAILURES:");
  for (const f of FAIL) console.log(`   - ${f}`);
}
console.log("═══════════════════════════════════════════════════════\n");
process.exit(FAIL.length ? 1 : 0);
