// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 6 — 18 execution-guarantee checks (READ-ONLY, no transactions)
//
//  Must be runnable from ANY working directory (scratch CWD):
//    • source is imported relative to THIS file (repo copy)
//    • config / wallets / state are read relative to process.cwd()
//    • the state file is hash-compared before/after — this harness never writes
// ═══════════════════════════════════════════════════════════════════════════
import { TEST_STATE_FILE, realStateHash } from "./_test_state_isolation.mjs";
import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

import { discoverTokens, findRoute, candidatePaths, quoteBestPath, discoverSwapRoutes } from "./swapRoutes.js";
import { getAllTokens, getFactoryAddress, getRouterAddress, getConfirmedPools, getKnownMarkets } from "./deployments/index.js";
import { discoverMarkets, collateralForSide, marketKey } from "./marketDiscovery.js";
import { selectRandomSwapPair, minSwapAmountFor, calculateRandomSwapAmount } from "./tokenInventory.js";
import { RotationMemory } from "./rotation.js";
import { applySlippage, resolveShortCollateralAmount, previewCloseAt, readOnChainPosition, findMaxCloseBps, AutoTrader, DEFAULT_AUTO_CONFIG } from "./autoTrader.js";

const REPO = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.resolve("auto-trader-state.json");
const hashState = () => {
  try { return crypto.createHash("sha256").update(fs.readFileSync(STATE_FILE)).digest("hex"); }
  catch (e) { return "ERR:" + e.message; }
};
const STATE_BEFORE = hashState();

const cfg = JSON.parse(fs.readFileSync(path.resolve("config.json"), "utf8"));
const pk = fs.readFileSync(path.resolve("wallets/pk.txt"), "utf8").trim();
const walletAddr = new ethers.Wallet(pk).address; // no provider attached: cannot send
const provider = new ethers.JsonRpcProvider(
  cfg.rpcUrl || "https://ethereum-sepolia-rpc.publicnode.com",
  cfg.chainId || 11155111,
  { staticNetwork: true },
);
const routerAddr = getRouterAddress();
const autoSwap = cfg.autoSwap || {};

const results = [];
function check(n, name, ok, detail = "") {
  results.push({ n, name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  [${String(n).padStart(2)}] ${name}${detail ? ` — ${detail}` : ""}`);
  return !!ok;
}
const fmt = (v) => String(v);

// ── shared discovery (one pass) ──────────────────────────────────────────────
const discovered = await discoverMarkets({
  provider,
  factoryAddress: getFactoryAddress(),
  tokens: getAllTokens(),
  confirmedPools: getConfirmedPools() || [],
  knownMarkets: getKnownMarkets() || [],
  availableMarkets: cfg.availableMarkets || [],
  runtime: {},
  log: () => {},
});
const markets = discovered.markets || [];
const tokenList = await discoverTokens({ provider, tokens: getAllTokens(), markets, log: () => {} });
const routes = await discoverSwapRoutes({
  provider, routerAddress: routerAddr, factoryAddress: getFactoryAddress(),
  tokens: tokenList, log: () => {},
});

const bySym = new Map(tokenList.map(t => [t.symbol, t]));
const dec = (s) => Number(bySym.get(s)?.decimals ?? 18);
const router = new ethers.Contract(routerAddr, [
  "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)",
], provider);
const quoteOn = async (amountIn, path_) => {
  try {
    const a = await router.getAmountsOut(amountIn, path_);
    return a[a.length - 1];
  } catch { return null; }
};
const ERC20 = new ethers.Interface(["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)"]);
const allowanceOf = (addr) => new ethers.Contract(addr, ERC20, provider).allowance(walletAddr, routerAddr);
const allowanceBefore = [];
for (const t of tokenList) allowanceBefore.push(await allowanceOf(t.address));

// ═══ T01 — FULL TOKEN MATRIX, BOTH DIRECTIONS ═══════════════════════════════
{
  const n = tokenList.length;
  const expected = n * (n - 1);
  const keys = routes.map(r => `${r.fromSym}>${r.toSym}`);
  const unique = new Set(keys);
  const endpointsOk = routes.every(r =>
    r.valid === true &&
    String(r.path[0]).toLowerCase() === String(r.fromAddr).toLowerCase() &&
    String(r.path[r.path.length - 1]).toLowerCase() === String(r.toAddr).toLowerCase() &&
    (r.path.length === 2 || r.path.length === 3));
  check(1, `full token matrix both directions (${n} tokens = ${expected} ordered pairs)`,
    unique.size === expected && endpointsOk,
    `discovered ${unique.size}/${expected}, endpoints+pathlen ok=${endpointsOk}`);
}

// ═══ T02 — REVERSE ROUTES ═══════════════════════════════════════════════════
{
  const set = new Set(routes.map(r => `${r.fromSym}>${r.toSym}`));
  const missing = [];
  for (const a of tokenList) for (const b of tokenList) {
    if (a.symbol === b.symbol) continue;
    if (!set.has(`${b.symbol}>${a.symbol}`)) missing.push(`${b.symbol}>${a.symbol}`);
  }
  check(2, "every directed route has its reverse", missing.length === 0,
    missing.length ? `missing: ${missing.slice(0, 6).join(", ")}` : `${set.size} pairs, all reversible`);
}

// ═══ T03 — DIRECT ROUTE ═════════════════════════════════════════════════════
{
  const r = routes.find(x => x.type === "direct" && x.path.length === 2);
  const direct = r ? findRoute(routes, r.fromAddr, r.toAddr) : null;
  const firstIsDirect = (() => {
    if (!r) return false;
    return candidatePaths(routes, r.fromAddr, r.toAddr, { directProbe: false })[0]?.type === "direct";
  })();
  check(3, "direct (1-hop) route is preferred and validated",
    !!direct && direct.type === "direct" && direct.path.length === 2 && firstIsDirect,
    r ? `${r.fromSym}>${r.toSym} path.len=${direct?.path.length}` : "no direct route found");
}

// ═══ T04 — 2-HOP FALLBACK ═══════════════════════════════════════════════════
{
  // Simulate a pair with NO direct pool by removing its direct record; the
  // engine must still compose A→HUB→B from two validated legs and quote it.
  let found = null, multiCands = 0;
  for (const a of tokenList) {
    if (found) break;
    for (const b of tokenList) {
      if (a.symbol === b.symbol) continue;
      const withoutDirect = routes.filter(r =>
        !(String(r.fromAddr).toLowerCase() === String(a.address).toLowerCase() &&
          String(r.toAddr).toLowerCase() === String(b.address).toLowerCase()));
      const cands = candidatePaths(withoutDirect, a.address, b.address, { directProbe: false, maxPaths: 4 });
      if (!cands.some(c => c.type === "multi")) continue;
      multiCands++;
      const q = await quoteBestPath({
        provider, routerAddress: routerAddr, routes: withoutDirect,
        fromAddr: a.address, toAddr: b.address,
        amountIn: 10n ** BigInt(dec(a.symbol)),
        // The direct record was removed ABOVE, but quoteBestPath() would still
        // re-probe the live A→B pool on-chain and answer with type "direct-probe"
        // — which would hide the multi-hop composition this check is about.
        // Disable that probe so only the validated A→HUB→B legs are exercised.
        directProbe: false,
      });
      if (q && q.type === "multi" && q.amountOut > 0n && q.path.length === 3) {
        found = `${a.symbol}>${b.symbol} (path len ${q.path.length})`;
        break;
      }
    }
  }
  check(4, "2-hop fallback produces a live A→HUB→B quote when direct is unavailable",
    !!found, found ? `quoted ${found}; ${multiCands} pairs offered multi` : `no multi-hop quote (${multiCands} pairs offered multi)`);
}

// ═══ T05 — amountOut = 0 NEVER RETURNS A TRADEABLE RESULT ═══════════════════
{
  let bad = 0, nulls = 0, quoted = 0;
  for (const r of routes) {
    const q = await quoteBestPath({
      provider, routerAddress: routerAddr, routes,
      fromAddr: r.fromAddr, toAddr: r.toAddr, amountIn: 1n, // 1 base unit → must be 0/unquotable
    });
    if (q === null) { nulls++; continue; }
    if (q.amountOut <= 0n) bad++; else quoted++;
  }
  const samplesOk = routes.every(r => r.quoteSample === undefined || BigInt(r.quoteSample) > 0n);
  check(5, "zero-output quotes are rejected, never returned as a route",
    bad === 0 && samplesOk,
    `null=${nulls} quoted>0=${quoted} bad=${bad}, quoteSample>0=${samplesOk}`);
}

// ═══ T06 — SYMBOL COLLISION ═════════════════════════════════════════════════
{
  const addrSeen = new Map(), symSeen = new Map(), collisions = [];
  for (const t of tokenList) {
    const a = String(t.address).toLowerCase();
    const s = String(t.symbol);
    if (addrSeen.has(a) && addrSeen.get(a) !== s) collisions.push(`addr ${a}: ${addrSeen.get(a)} vs ${s}`);
    if (symSeen.has(s) && symSeen.get(s) !== a) collisions.push(`sym ${s}: ${symSeen.get(s)} vs ${a}`);
    addrSeen.set(a, s); symSeen.set(s, a);
  }
  // every route's symbol must resolve to exactly one address (no symbol reuse)
  const routeSym = new Map();
  let routeCollisions = 0;
  for (const r of routes) {
    for (const [s, a] of [[r.fromSym, r.fromAddr], [r.toSym, r.toAddr]]) {
      const k = `${s}|${r.type}`;
      const la = String(a).toLowerCase();
      if (routeSym.has(k) && routeSym.get(k) !== la) routeCollisions++;
      else routeSym.set(k, la);
    }
  }
  check(6, "symbol↔address mapping is 1:1 (no symbol collisions)",
    collisions.length === 0 && routeCollisions === 0 && addrSeen.size === tokenList.length,
    `${tokenList.length} tokens, collisions=${collisions.length + routeCollisions}`);
}

// ═══ T07 — LONG COLLATERAL ══════════════════════════════════════════════════
{
  const set = new Set(routes.map(r => `${r.fromSym}>${r.toSym}`));
  let bad = 0, checked = 0, detail = "";
  for (const m of markets) {
    const c = collateralForSide(m, "LONG");
    if (!c) continue;
    const other = String(c).toLowerCase() === String(m.token0 || m.poolToken0 || "").toLowerCase()
      ? (m.token1 || m.poolToken1) : (m.token0 || m.poolToken0);
    if (!other) continue;
    checked++;
    const cs = tokenList.find(t => String(t.address).toLowerCase() === String(c).toLowerCase())?.symbol;
    const os = tokenList.find(t => String(t.address).toLowerCase() === String(other).toLowerCase())?.symbol;
    if (!cs || !os) { bad++; detail = `unmapped ${marketKey(m)}`; continue; }
    if (!set.has(`${cs}>${os}`)) { bad++; detail = `${marketKey(m)}: ${cs}>${os} missing`; }
  }
  check(7, "LONG collateral resolves to token0 and can be routed into the pair",
    checked > 0 && bad === 0, `${checked} markets, bad=${bad}${detail ? ` (${detail})` : ""}`);
}

// ═══ T08 — SHORT COLLATERAL ═════════════════════════════════════════════════
{
  const set = new Set(routes.map(r => `${r.fromSym}>${r.toSym}`));
  let bad = 0, checked = 0, detail = "";
  for (const m of markets) {
    const c = collateralForSide(m, "SHORT");
    if (!c) continue;
    const other = String(c).toLowerCase() === String(m.token1 || m.poolToken1 || "").toLowerCase()
      ? (m.token0 || m.poolToken0) : (m.token1 || m.poolToken1);
    if (!other) continue;
    checked++;
    const cs = tokenList.find(t => String(t.address).toLowerCase() === String(c).toLowerCase())?.symbol;
    const os = tokenList.find(t => String(t.address).toLowerCase() === String(other).toLowerCase())?.symbol;
    if (!cs || !os) { bad++; detail = `unmapped ${marketKey(m)}`; continue; }
    if (!set.has(`${cs}>${os}`)) { bad++; detail = `${marketKey(m)}: ${cs}>${os} missing`; }
  }
  check(8, "SHORT collateral resolves to token1 and can be routed into the pair",
    checked > 0 && bad === 0, `${checked} markets, bad=${bad}${detail ? ` (${detail})` : ""}`);
}

// ═══ T09 — CANDIDATE ISOLATION ══════════════════════════════════════════════
{
  let bad = 0, sample = 0;
  for (const r of routes.slice(0, 12)) {
    const cands = candidatePaths(routes, r.fromAddr, r.toAddr, { maxPaths: 4, directProbe: false });
    sample++;
    if (cands.length > 4) bad++;
    const keys = new Set();
    for (const c of cands) {
      if (String(c.path[0]).toLowerCase() !== String(r.fromAddr).toLowerCase()) bad++;
      if (String(c.path[c.path.length - 1]).toLowerCase() !== String(r.toAddr).toLowerCase()) bad++;
      if (c.path.length > 3) bad++;
      if (keys.has(c.key)) bad++;
      keys.add(c.key);
    }
  }
  check(9, "candidate paths stay isolated (start/end fixed, ≤4, no duplicates)",
    bad === 0 && sample > 0, `sampled ${sample} pairs, violations=${bad}`);
}

// ═══ T10 — CLOSE MANAGER ISOLATION ══════════════════════════════════════════
{
  const src = fs.readFileSync(path.join(REPO, "autoTrader.js"), "utf8");
  const start = src.indexOf("async function closePositionFn(");
  let end = start + 6000;
  const m2 = src.indexOf("\nasync function ", start + 10);
  const m3 = src.indexOf("\nfunction ", start + 10);
  if (m2 > 0 && m2 < end) end = m2;
  if (m3 > 0 && m3 < end) end = m3;
  const body = src.slice(start, end);
  const takesManager = /closePositionFn\(\{\s*wallet,\s*provider,\s*managerAddr/.test(body);
  const noRotationManager = !/getManagerAddr\s*\(/.test(body);
  const hasSelector = /CLOSE_POSITION_SELECTOR = "0xb35648d7"/.test(src);
  const mgr = (markets.find(x => x.managerAddr) || {}).managerAddr || getFactoryAddress();
  const p = await previewCloseAt(provider, mgr, 999999n, 10000n);
  const isolated = p.ok === false && p.err === "0xa5732d32"; // MAM_InvalidPosition
  check(10, "CLOSE uses only the injected manager (never rotation/side manager)",
    takesManager && noRotationManager && hasSelector && isolated,
    `param=${takesManager} noRotation=${noRotationManager} selector=${hasSelector} probe=${p.err}`);
}

// ═══ T11 — poolMin SHORT SIZING ═════════════════════════════════════════════
{
  const m = markets.find(x => x.poolAddr && x.managerAddr && collateralForSide(x, "SHORT"));
  let ok = false, detail = "no market with manager+pool";
  if (m) {
    const collateral = collateralForSide(m, "SHORT");
    const capRaw = 10n ** 24n;
    const tiny = await resolveShortCollateralAmount(provider, {
      pool: m.poolAddr, manager: m.managerAddr, collateralToken: collateral,
      configuredRaw: 1n, capRaw, leverageX10: 20n, // 2.0x — leverage must be > 1.0
    });
    const over = await resolveShortCollateralAmount(provider, {
      pool: m.poolAddr, manager: m.managerAddr, collateralToken: collateral,
      configuredRaw: capRaw * 10n, capRaw, leverageX10: 20n,
    });
    const tinyOk = tiny.ok === true && tiny.amount >= tiny.poolMin && tiny.amount <= capRaw && tiny.amount > 1n;
    const overOk = over.ok === false && over.amount === undefined && over.code === "COLLATERAL_EXCEEDS_CAP";
    ok = tinyOk && overOk;
    detail = `${marketKey(m)} tiny={ok:${tiny.ok},amt:${tiny.amount},poolMin:${tiny.poolMin}} over={ok:${over.ok},${over.code}}`;
  }
  check(11, "SHORT sizing respects poolMin floor and never exceeds the cap", ok, detail);
}

// ═══ T12 — amountOutMin ≠ 0 ═════════════════════════════════════════════════
{
  const r = routes.find(x => x.path.length === 2);
  const quote = r ? await quoteOn(10n ** BigInt(dec(r.fromSym)), r.path) : null;
  const slippaged = quote !== null ? applySlippage(quote, 50n) : null;
  const src = fs.readFileSync(path.join(REPO, "autoTrader.js"), "utf8");
  const guard = /if\s*\(!\(amountOutMin > 0n\)\)/.test(src);
  const realZero = src.split("\n").filter(l => {
    if (/^\s*\*/.test(l) || /^\s*\/\*/.test(l)) return false;
    const code = l.replace(/\/\/.*$/, "");
    if (!/amountOutMin\s*=\s*0n?\b/.test(code)) return false;
    if (/\blog\(/.test(code)) return false;
    if (/never|Never|guard|Guard|diagnostic|eth_call|DRY|dry/i.test(code)) return false;
    return true;
  });
  check(12, "amountOutMin is never 0 (slippage floor + explicit guard)",
    slippaged !== null && slippaged > 0n && guard && realZero.length === 0,
    `quote=${quote} amountOutMin=${slippaged} guard=${guard} unguardedZero=${realZero.length}`);
}

// ═══ T13 — ALLOWANCE ════════════════════════════════════════════════════════
{
  const src = fs.readFileSync(path.join(REPO, "autoTrader.js"), "utf8");
  const approvesFirst = /allowance < amount[\s\S]{0,400}approve\(routerAddr/.test(src);
  check(13, "swap approves the router BEFORE swapping (preflight ordering)",
    approvesFirst && allowanceBefore.length === tokenList.length,
    `approve-order=${approvesFirst}, ${allowanceBefore.length}/${tokenList.length} allowances read`);
}

// ═══ T14 — BALANCE DEFICIT GATE ═════════════════════════════════════════════
{
  const balances = {};
  for (const t of tokenList) balances[t.symbol] = { raw: 10n ** 18n, float: 1000 };
  balances.WETH = { raw: 63124803927031n, float: 0.000063124803927031 }; // < minSwapAmountWETH
  const rot = new RotationMemory({ state: null });
  const counts = {};
  for (const r of routes) counts[r.key ?? `${r.fromSym}>${r.toSym}`] = 100;
  for (const r of routes.filter(x => x.fromSym === "WETH")) counts[`${r.fromSym}>${r.toSym}`] = 0;
  rot.swapPairCounts = counts;
  let gated = 0;
  for (let i = 0; i < 50; i++) {
    const p = selectRandomSwapPair(null, balances, autoSwap, {}, () => {}, routes, rot);
    if (!p) break;
    const amt = calculateRandomSwapAmount(p.from, balances[p.from].float, autoSwap, dec(p.from));
    if (!amt) gated++;
    else rot.recordSwapPair(p.from, p.to);
  }
  const gateValue = minSwapAmountFor("WETH", autoSwap);
  check(14, "a source below minSwapAmount is never selected (no swap livelock)",
    gated === 0 && gateValue === 0.0001,
    `gated picks=${gated}/50, minSwapAmountFor(WETH)=${gateValue}`);
}

// ═══ T15 — SWAP PREFLIGHT (quote at real size ⇒ amountOutMin > 0) ═══════════
{
  let executable = 0, skipped = 0, bad = 0;
  for (const r of routes) {
    const minUnits = minSwapAmountFor(r.fromSym, autoSwap); // smallest size the gate allows
    const amountRaw = minUnits > 0
      ? ethers.parseUnits(minUnits.toFixed(dec(r.fromSym)), dec(r.fromSym))
      : 10n ** BigInt(dec(r.fromSym));
    const q = await quoteOn(amountRaw, r.path);
    if (q === null || q <= 0n) { skipped++; continue; }
    executable++;
    const minOut = applySlippage(q, BigInt(autoSwap.slippageBps || 50));
    if (minOut <= 0n) bad++;
  }
  check(15, "swap preflight: every executable pair yields amountOutMin > 0",
    bad === 0 && (executable + skipped === routes.length),
    `executable=${executable} skipped=${skipped} bad=${bad} of ${routes.length}`);
}

// ═══ T16 — A LIVE POSITION IS NEVER CLEARED BY AN AMBIGUOUS READ ════════════
{
  const src = fs.readFileSync(path.join(REPO, "autoTrader.js"), "utf8");
  const stored = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")).activePosition || null;
  const mgrs = [...new Set(markets.map(m => m.managerAddr).filter(Boolean))];

  // static — the unreadable branch backs off and KEEPS the position; startup
  // recovery routes through the chain (never a local "state says X" clear).
  const unIdx = src.indexOf('_noteCloseFailure(null, "POSITION_UNREADABLE")');
  const unBlock = unIdx >= 0 ? src.slice(unIdx, unIdx + 400) : "";
  // the unreadable branch may return either the legacy `false` or the
  // structured { ok:false, blocked:true, continueCycle:true } result — both
  // are a "kept, back off" answer as long as no branch nulls activePosition.
  const keptAnswer = unBlock.includes("return false") ||
    (unBlock.includes("ok: false") && unBlock.includes("blocked: true") && unBlock.includes("continueCycle: true"));
  const unreadableKeeps = !!unBlock && keptAnswer && !unBlock.includes("activePosition = null");
  const locateCalls = (src.match(/this\._locateStoredPosition\(\)/g) || []).length;

  // the trader under test is built from the prototype so this harness cannot
  // write the state file (the constructor's loadState()/saveState() is skipped)
  const mkTrader = (prov) => {
    const t = Object.create(AutoTrader.prototype);
    t.state = JSON.parse(JSON.stringify(JSON.parse(fs.readFileSync(STATE_FILE, "utf8"))));
    t.deps = { accounts: [{ address: walletAddr }], selectedWalletIndex: 0, confirmedPools: cfg.confirmedPools || {} };
    t.markets = markets;
    t.config = { ...DEFAULT_AUTO_CONFIG };
    t.log = () => {};
    t.getRuntime = () => ({ provider: prov });
    return t;
  };

  // functional — a record the chain confirms ACTIVE must be reported active.
  let mgr = stored?.managerAddr || null;
  if (!mgr && stored?.positionId != null) {
    for (const m of mgrs) {
      const r = await readOnChainPosition(provider, m, stored.positionId);
      if (r && r.active) { mgr = m; break; }
    }
  }
  let liveStatus = "n/a", liveMgr = null;
  if (stored && stored.positionId != null && mgr) {
    const found = await mkTrader(provider)._locateStoredPosition();
    liveStatus = found.status; liveMgr = found.managerAddr || null;
  }
  const liveOk = !!stored && stored.positionId != null && liveStatus === "active" &&
    !!liveMgr && String(liveMgr).toLowerCase() === String(mgr).toLowerCase();

  // functional — an RPC outage must read as "unreadable", never as "gone".
  let deadStatus = "n/a";
  if (stored && stored.positionId != null) {
    const dead = new ethers.JsonRpcProvider(cfg.rpcUrl || "https://ethereum-sepolia-rpc.publicnode.com", cfg.chainId || 11155111, { staticNetwork: true });
    const refuse = () => Promise.reject(new Error("simulated RPC outage (read-only harness)"));
    dead.send = refuse; dead._perform = refuse; dead.call = refuse;
    deadStatus = (await mkTrader(dead)._locateStoredPosition()).status;
  }
  const deadOk = deadStatus === "n/a" || deadStatus === "unreadable";

  check(16, "live position is never cleared by an unreadable/ambiguous read",
    unreadableKeeps && locateCalls >= 2 && liveOk && deadOk,
    `static[keeps=${unreadableKeeps} locateCalls=${locateCalls}] live[${liveStatus}${liveMgr ? " on " + liveMgr.slice(0, 10) : ""}] outage[${deadStatus}]`);
}

// ═══ T17 — PARTIAL-CLOSE FALLBACK IS STRUCTURED (never null, never clears) ══
{
  const src = fs.readFileSync(path.join(REPO, "autoTrader.js"), "utf8");
  const apStart = src.indexOf("async function attemptPartialClose(");
  const cfStart = src.indexOf("async function closePositionFn(");
  const clsStart = src.indexOf("export class AutoTrader");
  const apBody = apStart >= 0 && cfStart > apStart ? src.slice(apStart, cfStart) : "";
  const cfBody = cfStart >= 0 && clsStart > cfStart ? src.slice(cfStart, clsStart) : "";

  const fallbackCalls = (cfBody.match(/return attemptPartialClose\(/g) || []).length;
  const liquidityBranches =
    (cfBody.match(/ERR_INSUFFICIENT_LIQUIDITY/g) || []).length >= 2 &&
    (cfBody.match(/ERR_POOL_INSUFFICIENT_OUTPUT/g) || []).length >= 2;
  const neverNull = apBody.length > 0 && !/return null\s*;/.test(apBody);
  const keepsState = (apBody.match(/clearState:\s*false/g) || []).length > 0;

  // functional — the read-only closeBps search returns a bounded, classified
  // object (never throws, never guesses) on BOTH outcomes: a manager whose #61
  // is fully closable, and the stored position's own manager where #61 sits in
  // a too-small→illiquid pocket (search must report that honestly).
  const mgrsAll = [...new Set(markets.map(m => m.managerAddr).filter(Boolean))];
  let mgr61 = null;
  for (const m of mgrsAll) {
    const r = await readOnChainPosition(provider, m, 61n);
    if (r && r.active) { mgr61 = m; break; }
  }
  if (!mgr61) mgr61 = mgrsAll[0] || null;
  const storedMgr = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"))?.activePosition?.managerAddr || null;
  const classifiedCode = (r) => r && (r.ok === true ? typeof r.closeBps === "bigint" : ["CLOSE_AMOUNT_TOO_SMALL", "CLOSE_BPS_NOT_FOUND", "PROBE_LIMIT"].includes(r.code));
  const bounded = (r) => r && Number(r.probes) > 0 && Number(r.probes) <= 48;

  let open1 = null, open2 = null, threw = null;
  try {
    if (mgr61) open1 = await findMaxCloseBps(provider, mgr61, 61n, { log: () => {} });
    if (storedMgr && (!mgr61 || storedMgr.toLowerCase() !== mgr61.toLowerCase())) {
      open2 = await findMaxCloseBps(provider, storedMgr, 61n, { log: () => {} });
    }
  } catch (e) { threw = e?.message || String(e); }

  const results17 = [open1, open2].filter(Boolean);
  const structured = !threw && results17.length >= 1 &&
    results17.every((r) => classifiedCode(r) && bounded(r));
  const sawBothPaths = results17.length >= 1 &&
    (results17.length === 1
      ? results17[0].ok === true || results17[0].ok === false
      : results17.some((r) => r.ok === true) && results17.some((r) => r.ok === false));
  const bogus = mgr61 ? await previewCloseAt(provider, mgr61, 999999n, 10000n) : null;
  const classified = !!bogus && bogus.ok === false && bogus.err === "0xa5732d32";
  const describe = (r) => !r ? "n/a" : (r.ok ? `ok closeBps=${r.closeBps}` : `code=${r.code}`) + ` probes=${r.probes}`;

  check(17, "liquidity-blocked close falls back to a bounded partial-close search",
    fallbackCalls >= 2 && liquidityBranches && neverNull && keepsState && structured && sawBothPaths && classified,
    `calls=${fallbackCalls} branches=${liquidityBranches} nullReturns=${!neverNull} keepsState=${keepsState} ` +
    `search[${describe(open1)} | ${describe(open2)}] bogus=${bogus?.err || "n/a"}`);
}

// ═══ T18 — THIS HARNESS IS READ-ONLY (state + allowances byte-identical) ════
const allowanceAfter = [];
for (const t of tokenList) allowanceAfter.push(await allowanceOf(t.address));
const STATE_AFTER = hashState();
const allowanceUnchanged = allowanceBefore.every((v, i) => v === allowanceAfter[i]);
check(18, "harness left state file and router allowances byte-identical",
  STATE_AFTER === STATE_BEFORE && allowanceUnchanged,
  `state=${STATE_AFTER === STATE_BEFORE ? "unchanged" : "CHANGED"} allowances=${allowanceUnchanged ? "unchanged" : "CHANGED"}`);

// ═══ EXPECTED OUTPUT SUMMARY (derived from source + discovery, not asserted) ═
{
  const src = fs.readFileSync(path.join(REPO, "autoTrader.js"), "utf8");
  const lines = src.split("\n");
  const codeLine = (l) => (!/^\s*\*/.test(l) && !/^\s*\/\*/.test(l)) ? l.replace(/\/\/.*$/, "") : null;
  const count = (re, filter = () => true) => lines.filter((l) => { const c = codeLine(l); return c !== null && re.test(c) && filter(c); }).length;

  const unguardedZero = count(/amountOutMin\s*=\s*0n?\b/,
    (c) => !/\blog\(/.test(c) && !/never|Never|guard|Guard|diagnostic|eth_call|DRY|dry/i.test(c));
  const hardcodedCollateral = count(/collateral(Token)?\s*[:=]\s*"0x[0-9a-fA-F]{40}"/i);
  const hardcodedManager = count(/managerAddr\s*=\s*"0x[0-9a-fA-F]{40}"/i);
  const rotationClose = count(/getManagerAddr\(/, (c) => !/^\s*getManagerAddr\(/.test(c));
  const cappedLoops = (src.match(/samePairFails >= 2/g) || []).length;
  const loopsWithCap = (src.match(/let samePairFails/g) || []).length;

  // marketCandidates[0] must never carry collateral/identity logic — the two
  // occurrences may only feed a log line (the OPEN loop iterates every candidate).
  let idxC0 = 0, c0LogOnly = true;
  while ((idxC0 = src.indexOf("marketCandidates[0]", idxC0 + 1)) >= 0) {
    const after = src.slice(idxC0, idxC0 + 600).split("\n").slice(0, 10);
    const uses = after.filter((l) => /\bmarket\./.test(l));
    if (!uses.length || uses.some((l) => !/\.log\(/.test(l))) c0LogOnly = false;
  }

  const expected = tokenList.length * (tokenList.length - 1);
  const uniq = new Set(routes.map((r) => `${r.fromSym}>${r.toSym}`)).size;
  const rows = [
    ["unguarded amountOutMin=0   ", unguardedZero],
    ["hardcoded CLOSE manager    ", hardcodedManager],
    ["hardcoded collateral source", hardcodedCollateral],
    ["marketCandidates[0] collat.", c0LogOnly ? 0 : 1],
    ["rotation/side mgr for CLOSE", rotationClose],
    ["uncapped swap-retry loops  ", loopsWithCap - cappedLoops],
    ["routes                     ", `${uniq}/${expected}`],
  ];
  console.log("\n=== EXPECTED OUTPUT SUMMARY ===");
  for (const [k, v] of rows) console.log(`  ${k}: ${v}`);
}

// ═══ harness integrity (state/allowances already asserted as check #18) ═════
console.log(`\nstate sha256 before=${STATE_BEFORE}`);
console.log(`state sha256 after =${STATE_AFTER}`);
console.log(`router allowances unchanged: ${allowanceUnchanged}`);
if (STATE_BEFORE !== STATE_AFTER) { console.error("STATE FILE MODIFIED — aborting"); process.exit(2); }
if (!allowanceUnchanged) { console.error("ALLOWANCE CHANGED — this harness must be read-only"); process.exit(2); }

const passed = results.filter(r => r.ok).length;
console.log(`\n=== ${passed}/${results.length} checks passed ===`);
if (results.some(r => !r.ok)) {
  console.log("failed: " + results.filter(r => !r.ok).map(r => `#${r.n} ${r.name}`).join(" | "));
  process.exit(1);
}
process.exit(0);
