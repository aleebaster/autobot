// ═══════════════════════════════════════════════════════════════════════════
//  SWAP REASON CODES + DIAGNOSTICS — offline suite (0 network, 0 transactions)
//
//  Verifies the rotation diagnostics contract end-to-end:
//    • every skip/fail carries { state, recoverable, recommendedAction }
//    • approve-FIRST ordering: allowance is checked BEFORE the router preflight,
//      the approve is sent ONCE, awaited, allowance re-READ, then the swap
//    • dry mode with missing allowance → WAITING_FOR_ALLOWANCE (never a fake
//      PREFLIGHT_REVERT), nothing sent
//    • zero balance → WAITING_FOR_INVENTORY, nothing sent
//    • size-driven economy gates → shrink-and-retry (thresholds unchanged)
//    • RATE_DEVIATION via the SYMMETRIC ROUND-TRIP (degenerate reverse quote
//      blocks the swap; a missing reverse quote → RATE_DEVIATION_UNVERIFIED)
//    • one skip never blocks the rest of the queue
//    • maintenance summary aggregates skippedByReason / pendingByState
//
//  HARNESS: a JsonRpcProvider subclass answers every eth_call locally from an
//  in-memory world (tokens, balances, allowances, CPMM pools priced with the
//  real legAmountOut formula). eth_sendRawTransaction is rejected by
//  construction — the TX guard from _test_state_isolation.mjs is the second
//  line of defence. Live-mode scenarios use a FAKE txManager that records
//  txType order and settles balance deltas inside eth_estimateGas, so no
//  ethers signing path is ever exercised.
// ═══════════════════════════════════════════════════════════════════════════

import "./_test_state_isolation.mjs"; // state redirect + default-deny live-TX guard
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { ethers } from "ethers";

const REPO = path.dirname(fileURLToPath(import.meta.url));
const SCRATCH_DIR = path.join(REPO, ".reason-codes-test-state");
fs.mkdirSync(SCRATCH_DIR, { recursive: true });
const SCRATCH_STATE = path.join(SCRATCH_DIR, "state.json");
fs.writeFileSync(SCRATCH_STATE, JSON.stringify({}));
process.env.NEMESIS_STATE_FILE = SCRATCH_STATE; // BEFORE autoTrader import

const { AutoTrader, applySlippage } = await import("./autoTrader.js");
const { SWAP_DIRECTION_STATES, swapReasonMeta, classifySwapRevert, runSwapRotationQueue, normalizeSwapConfig } = await import("./swapEngine.js");
const { poolShareCapAmountIn, shrinkToFitEconomy, checkRateConsistency, legAmountOut } = await import("./swapEconomics.js");
const { getRouterAddress, getFactoryAddress } = await import("./deployments/index.js");

const ROUTER = getRouterAddress();
const FACTORY = getFactoryAddress();

// ─── world addresses (pure mocks, not deployment tokens) ────────────────────
const PK = "0x" + "11".repeat(32);
const wallet = new ethers.Wallet(PK);
const WALLET = wallet.address.toLowerCase();
const A = ("0x" + "aa".repeat(20)).toLowerCase();
const B = ("0x" + "bb".repeat(20)).toLowerCase();
const C = ("0x" + "cc".repeat(20)).toLowerCase(); // 6-decimal token
const POOL_AB = ("0x" + "d1".repeat(20)).toLowerCase();
const POOL_BC = ("0x" + "d2".repeat(20)).toLowerCase();

const ERC20_IFACE = new ethers.Interface([
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
]);
const ROUTER_IFACE = new ethers.Interface([
  "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[])",
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[])",
]);
const FACTORY_IFACE = new ethers.Interface(["function getPool(address,address) view returns (address)"]);
const POOL_IFACE = new ethers.Interface([
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1)",
  "function token0() view returns (address)",
  "function swapFeeBps() view returns (uint256)",
]);

const pairKey = (x, y) => [String(x).toLowerCase(), String(y).toLowerCase()].sort().join(">");
const E18 = 10n ** 18n;
const E6 = 10n ** 6n;

/** Build an in-memory chain world. */
function makeWorld() {
  return {
    ethBalance: ethers.parseEther("5"),
    tokenByAddr: {
      [A]: { symbol: "AA", decimals: 18 },
      [B]: { symbol: "BB", decimals: 18 },
      [C]: { symbol: "CC", decimals: 6 },
    },
    balances: { [WALLET]: { [A]: 0n, [B]: 0n, [C]: 0n } },
    allowances: { [WALLET]: {} }, // token -> spender -> amount
    poolsByKey: {},
    poolsByAddr: {},
    code: {},
    estimateSwapsApplied: 0,
    corruptReverse: null, // "inflate" | "revert"
    corruptPair: null,    // [fwdFrom, fwdTo] — reverse of this pair is corrupted
  };
}

function addPool(w, { addr, token0, token1, reserve0, reserve1, feeBps = 100n }) {
  const pool = { addr, token0: token0.toLowerCase(), token1: token1.toLowerCase(), reserve0, reserve1, feeBps };
  w.poolsByKey[pairKey(token0, token1)] = pool;
  w.poolsByAddr[addr] = pool;
  w.code[addr] = "0x01";
  return pool;
}

function setBal(w, token, raw) { w.balances[WALLET][token.toLowerCase()] = BigInt(raw); }
function setAllow(w, token, raw) {
  const t = token.toLowerCase();
  w.allowances[WALLET][t] = { ...(w.allowances[WALLET][t] || {}), [ROUTER.toLowerCase()]: BigInt(raw) };
}

/** Honest CPMM multi-hop quote over the world's pools (reverts like a router). */
function amountsOut(w, amountIn, pathArr) {
  const amounts = [BigInt(amountIn)];
  let cur = BigInt(amountIn);
  for (let i = 0; i < pathArr.length - 1; i++) {
    const pool = w.poolsByKey[pairKey(pathArr[i], pathArr[i + 1])];
    if (!pool) throw new Error("execution reverted: NO_POOL");
    const inIs0 = String(pathArr[i]).toLowerCase() === pool.token0;
    const out = legAmountOut({
      amountIn: cur,
      reserveIn: inIs0 ? pool.reserve0 : pool.reserve1,
      reserveOut: inIs0 ? pool.reserve1 : pool.reserve0,
      swapFeeBps: pool.feeBps,
    });
    if (!(out > 0n)) throw new Error("execution reverted: INSUFFICIENT_LIQUIDITY");
    amounts.push(out);
    cur = out;
  }
  return amounts;
}

class FakeProvider extends ethers.JsonRpcProvider {
  constructor(w) {
    super("http://127.0.0.1:9", 11155111, { staticNetwork: true });
    this.world = w;
  }
  async getBalance() { return this.world.ethBalance; }
  async getCode(addr) { return this.world.code[String(addr).toLowerCase()] || "0x"; }
  async getFeeData() {
    return { gasPrice: 1_000_000_000n, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n };
  }
  async send(method, params) {
    const w = this.world;
    switch (method) {
      case "eth_chainId": return "0xaa36a7";
      case "eth_blockNumber": return "0x10";
      case "eth_getTransactionCount": return "0x1";
      case "eth_maxPriorityFeePerGas": return "0x1";
      case "eth_gasPrice": return "0x3b9aca00";
      case "eth_estimateGas": return this._estimateGas(params[0]);
      case "eth_call": return this._ethCall(params[0]);
      case "eth_sendRawTransaction": throw new Error("REAL-TX-BLOCKED-BY-TEST");
      default: return null;
    }
  }
  _estimateGas(tx) {
    const w = this.world;
    // The fake chain "settles" a swap exactly where a real one would: at gas
    // estimation, AFTER preflight passed and BEFORE the broadcast.
    try {
      if (String(tx?.to || "").toLowerCase() === ROUTER.toLowerCase() && tx.data && tx.data !== "0x") {
        const p = ROUTER_IFACE.parseTransaction({ data: tx.data });
        if (p?.name === "swapExactTokensForTokens") {
          const amountIn = BigInt(p.args[0]);
          const pathArr = [...p.args[2]]; // (amountIn, amountOutMin, path, to, deadline)
          const amounts = amountsOut(w, amountIn, pathArr);
          const out = amounts[amounts.length - 1];
          const from = String(pathArr[0]).toLowerCase();
          const to = String(pathArr[pathArr.length - 1]).toLowerCase();
          w.balances[WALLET][from] = (w.balances[WALLET][from] ?? 0n) - amountIn;
          w.balances[WALLET][to] = (w.balances[WALLET][to] ?? 0n) + out;
          w.estimateSwapsApplied++;
        }
      }
    } catch (e) { /* estimation revert */ throw new Error("execution reverted: ESTIMATE: " + (e?.message || e)); }
    return "0x30d40";
  }
  _ethCall(tx) {
    const w = this.world;
    const to = String(tx?.to || "").toLowerCase();
    const data = tx?.data || "0x";
    const parse = (iface) => { try { return iface.parseTransaction({ data }); } catch { return null; } };

    const tok = w.tokenByAddr[to];
    if (tok) {
      const p = parse(ERC20_IFACE);
      if (!p) return "0x";
      if (p.name === "decimals") return ERC20_IFACE.encodeFunctionResult("decimals", [tok.decimals]);
      if (p.name === "symbol") return ERC20_IFACE.encodeFunctionResult("symbol", [tok.symbol]);
      if (p.name === "balanceOf") {
        const owner = String(p.args[0]).toLowerCase();
        return ERC20_IFACE.encodeFunctionResult("balanceOf", [w.balances[owner]?.[to] ?? 0n]);
      }
      if (p.name === "allowance") {
        const owner = String(p.args[0]).toLowerCase();
        const spender = String(p.args[1]).toLowerCase();
        return ERC20_IFACE.encodeFunctionResult("allowance", [w.allowances[owner]?.[to]?.[spender] ?? 0n]);
      }
    }
    if (to === FACTORY.toLowerCase()) {
      const p = parse(FACTORY_IFACE);
      if (p?.name === "getPool") {
        const pool = w.poolsByKey[pairKey(p.args[0], p.args[1])];
        return FACTORY_IFACE.encodeFunctionResult("getPool", [pool ? pool.addr : ethers.ZeroAddress]);
      }
    }
    const pool = w.poolsByAddr[to];
    if (pool) {
      const p = parse(POOL_IFACE);
      if (p?.name === "getReserves") return POOL_IFACE.encodeFunctionResult("getReserves", [pool.reserve0, pool.reserve1]);
      if (p?.name === "token0") return POOL_IFACE.encodeFunctionResult("token0", [pool.token0]);
      if (p?.name === "swapFeeBps") return POOL_IFACE.encodeFunctionResult("swapFeeBps", [pool.feeBps]);
    }
    if (to === ROUTER.toLowerCase()) {
      const p = parse(ROUTER_IFACE);
      if (p?.name === "getAmountsOut") {
        const amountIn = BigInt(p.args[0]);
        const pathArr = [...p.args[1]];
        const isCorruptReverse = w.corruptPair && pathArr.length === 2
          && String(pathArr[0]).toLowerCase() === w.corruptPair[1]
          && String(pathArr[1]).toLowerCase() === w.corruptPair[0];
        if (isCorruptReverse && w.corruptReverse === "revert") {
          throw new Error("execution reverted: MOCK_REVERSE_UNAVAILABLE");
        }
        const amounts = amountsOut(w, amountIn, pathArr);
        if (isCorruptReverse && w.corruptReverse === "inflate") {
          amounts[amounts.length - 1] = amounts[amounts.length - 1] * 50n;
        }
        return ROUTER_IFACE.encodeFunctionResult("getAmountsOut", [amounts]);
      }
      if (p?.name === "swapExactTokensForTokens") {
        return "0x"; // preflight success
      }
    }
    return "0x";
  }
}

/** Fake txManager: records txType order; never signs; returns a settled receipt.
 *  An approve "lands" by setting MaxUint256 for every world token (the router
 *  allowance the re-check then reads). */
function makeTxManager(calls, w) {
  return {
    journal: null,
    async sendAndWait({ txType }) {
      calls.push(txType);
      if (txType === "SWAP-APPROVE" && w) {
        for (const tok of Object.keys(w.tokenByAddr)) setAllow(w, tok, ethers.MaxUint256);
      }
      return { status: 1, hash: "0x" + "ab".repeat(32), receipt: { gasUsed: 90_000n, blockNumber: 1 } };
    },
  };
}

const baseCfg = () => ({
  dryRun: true,
  deadlineSeconds: 600,
  ethGuard: { MIN_ETH_GAS_RESERVE: "0.001" },
  autoSwap: {
    enabled: true, swapMinPercent: 15, swapMaxPercent: 15,
    minSwapAmountAA: "0.5", maxSwapAmountAA: "1000",
    minSwapAmountBB: "0.5", maxSwapAmountBB: "1000",
    minSwapAmountCC: "1", maxSwapAmountCC: "1000",
    reserveByToken: { AA: "0", BB: "0", CC: "0" },
  },
  swap: {
    enabled: true, slippageBps: 50, maxGasGwei: 0, maxSwapsPerCycle: 10,
    rotatePairs: true, reverseDirections: true,
    minIntervalMs: 0, maxIntervalMs: 0, maxConsecutiveFailures: 3,
    routeBackoffMs: 0, routeBackoffMaxMs: 0,
  },
  swapEconomy: { maxPoolShareBps: 100, maxPriceImpactBps: 200, maxRateDeviation: 0.05, maxLegs: 2 },
});

const routesFor = (w) => ([
  { valid: true, fromSym: "AA", toSym: "BB", fromAddr: A, toAddr: B, path: [A, B], type: "direct", pool: POOL_AB },
  { valid: true, fromSym: "BB", toSym: "AA", fromAddr: B, toAddr: A, path: [B, A], type: "direct", pool: POOL_AB },
  { valid: true, fromSym: "BB", toSym: "CC", fromAddr: B, toAddr: C, path: [B, C], type: "direct", pool: POOL_BC },
  { valid: true, fromSym: "CC", toSym: "BB", fromAddr: C, toAddr: B, path: [C, B], type: "direct", pool: POOL_BC },
]);

function makeTrader(w, { dryRun = true, cfgOverrides = {} } = {}) {
  const provider = new FakeProvider(w);
  const walletConnected = new ethers.Wallet(PK, provider);
  const t = new AutoTrader({ config: { ...baseCfg(), dryRun, ...cfgOverrides } });
  const calls = [];
  t.txManager = makeTxManager(calls, w);
  t.ensureMarkets = async () => t.markets;
  t.getRuntime = () => ({ provider, wallet: walletConnected });
  t.tokenList = [
    { symbol: "AA", address: A, decimals: 18 },
    { symbol: "BB", address: B, decimals: 18 },
    { symbol: "CC", address: C, decimals: 6 },
  ];
  t.routes = routesFor(w);
  t._testLogs = [];
  t.log = (m) => { t._testLogs.push(String(m)); }; // quiet unless asserted
  t._testCalls = calls;
  t._testProvider = provider;
  t._testWallet = walletConnected;
  return t;
}

function ctxFor(t) {
  const cfg = normalizeSwapConfig(t.config);
  const { decimalsMap } = t._swapDirections({});
  return {
    cfg, provider: t._testProvider, wallet: t._testWallet, walletAddr: wallet.address, decimalsMap,
    dryRun: !!t.config.dryRun, phase: "TEST ", slippageBps: BigInt(cfg.slippageBps),
  };
}

const dirAB = { from: "AA", to: "BB", fromAddr: A, toAddr: B, path: [A, B], type: "direct", pool: POOL_AB, key: "AA>BB" };
const dirBA = { from: "BB", to: "AA", fromAddr: B, toAddr: A, path: [B, A], type: "direct", pool: POOL_AB, key: "BB>AA" };

const results = [];
function report(n, name, ok, detail = "") {
  results.push({ n, name, ok: !!ok, detail });
  console.log((ok ? "PASS  [" : "FAIL  [") + String(n).padStart(2, "0") + "] " + name + (detail ? " — " + detail : ""));
  return !!ok;
}

// ═══════════════════════════════════════════════════════════════════════════
// UNITS — reason meta + revert classification + shrink math (no provider)
// ═══════════════════════════════════════════════════════════════════════════

{
  const checks = [
    ["INSUFFICIENT_BALANCE", SWAP_DIRECTION_STATES.WAITING_FOR_INVENTORY, true],
    ["ALLOWANCE_MISSING", SWAP_DIRECTION_STATES.WAITING_FOR_ALLOWANCE, true],
    ["WAITING_FOR_ALLOWANCE", SWAP_DIRECTION_STATES.WAITING_FOR_ALLOWANCE, true],
    ["ZERO_AMOUNT_OUT_MIN", SWAP_DIRECTION_STATES.WAITING_FOR_PRICE, true],
    ["RATE_DEVIATION", SWAP_DIRECTION_STATES.WAITING_FOR_PRICE, false],
    ["RATE_DEVIATION_UNVERIFIED", SWAP_DIRECTION_STATES.WAITING_FOR_PRICE, false],
    ["APPROVAL_REQUIRED", SWAP_DIRECTION_STATES.WAITING_FOR_ALLOWANCE, false],
    ["INSUFFICIENT_ALLOWANCE", SWAP_DIRECTION_STATES.FAILED, false],
  ];
  let ok = true; const bad = [];
  for (const [code, state, rec] of checks) {
    const m = swapReasonMeta(code);
    if (m.state !== state || m.recoverable !== rec || !m.recommendedAction) { ok = false; bad.push(code); }
  }
  const unk = swapReasonMeta("NOT_A_CODE");
  if (unk.state !== SWAP_DIRECTION_STATES.FAILED || unk.recoverable !== false) ok = false;
  report(1, "swapReasonMeta maps every code → state/recoverable/action", ok, bad.length ? `bad: ${bad.join(",")}` : `${checks.length} codes + unknown fallback`);
}

{
  const c1 = classifySwapRevert("execution reverted: TransferHelper: TRANSFER_FROM_FAILED");
  const c2 = classifySwapRevert("execution reverted: OMMLibrary: INSUFFICIENT_INPUT_AMOUNT");
  const c3 = classifySwapRevert("execution reverted: something else entirely");
  report(2, "classifySwapRevert: TRANSFER_FROM_FAILED→ALLOWANCE_MISSING, INSUFFICIENT_INPUT_AMOUNT→WAITING_FOR_LIQUIDITY, else null",
    c1?.code === "ALLOWANCE_MISSING" && c2?.code === "WAITING_FOR_LIQUIDITY" && c3 === null,
    `got ${c1?.code}/${c2?.code}/${c3}`);
}

{
  const cap = poolShareCapAmountIn({ reserveIn: 1000n * E18, maxPoolShareBps: 100 });
  const zero = poolShareCapAmountIn({ reserveIn: 0n, maxPoolShareBps: 100 });
  const cap6 = poolShareCapAmountIn({ reserveIn: 5000n * E6, maxPoolShareBps: 250 }); // 2.5% of 5000 = 125
  report(3, "poolShareCapAmountIn: reserve×bps/10000 exact bigint",
    cap === 10n * E18 && zero === 0n && cap6 === 125n * E6,
    `cap18=${cap} cap0=${zero} cap6=${cap6}`);
}

{
  // size-driven: fails at 30e18 (share 3%), passes at 7.5e18 (share 0.75%)
  const probe = async (amt) => {
    const share = Number((amt * 10000n) / (1000n * E18)) / 10000;
    return share > 0.01
      ? { ok: false, gates: ["POOL_SHARE_HIGH"], legs: [] }
      : { ok: true, gates: [], legs: [] };
  };
  const r1 = await shrinkToFitEconomy({ amountIn: 30n * E18, minAmountIn: E18 / 2n, probe });
  // non-size gate: stops immediately
  const r2 = await shrinkToFitEconomy({ amountIn: 30n * E18, minAmountIn: E18 / 2n, probe: async () => ({ ok: false, gates: ["ZERO_RESERVE"], legs: [] }) });
  // floor already at the failing size: no halving below the min
  const r3 = await shrinkToFitEconomy({ amountIn: 30n * E18, minAmountIn: 30n * E18, probe });
  report(4, "shrinkToFitEconomy: halve on size gates, stop on non-size gates, stop at min floor",
    r1.ok === true && r1.amountIn === 7_500_000_000_000_000_000n && r1.halvings === 2
    && r2.ok === false && r2.halvings === 0 && /not size-driven/.test(r2.reason)
    && r3.ok === false && /min amount reached/.test(r3.reason),
    `r1=${r1.amountIn}@${r1.halvings} r2=${r2.reason} r3=${r3.reason}`);
}

{
  // honest round-trip product ≈ (1−fee)^2 must pass; degenerate 162× must fail
  const honest = checkRateConsistency({ rateAB: 2.0, rateBA: 0.49005, legs: 1, feeFrac: 0.01, maxDeviation: 0.05 });
  const degenerate = checkRateConsistency({ rateAB: 12.7, rateBA: 12.75, legs: 1, feeFrac: 0.01, maxDeviation: 0.05 });
  report(5, "checkRateConsistency: honest product≈0.9801 passes, degenerate 162× fails",
    honest.ok === true && degenerate.ok === false,
    `honest dev=${honest.deviation?.toFixed?.(5)} degen product=${degenerate.product?.toFixed?.(1)}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// INTEGRATION — full _attemptSwapDirection over the fake world
// ═══════════════════════════════════════════════════════════════════════════

{ // [6] zero balance → WAITING_FOR_INVENTORY, nothing sent
  const w = makeWorld();
  addPool(w, { addr: POOL_AB, token0: A, token1: B, reserve0: 1000n * E18, reserve1: 5000n * E18 });
  setBal(w, A, 200n * E18); setBal(w, B, 0n);
  setAllow(w, A, ethers.MaxUint256);
  const t = makeTrader(w, { dryRun: true });
  const r = await t._attemptSwapDirection(dirBA, ctxFor(t));
  report(6, "zero balance → skip INSUFFICIENT_BALANCE state=WAITING_FOR_INVENTORY, recoverable, no tx",
    r.status === "skip" && r.code === "INSUFFICIENT_BALANCE"
    && r.state === SWAP_DIRECTION_STATES.WAITING_FOR_INVENTORY
    && r.recoverable === true && !!r.recommendedAction
    && t._testCalls.length === 0 && w.estimateSwapsApplied === 0,
    `status=${r.status} code=${r.code} state=${r.state} calls=${t._testCalls.length}`);
}

{ // [7] dry + missing allowance → WAITING_FOR_ALLOWANCE BEFORE preflight, nothing sent
  const w = makeWorld();
  addPool(w, { addr: POOL_AB, token0: A, token1: B, reserve0: 1000n * E18, reserve1: 5000n * E18 });
  setBal(w, A, 200n * E18);
  setAllow(w, A, 0n);
  const t = makeTrader(w, { dryRun: true });
  const r = await t._attemptSwapDirection(dirAB, ctxFor(t));
  report(7, "dry + allowance=0 → WAITING_FOR_ALLOWANCE (approve would run live), nothing sent",
    r.status === "skip" && r.code === "WAITING_FOR_ALLOWANCE"
    && r.state === SWAP_DIRECTION_STATES.WAITING_FOR_ALLOWANCE
    && r.recoverable === true
    && t._testCalls.length === 0 && w.estimateSwapsApplied === 0,
    `code=${r.code} state=${r.state}`);
}

{ // [8] LIVE: approve-first order, single approve, re-check, swap confirmed
  const w = makeWorld();
  addPool(w, { addr: POOL_AB, token0: A, token1: B, reserve0: 1000n * E18, reserve1: 5000n * E18 });
  setBal(w, A, 200n * E18); // 15% = 30e18 > 1% cap 10e18 → shrink applies
  setAllow(w, A, 0n);
  const t = makeTrader(w, { dryRun: false });
  const cyc = await t.runSwapMaintenanceCycle({ force: true, from: "AA", to: "BB", maxSwaps: 1 });
  const r = cyc.results[0];
  const diag = t._testLogs.filter(l => /SKIP|DIAG|approve|APPROVE|revert|MISMATCH|VERIFY/i.test(l)).slice(-6).join(" | ");
  report(8, "LIVE approve-first: [SWAP-APPROVE, SWAP] order, allowance re-checked, shrunk size, CONFIRMED",
    r?.status === "ok" && r?.state === SWAP_DIRECTION_STATES.CONFIRMED
    && t._testCalls[0] === "SWAP-APPROVE" && t._testCalls[1] === "SWAP" && t._testCalls.length === 2
    && !!r?.approveTxHash && r?.shrunk && r?.amountIn === String(10n * E18)
    && w.estimateSwapsApplied === 1 && cyc.verified === 1,
    `calls=${t._testCalls.join(",")} amountIn=${r?.amountIn} shrunk=${r?.shrunk ? r.shrunk.from + "→" + r.shrunk.to : "-"} verified=${cyc.verified} status=${r?.status} code=${r?.code} reason=${r?.reason} logs=[${diag}]`);
}

{ // [9] repeat cycle: MaxUint allowance now covers → NO second approve
  const w = makeWorld();
  addPool(w, { addr: POOL_AB, token0: A, token1: B, reserve0: 1000n * E18, reserve1: 5000n * E18 });
  setBal(w, A, 200n * E18);
  setAllow(w, A, ethers.MaxUint256);
  const t = makeTrader(w, { dryRun: false });
  const cyc = await t.runSwapMaintenanceCycle({ force: true, from: "AA", to: "BB", maxSwaps: 1 });
  const r = cyc.results[0];
  const diag = t._testLogs.filter(l => /SKIP|DIAG|approve|APPROVE|revert|MISMATCH|VERIFY|GAS/i.test(l)).slice(-6).join(" | ");
  report(9, "allowance already sufficient → exactly one tx ([SWAP]), no approve, CONFIRMED",
    r?.status === "ok" && t._testCalls.length === 1 && t._testCalls[0] === "SWAP"
    && !r?.approveTxHash && w.estimateSwapsApplied === 1,
    `calls=${t._testCalls.join(",")} approveTxHash=${r?.approveTxHash} status=${r?.status} code=${r?.code} reason=${r?.reason} logs=[${diag}]`);
}

{ // [10] size-driven gates shrink in dry mode → EXECUTABLE with the capped amount
  const w = makeWorld();
  addPool(w, { addr: POOL_AB, token0: A, token1: B, reserve0: 1000n * E18, reserve1: 5000n * E18 });
  setBal(w, A, 200n * E18); // 30e18 sized → share 3% > 1% → shrink to cap 10e18
  setAllow(w, A, ethers.MaxUint256);
  const t = makeTrader(w, { dryRun: true });
  const r = await t._attemptSwapDirection(dirAB, ctxFor(t));
  report(10, "POOL_SHARE_HIGH shrinks to the 1% cap → dry EXECUTABLE, thresholds unchanged",
    r.status === "dry" && r.state === SWAP_DIRECTION_STATES.EXECUTABLE
    && r.amountIn === String(10n * E18) && r.shrunk && r.shrunk.from !== r.shrunk.to,
    `status=${r.status} amountIn=${r.amountIn} shrunk=${r.shrunk ? r.shrunk.from + "→" + r.shrunk.to : "-"}`);
}

{ // [11] degenerate reverse quote → RATE_DEVIATION, swap blocked, nothing sent
  const w = makeWorld();
  addPool(w, { addr: POOL_AB, token0: A, token1: B, reserve0: 1000n * E18, reserve1: 5000n * E18 });
  setBal(w, A, 50n * E18);
  setAllow(w, A, ethers.MaxUint256);
  w.corruptPair = [A, B];
  w.corruptReverse = "inflate"; // reverse of A→B quotes 50× reality
  const t = makeTrader(w, { dryRun: true });
  const r = await t._attemptSwapDirection(dirAB, ctxFor(t));
  report(11, "round-trip product 49× (honest≈0.98) → RATE_DEVIATION, blocked, 0 tx",
    r.status === "skip" && r.code === "RATE_DEVIATION"
    && r.state === SWAP_DIRECTION_STATES.WAITING_FOR_PRICE
    && t._testCalls.length === 0 && w.estimateSwapsApplied === 0,
    `code=${r.code} state=${r.state}`);
}

{ // [12] reverse quote unavailable → RATE_DEVIATION_UNVERIFIED (explicit, not silent)
  const w = makeWorld();
  addPool(w, { addr: POOL_AB, token0: A, token1: B, reserve0: 1000n * E18, reserve1: 5000n * E18 });
  setBal(w, A, 50n * E18);
  setAllow(w, A, ethers.MaxUint256);
  w.corruptPair = [A, B];
  w.corruptReverse = "revert";
  const t = makeTrader(w, { dryRun: true });
  const r = await t._attemptSwapDirection(dirAB, ctxFor(t));
  report(12, "missing reverse quote → RATE_DEVIATION_UNVERIFIED (explicit block, not a silent pass)",
    r.status === "skip" && r.code === "RATE_DEVIATION_UNVERIFIED"
    && t._testCalls.length === 0 && w.estimateSwapsApplied === 0,
    `code=${r.code}`);
}

{ // [13] 6-decimal token end-to-end: C→B with honest pool, dry EXECUTABLE
  const w = makeWorld();
  addPool(w, { addr: POOL_BC, token0: B, token1: C, reserve0: 5000n * E18, reserve1: 10_000n * E6 });
  setBal(w, C, 500n * E6); // 15% = 75 CC; share 75/10000 = 0.75% < 1% → no shrink
  setAllow(w, C, ethers.MaxUint256);
  const t = makeTrader(w, { dryRun: true });
  const dirCB = { from: "CC", to: "BB", fromAddr: C, toAddr: B, path: [C, B], type: "direct", pool: POOL_BC, key: "CC>BB" };
  const r = await t._attemptSwapDirection(dirCB, ctxFor(t));
  const sized = Number(r.amountIn || 0) / 1e6;
  report(13, "6-decimal CC→BB dry EXECUTABLE with correct decimal sizing",
    r.status === "dry" && r.state === SWAP_DIRECTION_STATES.EXECUTABLE
    && sized > 74.9 && sized < 75.1,
    `status=${r.status} amountIn=${r.amountIn} (~${sized} CC)`);
}

{ // [14] queue: one skip never blocks the rest
  const dirs = [{ key: "X>Y" }, { key: "Y>Z" }];
  const seen = [];
  const res = await runSwapRotationQueue({
    directions: dirs, maxSwaps: 5,
    attempt: async (d) => {
      seen.push(d.key);
      return d.key === "X>Y"
        ? { status: "skip", code: "INSUFFICIENT_BALANCE" }
        : { status: "ok", txHash: "0x1" };
    },
    canAttempt: () => true, recordSkip: () => {}, recordFailure: () => {}, recordSuccess: () => {},
    stopRequested: () => false,
  });
  report(14, "runSwapRotationQueue: a skip does not block the next direction",
    res.verified === 1 && res.skipped === 1 && seen.length === 2 && seen[1] === "Y>Z",
    `verified=${res.verified} skipped=${res.skipped} seen=${seen.join(",")}`);
}

{ // [15] full maintenance cycle aggregates skippedByReason / pendingByState
  const w = makeWorld();
  addPool(w, { addr: POOL_AB, token0: A, token1: B, reserve0: 1000n * E18, reserve1: 5000n * E18 });
  setBal(w, A, 200n * E18); setBal(w, B, 0n);
  setAllow(w, A, 0n);
  const t = makeTrader(w, { dryRun: true });
  const cyc = await t.runSwapMaintenanceCycle({ force: true, maxSwaps: 10 });
  // 4 directions: AA>BB → WAITING_FOR_ALLOWANCE (allowance 0, dry);
  // BB>AA / BB>CC / CC>BB → WAITING_FOR_INVENTORY (balances 0).
  // attempted counts settlements+failures only — pure skips land in skipped.
  const byReason = cyc.skippedByReason || {};
  const byState = cyc.pendingByState || {};
  report(15, "maintenance summary: skippedByReason + pendingByState + executable populated",
    cyc.total === 4 && cyc.attempted === 0 && cyc.skipped === 4
    && byReason.WAITING_FOR_ALLOWANCE === 1 && byReason.INSUFFICIENT_BALANCE === 3
    && byState[SWAP_DIRECTION_STATES.WAITING_FOR_ALLOWANCE] === 1
    && byState[SWAP_DIRECTION_STATES.WAITING_FOR_INVENTORY] === 3
    && Array.isArray(cyc.executable) && cyc.executable.length === 0,
    `total=${cyc.total} attempted=${cyc.attempted} skipped=${cyc.skipped} byReason=${JSON.stringify(byReason)} byState=${JSON.stringify(byState)}`);
}

{ // [16] multi-hop shrink + 6-dec leg: B→C via pool — ECONOMY share on 18-dec leg
  const w = makeWorld();
  addPool(w, { addr: POOL_BC, token0: B, token1: C, reserve0: 1000n * E18, reserve1: 10_000n * E6 });
  setBal(w, B, 200n * E18); // 30e18 → share 3% > 1% → shrink to 10e18
  setAllow(w, B, ethers.MaxUint256);
  const t = makeTrader(w, { dryRun: true });
  const r = await t._attemptSwapDirection(dirBA.from ? { from: "BB", to: "CC", fromAddr: B, toAddr: C, path: [B, C], type: "direct", pool: POOL_BC, key: "BB>CC" } : dirBA, ctxFor(t));
  report(16, "BB→CC: 18-dec pool-share gate shrinks to the 1% cap, dry EXECUTABLE",
    r.status === "dry" && r.state === SWAP_DIRECTION_STATES.EXECUTABLE && r.amountIn === String(10n * E18),
    `status=${r.status} amountIn=${r.amountIn}`);
}

// ─── verdict ────────────────────────────────────────────────────────────────
const passed = results.filter(r => r.ok).length;
const failed = results.length - passed;
console.log("\n════════════════════════════════════════════════════════════");
console.log(`  SWAP REASON CODES: ${passed}/${results.length} passed, ${failed} failed`);
console.log("════════════════════════════════════════════════════════════");
process.exit(failed ? 1 : 0);
