// Diagnostic test: SWAP visibility through the data source the SITE uses.
//
// Verifies:
//  1. Positive control — a recent site-deployment swap is returned by the
//     site's subgraph (direct Goldsky endpoint) and its receipt targets the
//     site router/managers (pipeline is alive and correctly wired).
//  2. The two reported "missing" tx hashes — receipt targets the OLD v2
//     router, site subgraph returns 0 rows (expected: wrong deployment),
//     old bot subgraph still has them (evidence they exist on-chain).
//  3. Journal CONFIRMED swaps — classified by receipt `to`:
//       - via site router   → MUST be visible on site subgraph
//       - via old v2 router → flagged HIDDEN_WRONG_DEPLOYMENT (report only)
//       - any other target  → FAIL (unknown deployment = real anomaly)
//  4. Positions/closes same-root-cause check — v5 position visible on site,
//     v2 position #75 invisible on site, site indexes CLOSE transactions.
//
// READ-ONLY. Exit code 0 = all checks passed, 1 = failure.
import "./_test_state_isolation.mjs"; // state redirect + default-deny live-TX guard
import fs from "fs";
import { ethers } from "ethers";
import { getDeploymentProfile, getActiveDeploymentId } from "./deployments/index.js";

const V5 = getDeploymentProfile("v5");
const V2 = getDeploymentProfile("v2");
const SITE = V5.discovery.subgraphUrl;
const PROXY = "https://nemesis.trade/api/subgraph";
const BOT = V2.discovery.subgraphUrl;
const WALLET = "0x315E5193633A962B3F369F9C3833D973D0588cCD";

const TARGET_TXS = [
  "0x4d29c642744ef6aa8ec4b5851a40b63a9a8de5a98f8c500b07654892e4b0ec1b",
  "0x82fa17e120b4bff88f7f6f6771a95c47da5fe402f9cae8f2cc08a16317365c56",
];

// publicnode occasionally returns NULL receipts for older blocks — use a
// second source and retry, otherwise the test would be flaky.
const RPCS = ["https://sepolia.drpc.org", "https://ethereum-sepolia-rpc.publicnode.com"];
const providers = RPCS.map(u => new ethers.JsonRpcProvider(u, 11155111, { batchMaxCount: 2 }));

let failures = 0;
const ok = (cond, label, detail = "") => {
  if (cond) console.log(`  PASS  ${label}${detail ? `  (${detail})` : ""}`);
  else { failures++; console.log(`  FAIL  ${label}${detail ? `  (${detail})` : ""}`); }
};

async function gql(ep, query) {
  const r = await fetch(ep, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query }) });
  const j = await r.json();
  if (j.errors) throw new Error(j.errors.map(e => e.message).join("; "));
  return j.data;
}

async function receipt(hash) {
  for (const p of providers) {
    for (let i = 0; i < 2; i++) {
      try {
        const r = await p.getTransactionReceipt(hash);
        if (r) return r;
      } catch {}
      await new Promise(res => setTimeout(res, 300));
    }
  }
  return null;
}

function classify(to) {
  const l = String(to || "").toLowerCase();
  if (l === V5.router.toLowerCase()) return "SITE_ROUTER";
  if (l === V2.router.toLowerCase()) return "OLD_V2_ROUTER";
  const siteAddrs = new Set([
    ...Object.values(V5.confirmedPools).map(p => p.manager.toLowerCase()),
    V5.factory.toLowerCase(),
  ]);
  if (siteAddrs.has(l)) return "SITE_CONTRACT";
  const oldAddrs = new Set([
    ...Object.values(V2.confirmedPools).map(p => p.manager.toLowerCase()),
    V2.factory.toLowerCase(),
  ]);
  if (oldAddrs.has(l)) return "OLD_V2_CONTRACT";
  return "UNKNOWN";
}

const report = { active: getActiveDeploymentId(), checks: {} };

console.log(`active deployment profile: ${getActiveDeploymentId()}`);
console.log("expected active profile for site-visible swaps: v5\n");

// ── Check 1: positive control — site swap via site source ──────────────────
console.log("CHECK 1 — positive control: site-deployment swap visible via site data source");
let control = null;
try {
  const d = await gql(SITE, `{ swaps(first: 1, orderBy: timestamp, orderDirection: desc) { txHash pool { id token0 { id } token1 { id } } } }`);
  control = d.swaps[0];
  ok(!!control, "site subgraph returns a recent swap", control?.txHash);
  const rec = control ? await receipt(control.txHash) : null;
  ok(rec && rec.status === 1, "control swap receipt SUCCESS", rec ? `status=${rec.status}` : "no receipt");
  let cls = rec ? classify(rec.to) : "NONE";
  // Pools created after the confirmedPools registry snapshot (e.g. a manager
  // proxy of a brand-new factory pool) are still site-deployment contracts —
  // prove it via factory.getPool(token0,token1) === the subgraph pool id.
  if (cls === "UNKNOWN" && control?.pool?.id && control.pool.token0?.id && control.pool.token1?.id) {
    try {
      const fac = new ethers.Contract(V5.factory, ["function getPool(address,address) view returns (address)"], providers[0]);
      const got = await fac.getPool(control.pool.token0.id, control.pool.token1.id);
      if (String(got).toLowerCase() === String(control.pool.id).toLowerCase()) cls = "SITE_FACTORY_POOL";
    } catch {}
  }
  ok(cls === "SITE_ROUTER" || cls === "SITE_CONTRACT" || cls === "SITE_FACTORY_POOL", "control swap targets SITE deployment contract", `to=${rec?.to} [${cls}]`);
  const again = control ? await gql(SITE, `{ swaps(where: { txHash: "${control.txHash}" }) { id } }`) : { swaps: [] };
  ok(again.swaps.length >= 1, "control swap findable by txHash via site source", `${again.swaps.length} row(s)`);
  const viaProxy = control ? await gql(PROXY, `{ swaps(where: { txHash: "${control.txHash}" }) { id } }`) : null;
  ok(viaProxy && viaProxy.swaps.length >= 1, "control swap findable via site proxy /api/subgraph");
  report.checks.control = { hash: control?.txHash, to: rec?.to, cls, siteRows: again.swaps.length, proxyRows: viaProxy?.swaps.length };
} catch (e) {
  ok(false, "positive control query failed", e.message);
}
console.log();

// ── Check 2: the two reported hashes ───────────────────────────────────────
console.log("CHECK 2 — reported missing txs (0x4d29c642…, 0x82fa17e1…)");
report.checks.reported = [];
for (const h of TARGET_TXS) {
  const rec = await receipt(h);
  ok(rec && rec.status === 1, `${h.slice(0, 14)}… receipt SUCCESS`, rec ? `status=${rec.status} block=${rec.blockNumber}` : "NOT FOUND");
  const cls = rec ? classify(rec.to) : "NONE";
  ok(cls === "OLD_V2_ROUTER", `${h.slice(0, 14)}… executed via OLD v2 router`, `to=${rec?.to} [${cls}]`);

  const siteRows = await gql(SITE, `{ swaps(where: { txHash: "${h}" }) { id } }`).then(d => d.swaps.length).catch(e => "ERR:" + e.message);
  const proxyRows = await gql(PROXY, `{ swaps(where: { txHash: "${h}" }) { id } }`).then(d => d.swaps.length).catch(e => "ERR:" + e.message);
  let botRows = "unavailable";
  try { botRows = (await gql(BOT, `{ swaps(where: { txHash: "${h}" }) { id } }`)).swaps.length; } catch {}

  if (cls === "OLD_V2_ROUTER") {
    ok(siteRows === 0, `${h.slice(0, 14)}… NOT on site source (expected: wrong deployment)`, `site=${siteRows} proxy=${proxyRows}`);
    if (botRows !== "unavailable") ok(botRows >= 1, `${h.slice(0, 14)}… IS on old bot subgraph (exists on-chain)`, `old=${botRows}`);
    else console.log(`  WARN  ${h.slice(0, 14)}… old bot subgraph unreachable (not a failure)`);
  } else if (cls === "SITE_ROUTER" || cls === "SITE_CONTRACT") {
    ok(siteRows >= 1, `${h.slice(0, 14)}… via SITE deployment → must be on site source`, `site=${siteRows}`);
  } else {
    ok(false, `${h.slice(0, 14)}… unknown tx target`, String(rec?.to));
  }
  report.checks.reported.push({ hash: h, to: rec?.to, cls, siteRows, proxyRows, botRows });
}
console.log();

// ── Check 3: journal CONFIRMED swaps classification ────────────────────────
// Semantics (adaptive to root cause):
//   - target UNKNOWN                → FAIL (anomaly)
//   - target SITE deployment        → MUST be visible on site source, else FAIL
//   - target OLD v2 deployment      → INFO hidden (historical root cause;
//     with STRICT=1 env this also FAILs, to alarm until bot runs on v5)
console.log("CHECK 3 — journal CONFIRMED swaps (census by router + sample receipts)");
const STRICT = process.env.STRICT === "1";
let journalLines = [];
try {
  journalLines = fs.readFileSync("tx-journal.jsonl", "utf8").trim().split(/\r?\n/);
} catch {}
const confirmed = journalLines.flatMap(l => { try { const e = JSON.parse(l); return e.type === "SWAP" && e.state === "CONFIRMED" && e.hash ? [e] : []; } catch { return []; } });
ok(confirmed.length > 0, "journal has CONFIRMED SWAP entries", `${confirmed.length} total`);
const routers = [...new Set(confirmed.map(e => String(e.to).toLowerCase()))];
const knownRouters = new Set([V5.router.toLowerCase(), V2.router.toLowerCase()]);
const unknownRouters = routers.filter(r => !knownRouters.has(r));
ok(unknownRouters.length === 0, "no confirmed swaps with unknown router", unknownRouters.join(", ") || "all known");
const viaSiteCount = confirmed.filter(e => String(e.to).toLowerCase() === V5.router.toLowerCase()).length;
const viaOldCount = confirmed.filter(e => String(e.to).toLowerCase() === V2.router.toLowerCase()).length;
console.log(`  INFO  router census: via SITE(v5)=${viaSiteCount}  via OLD(v2)=${viaOldCount}  total=${confirmed.length}`);
if (viaOldCount > 0) {
  const msg = `${viaOldCount} historical swap(s) executed via OLD v2 router → HIDDEN from site source (root cause)`;
  if (STRICT) ok(false, msg);
  else console.log(`  WARN  ${msg}  (set STRICT=1 to fail on this)`);
}

const sample = confirmed.slice(-3);
const census = { viaSite: 0, viaOld: 0, unknown: 0, visibleRows: 0 };
for (const e of sample) {
  const rec = await receipt(e.hash);
  const cls = rec ? classify(rec.to) : "NONE";
  if (cls === "SITE_ROUTER" || cls === "SITE_CONTRACT") {
    const rows = await gql(SITE, `{ swaps(where: { txHash: "${e.hash}" }) { id } }`).then(d => d.swaps.length).catch(() => -1);
    ok(rows >= 1, `journal swap ${e.hash.slice(0, 14)}… via SITE → visible on site`, `rows=${rows}`);
    census.viaSite++; census.visibleRows += Math.max(rows, 0);
  } else if (cls === "OLD_V2_ROUTER" || cls === "OLD_V2_CONTRACT") {
    console.log(`  INFO  journal swap ${e.hash.slice(0, 14)}… via OLD v2 → HIDDEN_WRONG_DEPLOYMENT (historical, root cause)`);
    census.viaOld++;
  } else {
    ok(false, `journal swap ${e.hash.slice(0, 14)}… UNKNOWN tx target`, String(rec?.to));
    census.unknown++;
  }
}
ok(census.unknown === 0, "sampled swaps all classified", JSON.stringify(census));
report.checks.journal = { confirmedTotal: confirmed.length, routers, viaSiteCount, viaOldCount, sample, census, strict: STRICT };
console.log();

// ── Check 4: positions/closes same root cause ──────────────────────────────
console.log("CHECK 4 — positions & closes: same deployment mismatch");
try {
  const sitePos = await gql(SITE, `{ positions(where: { user: "${WALLET.toLowerCase()}" }) { id status } }`);
  ok(sitePos.positions.length >= 1, "wallet has a SITE-deployment position visible", `${sitePos.positions.length} pos: ${sitePos.positions.map(p => p.id).join(", ")}`);
  const v2pos = await gql(SITE, `{ position(id: "0x6562c653a2f2982d8dad9e420bf3ff5a568efd82-75") { id } }`).catch(() => ({ position: null }));
  ok(!v2pos.position, "v2 position #75 NOT on site (same root cause as swaps)");
  const closes = await gql(SITE, `{ transactions(first: 5, where: { type: "POSITION_CLOSE" }) { id txHash type } }`).catch(() => null);
  ok(!!closes && closes.transactions.length >= 1, "site DOES index CLOSE txs for site-deployment positions", closes ? `${closes.transactions.length} recent POSITION_CLOSE rows` : "query failed");
  let botPos = null;
  try { botPos = await gql(BOT, `{ positions(where: { user: "${WALLET.toLowerCase()}", status: "CLOSED" }) { id } }`); } catch {}
  if (botPos) console.log(`  INFO  old bot subgraph has ${botPos.positions.length} CLOSED v2 positions → invisible on site (historical)`);
  report.checks.positions = {
    site: sitePos.positions,
    v2OnSite: !!v2pos.position,
    siteCloseTxs: closes?.transactions?.length ?? null,
    botClosed: botPos?.positions?.length ?? null,
  };
} catch (e) {
  ok(false, "positions/closes check failed", e.message);
}

report.failures = failures;
report.passed = failures === 0;
fs.writeFileSync("_test_swap_site_visibility.json", JSON.stringify(report, null, 2));

console.log("\n════════ FINDINGS ════════");
console.log(`  1. Site swap/position history source = site subgraph:`);
console.log(`       ${SITE}`);
console.log(`       (router ${V5.router}, factory ${V5.factory}, startBlock 11873268)`);
console.log(`  2. Journal census: via SITE(v5)=${viaSiteCount}, via OLD(v2)=${viaOldCount}`);
console.log(`     → every old-v2 swap/position/close is INVISIBLE on the site by construction.`);
console.log(`  3. Fix (no contract/deploy change): run the bot with the migrated v5 profile`);
console.log(`     (setActiveDeployment('v5') active) so new swaps go through the site router;`);
console.log(`     historical v2 record stays in tx-journal.jsonl / auto-trader-state.json.`);

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} → _test_swap_site_visibility.json`);
process.exit(failures === 0 ? 0 : 1);
