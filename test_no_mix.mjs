// ═══════════════════════════════════════════════════════════════════════════════
//  READ-ONLY INTEGRATION TEST: the bot CANNOT mix old (v2) and new (v5)
//  tokens/pools/managers when the active deployment is v5.
//
//  Runs discoverMarkets() against the REAL v5 factory with:
//    • tokens        = v5 site token table
//    • confirmedPools= v5 site pools
//    • availableMarkets = POISONED with the old v2 pool entries from config.json
//  Expected:
//    • every accepted market uses a v5 pool + v5 manager
//    • every injected v2 pool is REJECTED ("not registered on active factory")
//    • no accepted market references any v2 pool/manager/token address
//
//  NO transactions, NO state writes. Exit 0 = pass.
// ═══════════════════════════════════════════════════════════════════════════════
import "./_test_state_isolation.mjs"; // state redirect + default-deny live-TX guard
import { ethers } from "ethers";
import fs from "fs";
import { discoverMarkets } from "./marketDiscovery.js";
import { getDeploymentProfile } from "./deployments/index.js";

const V5 = getDeploymentProfile("v5");
const V2 = getDeploymentProfile("v2");
const provider = new ethers.JsonRpcProvider("https://ethereum-sepolia-rpc.publicnode.com", 11155111, { batchMaxCount: 2 });

let fails = 0;
const ok = (n) => console.log(`  ✅ ${n}`);
const bad = (n, d) => { fails++; console.log(`  ❌ ${n}${d ? " — " + d : ""}`); };

// Poison: the OLD v2 market entries (same shape as config.availableMarkets)
const v2Poison = Object.entries(V2.confirmedPools).map(([symbol, e]) => {
  const [aSym] = symbol.split("/");
  return {
    symbol,
    collateralToken: V2.tokens[aSym === "ETH" ? "WETH" : aSym] || V2.tokens.NEMESIS,
    collateralSymbol: aSym,
    poolAddress: e.pool,
    pool: e.pool,
    managerAddress: e.manager,
    supportsLong: true,
    supportsShort: true,
    isActive: true,
    health: "WORKING",
  };
});
console.log(`Poisoned availableMarkets: ${v2Poison.length} OLD v2 entries (pools ${v2Poison.map(p => p.pool.slice(0, 8)).join(",")}…)`);

// Extra poison: the LEGACY-USDT/WETH pool 0xb773392d… — factory-registered on
// the ACTIVE v5 factory (so the factory gate alone would accept it) but pairing
// the pre-migration USDT 0x5f2E83cC… which is NOT in the v5 token table.
// Declared here with the SITE USDT as collateral hint — the token-set gate must
// reject it because the pool's real token0 is the legacy USDT.
const legacyUsdtWeth = Object.values(V5.excludedPools || {}).find(e => String(e.pool).toLowerCase().startsWith("0xb773392d"));
if (legacyUsdtWeth) {
  v2Poison.push({
    symbol: "USDT/WETH",
    collateralToken: V5.tokens.USDT,           // LIE: claims site USDT
    collateralSymbol: "USDT",
    poolAddress: legacyUsdtWeth.pool,          // real pool: legacy USDT / WETH
    pool: legacyUsdtWeth.pool,
    managerAddress: legacyUsdtWeth.manager,
    supportsLong: true,
    supportsShort: true,
    isActive: true,
    health: "WORKING",
  });
  console.log(`Added legacy-token poison: USDT/WETH ${legacyUsdtWeth.pool.slice(0, 12)}… (legacy USDT 0x5f2E83cC… must be rejected by token-set gate)`);
} else {
  console.log("WARNING: v5.excludedPools missing legacy USDT/WETH 0xb773392d… — token-set gate not fully exercised");
}

const logs = [];
const discovered = await discoverMarkets({
  provider,
  factoryAddress: V5.factory,
  tokens: V5.tokens,
  confirmedPools: V5.confirmedPools,
  knownMarkets: V5.knownMarkets,
  availableMarkets: v2Poison,
  log: (m) => logs.push(m),
});

const markets = discovered.markets || [];
const rejected = discovered.rejected || [];
console.log(`\nDiscovery result: ${markets.length} accepted, ${rejected.length} rejected`);

// Sets for membership checks
const v5Pools = new Set(Object.values(V5.confirmedPools).map(e => e.pool.toLowerCase()));
const v5Mgrs = new Set(Object.values(V5.confirmedPools).map(e => e.manager.toLowerCase()));
const v5Tokens = new Set(Object.values(V5.tokens).map(a => a.toLowerCase()));
const v2Pools = new Set(Object.values(V2.confirmedPools).map(e => e.pool.toLowerCase()));
const v2Mgrs = new Set(Object.values(V2.confirmedPools).map(e => e.manager.toLowerCase()));
const v2Tokens = new Set(Object.values(V2.tokens).map(a => a.toLowerCase()));

// The site factory legitimately registers MORE pools among the v5 token set
// than the 6 USDT-pair confirmedPools (e.g. WETH/DAI, NEMESIS/WETH). Those are
// still v5-native (same factory, managers discovered via Factory.getManager).
// The NO-MIX invariant is: every accepted market must be v5-native AND must
// have ZERO overlap with the v2 address space.
const FACTORY_ABI = ["function getPool(address,address) view returns (address)", "function getManager(address) view returns (address)"];
const fac = new ethers.Contract(V5.factory, FACTORY_ABI, provider);

// 1. every accepted market must be v5-native and zero-overlap with v2
let confirmedNative = 0;
for (const m of markets) {
  const pool = String(m.poolAddr || m.pool || "").toLowerCase();
  const mgr = String(m.managerAddr || m.manager || "").toLowerCase();
  const label = m.marketSymbol || m.symbol;

  // zero overlap with v2 address space — THE core no-mix invariant
  if (v2Pools.has(pool)) bad(`accepted market ${label} uses a v2 POOL`, pool);
  if (v2Mgrs.has(mgr)) bad(`accepted market ${label} uses a v2 MANAGER`, mgr);
  for (const t of [m.token0, m.token1]) {
    const tl = String(t || "").toLowerCase();
    if (v2Tokens.has(tl) && !v5Tokens.has(tl)) bad(`accepted market ${label} uses a v2-only TOKEN`, tl);
    if (!v5Tokens.has(tl) && tl !== ethers.ZeroAddress) bad(`accepted market ${label} uses NON-v5 token`, tl);
  }

  // pool must be REGISTERED on the active (v5) factory — positive proof
  try {
    const gp = await fac.getPool(m.token0, m.token1);
    if (gp && gp !== ethers.ZeroAddress && gp.toLowerCase() === pool) confirmedNative++;
    else bad(`accepted market ${label} pool NOT registered on v5 factory`, `${pool} vs getPool=${gp}`);
  } catch (e) {
    bad(`accepted market ${label}: Factory.getPool reverted`, e.shortMessage || e.message);
  }
}
if (markets.length > 0 && confirmedNative === markets.length) {
  ok(`all ${markets.length} accepted markets are registered on the v5 factory (0 v2 overlap)`);
}

// 2. every v2 pool must be rejected
for (const p of v2Poison) {
  const poolL = p.pool.toLowerCase();
  const acceptedHit = markets.find(m => String(m.poolAddr || m.pool || "").toLowerCase() === poolL);
  const rejectHit = rejected.find(r => String(r.pool || "").toLowerCase() === poolL);
  if (acceptedHit) bad(`v2 pool ${p.pool} was ACCEPTED on v5 — MIXING!`, p.symbol);
  else if (rejectHit) ok(`v2 pool ${p.symbol} ${p.pool.slice(0, 10)}… rejected (${rejectHit.reason})`);
  else bad(`v2 pool ${p.symbol} ${p.pool} vanished — neither accepted nor rejected (unexpected)`);
}

// 3. zero overlap between accepted and v2 address spaces
for (const m of markets) {
  const pool = String(m.poolAddr || m.pool || "").toLowerCase();
  const mgr = String(m.managerAddr || m.manager || "").toLowerCase();
  if (v2Pools.has(pool)) bad("accepted market pool is a v2 pool", pool);
  if (v2Mgrs.has(mgr)) bad("accepted market manager is a v2 manager", mgr);
}

// 4. expected v5 markets present (factory enumeration over the 7 v5 tokens)
const expected = ["ETH/USDT", "NEMESIS/USDT", "USDC/USDT", "DAI/USDT", "UNI/USDT", "LINK/USDT", "NEMESIS/WETH"];
const gotSymbols = new Set(markets.map(m => m.marketSymbol || m.symbol));
for (const e of expected) {
  if (!gotSymbols.has(e)) {
    // symbol naming may flip (USDT/DAI vs DAI/USDT) — check by pool instead
    const ePool = V5.confirmedPools[e]?.pool?.toLowerCase();
    const byPool = markets.find(m => String(m.poolAddr || m.pool || "").toLowerCase() === ePool);
    if (!byPool) bad(`expected v5 market ${e} missing from discovery`);
    else ok(`expected v5 market ${e} found as ${byPool.marketSymbol || byPool.symbol}`);
  } else ok(`expected v5 market ${e} found`);
}

console.log(`\n${fails === 0 ? "PASS" : "FAIL"} — no-mix (v2/v5 isolation): ${fails} failure(s)`);
process.exit(fails === 0 ? 0 : 1);
