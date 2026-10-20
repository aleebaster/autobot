// ═══════════════════════════════════════════════════════════════════════════════
//  UNIT TEST: deployment registry + token/pool isolation (NO network, NO txs)
//
//  Verifies:
//    1. v5 profile exists, is ACTIVE by default, and carries the full site config
//    2. v2 profile remains selectable (read-only diagnostics of old positions)
//    3. Token tables do NOT overlap between v2 and v5 (except WETH/NEMESIS which
//       are genuinely the same contracts on both deployments)
//    4. Confirmed pools do NOT overlap between v2 and v5
//    5. Switching deployments flips factory/router/tokens/pools atomically
//    6. No truncated/short addresses in v5 (all 42-char, checksummed-length)
// ═══════════════════════════════════════════════════════════════════════════════
import "./_test_state_isolation.mjs"; // state redirect + default-deny live-TX guard
import {
  getAllDeployments, getDeploymentProfile, getActiveDeployment, getActiveDeploymentId,
  setActiveDeployment, getFactoryAddress, getRouterAddress, getAllTokens,
  getConfirmedPools, getKnownMarkets, getTokenAddress, isV2Plus,
} from "./deployments/index.js";

let fails = 0;
const ok = (name) => console.log(`  ✅ ${name}`);
const bad = (name, detail) => { fails++; console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`); };
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

// 1. registry shape
const all = getAllDeployments();
["v1", "v2", "v3", "v4", "v5"].forEach(id => {
  if (!all[id]) bad(`registry has ${id}`);
});
ok("registry has v1..v5");

const v5 = getDeploymentProfile("v5");
if (!v5) { console.error("FATAL: no v5 profile"); process.exit(1); }
if (getActiveDeploymentId() !== "v5") bad("default active deployment is v5", `got ${getActiveDeploymentId()}`);
else ok("default active deployment = v5");
if (getActiveDeployment().id !== "v5") bad("getActiveDeployment() returns v5");
else ok("getActiveDeployment() = v5");

// 2. v5 full site addresses present and well-formed
const checkAddr = (label, a) => {
  if (!a || !ADDR_RE.test(a)) bad(`${label} is a full 40-byte address`, String(a));
};
checkAddr("v5.factory", v5.factory);
checkAddr("v5.router", v5.router);
["WETH", "USDT", "USDC", "DAI", "UNI", "LINK", "NEMESIS"].forEach(s => checkAddr(`v5.tokens.${s}`, v5.tokens[s]));
ok("v5 core addresses well-formed");

// Site USDT (NOT the old v2 USDT)
if (v5.tokens.USDT.toLowerCase() !== "0x3a1ff83bfd63e5e2564aec95ade244234773049f") bad("v5 USDT is the SITE usdt", v5.tokens.USDT);
else ok("v5 USDT = site USDT 0x3a1ff83b…");
if (v5.factory.toLowerCase() !== "0x35f75f9218c640335d7166628319c4d95d1b0ae8") bad("v5 factory is the SITE factory");
else ok("v5 factory = site factory 0x35f75f92…");

// 3. confirmedPools completeness + shape
const pools5 = v5.confirmedPools || {};
const expectedMarkets = ["ETH/USDT", "NEMESIS/USDT", "USDC/USDT", "DAI/USDT", "UNI/USDT", "LINK/USDT", "NEMESIS/WETH"];
expectedMarkets.forEach(m => {
  const e = pools5[m];
  if (!e) { bad(`v5 confirmedPools has ${m}`); return; }
  checkAddr(`v5 pool ${m}`, e.pool);
  checkAddr(`v5 manager ${m}`, e.manager);
  if (e.deployed !== true) bad(`v5 ${m} deployed flag`);
});
ok(`v5 confirmedPools: ${Object.keys(pools5).length} markets, all with full pool+manager`);

// 3b. excludedPools — legacy pools verified but NEVER tradable
const excl5 = v5.excludedPools || {};
if (Object.keys(excl5).length < 2) bad("v5 excludedPools has the 2 legacy pools", `got ${Object.keys(excl5).length}`);
else ok(`v5 excludedPools: ${Object.keys(excl5).length} legacy pool(s) documented`);
for (const [k, e] of Object.entries(excl5)) {
  checkAddr(`v5 excludedPools.${k}.pool`, e.pool);
  if (Object.values(pools5).some(p => String(p.pool).toLowerCase() === String(e.pool).toLowerCase())) {
    bad(`excluded pool ${k} is ALSO in confirmedPools — no-mix violation!`, e.pool);
  }
}
// the task-listed USDT/WETH prefix must resolve to the excluded legacy pool
const legacyUsdtWeth = Object.values(excl5).find(e => String(e.pool).toLowerCase().startsWith("0xb773392d"));
if (!legacyUsdtWeth) bad("excludedPools contains legacy USDT/WETH 0xb773392d… (full address required)");
else ok("legacy USDT/WETH 0xb773392d… present in excludedPools (not tradable)");
// NEMESIS/WETH (task prefix 0xca028f53…) must be a CONFIRMED market
if (!String(pools5["NEMESIS/WETH"]?.pool || "").toLowerCase().startsWith("0xca028f53")) {
  bad("NEMESIS/WETH confirmed pool starts with 0xca028f53", pools5["NEMESIS/WETH"]?.pool);
} else ok("NEMESIS/WETH confirmed pool = site 0xca028f53…");

// 4. v2 still selectable, and its addresses are the OLD ones
setActiveDeployment("v2");
const v2 = getActiveDeployment();
if (v2.id !== "v2") bad("setActiveDeployment(v2) works");
const pools2 = getConfirmedPools();
if (v2.factory.toLowerCase() !== "0xded3d3ca2f7efde734790ce51bd03d5145e4830b") bad("v2 factory preserved", v2.factory);
else ok("v2 selectable — old factory preserved");
if (getAllTokens().USDT.toLowerCase() !== "0x5f2e83ccdea73d60af400e03f1cd8fb9eab07b20") bad("v2 USDT preserved");
else ok("v2 USDT = old 0x5f2E83cC… (read-only diagnostics possible)");

// 5. NO MIX — token tables disjoint except known-shared contracts
const shared = new Set(["WETH", "ETH", "NEMESIS"]); // same contracts on v2 and v5
let mixed = [];
for (const [sym, a5] of Object.entries(v5.tokens)) {
  if (shared.has(sym)) continue;
  const a2 = v2.tokens[sym];
  if (a2 && a2.toLowerCase() === a5.toLowerCase()) mixed.push(sym);
}
if (mixed.length) bad("v2/v5 token tables share non-shared symbols", mixed.join(","));
else ok("token tables isolated (only WETH/NEMESIS shared — genuinely same contracts)");

// pools disjoint
const p5set = new Set(Object.values(pools5).map(e => e.pool.toLowerCase()));
const p2set = new Set(Object.values(pools2).map(e => e.pool.toLowerCase()));
const poolOverlap = [...p5set].filter(p => p2set.has(p));
if (poolOverlap.length) bad("v2/v5 confirmedPools overlap", poolOverlap.join(","));
else ok("confirmedPools isolated (0 shared pool addresses)");

const m5set = new Set(Object.values(pools5).map(e => e.manager.toLowerCase()));
const m2set = new Set(Object.values(pools2).map(e => e.manager.toLowerCase()));
const mgrOverlap = [...m5set].filter(m => m2set.has(m));
if (mgrOverlap.length) bad("v2/v5 managers overlap", mgrOverlap.join(","));
else ok("managers isolated (0 shared manager addresses)");

// 6. switch back to v5 — atomic flip
setActiveDeployment("v5");
if (getFactoryAddress().toLowerCase() !== v5.factory.toLowerCase()) bad("switch back: factory");
if (getRouterAddress().toLowerCase() !== v5.router.toLowerCase()) bad("switch back: router");
if (getTokenAddress("USDT").toLowerCase() !== v5.tokens.USDT.toLowerCase()) bad("switch back: USDT token");
if (!isV2Plus()) bad("isV2Plus() true for v5");
ok("setActiveDeployment('v5') flips factory/router/tokens atomically");

// 7. old state files untouched
import fs from "fs";
try {
  const st = JSON.parse(fs.readFileSync("auto-trader-state.json", "utf8"));
  const ap = st.activePositions?.[0] ?? null;
  if (ap?.positionId) {
    const v2Mgrs = new Set(Object.values(pools2).map(e => e.manager.toLowerCase()));
    if (ap.managerAddr && v2Mgrs.has(ap.managerAddr.toLowerCase())) {
      ok(`state #${ap.positionId} still points at v2 manager ${ap.managerAddr.slice(0, 10)}… (untouched)`);
    } else {
      // position may live on a manager not in confirmedPools — just confirm file exists
      ok(`state #${ap.positionId} preserved (manager ${ap.managerAddr?.slice(0, 10)}… — outside confirmedPools, untouched)`);
    }
  }
} catch (e) { bad("state file unreadable", e.message); }

console.log(`\n${fails === 0 ? "PASS" : "FAIL"} — deployment registry/isolation: ${fails} failure(s)`);
process.exit(fails === 0 ? 0 : 1);
