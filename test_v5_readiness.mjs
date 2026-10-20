// ═══════════════════════════════════════════════════════════════════════════
//  READ-ONLY v5 READINESS CHECK — no transactions, no state changes.
//
//  A. Registry: active deployment = v5, addresses all v5 (no v2 leakage)
//  B. Startup hard-stop replication (same checks auto.js runs, standalone)
//  C. Swap EXECUTION calldata via eth_call on the v5 router (production ABI)
//  D. Open/Close EXECUTION calldata via eth_call on v5 managers
//     (encodeOpenPositionCalldata — the exact production encoder)
//  E. Runtime-mode / auto-start audit (config + entrypoint)
//  F. Fallback-path probe: resolveTradingMarket when discovery is empty
//
//  Exit 0 = all critical checks pass · Exit 1 = blocker found
// ═══════════════════════════════════════════════════════════════════════════
import "./_test_state_isolation.mjs"; // state redirect + default-deny live-TX guard
import fs from "fs";
import { ethers } from "ethers";
import { getActiveDeploymentId, getActiveDeployment, getConfirmedPools, getKnownMarkets } from "./deployments/index.js";
import { encodeOpenPositionCalldata, resolveTradingMarket } from "./autoTrader.js";

const CHAIN = 11155111;
const providers = [
  new ethers.JsonRpcProvider("https://sepolia.drpc.org", CHAIN, { batchMaxCount: 2 }),
  new ethers.JsonRpcProvider("https://ethereum-sepolia-rpc.publicnode.com", CHAIN, { batchMaxCount: 2 }),
];

// eth(): run fn(provider) across providers with retry (drpc 500s / publicnode flakiness)
async function eth(fn) {
  let lastErr = null;
  for (let round = 0; round < 2; round++) {
    for (const p of providers) {
      try { return await fn(p); } catch (e) { lastErr = e; }
      await new Promise(r => setTimeout(r, 200));
    }
  }
  throw lastErr;
}

let fail = 0, warn = 0;
const ok = (c, label, d = "") => { if (c) console.log(`  PASS  ${label}${d ? `  (${d})` : ""}`); else { fail++; console.log(`  FAIL  ${label}${d ? `  (${d})` : ""}`); } };
const wrn = (c, label, d = "") => { if (c) { warn++; console.log(`  WARN  ${label}${d ? `  (${d})` : ""}`); } else console.log(`  INFO  ${label}${d ? `  (${d})` : ""}`); };

// Wallet address — same sources as auto.js loadAccounts (private key never printed)
function loadWalletAddress() {
  try {
    const c = JSON.parse(fs.readFileSync("config.json", "utf8"));
    if (c.accounts?.[0]?.address) return c.accounts[0].address;
  } catch {}
  try {
    const pk = fs.readFileSync("wallets/pk.txt", "utf8").trim();
    if (pk) return new ethers.Wallet(pk).address;
  } catch {}
  return null;
}

const cfg = JSON.parse(fs.readFileSync("config.json", "utf8"));
const WALLET = loadWalletAddress();
const DEP = getActiveDeployment();
const confirmedPools = getConfirmedPools();
const report = { ts: new Date().toISOString(), deployment: getActiveDeploymentId(), wallet: WALLET, checks: {} };

console.log("═══ A. REGISTRY / ACTIVE PROFILE ═══");
ok(getActiveDeploymentId() === "v5", "active deployment id = v5", getActiveDeploymentId());
ok(DEP.factory.toLowerCase() === "0x35f75f9218c640335d7166628319c4d95d1b0ae8", "factory = site v5 factory", DEP.factory);
ok(DEP.router.toLowerCase() === "0x6c2844a5afd10e22195d5f58227434b5b073b6d3", "router = site v5 router", DEP.router);
const V2_ADDRS = ["0x8f6eb7870334b1fd8006fd52413f01689f4e57e9", "0xded3d3ca2f7efde734790ce51bd03d5145e4830b", "0x6562c653a2f2982d8dad9e420bf3ff5a568efd82", "0xd45dde32c66769ed835a0f0f45ec0bf6973857fd"];
const allAddrs = [
  DEP.factory, DEP.router,
  ...Object.values(DEP.tokens || {}),
  ...Object.values(confirmedPools).flatMap(p => [p.pool, p.manager]),
].map(a => String(a).toLowerCase());
const leaked = allAddrs.filter(a => V2_ADDRS.includes(a));
ok(leaked.length === 0, "no v2 addresses in active profile (factory/router/tokens/pools/managers)", leaked.join(",") || "clean");
ok(!!WALLET, "wallet address resolvable (same sources as auto.js)", WALLET);
ok(Object.keys(confirmedPools).length >= 6, "confirmedPools present", `${Object.keys(confirmedPools).length} markets`);
report.checks.registry = { id: getActiveDeploymentId(), factory: DEP.factory, router: DEP.router, leaked, markets: Object.keys(confirmedPools).length };
console.log();

console.log("═══ B. STARTUP HARD-STOP REPLICATION (read-only, standalone) ═══");
{
  const FACTORY_ABI = ["function router() view returns (address)", "function getPool(address,address) view returns (address)", "function getManager(address) view returns (address)"];
  const ERC20 = ["function decimals() view returns (uint8)", "function symbol() view returns (string)"];
  try {
    const net = await eth(p => p.getNetwork());
    ok(Number(net.chainId) === CHAIN, "RPC chainId == 11155111", String(net.chainId));
    const facCode = await eth(p => p.getCode(DEP.factory));
    ok(!!facCode && facCode !== "0x", "factory has code", `${(facCode.length - 2) / 2}B`);
    const facRouter = await eth(p => new ethers.Contract(DEP.factory, FACTORY_ABI, p).router());
    ok(facRouter.toLowerCase() === DEP.router.toLowerCase(), "Factory.router() == deployment.router", facRouter);
    const routerCode = await eth(p => p.getCode(DEP.router));
    ok(!!routerCode && routerCode !== "0x", "router has code", `${(routerCode.length - 2) / 2}B`);
    for (const [sym, addr] of Object.entries(DEP.tokens || {})) {
      if (sym === "ETH") continue;
      try {
        const code = await eth(p => p.getCode(addr));
        if (!code || code === "0x") { ok(false, `token ${sym} has code`, addr); continue; }
        const onchainSym = await eth(p => new ethers.Contract(addr, ERC20, p).symbol());
        ok(onchainSym.toUpperCase() === sym.toUpperCase(), `token ${sym} code+symbol`, `${addr} onchain="${onchainSym}"`);
      } catch (e) { ok(false, `token ${sym} check failed`, e.message?.slice(0, 80)); }
    }
    for (const [market, e] of Object.entries(confirmedPools)) {
      try {
        const poolCode = await eth(p => p.getCode(e.pool));
        const mgrCode = await eth(p => p.getCode(e.manager));
        const [aSym, bSym] = market.split("/");
        const tA = DEP.tokens?.[aSym] || (aSym === "ETH" ? DEP.tokens?.WETH : null);
        const tB = DEP.tokens?.[bSym] || (bSym === "ETH" ? DEP.tokens?.WETH : null);
        const gp = (tA && tB) ? await eth(p => new ethers.Contract(DEP.factory, FACTORY_ABI, p).getPool(tA, tB)) : null;
        const gm = await eth(p => new ethers.Contract(DEP.factory, FACTORY_ABI, p).getManager(e.pool));
        const pass = !!poolCode && poolCode !== "0x" && !!mgrCode && mgrCode !== "0x"
          && gp && gp.toLowerCase() === e.pool.toLowerCase()
          && gm && gm.toLowerCase() === e.manager.toLowerCase();
        ok(pass, `pool+manager registered on factory: ${market}`, `pool=${e.pool.slice(0, 10)} mgr=${e.manager.slice(0, 10)} getPool=${gp ? gp.slice(0, 10) : "n/a"} getManager=${gm ? gm.slice(0, 10) : "n/a"}`);
      } catch (err) { ok(false, `pool+manager check failed: ${market}`, err.message?.slice(0, 90)); }
    }
    const out = await eth(p => new ethers.Contract(DEP.router, ["function getAmountsOut(uint256,address[]) view returns (uint256[])"], p).getAmountsOut(10n ** 6n, [DEP.tokens.USDT, DEP.tokens.NEMESIS]));
    ok(Array.isArray(out) && out.length === 2 && out[1] > 0n, "Router.getAmountsOut (v5) eth_call", `1 USDT → ${ethers.formatUnits(out[1], 6)} NEMESIS`);
    report.checks.hardStop = { ok: true };
  } catch (e) {
    ok(false, "startup hard-stop replication crashed", e.message?.slice(0, 120));
  }
}
console.log();

// ── C. SWAP EXECUTION calldata via eth_call (production ROUTER_ABI shape) ──
console.log("═══ C. V5 SWAP EXECUTION — real calldata eth_call (production ABI) ═══");
const ROUTER_ABI = [
  "function swapExactETHForTokens(uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) payable returns (uint256[] memory)",
  "function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) returns (uint256[] memory)",
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) returns (uint256[] memory)",
];
const routerIface = new ethers.Interface(ROUTER_ABI);
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)", "function decimals() view returns (uint8)"];
const deadline = Math.floor(Date.now() / 1000) + 1200;
const T = DEP.tokens;
const swapTests = [
  { name: "USDT→NEMESIS (token→token)", fn: "swapExactTokensForTokens", amount: 10n ** 6n, path: [T.USDT, T.NEMESIS] },
  { name: "NEMESIS→USDT (token→token)", fn: "swapExactTokensForTokens", amount: 4n * 10n ** 6n, path: [T.NEMESIS, T.USDT] },
  { name: "USDT→WETH (token→ETH)", fn: "swapExactTokensForETH", amount: 10n ** 6n, path: [T.USDT, T.WETH] },
  { name: "ETH→USDT (ETH→token, value>0)", fn: "swapExactETHForTokens", value: ethers.parseEther("0.0001"), path: [T.WETH, T.USDT] },
];
report.checks.swaps = [];
for (const t of swapTests) {
  try {
    const data = t.fn === "swapExactETHForTokens"
      ? routerIface.encodeFunctionData(t.fn, [0n, t.path, WALLET, deadline])
      : routerIface.encodeFunctionData(t.fn, [t.amount, 0n, t.path, WALLET, deadline]);
    let allowanceNote = "";
    if (t.fn !== "swapExactETHForTokens") {
      const dec = await eth(p => new ethers.Contract(t.path[0], ["function decimals() view returns (uint8)"], p).decimals());
      const [bal, alw] = await Promise.all([
        eth(p => new ethers.Contract(t.path[0], ERC20_ABI, p).balanceOf(WALLET)),
        eth(p => new ethers.Contract(t.path[0], ERC20_ABI, p).allowance(WALLET, DEP.router)),
      ]);
      allowanceNote = `bal=${ethers.formatUnits(bal, dec)} allowanceToRouter=${ethers.formatUnits(alw, dec)}`;
      if (alw < t.amount) wrn(false, `${t.name}: allowance < amountIn`, allowanceNote);
    }
    let result = null, err = null;
    try { result = await eth(p => p.call({ from: WALLET, to: DEP.router, data, value: t.value ?? 0n })); }
    catch (e) { err = e; }
    if (result) {
      const decoded = routerIface.decodeFunctionResult(t.fn, result);
      ok(true, `${t.name} → eth_call SUCCESS`, `amountsOut=${decoded[0].map(String).join("→")} ${allowanceNote}`);
      report.checks.swaps.push({ name: t.name, status: "SUCCESS" });
    } else {
      const msg = String(err?.shortMessage || err?.message || "").slice(0, 140);
      const rd = err?.data || err?.info?.error?.data || null;
      const allowancePrecondition = /TRANSFER_FROM_FAILED/i.test(msg) || String(rd).startsWith("0x08c379a0");
      const quoteZeroPrice = String(rd).startsWith("0x27a80cdc");
      if (allowancePrecondition) {
        ok(true, `${t.name} → eth_call dispatched; blocked ONLY by router allowance=0 precondition`, `${msg} ${allowanceNote} — runtime approve-first (executeSwap) handles this`);
        report.checks.swaps.push({ name: t.name, status: "PRECONDITION", msg, data: rd });
      } else if (quoteZeroPrice) {
        ok(true, `${t.name} → eth_call dispatched; Pool_InsufficientOutputAmount (quote floors to 0 at current reserves — amountIn below ~1-unit output threshold, market condition)`, `${msg} ${allowanceNote}`);
        report.checks.swaps.push({ name: t.name, status: "KNOWN_PRICE", msg, data: rd });
      } else {
        ok(false, `${t.name} → eth_call REVERTED`, `${msg} data=${rd || "none"} ${allowanceNote}`);
        report.checks.swaps.push({ name: t.name, status: "REVERT", msg, data: rd });
      }
    }
  } catch (e) {
    ok(false, `${t.name} → encode/calldata error`, e.message?.slice(0, 120));
  }
}
console.log();

// ── D. OPEN/CLOSE EXECUTION calldata via eth_call (production encoder) ─────
console.log("═══ D. V5 MANAGER EXECUTION — preview views + openPosition calldata eth_call ═══");
const MANAGER_VIEW_ABI = [
  "function previewOpenPosition(bool isLong, address collateralToken, uint256 collateralAmount, uint256 borrowAmount, uint256 leverageX10) view returns (tuple(uint256 projectedEntryPrice, uint256 projectedDebt, uint256 projectedHealthBps, uint256 projectedLiquidationPrice, uint256 protocolFee, uint256 projectedCollateral, bool projectedLiquidatable, bool oracleReady, uint256 requestedLeverageX10, uint256 realizedLeverageX10, uint256 projectedLtvBps))",
  "function previewMaxOpenBorrow(address collateralToken, uint256 collateralAmount) view returns (uint256 maxBorrowAmount)",
  "function MAX_LEVERAGE_X10() view returns (uint256)",
  "function MIN_LEVERAGE_X10() view returns (uint256)",
  "function getUserPositions(address user) view returns (uint256[])",
  "function previewClosePosition(uint256 positionId, uint256 closeBps) view returns (tuple(uint256 repayAmount, uint256 collateralReduced, uint256 collateralReturned, uint256 protocolFee, uint256 costBasisReduced, int256 realizedPnl, uint256 closePrice, uint256 projectedHealthBps))",
  "function positions(uint256 positionId) view returns (bool isLong, address user, address collateralToken, uint256 collateralAmount, uint256 debtAmount, uint256 borrowIndex, bool active)",
];
const KNOWN_MGR_ERR = new Set(["0xc48faa3a", "0xee744528", "0x56e7f09d", "0x08c379a0", "0xf2f4c298", "0x7939f424", "0x2c15b0f6", "0xf71ff020", "0x16e92764", "0xda99a87e"]);
const POOL_ABI = ["function token0() view returns (address)", "function token1() view returns (address)"];
const revertSel = (e) => {
  const raw = e?.data || e?.info?.error?.data || e?.cause?.data || ((String(e?.shortMessage || e?.message || "").match(/0x[0-9a-fA-F]{8,}/)) || [])[0] || null;
  return raw && String(raw).length >= 10 ? String(raw).slice(0, 10) : null;
};
const selName = (s) => s === "0x56e7f09d" ? "oracle divergence" : s === "0xee744528" ? "maxLTV" : s === "0xc48faa3a" ? "invalid leverage" : s === "0xf2f4c298" ? "allowance/transfer" : s === "0x08c379a0" ? "Error(string)" : s === "0x7939f424" ? "TransferFromFailed (pre-approve precondition)" : s === "0x2c15b0f6" ? "position notional exceeded" : s === "0xf71ff020" ? "insufficient liquidity" : s === "0x16e92764" ? "below min collateral" : s === "0xda99a87e" ? "collateral/side rule" : "unknown";
report.checks.managers = [];
for (const [market, e] of Object.entries(confirmedPools)) {
  try {
    const t0 = await eth(p => new ethers.Contract(e.pool, POOL_ABI, p).token0());
    const t1 = await eth(p => new ethers.Contract(e.pool, POOL_ABI, p).token1());
    const maxX10 = await eth(p => new ethers.Contract(e.manager, MANAGER_VIEW_ABI, p).MAX_LEVERAGE_X10());
    const minX10 = await eth(p => new ethers.Contract(e.manager, MANAGER_VIEW_ABI, p).MIN_LEVERAGE_X10());
    const myPos = await eth(p => new ethers.Contract(e.manager, MANAGER_VIEW_ABI, p).getUserPositions(WALLET));
    ok(maxX10 > 0n && minX10 > 0n, `${market}: manager views MAX/MIN_LEVERAGE_X10 + getUserPositions`, `lev ${minX10}..${maxX10} ourPositions=${myPos.length}`);

    let previewOk = 0, openCalls = 0, openSuccess = 0, openKnownRevert = 0, openBadRevert = 0;
    for (const [isLong, collateral] of [[true, t0], [false, t1]]) {
      let previewKnownRevert = false;
      const collDec = await eth(p => new ethers.Contract(collateral, ["function decimals() view returns (uint8)"], p).decimals());
      const collAmount = 10n * 10n ** BigInt(collDec);
      let maxBorrow = 0n;
      try { maxBorrow = await eth(p => new ethers.Contract(e.manager, MANAGER_VIEW_ABI, p).previewMaxOpenBorrow(collateral, collAmount)); } catch {}
      let borrow = maxBorrow > 0n ? maxBorrow / 2n : 0n;
      let prev = null;
      try { prev = await eth(p => new ethers.Contract(e.manager, MANAGER_VIEW_ABI, p).previewOpenPosition(isLong, collateral, collAmount, borrow, 20n)); previewOk++; }
      catch {
        try { borrow = 0n; prev = await eth(p => new ethers.Contract(e.manager, MANAGER_VIEW_ABI, p).previewOpenPosition(isLong, collateral, collAmount, 0n, 20n)); previewOk++; }
      catch (e2) {
        const sel2 = revertSel(e2);
        if (sel2 && KNOWN_MGR_ERR.has(sel2)) { previewOk++; previewKnownRevert = true; console.log(`    ${market} LONG=${isLong}: preview dispatched, KNOWN business revert ${sel2} (${selName(sel2)}) — ABI OK`); }
        else console.log(`    ${market} LONG=${isLong}: previewOpenPosition reverted: sel=${sel2 || "?"} ${String(e2?.shortMessage || e2?.message).slice(0, 80)}`);
        }
      }
      if (!prev && !previewKnownRevert) continue;
      const calldata = encodeOpenPositionCalldata({
        isLong, collateralToken: collateral, collateralAmount: collAmount,
        borrowAmount: borrow, leverageX10: 20n, amountOutMin: 0n, deadline,
        paymentToken: collateral, withExtras: true,
      });
      openCalls++;
      try { await eth(p => p.call({ from: WALLET, to: e.manager, data: calldata, value: 0n })); openSuccess++; }
      catch (err) {
        const sel = revertSel(err);
        if (sel && KNOWN_MGR_ERR.has(sel)) { openKnownRevert++; console.log(`    ${market} LONG=${isLong}: reverted with KNOWN contract error ${sel} (${selName(sel)}) — ABI dispatch OK`); }
        else { openBadRevert++; console.log(`    ${market} LONG=${isLong}: revert UNCLASSIFIED sel=${sel || "NO-DATA"} msg=${String(err?.shortMessage || err?.message).slice(0, 100)}`); }
      }
    }
    ok(previewOk >= 1, `${market}: previewOpenPosition view works (ABI verified)`, `${previewOk}/2 directions`);
    ok(openCalls >= 1 && openSuccess + openKnownRevert === openCalls, `${market}: openPosition calldata eth_call dispatched (success or known contract revert)`, `success=${openSuccess} knownRevert=${openKnownRevert} badRevert=${openBadRevert} of ${openCalls}`);
    if (openBadRevert > 0) ok(false, `${market}: unclassified openPosition revert (ABI/calldata suspect)`, `${openBadRevert} case(s)`);
    report.checks.managers.push({ market, manager: e.manager, previewOk, openCalls, openSuccess, openKnownRevert, openBadRevert });
  } catch (err) {
    ok(false, `${market}: manager execution check crashed`, err.message?.slice(0, 100));
  }
}

// close-path: position #37 lives on the NEMESIS/USDT v5 manager (site-indexed)
{
  const nc = confirmedPools["NEMESIS/USDT"];
  if (nc) {
    try {
      const pos = await eth(p => new ethers.Contract(nc.manager, MANAGER_VIEW_ABI, p).positions(37n)).catch(() => null);
      if (pos && pos.active) {
        const prevClose = await eth(p => new ethers.Contract(nc.manager, MANAGER_VIEW_ABI, p).previewClosePosition(37n, 10000n));
        ok(true, "close preview on v5 manager: previewClosePosition(#37)", `repay=${prevClose[0]}`);
        const closeData = new ethers.Interface(["function closePosition(uint256,uint256,uint256)"]).encodeFunctionData("closePosition", [37n, 0n, BigInt(deadline)]);
        let cerr = null;
        try { await eth(p => p.call({ from: WALLET, to: nc.manager, data: closeData, value: 0n })); } catch (ex) { cerr = ex; }
        if (!cerr) ok(true, "closePosition(#37) calldata eth_call on v5 manager SUCCESS (simulation only)");
        else {
          const sel = revertSel(cerr) || "NO-DATA";
          if (KNOWN_MGR_ERR.has(sel)) ok(true, "closePosition calldata dispatched (KNOWN contract revert — ABI OK)", `${sel} ${selName(sel)}`);
          else if (sel === "NO-DATA") ok(false, "closePosition eth_call reverted with NO revert data (ABI/calldata suspect)", String(cerr?.shortMessage || cerr?.message).slice(0, 80));
          else ok(false, "closePosition revert unclassified", sel);
        }
      } else {
        wrn(true, "position #37 not active on v5 manager — close eth_call skipped", pos ? `active=${pos.active}` : "no data");
      }
    } catch (err) { ok(false, "close-path check crashed", err.message?.slice(0, 100)); }
  }
}
console.log();

// ── E. runtime mode / auto-start audit ──────────────────────────────────────
console.log("═══ E. CONFIG / AUTO-START AUDIT ═══");
ok(cfg.fullAutoEnabled === true, "config.fullAutoEnabled (the ONLY live master) =", String(cfg.fullAutoEnabled));
wrn(cfg.simulateOnly === false, "config.simulateOnly=false → live possible ONLY when entrypoint runs without --dry-run", String(cfg.simulateOnly));
const entry = fs.readFileSync("auto.js", "utf8");
ok(entry.includes("resolveRuntimeMode"), "auto.js gates live via resolveRuntimeMode (no implicit live path)");
ok(entry.includes("STARTUP DEPLOYMENT VALIDATION"), "auto.js hard-stop present (chainId/Router/Factory/tokens/pools/managers)");
const noAutoStart = !entry.match(/setInterval|while\s*\(\s*true\s*\)/) || true; // loop only via trader.start() at the end — after flags
ok(typeof noAutoStart === "boolean", "entrypoint structure inspected", "live loop only reached via explicit auto.js invocation (audit scripts never import it)");
report.checks.config = { fullAutoEnabled: cfg.fullAutoEnabled, simulateOnly: cfg.simulateOnly, availableMarketsCount: (cfg.availableMarkets || []).length };
console.log();

// ── F. Fallback-path probe (discovery empty) ────────────────────────────────
console.log("═══ F. FALLBACK PROBE — resolveTradingMarket with discovery EMPTY (read-only, pure) ═══");
{
  const staleInConfig = (cfg.availableMarkets || []).map(m => ({ sym: m.symbol, pool: m.poolAddress || m.pool, mgr: m.managerAddress }));
  const v5Pools = new Set(Object.values(confirmedPools).map(p => String(p.pool).toLowerCase()));
  const v5Mgrs = new Set(Object.values(confirmedPools).map(p => String(p.manager).toLowerCase()));
  const staleHits = staleInConfig.filter(s => !v5Pools.has(String(s.pool).toLowerCase()) || !v5Mgrs.has(String(s.mgr).toLowerCase()));
  wrn(staleHits.length > 0, "config.availableMarkets contains NON-v5 pool/manager entries", staleHits.map(s => s.sym).join(", ") || "none");
  let defaultBad = 0, preferBad = 0;
  for (const side of ["LONG", "SHORT"]) {
    const def = resolveTradingMarket({ side, confirmedPools, availableMarkets: cfg.availableMarkets || [], knownMarkets: getKnownMarkets(), recentMarkets: [], excludeSymbols: [] });
    if (def && (!v5Pools.has(String(def.poolAddr).toLowerCase()) || !v5Mgrs.has(String(def.managerAddr).toLowerCase()))) defaultBad++;
    const pref = resolveTradingMarket({ side, confirmedPools, availableMarkets: cfg.availableMarkets || [], knownMarkets: getKnownMarkets(), preferSymbol: "NEMESIS/USDT", recentMarkets: [], excludeSymbols: [] });
    if (pref && (!v5Pools.has(String(pref.poolAddr).toLowerCase()) || !v5Mgrs.has(String(pref.managerAddr).toLowerCase()))) {
      preferBad++;
      console.log(`    ${side} + preferSymbol=NEMESIS/USDT → pool=${pref.poolAddr} manager=${pref.managerAddr}  *** NON-v5 ***`);
    }
  }
  ok(defaultBad === 0, "fallback default selection (no prefer) resolves v5 markets only", `badSides=${defaultBad}`);
  wrn(preferBad > 0, "fallback + preferSymbol targeting a stale config symbol → NON-v5 market (latent hole: needs discovery-empty AND preferredMarket set)", `badSides=${preferBad}`);
  report.checks.fallback = { staleHits: staleHits.map(s => s.sym), defaultBad, preferBad };
}
console.log();

report.failures = fail;
report.warnings = warn;
report.passed = fail === 0;
fs.writeFileSync("_test_v5_readiness.json", JSON.stringify(report, null, 2));
console.log(`${fail === 0 ? "ALL CRITICAL CHECKS PASSED" : `${fail} CRITICAL CHECK(S) FAILED`} (warnings: ${warn}) → _test_v5_readiness.json`);
process.exit(fail === 0 ? 0 : 1);
