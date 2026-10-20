// ═════════════════════════════════════════════════════════════════════════════
//  SWAP MAINTENANCE ENGINE — 17 read-only checks (0 transactions)
//
//  Covers: route discovery, both directions, per-token decimals, per-token
//  reserve, amountOutMin > 0, router allowance, failed-route rotation,
//  successful rotation, no duplicate consecutive pair, the engine continuing
//  after a failure, engine independence from a failed CLOSE, LONG/SHORT
//  collateral, CLOSE manager resolution, the `npm start` entrypoint + CLI modes,
//  the single-swap-scheduler guard — plus a state-file hash check.
//
//  ISOLATION: NEMESIS_STATE_FILE points at a SCRATCH copy that is set BEFORE
//  autoTrader.js is evaluated (STATE_FILE is read at module load), so the real
//  auto-trader-state.json is never written by this run.
// ═════════════════════════════════════════════════════════════════════════════

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { ethers } from "ethers";

// ═══ LIVE-TEST GATE (default: SKIP) ═══════════════════════════════════════
// This suite can sign real transactions. Normal runs must never do that:
// it is only reachable with the explicit opt-in phrase below (the global
// signer guard in _test_state_isolation.mjs enforces the same + chainId).
if (process.env.NEMESIS_ALLOW_LIVE_TX !== "SEND LIVE TRANSACTIONS") {
  console.log('SKIP — live-test opt-in missing. Re-run only with: NEMESIS_ALLOW_LIVE_TX="SEND LIVE TRANSACTIONS" (NEMESIS_LIVE_CHAIN_ID defaults to 11155111).');
  process.exit(0);
}

const REPO = path.dirname(fileURLToPath(import.meta.url));
const REAL_STATE = path.join(REPO, "auto-trader-state.json");
const SCRATCH_DIR = path.join(REPO, ".swap-test-state");
const SCRATCH_STATE = path.join(SCRATCH_DIR, "state.json");

const sha = (p) => (fs.existsSync(p) ? crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex") : "(missing)");
const STATE_BEFORE = sha(REAL_STATE);

// ─── isolation (MUST precede the autoTrader import) ──────────────────────────
fs.mkdirSync(SCRATCH_DIR, { recursive: true });
fs.copyFileSync(REAL_STATE, SCRATCH_STATE);
// Guarantee a held position record so runCycle() takes the PHASE-1.5b branch
// (OPEN skipped, swap engine still runs) instead of attempting a dry OPEN.
{
  const st = JSON.parse(fs.readFileSync(SCRATCH_STATE, "utf8"));
  if (!st.activePositions?.[0] ?? null) {
    st.activePositions = [{ positionId: 0, side: "SHORT", collateralToken: "0x0", positionIdx: 0, marketSymbol: "USDT/DAI", managerAddr: "0x0", poolAddr: "0x0", openedAt: 0 }];
    fs.writeFileSync(SCRATCH_STATE, JSON.stringify(st, null, 2));
  }
}
process.env.NEMESIS_STATE_FILE = SCRATCH_STATE;

const { AutoTrader, applySlippage, previewCloseAt, tokenDecimalsOnChain } = await import("./autoTrader.js");
const { SwapRouteBackoff, runSwapRotationQueue, normalizeSwapConfig, reserveRawFor, computeSwapAmount, SWAP_FAILURE_CODES } = await import("./swapEngine.js");
const { RotationMemory } = await import("./rotation.js");
const { discoverTokens, discoverSwapRoutes, quoteBestPath } = await import("./swapRoutes.js");
const { getAllTokens, getFactoryAddress, getRouterAddress, getConfirmedPools, getKnownMarkets } = await import("./deployments/index.js");
const { discoverMarkets, collateralForSide, marketKey } = await import("./marketDiscovery.js");

const cfg = JSON.parse(fs.readFileSync(path.join(REPO, "config.json"), "utf8"));
const pkFile = fs.existsSync(path.join(REPO, "wallets/pk.txt")) ? path.join(REPO, "wallets/pk.txt") : path.join(REPO, "pk.txt");
const pk = fs.readFileSync(pkFile, "utf8").trim();
const rpcUrl = cfg.rpcUrl || "https://ethereum-sepolia-rpc.publicnode.com";
const chainId = cfg.chainId || 11155111;
const provider = new ethers.JsonRpcProvider(rpcUrl, chainId, { staticNetwork: true });
const routerAddr = getRouterAddress();
const walletAddr = new ethers.Wallet(pk).address;

const LOGS = [];
const log = (m, level = "info") => { LOGS.push({ m: String(m), level }); };
const txSent = () => LOGS.filter(l => /^\[TX\] \S+ SENT /.test(l.m)).length;
const nonceNow = () => provider.getTransactionCount(walletAddr, "pending").catch(() => -1);

const results = [];
function report(n, name, ok, detail = "") {
  results.push({ n, name, ok: !!ok, detail });
  console.log((ok ? "PASS  [" : "FAIL  [") + String(n).padStart(2, "0") + "] " + name + (detail ? " — " + detail : ""));
  return !!ok;
}

// ─── shared on-chain discovery (one pass, all read-only) ─────────────────────
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
const routes = await discoverSwapRoutes({ provider, routerAddress: routerAddr, factoryAddress: getFactoryAddress(), tokens: tokenList, log: () => {} });
const valid = routes.filter(r => r && r.valid === true);
const bySym = new Map(tokenList.map(t => [t.symbol, t]));
const addrOf = (s) => bySym.get(s)?.address || null;
const nTokens = tokenList.length;
const expectedPairs = nTokens * (nTokens - 1);
const routeKeySet = new Set(valid.map(r => `${r.fromSym}>${r.toSym}`));

const src = fs.readFileSync(path.join(REPO, "autoTrader.js"), "utf8");

// ═══════════════════════════════════════════════════════════════════════════
// [1] ROUTES DISCOVERY
{
  const ok = nTokens >= 7 && valid.length >= expectedPairs;
  report(1, "routes discovery — 7 tokens → 42 directed validated routes",
    ok, `tokens=${nTokens} validated=${valid.length}/${expectedPairs}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// [2] BOTH DIRECTIONS (A→B and B→A are independent validated records)
{
  const missing = [];
  for (const a of tokenList) for (const b of tokenList) {
    if (a.symbol === b.symbol) continue;
    if (!routeKeySet.has(`${b.symbol}>${a.symbol}`)) missing.push(`${b.symbol}>${a.symbol}`);
  }
  // the engine's own direction builder must expose both legs as separate entries
  const fake = new AutoTrader({ accounts: [{ address: walletAddr, privateKey: pk }], selectedWalletIndex: 0, proxies: [], rpcUrl, chainId, config: { dryRun: true, swap: cfg.swap, autoSwap: cfg.autoSwap, availableMarkets: cfg.availableMarkets || [] }, confirmedPools: getConfirmedPools(), getProvider: (u, c) => new ethers.JsonRpcProvider(u, c), log });
  fake.routes = valid;
  fake.tokenList = tokenList;
  const dirs = fake._swapDirections();
  const dirKeys = new Set(dirs.directions.map(d => d.key));
  const both = dirKeys.has("NEMESIS>USDT") && dirKeys.has("USDT>NEMESIS");
  report(2, "both directions — every route has its reverse and both appear in the queue",
    missing.length === 0 && dirs.directions.length >= expectedPairs && both,
    missing.length ? `missing ${missing.slice(0, 4).join(", ")}` : `${dirKeys.size} directions, NEMESIS>USDT + USDT>NEMESIS both present`);
}

// ═══════════════════════════════════════════════════════════════════════════
// [3] DECIMALS — read per token from the chain (never assumed 18), reserve scaled
{
  const onChain = {};
  let mismatches = 0;
  for (const t of tokenList) {
    const d = await tokenDecimalsOnChain(provider, t.address).catch(() => null);
    onChain[t.symbol] = d;
    if (Number(d) !== Number(t.decimals)) mismatches++;
  }
  const weth18 = Number(onChain.WETH) === 18;
  const sixDec = ["USDT", "USDC", "DAI", "UNI", "LINK", "NEMESIS"].every(s => Number(onChain[s]) === 6);
  const swapCfg = normalizeSwapConfig({ swap: cfg.swap, autoSwap: cfg.autoSwap });
  // same human reserve string, parsed with each token's OWN decimals
  const nemReserve = reserveRawFor("NEMESIS", 6, swapCfg);   // "1"  → 1_000_000
  const wethReserve = reserveRawFor("WETH", 18, swapCfg);    // "0.00005" → 5e13
  const wrongDecimals = reserveRawFor("NEMESIS", 18, swapCfg); // what a bug would produce
  const ok = weth18 && sixDec && mismatches === 0
    && nemReserve === 10n ** 6n && wethReserve === 5n * 10n ** 13n
    && nemReserve !== wrongDecimals;
  report(3, "decimals — per-token on-chain decimals drive reserve/amount maths",
    ok, `WETH=${onChain.WETH} USDT=${onChain.USDT} DAI=${onChain.DAI} UNI=${onChain.UNI} LINK=${onChain.LINK} NEMESIS=${onChain.NEMESIS} mismatches=${mismatches} reserveNEMESIS(6d)=${nemReserve} (18d bug)=${wrongDecimals} reserveWETH=${wethReserve}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// [4] RESERVE — available = balance − reserve, never negative, never over
{
  const swapCfg = normalizeSwapConfig({ swap: cfg.swap, autoSwap: cfg.autoSwap });
  const dec = 6;
  const reserve = reserveRawFor("USDT", dec, swapCfg); // 1 USDT
  const atReserve = computeSwapAmount({ sym: "USDT", balanceRaw: reserve, decimals: dec, cfg: swapCfg });
  const below = computeSwapAmount({ sym: "USDT", balanceRaw: reserve - 1n, decimals: dec, cfg: swapCfg });
  const rich = computeSwapAmount({ sym: "USDT", balanceRaw: reserve * 10_000n, decimals: dec, cfg: swapCfg });
  const ok = atReserve.ok === false && atReserve.code === "INSUFFICIENT_BALANCE"
    && below.ok === false && below.code === "INSUFFICIENT_BALANCE"
    && rich.ok === true && rich.amountRaw > 0n && rich.amountRaw <= rich.availableRaw
    && rich.availableRaw === reserve * 9_999n;
  report(4, "reserve — balance ≤ reserve is rejected, amount never exceeds balance − reserve",
    ok, `reserve=${reserve} at={ok:${atReserve.ok}} below={ok:${below.ok}} rich={ok:${rich.ok},amt:${rich.amountRaw},avail:${rich.availableRaw}}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// [5] amountOutMin > 0 — slippage floor, explicit guard, no unguarded zero
{
  const best = await quoteBestPath({
    provider, routerAddress: routerAddr, routes: valid,
    fromAddr: addrOf("NEMESIS"), toAddr: addrOf("USDT"),
    amountIn: 10n ** 6n, log: () => {},
  });
  const bps50 = applySlippage(best?.amountOut || 1000n, 50n);
  const bps0 = applySlippage(best?.amountOut || 1000n, 0n);
  const guard = /if\s*\(!\s*\(amountOutMin\s*>\s*0n\)\s*\)/.test(src);
  const unguardedZero = /amountOutMin\s*=\s*0n/.test(src);
  const ok = !!best && best.amountOut > 0n && bps50 > 0n && bps0 > 0n && guard && !unguardedZero;
  report(5, "amountOutMin > 0 — live quote + slippage floor + explicit guard",
    ok, `quote=${best?.amountOut} min50bps=${bps50} guard=${guard} unguardedZero=${unguardedZero}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// [6] ALLOWANCE — router approved before the swap, logged either way
{
  // Window 900 (was 400): the single-swap `allowApprove` refusal guard sits
  // between the allowance check and the approve call and must stay intact.
  const approveOrder = /allowance < amount[\s\S]{0,900}approve\(routerAddr/.test(src);
  const logsBoth = src.includes("[SWAP] allowance OK") && src.includes("[SWAP] approve required");
  const ERC20 = ["function allowance(address,address) view returns (uint256)"];
  let read = 0;
  for (const t of tokenList) {
    try { await new ethers.Contract(t.address, ERC20, provider).allowance(walletAddr, routerAddr); read++; } catch { /* read-only */ }
  }
  const ok = approveOrder && logsBoth && read === tokenList.length;
  report(6, "allowance — approves the router BEFORE swapping, and logs which path ran",
    ok, `approveOrder=${approveOrder} bothLogs=${logsBoth} allowancesRead=${read}/${tokenList.length}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// [7] FAILED-ROUTE ROTATION — the failing route is parked, everything else runs
{
  const b = new SwapRouteBackoff({ maxConsecutiveFailures: 3, baseMs: 1000, maxMs: 8000 });
  const e = b.recordFailure("NEMESIS>USDT", "QUOTE_ZERO");
  const ok = b.canAttempt("NEMESIS>USDT") === false
    && b.canAttempt("USDT>NEMESIS") === true
    && b.canAttempt("DAI>UNI") === true
    && e.fails === 1 && e.lastCode === "QUOTE_ZERO"
    && SWAP_FAILURE_CODES.includes("QUOTE_ZERO");
  b.reset();
  report(7, "failed-route rotation — only THAT route is parked (per-route backoff, no global backoff)",
    ok, `parked NEMESIS>USDT=${!b.canAttempt("NEMESIS>USDT")} others=live codes=${SWAP_FAILURE_CODES.length}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// [8] SUCCESSFUL ROTATION — the direction that just ran moves to the END
{
  const mem = RotationMemory.fromJSON(null);
  const queue = valid.slice(0, 6).map(r => ({ from: r.fromSym, to: r.toSym, key: `${r.fromSym}>${r.toSym}` }));
  const before = mem.orderSwapPairs(queue)[0].key;
  mem.recordSwapPair(queue[0].from, queue[0].to);
  const after = mem.orderSwapPairs(queue)[0].key;
  const ok = before !== after && after !== queue[0].key;
  report(8, "successful rotation — the pair that just ran is ordered LAST next pass",
    ok, `first=${before} → after recording → ${after}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// [9] NO DUPLICATE CONSECUTIVE PAIR — simulated passes never repeat the leader
{
  const mem = RotationMemory.fromJSON(null);
  const dirs = valid.map(r => ({ from: r.fromSym, to: r.toSym, key: `${r.fromSym}>${r.toSym}` }));
  let prev = null, dups = 0; const picks = [];
  for (let i = 0; i < 15; i++) {
    const q = mem.orderSwapPairs(dirs);
    const pick = q[0];
    if (prev !== null && pick.key === prev) dups++;
    prev = pick.key; picks.push(pick.key);
    mem.recordSwapPair(pick.from, pick.to);
  }
  const uniquePicks = new Set(picks).size;
  const ok = dups === 0 && uniquePicks >= 8;
  report(9, "no duplicate consecutive pair — 15 simulated passes, leader changes every time",
    ok, `dups=${dups} uniqueLeaders=${uniquePicks}/15 first5=${picks.slice(0, 5).join(",")}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// [10] ENGINE CONTINUES AFTER A FAILURE — 3 failures, then a success
{
  const attempts = [];
  let i = 0;
  const res = await runSwapRotationQueue({
    directions: [
      { from: "A", to: "B", key: "A>B" },
      { from: "B", to: "A", key: "B>A" },
      { from: "C", to: "D", key: "C>D" },
      { from: "D", to: "C", key: "D>C" },
    ],
    maxSwaps: 1,
    attempt: async (d) => { attempts.push(d.key); return i++ < 3 ? { status: "fail", code: "QUOTE_ZERO", reason: "x" } : { status: "ok", txHash: "0x1" }; },
    recordFailure: () => {},
    recordSkip: () => {},
    recordSuccess: () => {},
  });
  const ok = res.attempted === 4 && res.failed === 3 && res.verified === 1
    && res.results.length === 4 && attempts.length === 4;
  report(10, "engine continues after failure — a failed route never stops the pass",
    ok, `attempted=${res.attempted} failed=${res.failed} verified=${res.verified} tried=${attempts.join(",")}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// [11] ENGINE INDEPENDENT FROM A FAILED CLOSE — cycle still runs its swap pass
{
  const nonceBefore = await nonceNow();
  const logMark = LOGS.length;
  const accounts = [{ address: walletAddr, privateKey: pk }];
  const trader = new AutoTrader({
    accounts, selectedWalletIndex: 0, proxies: [], rpcUrl, chainId,
    config: {
      dryRun: true, autoLoopIntervalMs: 0, cooldownAfterOpenMs: 0, cooldownAfterCloseMs: 0,
      autoSwap: cfg.autoSwap, swap: cfg.swap, slippageBps: cfg.slippageBps || 50,
      availableMarkets: cfg.availableMarkets || [], deadlineSeconds: cfg.deadlineSeconds || 1200,
    },
    confirmedPools: getConfirmedPools(),
    getProvider: (u, c) => new ethers.JsonRpcProvider(u, c),
    log,
  });
  // a CLOSE that cannot happen right now — the position record is KEPT
  trader.closeActivePosition = async () => ({ ok: false, blocked: true, continueCycle: true, code: "LIQUIDITY_LOW" });
  const hadPosition = !!trader.state.activePositions?.[0] ?? null;
  await trader.runCycle();
  const cycleLines = LOGS.slice(logMark).map(l => l.m);
  const cycleEnded = cycleLines.some(m => m.includes("CYCLE END"));
  const swapRan = cycleLines.some(m => /\[SWAP\].*rotation queue:/.test(m));
  const positionKept = !!trader.state.activePositions?.[0] ?? null;

  // and the swap pass itself is untouched by that close failure: any parked
  // route is parked PER ROUTE — there is no engine-wide gate.
  const s = await trader.runSwapMaintenanceCycle({ force: true, phase: "T11" });
  const parked = trader.swapBackoff.size();
  const nonceAfter = await nonceNow();

  const ok = cycleEnded && swapRan && positionKept
    && s.blocked === null && s.total >= expectedPairs
    && parked < s.total && s.eligible === s.total - parked && s.results.length > 0
    && nonceBefore === nonceAfter && txSent() === 0;
  report(11, "engine independent from CLOSE failure — cycle completes, per-route backoff only, 0 TX",
    ok, `cycleEnded=${cycleEnded} swapPass=${swapRan} positionKept=${positionKept} eligible=${s.eligible}/${s.total} parked=${parked} blocked=${s.blocked} tx=${txSent()} nonce ${nonceBefore}→${nonceAfter}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// [12] LONG — collateral is token0 and can be routed into the pair
{
  let bad = 0, sample = 0;
  for (const m of markets) {
    if (!m.token0) continue;
    sample++;
    const col = collateralForSide(m, "LONG");
    if (String(col).toLowerCase() !== String(m.token0).toLowerCase()) bad++;
  }
  const colOk = sample > 0 && bad === 0;
  const routerTakes = /swapExactTokensForTokens/.test(src);
  report(12, "LONG — collateral resolves to token0 and is routable",
    colOk && routerTakes, `markets=${sample} mismatches=${bad} router=${routerTakes}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// [13] SHORT — collateral is token1 and can be routed into the pair
{
  let bad = 0, sample = 0;
  for (const m of markets) {
    if (!m.token1) continue;
    sample++;
    const col = collateralForSide(m, "SHORT");
    if (String(col).toLowerCase() !== String(m.token1).toLowerCase()) bad++;
  }
  const poolMin = /poolMin/.test(src) && /maxCollateralTargetShort/.test(src);
  report(13, "SHORT — collateral resolves to token1, poolMin floor + cap respected",
    sample > 0 && bad === 0 && poolMin, `markets=${sample} mismatches=${bad} poolMin=${poolMin}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// [14] CLOSE MANAGER RESOLUTION — the position's OWN manager, never rotation
{
  const body = (() => {
    const start = src.indexOf("async function closePositionFn(");
    if (start < 0) return "";
    let end = start + 6000;
    const m2 = src.indexOf("\nasync function ", start + 10);
    const m3 = src.indexOf("\nfunction ", start + 10);
    if (m2 > 0 && m2 < end) end = m2;
    if (m3 > 0 && m3 < end) end = m3;
    return src.slice(start, end);
  })();
  const takesManager = /closePositionFn\(\{\s*wallet,\s*provider,\s*managerAddr/.test(body);
  const noRotationMgr = !/getManagerAddr\s*\(/.test(body);
  const hasSelector = /CLOSE_POSITION_SELECTOR = "0xb35648d7"/.test(src);
  const m = markets.find(x => x.poolAddr && x.managerAddr && collateralForSide(x, "SHORT"));
  let probe = "no market";
  if (m) {
    const p = await previewCloseAt(provider, m.managerAddr, 999999n, 10000n);
    probe = p.err;
  }
  const ok = takesManager && noRotationMgr && hasSelector && probe === "0xa5732d32";
  report(14, "manager resolution — CLOSE uses only the position's own manager",
    ok, `param=${takesManager} noRotation=${noRotationMgr} selector=${hasSelector} probe=${probe}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// [15] `npm start` ENTRYPOINT + CLI MODES PRESERVED
{
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
  const autoSrc = fs.readFileSync(path.join(REPO, "auto.js"), "utf8");
  const startIsAuto = pkg?.scripts?.start === "node auto.js";
  const cliModes = ["--swap-matrix", "--swap-once", "--swap-loop", "--max-cycles", "--confirm", "--dry-run", "--once"]
    .every(f => autoSrc.includes(f));
  const swapCfgPassed = /swap:\s*config\.swap/.test(autoSrc)
    && /swap:\s*config\.swap/.test(fs.readFileSync(path.join(REPO, "index.js"), "utf8"));
  const bootBanner = ["[NEMESIS] Bot started", "[SWAP] Engine ", "Rotation: ", "Reverse directions: ",
    "[SWAP] Routes: ", "[SWAP] Funded routes: ", "[LONG] ", "[SHORT] ", "[CLOSE] ", "[CYCLE] #"]
    .every(s => src.includes(s));
  const confirmGate = /runSwapLoop\(\{ confirm = false/.test(src) && /runSwapOnce\(\{ confirm = false/.test(src);
  const ok = startIsAuto && cliModes && swapCfgPassed && bootBanner && confirmGate;
  report(15, "npm start entrypoint + CLI modes preserved + boot banner present",
    ok, `start=${pkg?.scripts?.start} cli=${cliModes} swapCfg=${swapCfgPassed} banner=${bootBanner} confirmGate=${confirmGate}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// [16] ONE ACTIVE SWAP SCHEDULER — no second engine can be started
{
  const g = new AutoTrader({
    accounts: [{ address: walletAddr, privateKey: pk }], selectedWalletIndex: 0, proxies: [],
    rpcUrl, chainId,
    config: { dryRun: true, swap: cfg.swap, autoSwap: cfg.autoSwap, availableMarkets: cfg.availableMarkets || [] },
    confirmedPools: getConfirmedPools(),
    getProvider: (u, c) => new ethers.JsonRpcProvider(u, c),
    log,
  });

  // (a) start() must refuse while a swap loop owns the cadence — and never set running
  g._swapLoopRunning = true;
  await g.start();
  const refusedStart = g.running === false;
  g._swapLoopRunning = false;

  // (b) runSwapLoop must refuse while the main bot loop is running
  g.running = true;
  const r1 = await g.runSwapLoop({ confirm: true });
  g.running = false;

  // (c) runSwapLoop must refuse while another loop already holds the flag
  g._swapLoopRunning = true;
  const r2 = await g.runSwapLoop({ confirm: true });
  g._swapLoopRunning = false;

  // (d) the --confirm gate is still checked FIRST (CLI safety unchanged)
  const r3 = await g.runSwapLoop({ confirm: false });

  const flagFree = g._swapLoopRunning === false;
  const ok = refusedStart
    && r1?.blocked === "MAIN_LOOP_OWNS_SCHEDULER"
    && r2?.blocked === "SWAP_LOOP_ALREADY_RUNNING"
    && r3?.blocked === "CONFIRM_REQUIRED"
    && flagFree;
  report(16, "single swap scheduler — start() and runSwapLoop() can never run two engines",
    ok, `refusedStart=${refusedStart} mainLoop=${r1?.blocked} secondLoop=${r2?.blocked} confirmGate=${r3?.blocked} flagReset=${flagFree}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// [17] STATE FILE UNCHANGED + 0 transactions sent
{
  const STATE_AFTER = sha(REAL_STATE);
  const ok = STATE_BEFORE === STATE_AFTER && txSent() === 0;
  report(17, "state-file hash unchanged and no transaction was sent",
    ok, `sha=${STATE_BEFORE === STATE_AFTER ? "unchanged" : STATE_BEFORE + " → " + STATE_AFTER} txSent=${txSent()}`);
}

// ─── summary ────────────────────────────────────────────────────────────────
const passed = results.filter(r => r.ok).length;
console.log(`\n${"═".repeat(70)}`);
console.log(`  SWAP ENGINE TESTS: ${passed}/${results.length} PASS`);
if (passed !== results.length) {
  console.log("  FAILURES:");
  for (const r of results) if (!r.ok) console.log(`   - ${r.name} :: ${r.detail}`);
}
console.log(`  state sha256=${sha(REAL_STATE)}`);
console.log(`  transactions sent: ${txSent()}`);
console.log(`${"═".repeat(70)}\n`);

fs.rmSync(SCRATCH_DIR, { recursive: true, force: true });

if (sha(REAL_STATE) !== STATE_BEFORE) { console.error("STATE FILE MODIFIED — aborting"); process.exit(2); }
process.exit(passed === results.length ? 0 : 1);
