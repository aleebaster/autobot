// ═══════════════════════════════════════════════════════════════════════════
//  v5 PAIR ELIGIBILITY VERIFIER — READ-ONLY (0 transactions)
//
//  For every confirmed v5 pool, verifies (all via eth_call / subgraph-free):
//    1. CONTRACT TRIANGLE   — pool token0/token1, factory.getPool/getManager,
//                             manager.factory(), code at pool + manager.
//    2. LIQUIDITY           — getReserves, manager.getAvailableLiquidity.
//    3. OPENABILITY         — precheckMarketQuote for LONG (token0 collateral)
//                             and SHORT (token1 collateral) at the bot's real
//                             target sizes (WETH 0.002, others 10).
//    4. EXIT FEASIBILITY    — AUTHORITATIVE when this wallet owns a position
//                             on the pair: findMaxCloseBps (the exact path the
//                             bot uses). Otherwise PROXY: two-way router quotes
//                             at 0.5% depth + manager liquidity (never claims
//                             PROVEN for a proxy).
//    5. LOCAL POSITIONS     — every position this wallet has per manager
//                             (feeds maxOpenPositions budgeting).
//
//  LIVE-TEST ELIGIBILITY: triangle OK + both opens quotable + exit NOT blocked
//  (PROVEN or PROXY_OK). An exit-blocked pair is NEVER eligible.
// ═══════════════════════════════════════════════════════════════════════════

import "./_test_state_isolation.mjs"; // state redirect + default-deny live-TX guard
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { ethers } from "ethers";
import { getDeploymentProfile } from "./deployments/index.js";
import { precheckMarketQuote, findMaxCloseBps, readOnChainPosition } from "./autoTrader.js";

const REPO = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(path.join(REPO, "config.json"), "utf8"));
const V5 = getDeploymentProfile("v5");
const provider = new ethers.JsonRpcProvider(cfg.rpcUrl || "https://ethereum-sepolia-rpc.publicnode.com", cfg.chainId || 11155111, { staticNetwork: true });

const pkFile = fs.existsSync(path.join(REPO, "wallets/pk.txt")) ? path.join(REPO, "wallets/pk.txt") : path.join(REPO, "pk.txt");
const WALLET = new ethers.Wallet(fs.readFileSync(pkFile, "utf8").trim()).address;

const FACTORY_ABI = ["function getPool(address,address) view returns (address)", "function getManager(address) view returns (address)"];
const POOL_ABI = ["function token0() view returns (address)", "function token1() view returns (address)", "function getReserves() view returns (uint112,uint112,uint32)"];
const MGR_ABI = [
  "function factory() view returns (address)",
  "function getAvailableLiquidity() view returns (uint256)",
  "function getUserPositions(address) view returns (uint256[])",
  "function MAX_LEVERAGE_X10() view returns (uint256)",
  "function LTV_BPS() view returns (uint256)",
];
const ROUTER_ABI = ["function getAmountsOut(uint256,address[]) view returns (uint256[])"];
const ERC20_ABI = ["function decimals() view returns (uint8)", "function symbol() view returns (string)"];

const factory = new ethers.Contract(V5.factory, FACTORY_ABI, provider);
const router = new ethers.Contract(V5.router, ROUTER_ABI, provider);

const lev10 = Number(cfg.leverage || 2) * 10;
const TARGET = { WETH: "0.002", USDT: "10", GENERIC: "10" };

function targetCollateral(addr, dec) {
  const l = String(addr).toLowerCase();
  if (l === V5.tokens.WETH.toLowerCase()) return ethers.parseUnits(TARGET.WETH, 18);
  if (l === V5.tokens.USDT.toLowerCase()) return ethers.parseUnits(TARGET.USDT, 6);
  return ethers.parseUnits(TARGET.GENERIC, dec);
}

const symCache = new Map();
async function tokenMeta(addr) {
  const l = String(addr).toLowerCase();
  if (symCache.has(l)) return symCache.get(l);
  const c = new ethers.Contract(addr, ERC20_ABI, provider);
  const [symbol, decimals] = await Promise.all([c.symbol(), c.decimals()]);
  const m = { symbol, decimals: Number(decimals) };
  symCache.set(l, m);
  return m;
}

const eq = (a, b) => String(a || "").toLowerCase() === String(b || "").toLowerCase();

// ─── 0. LOCAL POSITIONS (this wallet, every confirmed manager) ──────────────
const localByMgr = new Map(); // mgr -> [{pid, active, pair?}]
const allPositions = [];
for (const [pair, p] of Object.entries(V5.confirmedPools)) {
  const c = new ethers.Contract(p.manager, MGR_ABI, provider);
  let ids = [];
  try { ids = (await c.getUserPositions(WALLET)) || []; } catch { continue; }
  const list = [];
  for (const pid of ids) {
    try {
      const on = await readOnChainPosition(provider, p.manager, pid);
      list.push({ pid: Number(pid), active: !!(on && on.active && !on.closed), side: on ? (on.isLong ? "LONG" : "SHORT") : "?", on });
      allPositions.push({ pair, pid: Number(pid), active: !!(on && on.active && !on.closed), side: on ? (on.isLong ? "LONG" : "SHORT") : "?", manager: p.manager });
    } catch (e) { list.push({ pid: Number(pid), active: null, side: "?", err: e.message?.slice(0, 60) }); }
  }
  localByMgr.set(p.manager.toLowerCase(), list);
}

// ─── 1-4. PER-PAIR VERIFICATION ─────────────────────────────────────────────
const report = { wallet: WALLET, chainId: cfg.chainId || 11155111, generatedAt: new Date().toISOString(), pairs: [], localPositions: allPositions };

console.log(`wallet ${WALLET}  ·  v5 factory ${V5.factory}`);
console.log(`local positions (all confirmed managers): ${allPositions.length} total, ${allPositions.filter(p => p.active).length} active\n`);

for (const [pair, pp] of Object.entries(V5.confirmedPools)) {
  const r = { pair, pool: pp.pool, manager: pp.manager };
  const pool = new ethers.Contract(pp.pool, POOL_ABI, provider);
  const mgr = new ethers.Contract(pp.manager, MGR_ABI, provider);

  // 1. triangle
  try {
    const [t0, t1] = await Promise.all([pool.token0(), pool.token1()]);
    r.token0 = { addr: t0, ...(await tokenMeta(t0)) };
    r.token1 = { addr: t1, ...(await tokenMeta(t1)) };
    const [fp, fm, mf, codePool, codeMgr, maxLev, ltv] = await Promise.all([
      factory.getPool(t0, t1),
      factory.getManager(pp.pool),
      mgr.factory(),
      provider.getCode(pp.pool),
      provider.getCode(pp.manager),
      mgr.MAX_LEVERAGE_X10().catch(() => null),
      mgr.LTV_BPS().catch(() => null),
    ]);
    r.triangle = {
      factoryGetPoolOk: eq(fp, pp.pool),
      factoryGetManagerOk: eq(fm, pp.manager),
      managerFactoryOk: eq(mf, V5.factory),
      poolCode: codePool.length > 2,
      managerCode: codeMgr.length > 2,
      maxLeverageX10: maxLev ? Number(maxLev) : null,
      ltvBps: ltv ? Number(ltv) : null,
    };
    r.triangleOk = Object.entries(r.triangle).filter(([k]) => /Ok$|Code/.test(k)).every(([, v]) => v === true);
  } catch (e) {
    r.triangleOk = false;
    r.triangleError = e.message?.slice(0, 120);
  }

  // 2. liquidity
  try {
    const [res, liq] = await Promise.all([pool.getReserves(), mgr.getAvailableLiquidity().catch(() => null)]);
    r.reserves = { token0: res[0].toString(), token1: res[1].toString() };
    r.managerLiquidity = liq ? liq.toString() : null;
    // two-way router quotes at 0.5% depth of the smaller reserve side
    const d0 = r.token0.decimals, d1 = r.token1.decimals;
    const amt0 = (BigInt(res[0]) / 200n) || 1n;
    const amt1 = (BigInt(res[1]) / 200n) || 1n;
    const [q01, q10] = await Promise.all([
      router.getAmountsOut(amt0, [r.token0.addr, r.token1.addr]).then(x => x[1].toString()).catch(e => "ERR:" + (e.shortMessage || e.message || "").slice(0, 40)),
      router.getAmountsOut(amt1, [r.token1.addr, r.token0.addr]).then(x => x[1].toString()).catch(e => "ERR:" + (e.shortMessage || e.message || "").slice(0, 40)),
    ]);
    r.twoWay = {
      fwd: `${amt0} ${r.token0.symbol} -> ${q01} ${r.token1.symbol}`,
      rev: `${amt1} ${r.token1.symbol} -> ${q10} ${r.token0.symbol}`,
      ok: typeof q01 === "string" && !q01.startsWith("ERR") && BigInt(q01) > 0n
        && typeof q10 === "string" && !q10.startsWith("ERR") && BigInt(q10) > 0n,
    };
  } catch (e) {
    r.liquidityError = e.message?.slice(0, 120);
  }

  // 3. openability — both sides at the bot's real target size
  for (const [side, token] of [["LONG", r.token0], ["SHORT", r.token1]]) {
    if (!token) continue;
    try {
      const amount = targetCollateral(token.addr, token.decimals);
      const chk = await precheckMarketQuote(provider, {
        pool: pp.pool, manager: pp.manager, collateralToken: token.addr,
        collateralAmount: amount, leverageX10: lev10, isLong: side === "LONG",
      });
      r[`open_${side}`] = chk.ok ? { ok: true, borrow: chk.borrowAmount?.toString(), amountOutMin: chk.amountOutMin?.toString() } : { ok: false, code: chk.code, reason: (chk.reason || "").slice(0, 80) };
    } catch (e) {
      r[`open_${side}`] = { ok: false, code: "THROW", reason: e.message?.slice(0, 80) };
    }
  }

  // 4. exit feasibility — probe EVERY active local position on this pair;
  //    the pool-level verdict is the BEST result (any provable close = the
  //    pair demonstrably closes right now; blocked only if ALL are blocked).
  const locals = (localByMgr.get(pp.manager.toLowerCase()) || []).filter(x => x.active === true);
  if (locals.length) {
    const probes = [];
    let anyOk = false;
    for (const loc of locals) {
      try {
        const fm = await findMaxCloseBps(provider, pp.manager, BigInt(loc.pid), { log: () => {} });
        probes.push({ pid: loc.pid, ok: !!fm.ok, code: fm.ok ? null : (fm.code || "UNKNOWN"), maxBps: fm.ok ? (fm.maxBps ?? fm.bps ?? null) : null });
        if (fm.ok) anyOk = true;
      } catch (e) {
        probes.push({ pid: loc.pid, ok: false, code: "THROW", err: e.message?.slice(0, 50) });
      }
    }
    r.exitProbes = probes;
    r.exit = anyOk
      ? { level: "PROVEN", ok: true, via: `closeable position #${probes.find(p => p.ok)?.pid} maxBps=${probes.find(p => p.ok)?.maxBps ?? "?"}` }
      : { level: "PROVEN", ok: false, code: probes.map(p => p.code).filter(Boolean).join("+") || "UNKNOWN", via: `all ${probes.length} local position(s) blocked` };
  } else {
    const proxyOk = !!(r.twoWay?.ok) && r.managerLiquidity !== null && BigInt(r.managerLiquidity) > 0n;
    r.exit = proxyOk
      ? { level: "PROXY_OK", ok: true, via: "two-way 0.5%-depth quotes + managerLiquidity>0" }
      : { level: "PROXY_WEAK", ok: false, via: `twoWay=${r.twoWay?.ok} mgrLiq=${r.managerLiquidity}` };
  }

  // 5. verdict
  r.openBothOk = !!(r.open_LONG?.ok && r.open_SHORT?.ok);
  r.liveEligible = !!(r.triangleOk && r.openBothOk && r.exit.ok && r.exit.level !== "PROVEN_BUT_BLOCKED");
  report.pairs.push(r);

  const eTag = r.exit.ok ? (r.exit.level === "PROVEN" ? "EXIT:PROVEN" : "EXIT:PROXY-OK") : `EXIT:${r.exit.level}${r.exit.code ? "/" + r.exit.code : ""}`;
  console.log(
    `${pair.padEnd(14)} tri=${r.triangleOk ? "OK " : "BAD"} ` +
    `openL=${r.open_LONG?.ok ? "OK" : (r.open_LONG?.code || "ERR").padEnd(4)} ` +
    `openS=${r.open_SHORT?.ok ? "OK" : (r.open_SHORT?.code || "ERR").padEnd(4)} ` +
    `${eTag.padEnd(22)} ${r.liveEligible ? "★ LIVE-ELIGIBLE" : ""}`,
  );
}

// ─── summary ────────────────────────────────────────────────────────────────
const eligible = report.pairs.filter(p => p.liveEligible).map(p => p.pair);
const blocked = report.pairs.filter(p => !p.liveEligible).map(p => `${p.pair}(${p.triangleOk ? "" : "triangle,"}${p.openBothOk ? "" : "open,"}${p.exit.ok ? "" : "exit:" + (p.exit.code || p.exit.level)})`);
console.log(`\nLIVE-ELIGIBLE pairs: ${eligible.length ? eligible.join(", ") : "(none)"}`);
if (blocked.length) console.log(`not eligible: ${blocked.join(", ")}`);
console.log(`active local positions: ${allPositions.filter(p => p.active).length} of ${allPositions.length} (maxOpenPositions budget = active + 2)`);

fs.writeFileSync(path.join(REPO, "_verify_pairs_result.json"), JSON.stringify(report, null, 2));
console.log(`\nfull report -> _verify_pairs_result.json`);
