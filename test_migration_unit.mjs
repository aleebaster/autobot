// ═══════════════════════════════════════════════════════════════════════════════
//  UNIT TEST: v5 migration — token mapping, pool discovery merge, route
//  validation. NO network, NO transactions, NO state writes. Exit 0 = pass.
// ═══════════════════════════════════════════════════════════════════════════════
import "./_test_state_isolation.mjs"; // state redirect + default-deny live-TX guard
import {
  getActiveDeployment, getActiveDeploymentId, getDeploymentProfile,
  setActiveDeployment, getTokenAddress, getAllTokens, getFactoryAddress,
  getRouterAddress, getConfirmedPools,
} from "./deployments/index.js";
import {
  mergeMarketSources, normalizeSymbolKey, pairKeyFromAddresses,
  collateralForSide, collateralDecimalsForSide, STABLE_SYMBOLS,
} from "./marketDiscovery.js";
import {
  findRoute, candidatePaths, routeCandidates, sourcesForTarget, probeAmountsFor,
} from "./swapRoutes.js";

let fails = 0;
const ok = (n) => console.log(`  ✅ ${n}`);
const bad = (n, d) => { fails++; console.log(`  ❌ ${n}${d ? " — " + d : ""}`); };
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const V5 = getDeploymentProfile("v5");
const V2 = getDeploymentProfile("v2");

// ── 1. token mapping — active deployment is the SINGLE source ──
if (getActiveDeploymentId() !== "v5") bad("active deployment is v5", getActiveDeploymentId());
else ok("active deployment = v5");
if (getTokenAddress("USDT").toLowerCase() !== V5.tokens.USDT.toLowerCase()) bad("getTokenAddress(USDT) → site USDT");
else ok("getTokenAddress(USDT) → site USDT 0x3a1ff83b…");
if (getTokenAddress("weth").toLowerCase() !== V5.tokens.WETH.toLowerCase()) bad("getTokenAddress case-insensitive");
else ok("getTokenAddress is case-insensitive");
const tokMap = getAllTokens();
if (Object.keys(tokMap).length !== Object.keys(V5.tokens).length) bad("getAllTokens mirrors profile");
else ok(`getAllTokens = ${Object.keys(tokMap).length} symbols from the active profile`);
if (getFactoryAddress().toLowerCase() !== V5.factory.toLowerCase()) bad("getFactoryAddress from profile");
if (getRouterAddress().toLowerCase() !== V5.router.toLowerCase()) bad("getRouterAddress from profile");
ok("factory/router resolve from the active profile");

// switching flips the whole map atomically, then restores v5
setActiveDeployment("v2");
if (getTokenAddress("USDT").toLowerCase() !== V2.tokens.USDT.toLowerCase()) bad("v2 switch: USDT flips to OLD 0x5f2E83cC…");
else ok("setActiveDeployment('v2') flips token map (old USDT reachable for read-only diagnostics)");
if (getConfirmedPools()["NEMESIS/WETH"]) bad("v2 has no NEMESIS/WETH confirmed pool");
else ok("v2 confirmedPools unchanged by v5 additions");
setActiveDeployment("v5");
if (getTokenAddress("USDT").toLowerCase() !== V5.tokens.USDT.toLowerCase()) bad("switch back to v5");
else ok("switch back to v5 restores site tokens");

// excludedPools isolation
const exclPools = new Set(Object.values(V5.excludedPools || {}).map(e => String(e.pool).toLowerCase()));
const confPools = new Set(Object.values(V5.confirmedPools).map(e => String(e.pool).toLowerCase()));
const overlap = [...exclPools].filter(p => confPools.has(p));
if (overlap.length) bad("excludedPools ∩ confirmedPools must be empty", overlap.join(","));
else ok("excludedPools ∩ confirmedPools = ∅ (legacy pools never tradable)");
for (const e of Object.values(V5.excludedPools || {})) {
  if (!ADDR_RE.test(e.pool)) bad("excludedPools pool well-formed", e.pool);
}
ok("excludedPools addresses well-formed (full 40-byte)");
// legacy USDT/WETH excluded, site USDT/WETH = ETH/USDT confirmed pool
const legacy = Object.values(V5.excludedPools).find(e => String(e.pool).toLowerCase().startsWith("0xb773392d"));
if (!legacy) bad("legacy USDT/WETH 0xb773392d… documented in excludedPools");
else if (legacy.token0?.toLowerCase() !== "0x5f2e83ccdea73d60af400e03f1cd8fb9eab07b20") bad("legacy pool token0 is the OLD USDT", legacy.token0);
else ok("legacy USDT/WETH 0xb773392d… excluded (token0 = old USDT 0x5f2E83cC…)");
if (!String(V5.confirmedPools["ETH/USDT"].pool).toLowerCase().startsWith("0xd550e940")) bad("site USDT/WETH market = ETH/USDT pool 0xd550e940…");
else ok("site USDT/WETH market = ETH/USDT pool 0xd550e940… (ETH aliases WETH)");
if (!String(V5.confirmedPools["NEMESIS/WETH"].pool).toLowerCase().startsWith("0xca028f53")) bad("NEMESIS/WETH confirmed pool prefix 0xca028f53");
else ok("NEMESIS/WETH confirmed pool 0xca028f53… (task-listed, factory-verified)");

// ── 2. pool discovery — merge sources (pure) ──
if (normalizeSymbolKey("USDT/DAI") !== normalizeSymbolKey("DAI/USDT")) bad("normalizeSymbolKey order-independent");
else ok("normalizeSymbolKey: 'USDT/DAI' ≡ 'DAI/USDT'");
const merged = mergeMarketSources({
  availableMarkets: [
    { symbol: "UNI/USDT", poolAddress: V5.confirmedPools["UNI/USDT"].pool, supportsLong: true, supportsShort: false },
  ],
  confirmedPools: V5.confirmedPools,
  knownMarkets: V5.knownMarkets,
});
const uniCand = merged.find(c => normalizeSymbolKey(c.symbol) === normalizeSymbolKey("UNI/USDT"));
if (!uniCand) bad("merge: UNI/USDT candidate exists");
else {
  if (!uniCand.sources.includes("config") || !uniCand.sources.includes("confirmed")) bad("merge: UNI/USDT carries config+confirmed sources", uniCand.sources.join(","));
  else ok("merge unifies config + confirmedPools by pool address/symbol");
  if (uniCand.supportsShort !== false) bad("merge: declared supportsShort=false honoured");
  else ok("declared direction flags survive the merge");
}
const nwCand = merged.find(c => normalizeSymbolKey(c.symbol) === normalizeSymbolKey("NEMESIS/WETH"));
if (!nwCand || !nwCand.poolAddr || !ADDR_RE.test(nwCand.poolAddr)) bad("merge: NEMESIS/WETH declared from confirmedPools");
else ok("merge: NEMESIS/WETH declared from confirmedPools");
// no merged candidate may reference an excluded pool
const mergedExcl = merged.filter(c => c.poolAddr && exclPools.has(String(c.poolAddr).toLowerCase()));
if (mergedExcl.length) bad("merge produced a candidate on an EXCLUDED pool", mergedExcl.map(c => c.symbol).join(","));
else ok("merge never surfaces excluded pools as candidates");

// collateral side rule
const mkt = { token0: "0xAaa", token1: "0xBbb", token0Decimals: 6, token1Decimals: 18 };
if (collateralForSide(mkt, "LONG") !== "0xAaa" || collateralForSide(mkt, "SHORT") !== "0xBbb") bad("collateralForSide LONG=token0 SHORT=token1");
else ok("collateralForSide: LONG→token0, SHORT→token1");
if (collateralDecimalsForSide(mkt, "SHORT") !== 18) bad("collateralDecimalsForSide");
else ok("collateralDecimalsForSide reads per-side decimals");
if (!STABLE_SYMBOLS.has("USDT") || !STABLE_SYMBOLS.has("DAI")) bad("STABLE_SYMBOLS contains USDT+DAI");
else ok("STABLE_SYMBOLS identifies stables");

// ── 3. route validation (pure) ──
const A = "0x000000000000000000000000000000000000000A";
const B = "0x000000000000000000000000000000000000000B";
const HUB = "0x00000000000000000000000000000000000000AA";
const X = "0x00000000000000000000000000000000000000CC";
const routes = [
  { fromSym: "A", toSym: "B", fromAddr: A, toAddr: B, path: [A, B], type: "direct", valid: true },
  { fromSym: "A", toSym: "HUB", fromAddr: A, toAddr: HUB, path: [A, HUB], type: "direct", valid: true },
  { fromSym: "HUB", toSym: "B", fromAddr: HUB, toAddr: B, path: [HUB, B], type: "direct", valid: true },
  { fromSym: "A", toSym: "X", fromAddr: A, toAddr: X, path: [A, X], type: "direct", valid: false }, // invalid route ignored
];
const fAB = findRoute(routes, A, B);
if (!fAB || fAB.type !== "direct") bad("findRoute finds validated direct A→B");
else ok("findRoute returns the validated direct route");
if (findRoute(routes, B, A) !== null) bad("findRoute does NOT invent the reverse direction");
else ok("findRoute never invents a reverse direction");
if (findRoute(routes, A, X) !== null) bad("findRoute ignores valid:false routes");
else ok("findRoute excludes invalid routes");
const cands = candidatePaths(routes, A, B, { directProbe: false });
if (cands.length !== 2 || cands[0].type !== "direct" || cands[1].type !== "multi") bad("candidatePaths: direct first, then A→HUB→B", JSON.stringify(cands.map(c => c.type)));
else ok("candidatePaths: validated direct first, bounded multi-hop second");
const candsProbe = candidatePaths(routes, B, X, { directProbe: true });
if (!candsProbe.length || candsProbe[0].type !== "direct-probe") bad("candidatePaths direct-probe fallback for undeclared pair");
else ok("candidatePaths offers a direct-probe ONLY as bounded candidate");
const noPath = candidatePaths(routes, X, B, { directProbe: false });
if (noPath.length !== 0) bad("candidatePaths: no invented path X→B");
else ok("candidatePaths invents nothing (X→B = 0 candidates)");
const rc = routeCandidates(routes);
if (rc.length !== 3) bad("routeCandidates filters valid only", String(rc.length));
else ok(`routeCandidates: ${rc.length} valid candidates (invalid excluded)`);
const srcs = sourcesForTarget(routes, B);
if (srcs.length !== 2) bad("sourcesForTarget: A→B and HUB→B", String(srcs.length));
else ok("sourcesForTarget lists every validated source of B");
const exclSrc = sourcesForTarget(routes, B, [HUB]);
if (exclSrc.length !== 1 || exclSrc[0].fromAddr !== A) bad("sourcesForTarget honours exclusions");
else ok("sourcesForTarget honours excludeAddrs");
const probes = probeAmountsFor(6);
if (probes[0] !== 1_000_000n || probes[1] !== 10_000_000n) bad("probeAmountsFor scales by decimals", probes[0].toString());
else ok("probeAmountsFor scales probe ladder by token decimals");

// ── 4. old/new address-space disjointness (static) ──
const v2Tok = new Set(Object.values(V2.tokens).map(a => a.toLowerCase()));
const v5Tok = new Set(Object.values(V5.tokens).map(a => a.toLowerCase()));
const sharedTok = [...v5Tok].filter(t => v2Tok.has(t));
// WETH + NEMESIS are genuinely the same contracts on both
if (sharedTok.length !== 2) bad("exactly 2 shared tokens (WETH, NEMESIS)", sharedTok.join(","));
else ok("token spaces overlap ONLY on WETH + NEMESIS (same contracts both sides)");
const v2Mgr = new Set(Object.values(V2.confirmedPools).map(e => e.manager.toLowerCase()));
const v5Mgr = new Set(Object.values(V5.confirmedPools).map(e => e.manager.toLowerCase()));
const mgrOverlap = [...v5Mgr].filter(m => v2Mgr.has(m));
if (mgrOverlap.length) bad("v2/v5 manager overlap", mgrOverlap.join(","));
else ok("manager spaces fully disjoint (v2 vs v5)");
const poolOverlap = [...confPools].filter(p => new Set(Object.values(V2.confirmedPools).map(e => e.pool.toLowerCase())).has(p));
if (poolOverlap.length) bad("v2/v5 confirmed pool overlap", poolOverlap.join(","));
else ok("confirmed pool spaces fully disjoint (v2 vs v5)");

console.log(`\n${fails === 0 ? "PASS" : "FAIL"} — v5 migration unit tests: ${fails} failure(s)`);
process.exit(fails === 0 ? 0 : 1);
