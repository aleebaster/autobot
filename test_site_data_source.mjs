// ═══════════════════════════════════════════════════════════════════════════════
//  DIAGNOSTIC: confirmed bot swap must be visible via the SITE's data source.
//
//  Since the 2026-10-15 migration the ACTIVE deployment is v5 = nemesis.trade
//  production (same factory/router/subgraph as the site). This test verifies
//  that CONFIRMED SWAP hashes from the journal are indexed by:
//    - proxy:  https://nemesis.trade/api/subgraph
//    - direct: Goldsky nemesis-token-cycle-sepolia (prod-cycle-.../gn)
//  and uses the ACTIVE deployment's router/subgraph as the control.
//  Swaps executed BEFORE the migration (v2 router) are expected misses and
//  are labelled as such. READ-ONLY: no transactions, no state writes.
//
//  Usage:
//    node test_site_data_source.mjs                       # uses journal (latest 2 SWAP hashes)
//    node test_site_data_source.mjs 0xhash1 0xhash2       # explicit hashes
//  Exit: 0 = all visible on site source, 1 = at least one missing.
// ═══════════════════════════════════════════════════════════════════════════════
import "./_test_state_isolation.mjs"; // state redirect + default-deny live-TX guard
import fs from "fs";
import { ethers } from "ethers";
import { getActiveDeployment } from "./deployments/index.js";

const SITE_PROXY = "https://nemesis.trade/api/subgraph";
const SITE_DIRECT = "https://api.goldsky.com/api/public/project_cmma0sxdrnwdx01ym126h3z8q/subgraphs/nemesis-token-cycle-sepolia/prod-cycle-f4d42c64e87d-58c7574ac884/gn";
const RPC = "https://ethereum-sepolia-rpc.publicnode.com";
const SITE_ROUTER = "0x6c2844a5aFd10e22195d5f58227434b5b073b6D3";
const OLD_V2_ROUTER = "0x8f6eB7870334b1FD8006Fd52413f01689f4E57e9"; // pre-migration bot router

// Control = ACTIVE deployment (v5 → site router/subgraph; v2 → old bot router/subgraph)
const ACTIVE = getActiveDeployment();
const BOT_ROUTER = ACTIVE.router;
const BOT_SUBGRAPH = ACTIVE.discovery?.subgraphUrl || SITE_DIRECT;
console.log(`Active deployment: ${ACTIVE.id} (${ACTIVE.name})`);
console.log(`  control router:  ${BOT_ROUTER}`);
console.log(`  control subgraph:${BOT_SUBGRAPH === SITE_DIRECT ? " site subgraph" : " " + BOT_SUBGRAPH}`);

const provider = new ethers.JsonRpcProvider(RPC, 11155111, { batchMaxCount: 3 });

async function gql(ep, query) {
  const r = await fetch(ep, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query }) });
  const j = await r.json();
  if (j.errors) throw new Error(j.errors.map(e => e.message).join("; "));
  return j.data;
}

function hashesFromJournal(n = 2) {
  try {
    const lines = fs.readFileSync("tx-journal.jsonl", "utf8").trim().split(/\r?\n/);
    const swaps = [];
    for (const l of lines) {
      try {
        const e = JSON.parse(l);
        if (e.type === "SWAP" && e.hash && e.state === "CONFIRMED") swaps.push(e.hash);
      } catch {}
    }
    return swaps.slice(-n);
  } catch { return []; }
}

let hashes = process.argv.slice(2).filter(a => a.startsWith("0x"));
if (!hashes.length) hashes = hashesFromJournal(2);
if (!hashes.length) {
  console.error("No tx hashes: pass 0x... args or ensure tx-journal.jsonl has CONFIRMED SWAP entries");
  process.exit(2);
}

let fails = 0;
const report = { hashes, checks: [] };

for (const hash of hashes) {
  const rec = await provider.getTransactionReceipt(hash);
  if (!rec) { console.error(`FAIL ${hash}: receipt not found`); fails++; continue; }
  const onchain = {
    status: rec.status === 1 ? "SUCCESS" : `REVERTED(${rec.status})`,
    from: rec.from.toLowerCase(),
    to: (rec.to || "").toLowerCase(),
    block: rec.blockNumber,
    viaBotRouter: (rec.to || "").toLowerCase() === BOT_ROUTER.toLowerCase(),
    viaSiteRouter: (rec.to || "").toLowerCase() === SITE_ROUTER.toLowerCase(),
  };
  console.log(`\nTX ${hash}`);
  console.log(`  on-chain: ${onchain.status} block=${onchain.block} from=${onchain.from}`);
  console.log(`  to=${onchain.to}  botRouter=${onchain.viaBotRouter}  siteRouter=${onchain.viaSiteRouter}`);
  if (rec.status !== 1) { console.log("  FAIL: transaction not successful on-chain"); fails++; continue; }

  // same wallet, same tx via both site data sources + bot subgraph (control)
  const q = `{ swaps(where: { txHash: "${hash}" }) { id txHash user { id } pool { id } } }`;
  const row = { hash, onchain, site: null, siteProxy: null, bot: null };
  try { row.site = (await gql(SITE_DIRECT, q)).swaps; } catch (e) { row.site = "ERR " + e.message; }
  try { row.siteProxy = (await gql(SITE_PROXY, q)).swaps; } catch (e) { row.siteProxy = "ERR " + e.message; }
  try { row.bot = (await gql(BOT_SUBGRAPH, q)).swaps; } catch (e) { row.bot = "ERR " + e.message; }

  const siteOk = Array.isArray(row.site) && row.site.length > 0;
  const proxyOk = Array.isArray(row.siteProxy) && row.siteProxy.length > 0;
  const botOk = Array.isArray(row.bot) && row.bot.length > 0;
  console.log(`  site subgraph (token-cycle): ${siteOk ? "FOUND " + row.site.length : "NOT FOUND"}`);
  console.log(`  site proxy /api/subgraph:    ${proxyOk ? "FOUND " + row.siteProxy.length : "NOT FOUND"}`);
  console.log(`  active-deployment subgraph:  ${botOk ? "FOUND " + row.bot.length : "NOT FOUND"} (control) ${BOT_SUBGRAPH === SITE_DIRECT ? "[= site subgraph]" : ""}`);

  if (!siteOk) {
    if (onchain.to === OLD_V2_ROUTER.toLowerCase()) {
      // Pre-migration swap via the old v2 router: the site never indexed v2 pools,
      // so a miss here is EXPECTED and must not fail the suite.
      console.log(`  EXPECTED MISS: swap was executed via the OLD v2 router ${OLD_V2_ROUTER} (before the 2026-10-15 migration).`);
      console.log(`             The site indexes only v5 pools (nemesis-token-cycle-sepolia) — not a failure.`);
    } else {
      fails++;
      if (onchain.viaBotRouter) {
        console.log(`  DIAGNOSIS: swap executed via ACTIVE router ${BOT_ROUTER} but NOT indexed by the site subgraph.`);
        console.log(`             Unexpected on v5 — investigate indexing (site router ${SITE_ROUTER}).`);
      } else {
        console.log(`  FAIL: not via active router either — unexpected`);
      }
    }
  } else {
    console.log(`  PASS: swap visible on site data source`);
  }
  report.checks.push(row);
}

// positions visibility for the sending wallet (task 7)
const wallet = report.checks[0]?.onchain?.from;
if (wallet) {
  const q = `{ positions(where: { user: "${wallet}" }, first: 10) { id status pool { id } openedAtTxHash } }`;
  const row = { wallet, site: null, bot: null };
  try { row.site = (await gql(SITE_DIRECT, q)).positions; } catch (e) { row.site = "ERR " + e.message; }
  try { row.bot = (await gql(BOT_SUBGRAPH, q)).positions; } catch (e) { row.bot = "ERR " + e.message; }
  console.log(`\nPOSITIONS for ${wallet}`);
  console.log(`  site subgraph: ${Array.isArray(row.site) ? row.site.length : row.site} position(s) ${JSON.stringify(Array.isArray(row.site) ? row.site.map(p => p.id) : "")}`);
  console.log(`  bot subgraph:  ${Array.isArray(row.bot) ? row.bot.length : row.bot} position(s) (control)`);
  // known bot-side active position from local state (read-only)
  try {
    const st = JSON.parse(fs.readFileSync("auto-trader-state.json", "utf8"));
    const ap = st.activePositions?.[0] ?? null;
    if (ap?.positionId) {
      const id = `${String(ap.managerAddr).toLowerCase()}-${ap.positionId}`;
      const dq = `{ position(id: "${id}") { id status } }`;
      const s = await gql(SITE_DIRECT, dq).then(d => d.position).catch(e => "ERR " + e.message);
      console.log(`  bot active #${ap.positionId} (${id}) on site subgraph: ${s ? JSON.stringify(s) : "NOT FOUND"}`);
      if (!s) {
        console.log(`  DIAGNOSIS: stored position #${ap.positionId} lives on manager ${ap.managerAddr} —`);
        console.log(`             if that manager is NOT in deployments/v5.js confirmedPools, it is a PRE-MIGRATION (v2)`);
        console.log(`             position; the site only indexes v5 managers. Expected miss — state preserved untouched.`);
      }
    }
  } catch {}
  report.positions = row;
}

fs.writeFileSync("_test_site_data_source_result.json", JSON.stringify(report, null, 1));
console.log(`\n${fails === 0 ? "PASS" : "FAIL"} — ${fails} hash(es) not visible on site data source (see _test_site_data_source_result.json)`);
process.exit(fails === 0 ? 0 : 1);
