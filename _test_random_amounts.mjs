#!/usr/bin/env node
/**
 * TEST: Verify random amount generation produces unique values
 * Tests: getRandomSwapAmount, getRandomTradeAmount, consecutive repeat prevention
 */

import { ethers } from "ethers";

const WETH = "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9";
const TOKENS = {
  ETH: { address: WETH, decimals: 18 },
  DAI: { address: "0xe99655E262eF4C20eBeC4805B3963dad52a1538e", decimals: 6 },
  USDC: { address: "0x415582a27FDe699ea13f42277908572969223707", decimals: 6 },
  USDT: { address: "0x8b4449fe9cd5bbcb66e22bece8107d0e4fd3348b", decimals: 6 },
  UNI: { address: "0x8abea3BEDFD58e924712F1FC8f2761B2Ee49c116", decimals: 6 },
  LINK: { address: "0x1432dea6b80bc77b58e1badfcffd6613f0254347", decimals: 6 },
  NEMESIS: { address: "0xee466787c56b02f8dead4d0b668c375853fd11a3", decimals: 6 }
};

// ── Simulate the random amount generation logic ──
const _lastSwapAmounts = {};
const _lastTradeAmounts = {};

function generateRandomSwapAmount(balanceFloat, sym, options = {}) {
  const isEth = sym === "ETH" || sym === "WETH";
  const decimals = isEth ? 18 : (TOKENS[sym]?.decimals || 6);

  if (balanceFloat <= 0) return "0.001";

  const pctMin = options.pctMin || 0.01;
  const pctMax = options.pctMax || 0.05;
  const pct = pctMin + Math.random() * (pctMax - pctMin);
  let rawAmount = balanceFloat * pct;

  const configuredMin = isEth ? 0.00001 : 0.001;
  const configuredMaxRaw = isEth ? 0.0002 : balanceFloat * 0.1;
  const configuredMax = Math.max(configuredMaxRaw, balanceFloat * 0.05, configuredMin * 10);
  rawAmount = Math.max(configuredMin, Math.min(configuredMax, rawAmount));

  const decimalPlaces = 2 + Math.floor(Math.random() * 5);
  let amount = Number(rawAmount.toFixed(decimalPlaces));

  const prevAmount = _lastSwapAmounts[sym];
  if (prevAmount !== undefined && prevAmount > 0) {
    const diff = Math.abs(amount - prevAmount);
    const threshold = Math.max(prevAmount * 0.10, configuredMin * 0.5);
    if (diff < threshold) {
      const shift = threshold + Math.random() * threshold;
      if (amount > prevAmount) {
        amount = Math.min(configuredMax, amount + shift);
      } else {
        amount = Math.max(configuredMin, amount - shift);
      }
      amount = Number(amount.toFixed(decimalPlaces));
    }
  }

  amount = Math.max(configuredMin, Math.min(configuredMax, amount));
  if (amount <= 0) amount = configuredMin;
  _lastSwapAmounts[sym] = amount;
  return amount.toFixed(decimalPlaces).replace(/0+$/, "").replace(/\.$/, "") || String(configuredMin);
}

function generateRandomTradeAmount(balanceFloat, side, collatSym = "ETH") {
  const isEth = collatSym === "ETH" || collatSym === "WETH";
  if (balanceFloat <= 0) return "0.01";

  const pctMin = 0.01;
  const pctMax = 0.05;
  const pct = pctMin + Math.random() * (pctMax - pctMin);
  let rawAmount = balanceFloat * pct;

  const configuredMin = 0.01;
  const configuredMax = Math.max(configuredMin, balanceFloat * 0.1);
  rawAmount = Math.max(configuredMin, Math.min(configuredMax, rawAmount));

  const decimalPlaces = 2 + Math.floor(Math.random() * 4);
  let amount = Number(rawAmount.toFixed(decimalPlaces));

  const prevAmount = _lastTradeAmounts[side];
  if (prevAmount !== undefined && prevAmount > 0) {
    const diff = Math.abs(amount - prevAmount);
    const threshold = Math.max(prevAmount * 0.10, configuredMin * 0.5);
    if (diff < threshold) {
      const shift = threshold + Math.random() * threshold;
      if (amount > prevAmount) {
        amount = Math.min(configuredMax, amount + shift);
      } else {
        amount = Math.max(configuredMin, amount - shift);
      }
      amount = Number(amount.toFixed(decimalPlaces));
    }
  }

  amount = Math.max(configuredMin, Math.min(configuredMax, amount));
  if (amount <= 0) amount = configuredMin;
  _lastTradeAmounts[side] = amount;
  return amount.toFixed(decimalPlaces).replace(/0+$/, "").replace(/\.$/, "") || String(configuredMin);
}

// ── Run tests ──
console.log("═══════════════════════════════════════════════════════");
console.log("  RANDOM AMOUNT GENERATION TEST");
console.log("═══════════════════════════════════════════════════════\n");

// Test 1: ETH swaps (balance = 25 ETH)
console.log("═══ TEST 1: ETH SWAPS (balance = 25 ETH) ═══");
const ethSwaps = [];
for (let i = 0; i < 15; i++) {
  const amt = generateRandomSwapAmount(25, "ETH");
  ethSwaps.push(amt);
  const isRepeat = i > 0 && amt === ethSwaps[i - 1];
  console.log(`  Swap ${String(i + 1).padStart(2)}: ${amt.padEnd(10)} ETH ${isRepeat ? "❌ REPEAT!" : "✓"}`);
}
const ethUnique = new Set(ethSwaps);
console.log(`  Unique values: ${ethUnique.size}/${ethSwaps.length}`);
console.log(`  Consecutive repeats: ${ethSwaps.filter((v, i) => i > 0 && v === ethSwaps[i - 1]).length}\n`);

// Test 2: USDT swaps (balance = 1200 USDT)
console.log("═══ TEST 2: USDT SWAPS (balance = 1200 USDT) ═══");
const usdtSwaps = [];
for (let i = 0; i < 15; i++) {
  const amt = generateRandomSwapAmount(1200, "USDT");
  usdtSwaps.push(amt);
  const isRepeat = i > 0 && amt === usdtSwaps[i - 1];
  console.log(`  Swap ${String(i + 1).padStart(2)}: ${amt.padEnd(10)} USDT ${isRepeat ? "❌ REPEAT!" : "✓"}`);
}
const usdtUnique = new Set(usdtSwaps);
console.log(`  Unique values: ${usdtUnique.size}/${usdtSwaps.length}`);
console.log(`  Consecutive repeats: ${usdtSwaps.filter((v, i) => i > 0 && v === usdtSwaps[i - 1]).length}\n`);

// Test 3: DAI swaps (balance = 2400 DAI)
console.log("═══ TEST 3: DAI SWAPS (balance = 2400 DAI) ═══");
const daiSwaps = [];
for (let i = 0; i < 15; i++) {
  const amt = generateRandomSwapAmount(2400, "DAI");
  daiSwaps.push(amt);
  const isRepeat = i > 0 && amt === daiSwaps[i - 1];
  console.log(`  Swap ${String(i + 1).padStart(2)}: ${amt.padEnd(10)} DAI ${isRepeat ? "❌ REPEAT!" : "✓"}`);
}
const daiUnique = new Set(daiSwaps);
console.log(`  Unique values: ${daiUnique.size}/${daiSwaps.length}`);
console.log(`  Consecutive repeats: ${daiSwaps.filter((v, i) => i > 0 && v === daiSwaps[i - 1]).length}\n`);

// Test 4: LONG positions (ETH, balance = 25 ETH)
console.log("═══ TEST 4: LONG POSITIONS (ETH, balance = 25 ETH) ═══");
const longAmounts = [];
for (let i = 0; i < 15; i++) {
  const amt = generateRandomTradeAmount(25, "LONG", "ETH");
  longAmounts.push(amt);
  const isRepeat = i > 0 && amt === longAmounts[i - 1];
  console.log(`  LONG ${String(i + 1).padStart(2)}: ${amt.padEnd(10)} ETH ${isRepeat ? "❌ REPEAT!" : "✓"}`);
}
const longUnique = new Set(longAmounts);
console.log(`  Unique values: ${longUnique.size}/${longAmounts.length}`);
console.log(`  Consecutive repeats: ${longAmounts.filter((v, i) => i > 0 && v === longAmounts[i - 1]).length}\n`);

// Test 5: SHORT positions (ETH, balance = 25 ETH)
console.log("═══ TEST 5: SHORT POSITIONS (ETH, balance = 25 ETH) ═══");
const shortAmounts = [];
for (let i = 0; i < 15; i++) {
  const amt = generateRandomTradeAmount(25, "SHORT", "ETH");
  shortAmounts.push(amt);
  const isRepeat = i > 0 && amt === shortAmounts[i - 1];
  console.log(`  SHORT ${String(i + 1).padStart(2)}: ${amt.padEnd(10)} ETH ${isRepeat ? "❌ REPEAT!" : "✓"}`);
}
const shortUnique = new Set(shortAmounts);
console.log(`  Unique values: ${shortUnique.size}/${shortAmounts.length}`);
console.log(`  Consecutive repeats: ${shortAmounts.filter((v, i) => i > 0 && v === shortAmounts[i - 1]).length}\n`);

// Test 6: Leverage randomization
console.log("═══ TEST 6: LEVERAGE RANDOMIZATION ═══");
const leverages = [];
const minLev = 10;
const maxLev = 30;
let lastLev = null;
for (let i = 0; i < 15; i++) {
  let lev = Math.round(minLev + Math.random() * (maxLev - minLev));
  if (lastLev !== null && lev === lastLev) {
    lev = lev + 1;
    if (lev > maxLev) lev = minLev;
  }
  lastLev = lev;
  leverages.push(lev);
  const isRepeat = i > 0 && lev === leverages[i - 1];
  console.log(`  Leverage ${String(i + 1).padStart(2)}: ${String(lev).padStart(2)}x ${isRepeat ? "❌ REPEAT!" : "✓"}`);
}
const levUnique = new Set(leverages);
console.log(`  Unique values: ${levUnique.size}/${leverages.length}`);
console.log(`  Consecutive repeats: ${leverages.filter((v, i) => i > 0 && v === leverages[i - 1]).length}\n`);

// ── Summary ──
console.log("═══════════════════════════════════════════════════════");
console.log("  SUMMARY");
console.log("═══════════════════════════════════════════════════════");
const allTests = [
  { name: "ETH Swaps", unique: ethUnique.size, total: ethSwaps.length },
  { name: "USDT Swaps", unique: usdtUnique.size, total: usdtSwaps.length },
  { name: "DAI Swaps", unique: daiUnique.size, total: daiSwaps.length },
  { name: "LONG", unique: longUnique.size, total: longAmounts.length },
  { name: "SHORT", unique: shortUnique.size, total: shortAmounts.length },
  { name: "Leverage", unique: levUnique.size, total: leverages.length }
];
for (const t of allTests) {
  const pct = ((t.unique / t.total) * 100).toFixed(0);
  const icon = t.unique === t.total ? "✅" : t.unique >= t.total * 0.8 ? "⚠️" : "❌";
  console.log(`  ${icon} ${t.name.padEnd(15)} ${t.unique}/${t.total} unique (${pct}%)`);
}
console.log("\n🏁 TEST COMPLETE");
