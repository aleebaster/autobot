// ═══════════════════════════════════════════════════════════════════════════
//  LIVE-TEST PREFLIGHT — READ-ONLY (0 transactions)
//  nonce stability, balances, ACTIVE on-chain wallet positions per manager,
//  journal tail, current config budget, eligible pairs from the last verifier run.
// ═══════════════════════════════════════════════════════════════════════════
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { ethers } from "ethers";
import { getDeploymentProfile } from "./deployments/index.js";

const REPO = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(path.join(REPO, "config.json"), "utf8"));
const provider = new ethers.JsonRpcProvider(
  cfg.rpcUrl || "https://ethereum-sepolia-rpc.publicnode.com", cfg.chainId || 11155111, { staticNetwork: true });

const pkFile = fs.existsSync(path.join(REPO, "wallets/pk.txt")) ? path.join(REPO, "wallets/pk.txt") : path.join(REPO, "pk.txt");
const WALLET = new ethers.Wallet(fs.readFileSync(pkFile, "utf8").trim()).address;

const MGR_ABI = ["function positions(uint256) view returns (bool isLong, address user, address collateralToken, uint256 collateralAmount, uint256 debtAmount, uint256 borrowIndex, bool active)"];
const V5 = getDeploymentProfile("v5");

const MANAGERS = Object.entries(V5.confirmedPools || {}).map(([sym, p]) => ({ sym, mgr: p.manager, pool: p.pool }));

console.log("=== LIVE-TEST PREFLIGHT (read-only) ===");
console.log("wallet:", WALLET);

// 1. NONCE — latest vs pending must be equal (no in-flight tx)
const [nonceLatest, noncePending] = await Promise.all([
  provider.getTransactionCount(WALLET, "latest"),
  provider.getTransactionCount(WALLET, "pending"),
]);
console.log(`nonce latest=${nonceLatest} pending=${noncePending} ${nonceLatest === noncePending ? "STABLE" : "IN-FLIGHT!"}`);

// 2. BALANCES
const eth = await provider.getBalance(WALLET);
console.log(`ETH: ${ethers.formatEther(eth)}`);
const USDT = "0x3A1fF83BFD63E5e2564aEc95ade244234773049f";
const ERC20 = ["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)", "function symbol() view returns (string)"];
for (const t of [
  { sym: "USDT", addr: USDT },
  { sym: "WETH", addr: V5.tokens?.WETH?.address || V5.tokens?.weth || null },
]) {
  if (!t.addr) continue;
  const c = new ethers.Contract(t.addr, ERC20, provider);
  const [bal, dec] = await Promise.all([c.balanceOf(WALLET), c.decimals()]);
  console.log(`${t.sym}: ${ethers.formatUnits(bal, dec)}`);
}

// 3. ACTIVE ON-CHAIN wallet positions — batched parallel probe of ids 1..300
let activeCount = 0;
const activeList = [];
const KNOWN_IDS = [];
try {
  const st = JSON.parse(fs.readFileSync(path.join(REPO, "auto-trader-state.json"), "utf8"));
  const recs = st.activePositions || (st.activePosition ? [st.activePosition] : []);
  for (const r of recs) if (r?.positionId != null) KNOWN_IDS.push(Number(r.positionId));
} catch { }
const ids = [...new Set([...KNOWN_IDS, ...Array.from({ length: 300 }, (_, i) => i + 1)])];
for (const m of MANAGERS) {
  if (!m.mgr || m.mgr === "0x0") continue;
  let code = "0x";
  try { code = await provider.getCode(m.mgr); } catch { }
  if (!code || code === "0x") { console.log(`${m.sym}: manager NO CODE — skip`); continue; }
  const mgr = new ethers.Contract(m.mgr, MGR_ABI, provider);
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const results = await Promise.all(chunk.map(async (id) => {
      try { return { id, p: await mgr.positions(id) }; } catch { return { id, p: null }; }
    }));
    for (const { id, p } of results) {
      if (p && p.active && p.user.toLowerCase() === WALLET.toLowerCase()) {
        activeCount++;
        activeList.push({ id, sym: m.sym, mgr: m.mgr, side: p.isLong ? "LONG" : "SHORT", coll: p.collateralToken, collAmt: p.collateralAmount.toString() });
      }
    }
  }
}
console.log(`ACTIVE on-chain positions: ${activeCount}`);
for (const p of activeList) console.log(`  #${p.id} ${p.side} on ${p.sym} coll=${p.collAmt}`);

// 4. JOURNAL TAIL
const jf = path.join(REPO, "tx-journal.jsonl");
if (fs.existsSync(jf)) {
  const lines = fs.readFileSync(jf, "utf8").trim().split("\n");
  console.log(`journal: ${lines.length} entries`);
  for (const l of lines.slice(-3)) {
    try { const e = JSON.parse(l); console.log(`  last: ${e.type || e.kind || "?"} ${e.txHash || e.hash || ""} nonce=${e.nonce ?? "?"} status=${e.status || "?"}`); } catch { }
  }
} else console.log("journal: missing");

// 5. CURRENT CONFIG BUDGET
console.log(`config: maxOpenPositions=${cfg.maxOpenPositions} maxTradesPerRun=${cfg.maxTradesPerRun} enabledMarkets=${JSON.stringify(cfg.enabledMarkets)} hold=${cfg.minHoldSeconds}-${cfg.maxHoldSeconds}s`);

// 6. ELIGIBLE PAIRS (from last _verify_pairs run)
const vf = path.join(REPO, "_verify_pairs_result.json");
if (fs.existsSync(vf)) {
  try {
    const v = JSON.parse(fs.readFileSync(vf, "utf8"));
    const arr = Array.isArray(v) ? v : (v.pairs || v.results || []);
    console.log("eligible pairs (from verifier):");
    for (const p of arr) {
      const s = typeof p === "string" ? p : (p.sym || p.market || p.symbol || JSON.stringify(p).slice(0, 80));
      console.log("  -", s, p && p.eligible !== undefined ? (p.eligible ? "ELIGIBLE" : "NOT") : "");
    }
  } catch (e) { console.log("verifier result unreadable:", e.message); }
} else console.log("_verify_pairs_result.json missing");

console.log("=== PREFLIGHT DONE ===");
process.exit(0);
