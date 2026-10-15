// ═══════════════════════════════════════════════════════════════════════════
//  SWAP SAFETY EDGES — 10 read-only checks (0 transactions)
//
//  Covers the safety paths that the other suites do NOT exercise end-to-end:
//
//    • ZERO POOL RESERVES   — a real factory pool with a zero reserve side must
//                             quote 0 / revert, be rejected by route discovery
//                             and never enter the validated route set.
//    • FOREIGN TOKENS       — factory pools that introduce a NEW token address
//                             are never auto-added to the inventory (tokens are
//                             identified by contract ADDRESS, never by symbol).
//    • INSUFFICIENT BALANCE — zero balance and balance <= per-token reserve both
//                             SKIP with no transaction.
//    • GAS RESERVE          — ETH below MIN_ETH_GAS_RESERVE fails BEFORE any
//                             signature, parks ONLY that route.
//    • STALE QUOTE          — every attempt re-quotes the real size, so
//                             amountOutMin always equals applySlippage(quote, bps).
//    • BACKOFF + RECOVERY   — per-route parking, the reverse direction and every
//                             other route stay eligible; expiry/success re-arm it.
//    • ACTIVE POSITION      — every non-conclusive CLOSE outcome KEEPS
//                             state.activePosition; only a verified close clears.
//
//  HARNESS: a JsonRpcProvider subclass answers eth_call / eth_estimateGas /
//  eth_getBalance locally so the FULL AutoTrader code path (decimals → balance →
//  sizing → quote → slippage → preflight → estimateGas → gas-reserve guard) runs
//  for real. eth_sendRawTransaction is counted and REJECTED, so `sentRaw` and
//  `TX SENT` must both be 0 by construction.
//
//  ISOLATION: NEMESIS_STATE_FILE points at a SCRATCH copy that is set BEFORE
//  autoTrader.js is evaluated (STATE_FILE is read at module load), so the real
//  auto-trader-state.json is never written by this run.
// ═══════════════════════════════════════════════════════════════════════════

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { ethers } from "ethers";

const REPO = path.dirname(fileURLToPath(import.meta.url));
const REAL_STATE = path.join(REPO, "auto-trader-state.json");
const SCRATCH_DIR = path.join(REPO, ".safety-test-state");
const SCRATCH_STATE = path.join(SCRATCH_DIR, "state.json");

const sha = (p) => (fs.existsSync(p) ? crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex") : "(missing)");
const STATE_BEFORE = sha(REAL_STATE);

// ─── isolation (MUST precede the autoTrader import) ──────────────────────────
fs.mkdirSync(SCRATCH_DIR, { recursive: true });
fs.copyFileSync(REAL_STATE, SCRATCH_STATE);
process.env.NEMESIS_STATE_FILE = SCRATCH_STATE;

const { AutoTrader, applySlippage, tokenMetaOnChain } = await import("./autoTrader.js");
const { SwapRouteBackoff, runSwapRotationQueue, normalizeSwapConfig } = await import("./swapEngine.js");
const { discoverTokens, discoverSwapRoutes, quoteBestPath, probeAmountFor } = await import("./swapRoutes.js");
const { getAllTokens, getFactoryAddress, getRouterAddress, getConfirmedPools, getKnownMarkets } = await import("./deployments/index.js");
const { discoverMarkets } = await import("./marketDiscovery.js");
const { probeRouteEconomics } = await import("./swapEconomics.js");

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

const results = [];
function report(n, name, ok, detail = "") {
  results.push({ n, name, ok: !!ok, detail });
  console.log((ok ? "PASS  [" : "FAIL  [") + String(n).padStart(2, "0") + "] " + name + (detail ? " — " + detail : ""));
  return !!ok;
}

// ─── shared on-chain discovery (one pass, read-only) ─────────────────────────
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
const allRoutes = await discoverSwapRoutes({ provider, routerAddress: routerAddr, factoryAddress: getFactoryAddress(), tokens: tokenList, log: () => {} });
const validRoutes = allRoutes.filter(r => r && r.valid === true);
const addrOf = (sym) => tokenList.find(t => t.symbol === sym)?.address || null;
const decOf = (sym) => tokenList.find(t => t.symbol === sym)?.decimals ?? null;

// ═══════════════════════════════════════════════════════════════════════════
// [1] ZERO POOL RESERVES — the factory really does hold empty pools
// ═══════════════════════════════════════════════════════════════════════════
const FACTORY_ABI = [
  "function allPoolsLength() view returns (uint256)",
  "function allPools(uint256) view returns (address)",
];
const POOL_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
];
const zeroPools = [];
{
  const factory = new ethers.Contract(getFactoryAddress(), FACTORY_ABI, provider);
  let n = 0;
  try { n = Number(await factory.allPoolsLength()); } catch (e) { n = -1; }
  if (n > 0) {
    for (let i = 0; i < n; i += 12) {
      const chunk = [];
      for (let k = i; k < Math.min(i + 12, n); k++) {
        chunk.push((async (idx) => {
          try {
            const poolAddr = await factory.allPools(idx);
            const c = new ethers.Contract(poolAddr, POOL_ABI, provider);
            const [t0, t1, r] = await Promise.all([c.token0(), c.token1(), c.getReserves()]);
            if (BigInt(r[0]) === 0n || BigInt(r[1]) === 0n) {
              zeroPools.push({ idx, pool: poolAddr, t0, t1, r0: BigInt(r[0]), r1: BigInt(r[1]) });
            }
          } catch { /* pool without the standard getters — not relevant here */ }
        })(k));
      }
      await Promise.all(chunk);
    }
  }
  report(1, "zero pool reserves — empty pools exist on-chain and are detected",
    n > 0 && zeroPools.length >= 1,
    `allPools=${n} zeroReservePools=${zeroPools.length}${zeroPools.length ? " @ " + zeroPools.map(z => z.idx).join(",") : ""}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// [2] ZERO POOL RESERVES → no quote, no validated route, 0 transactions
// ═══════════════════════════════════════════════════════════════════════════
{
  const probe = probeAmountFor(18);
  const details = [];
  let allQuotedNull = zeroPools.length > 0;
  let allRejected = zeroPools.length > 0;

  for (const z of zeroPools.slice(0, 6)) {
    // (a) a synthetic VALIDATED direct record — the Router itself must still say 0
    const rec = [{ valid: true, type: "direct", path: [z.t0, z.t1], fromAddr: z.t0, toAddr: z.t1, fromSym: "?", toSym: "?", pool: z.pool }];
    let q = "error";
    try {
      q = await quoteBestPath({ provider, routerAddress: routerAddr, routes: rec, fromAddr: z.t0, toAddr: z.t1, amountIn: probe });
    } catch (e) { q = "error:" + String(e?.message || e).slice(0, 40); }
    if (q !== null) allQuotedNull = false;

    // (b) route discovery must REJECT the pair (probeQuote returns null → skipped)
    let rejected = false;
    let metas = [];
    try {
      metas = await discoverTokens({ provider, tokens: {}, markets: [{ token0: z.t0, token1: z.t1 }], log: () => {} });
      const built = await discoverSwapRoutes({ provider, routerAddress: routerAddr, factoryAddress: getFactoryAddress(), tokens: metas, log: () => {} });
      rejected = metas.length === 2 && built.length === 0;
      if (!rejected) allRejected = false;
      details.push(`#${z.idx} quote=${q === null ? "null" : q} meta=${metas.length} routes=${built.length}`);
    } catch (e) {
      allRejected = false;
      details.push(`#${z.idx} discovery error ${String(e?.message || e).slice(0, 40)}`);
    }
  }

  report(2, "zero pool reserves — router quotes 0 and discovery rejects the pair (0 TX)",
    allQuotedNull && allRejected,
    details.join(" | ") || "no zero-reserve pool to probe");
}

// ═══════════════════════════════════════════════════════════════════════════
// [3] FOREIGN TOKENS — a new factory pool never enters the inventory by itself
// ═══════════════════════════════════════════════════════════════════════════
{
  const deployment = getAllTokens();
  const deploymentAddrs = new Set(Object.values(deployment).map(a => String(a).toLowerCase()));
  const foreign = new Set();
  for (const z of zeroPools) {
    for (const t of [z.t0, z.t1]) {
      const k = String(t).toLowerCase();
      if (!deploymentAddrs.has(k)) foreign.add(k);
    }
  }
  const inventoryAddrs = tokenList.map(t => String(t.address).toLowerCase());
  const leaked = inventoryAddrs.filter(a => foreign.has(a));
  const routePools = new Set(validRoutes.flatMap(r => [r.pool, r.pool2].filter(Boolean)).map(a => String(a).toLowerCase()));
  const leakedPools = zeroPools.filter(z => routePools.has(String(z.pool).toLowerCase()));
  const uniqueInventory = new Set(inventoryAddrs);

  report(3, "foreign tokens — new factory pools are NOT auto-added (address-keyed inventory)",
    tokenList.length === 7 && uniqueInventory.size === 7
      && validRoutes.length === 42
      && leaked.length === 0 && leakedPools.length === 0
      && Object.keys(deployment).length === 8, // 7 addresses + the ETH→WETH alias
    `inventory=${tokenList.length} routes=${validRoutes.length} foreign=${foreign.size} leakedTokens=${leaked.length} leakedPools=${leakedPools.length}`);
}

// ═══════════════════════════════════════════════════════════════════════════
//  FAKE RPC — answers view calls locally, REJECTS every raw transaction
// ═══════════════════════════════════════════════════════════════════════════
const sel = (sig) => ethers.id(sig).slice(0, 10);
const SEL = {
  symbol: sel("symbol()"),
  decimals: sel("decimals()"),
  balanceOf: sel("balanceOf(address)"),
  allowance: sel("allowance(address,address)"),
  getAmountsOut: sel("getAmountsOut(uint256,address[])"),
  swapExact: sel("swapExactTokensForTokens(uint256,uint256,address[],address,uint256)"),
  // Pool/factory views needed by the per-leg economic gates (swapEconomics.js).
  // Without these the gates read the pool as RESERVE_UNREADABLE and reject every
  // route, which would mask the behaviour these tests actually exercise.
  getPool: sel("getPool(address,address)"),
  getReserves: sel("getReserves()"),
  token0: sel("token0()"),
  swapFeeBps: sel("swapFeeBps()"),
};
const coder = ethers.AbiCoder.defaultAbiCoder();
const hex = (v) => "0x" + BigInt(v).toString(16);

class FakeRpcProvider extends ethers.JsonRpcProvider {
  constructor(meta = {}) {
    super("http://127.0.0.1:1", chainId, { staticNetwork: true, batchMaxCount: 1 });
    this.sentRaw = 0;
    this.balances = new Map();          // token → bigint
    this.allowance = (1n << 255n);      // plenty — no approve is ever needed
    this.ethBalance = 0n;
    this.gasPrice = 10n ** 9n;          // 1 gwei
    this.gasEstimate = 100_000n;
    this.pools = new Map();             // pool address → { t0, t1, r0, r1 }
    this.quoteRate = 2n;                // amountOut = amountIn * rate
    this.quoteOutOverride = null;       // force an exact output
    this.liquidityGone = false;         // make getAmountsOut revert
    this.meta = new Map();              // address → { symbol, decimals }
    for (const t of meta.tokens || []) this.meta.set(String(t.address).toLowerCase(), { symbol: t.symbol, decimals: t.decimals });
  }

  // Moving the pool must invalidate every cached reserve, otherwise a test that
  // changes quoteRate between two attempts would silently reuse stale state and
  // prove nothing about freshness.
  get quoteRate() { return this._qRate; }
  set quoteRate(v) { this._qRate = BigInt(v); this.pools.clear(); }

  // Single source of truth for a pool's reserves, used by both getPool and the
  // lazy getAmountsOut path.
  //
  // Two constraints, both of which earlier versions got wrong:
  //   1. Reserves MUST stay inside uint112 (max ≈5.19e33). The first version used
  //      10^30·rate·100, which overflowed once the test moved the pool to a 1e6
  //      rate and made the encode throw — surfacing as RESERVE_UNREADABLE on the
  //      SECOND attempt only.
  //   2. Reserves MUST be decimals-aware. The economic gates compute spot in
  //      HUMAN units ((R1/10^decOut)/(R0/10^decIn)); a decimals-blind raw ratio
  //      of `quoteRate` therefore becomes quoteRate·10^(decIn−decOut) to the gate
  //      while getAmountsOut still returns the raw ratio — the two disagree and
  //      the leg trips PRICE_IMPACT_HIGH.
  // Anchoring each reserve at its own token's decimals makes human spot =
  // quoteRate exactly, and getAmountsOut returns the same quoteRate, so the
  // gates see ~0 impact. The 1% fee is removed from spot so the exec rate is
  // quoteRate rather than quoteRate·0.99.
  #mkPool(t0, t1) {
    const dec = (a) => BigInt(this.meta.get(a)?.decimals ?? 18);
    // uint112 max ≈ 5.19e33. Worst case is an 18-decimal token at the highest
    // rate the suite uses: 10^18 · SCALE · 1e6 · 100/99 < 5.19e33  ⇒  SCALE ≤ ~5e9.
    // 1e9 keeps pool share negligible (a 1-WETH swap is ~1e-9 of reserves).
    const SCALE = 10n ** 9n;
    const R0 = (10n ** dec(t0)) * SCALE;                  // ~1e9 of token t0
    const R1 = (10n ** dec(t1)) * SCALE * this._qRate * 100n / 99n;
    return { t0, t1, r0: R0, r1: R1 };
  }

  #ensurePool(tIn, tOut) {
    const [a, b] = tIn < tOut ? [tIn, tOut] : [tOut, tIn];
    const pool = "0x" + ethers.id(a + b).slice(26);
    if (!this.pools.has(pool)) this.pools.set(pool, this.#mkPool(a, b));
    return { pool, p: this.pools.get(pool) };
  }

  setBalance(symOrAddr, value) {
    const a = this.#resolve(symOrAddr);
    this.balances.set(a, BigInt(value));
  }

  #resolve(symOrAddr) {
    const raw = String(symOrAddr);
    const s = raw.toLowerCase();
    if (s.startsWith("0x") && s.length === 42) return s;
    const want = raw.toUpperCase();
    const hit = (this.metaTokens || []).find(t => String(t.symbol).toUpperCase() === want);
    return hit ? String(hit.address).toLowerCase() : s;
  }

  get metaTokens() { return [...this.meta.entries()].map(([address, m]) => ({ address, ...m })); }

  async send(method, params) {
    if (method === "eth_sendRawTransaction") {
      this.sentRaw++;
      throw new Error("TX FORBIDDEN — read-only safety test");
    }
    switch (method) {
      case "eth_chainId": return "0xaa36a7";
      case "net_version": return String(chainId);
      case "eth_blockNumber": return "0x1";
      case "eth_gasPrice": return hex(this.gasPrice);
      case "eth_maxPriorityFeePerGas": return hex(this.gasPrice);
      case "eth_getTransactionCount": return "0x0";
      case "eth_estimateGas": return hex(this.gasEstimate);
      case "eth_getBalance": return hex(this.ethBalance);
      case "eth_getCode": return "0x6080604052";
      case "eth_getBlockByNumber": return null;
      case "eth_call": return this.#handleCall(params[0]);
      default: throw new Error(`FAKE_RPC_UNSUPPORTED ${method}`);
    }
  }

  async _send(payload) {
    if (Array.isArray(payload) && payload.some(r => r?.method === "eth_sendRawTransaction")) {
      this.sentRaw++;
      throw new Error("TX FORBIDDEN — read-only safety test");
    }
    throw new Error("FAKE_RPC_BATCH_UNSUPPORTED " + JSON.stringify(payload).slice(0, 80));
  }

  async getFeeData() {
    return new ethers.FeeData(this.gasPrice, this.gasPrice, this.gasPrice);
  }

  #handleCall(tx) {
    const data = String(tx?.data || "0x");
    const s = data.slice(0, 10);
    const to = String(tx?.to || "").toLowerCase();
    const enc = (types, values) => coder.encode(types, values);

    if (s === SEL.symbol) {
      const m = this.meta.get(to);
      return enc(["string"], [m ? m.symbol : "UNK"]);
    }
    if (s === SEL.decimals) {
      const m = this.meta.get(to);
      return enc(["uint8"], [m ? m.decimals : 18]);
    }
    if (s === SEL.balanceOf) {
      return enc(["uint256"], [this.balances.get(to) ?? 0n]);
    }
    if (s === SEL.allowance) {
      return enc(["uint256"], [this.allowance]);
    }
    if (s === SEL.getAmountsOut) {
      if (this.liquidityGone) throw new Error("execution reverted: INSUFFICIENT_LIQUIDITY_AMOUNT_OUT");
      const [amountIn, pathArr] = coder.decode(["uint256", "address[]"], "0x" + data.slice(10));
      let out;
      if (this.quoteOutOverride !== null) {
        out = BigInt(this.quoteOutOverride);
      } else {
        // Multi-hop: apply the REAL constant-product formula with the 1% fee per
        // leg, reading the same reserves the economic gates read. This makes the
        // two directions of a pair true reciprocals instead of a symmetric
        // linear rate that would contradict itself under the cross-check.
        out = amountIn;
        for (let i = 0; i + 1 < pathArr.length; i++) {
          const tIn = String(pathArr[i]).toLowerCase();
          const tOut = String(pathArr[i + 1]).toLowerCase();
          // Created on demand: a route discovered on the real chain carries a
          // pool address this fake has never seen via getPool(), and the router
          // quotes through getAmountsOut directly. Same reserves either way.
          const { p } = this.#ensurePool(tIn, tOut);
          const [rIn, rOut] = tIn === p.t0 ? [p.r0, p.r1] : [p.r1, p.r0];
          const withFee = out * 99n;                       // 1% fee
          const denom = rIn * 100n + withFee;
          if (denom <= 0n) throw new Error("execution reverted: INSUFFICIENT_LIQUIDITY_AMOUNT_OUT");
          out = (withFee * rOut) / denom;
          if (out <= 0n) throw new Error("execution reverted: INSUFFICIENT_LIQUIDITY_AMOUNT_OUT");
        }
      }
      const amounts = new Array(pathArr.length).fill(0n);
      amounts[0] = amountIn;
      amounts[amounts.length - 1] = out;
      return enc(["uint256[]"], [amounts]);
    }
    if (s === SEL.swapExact) return "0x"; // preflight / state-changing call: succeeds locally

    // ── Constant-product pool + factory views for the economic gates ─────────
    // A single global "lastPair" would be clobbered by the cross-direction
    // reverse quote, so reserves/token0 are keyed BY POOL ADDRESS — exactly how
    // the real contracts behave. getAmountsOut is derived from those same
    // reserves with the 1% fee, so the two directions are genuine reciprocals
    // and rateAB × rateBA ≈ (1−fee)², which is what the gates expect.
    if (s === SEL.getPool) {
      const [a, b] = coder.decode(["address", "address"], "0x" + data.slice(10));
      const { pool } = this.#ensurePool(String(a).toLowerCase(), String(b).toLowerCase());
      return enc(["address"], [pool]);
    }
    if (s === SEL.token0) {
      const p = this.pools.get(to);
      return enc(["address"], [p ? p.t0 : ("0x" + "0".repeat(40))]);
    }
    if (s === SEL.swapFeeBps) return enc(["uint256"], [100n]);   // 1% per leg, as on-chain
    if (s === SEL.getReserves) {
      const p = this.pools.get(to);
      if (!p) throw new Error("execution reverted: unknown pool");
      return enc(["uint112", "uint112", "uint32"], [p.r0, p.r1, 0]);
    }

    throw new Error("FAKE_RPC_UNKNOWN_SELECTOR " + s);
  }
}

function mkFake(extra = {}) {
  const f = new FakeRpcProvider({ tokens: tokenList });
  // fund every token so sizing/quote/preflight all succeed and the ONLY thing
  // that can stop a swap in [5] is the ETH gas-reserve guard
  for (const t of tokenList) {
    f.setBalance(t.address, ethers.parseUnits(t.symbol === "WETH" ? "1" : "1000", t.decimals));
  }
  // Default to a GAS-FUNDED wallet. Only [05] zeroes ETH on purpose; leaving it
  // at 0 here would make the gas-reserve guard mask every other behaviour.
  f.ethBalance = ethers.parseEther("0.05");
  Object.assign(f, extra);
  return f;
}

function mkTrader({ dryRun, fake, extraConfig = {} }) {
  const t = new AutoTrader({
    accounts: [{ address: walletAddr, privateKey: pk }],
    selectedWalletIndex: 0, proxies: [],
    rpcUrl, chainId,
    config: {
      dryRun,
      swap: cfg.swap, autoSwap: cfg.autoSwap,
      slippageBps: cfg.slippageBps, deadlineSeconds: cfg.deadlineSeconds,
      availableMarkets: cfg.availableMarkets || [],
      ...extraConfig,
    },
    confirmedPools: getConfirmedPools(),
    availableMarkets: cfg.availableMarkets || [],
    getProvider: () => fake,
    log,
  });
  t.routes = validRoutes;
  t.tokenList = tokenList;
  t.markets = markets;
  t.ensureMarkets = async () => t.markets;   // discovery already done above, read-only
  return t;
}

function mkCtx(t, { dryRun }) {
  const c = normalizeSwapConfig(t.config);
  const { provider: p, wallet } = t.getRuntime();
  const { decimalsMap } = t._swapDirections({});
  return { cfg: c, provider: p, wallet, walletAddr: wallet.address, decimalsMap, dryRun, phase: "SAFETY", slippageBps: BigInt(c.slippageBps) };
}

const dirDAIUSDT = (t) => t._swapDirections({ from: "DAI", to: "USDT" }).directions[0];

// ═══════════════════════════════════════════════════════════════════════════
// [4] INSUFFICIENT BALANCE — zero balance AND balance <= reserve → SKIP, 0 TX
// ═══════════════════════════════════════════════════════════════════════════
{
  const f = mkFake();
  const t = mkTrader({ dryRun: true, fake: f });
  const ctx = mkCtx(t, { dryRun: true });
  const dir = dirDAIUSDT(t);

  f.setBalance("DAI", 0n);
  const rZero = await t._attemptSwapDirection(dir, ctx);

  // DAI reserve = 1 whole token → 0.5 leaves nothing tradable
  f.setBalance("DAI", ethers.parseUnits("0.5", decOf("DAI")));
  const rLow = await t._attemptSwapDirection(dir, ctx);

  const ok = rZero?.status === "skip" && rZero?.code === "INSUFFICIENT_BALANCE"
    && rLow?.status === "skip" && rLow?.code === "INSUFFICIENT_BALANCE"
    && f.sentRaw === 0;
  report(4, "insufficient balance — zero balance and balance<=reserve both SKIP without a TX",
    ok, `zero=${rZero?.status}/${rZero?.code} belowReserve=${rLow?.status}/${rLow?.code} sentRaw=${f.sentRaw}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// [5] GAS RESERVE — ETH below MIN_ETH_GAS_RESERVE fails before any signature
//     (all 42 directions funded, so the guard is the ONLY thing that can stop them)
// ═══════════════════════════════════════════════════════════════════════════
{
  const f = mkFake({ ethBalance: 0n, gasPrice: 10n ** 9n, gasEstimate: 100_000n });
  const t = mkTrader({ dryRun: false, fake: f });
  const s = await t.runSwapMaintenanceCycle({ force: true, phase: "GAS" });
  const codes = [...new Set(s.results.map(r => r.code))];
  const allGasReserve = s.results.length > 0 && s.results.every(r => r.status === "fail" && r.code === "GAS_RESERVE");

  const ok = s.total === 42 && s.attempted === 42 && s.failed === 42 && s.verified === 0
    && allGasReserve
    && t.swapBackoff.size() === 42
    && f.sentRaw === 0;
  report(5, "gas reserve — all 42 directions stop at ETH < MIN_ETH_GAS_RESERVE, 0 TX",
    ok, `total=${s.total} failed=${s.failed} codes=[${codes.join(",")}] parked=${t.swapBackoff.size()} sentRaw=${f.sentRaw} eth=${ethers.formatEther(f.ethBalance)}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// [6] STALE QUOTE — every attempt re-quotes the real size
// ═══════════════════════════════════════════════════════════════════════════
{
  // The pool "moves" between the two attempts. This proves FRESHNESS — that
  // amountOutMin is re-derived from a live quote rather than cached — not that
  // an absurd pool must clear the economic gates. A 500,000% swing was tried
  // first and is correctly vetoed by PRICE_IMPACT_HIGH: on a 2-hop path it makes
  // the intermediate amount dwarf the second leg's reserves, which is a real
  // reject, not a fake-RPC artefact. 2 → 3 is a realistic 50% re-price that the
  // gates legitimately accept while still changing amountOutMin observably.
  const RATE_A = 2n;
  const RATE_B = 3n;
  const f = mkFake({ quoteRate: RATE_A });
  const t = mkTrader({ dryRun: true, fake: f });
  const ctx = mkCtx(t, { dryRun: true });
  const dir = dirDAIUSDT(t);

  // Expected = applySlippage(FRESH quote for that exact size). Re-quoting here
  // (read-only) is what makes this a freshness test rather than a re-derivation
  // of the pool formula — if the bot had reused a stale quote it would not match.
  // Each requote must happen while the pool is still in the SAME state as the
  // attempt it is checking.
  const requote = async (amountInRaw) => {
    const best = await quoteBestPath({
      provider: f, routerAddress: routerAddr, routes: t.routes,
      fromAddr: dir.fromAddr, toAddr: dir.toAddr, amountIn: amountInRaw, log: () => {},
    });
    return best ? applySlippage(best.amountOut, 50n) : 0n;
  };

  const r1 = await t._attemptSwapDirection(dir, ctx);
  const want1 = await requote(BigInt(r1?.amountIn || 0));   // pool still at RATE_A

  f.quoteRate = RATE_B;                       // the pool moved between attempts
  const r2 = await t._attemptSwapDirection(dir, ctx);
  const want2 = await requote(BigInt(r2?.amountIn || 0));   // pool now at RATE_B

  // One-off diagnostics: show what the economic model actually sees for the
  // winning path at the moved pool, so a reject is never a blind guess.
  if (process.env.NEMESIS_DEBUG_ECON) {
    const best = await quoteBestPath({
      provider: f, routerAddress: routerAddr, routes: t.routes,
      fromAddr: dir.fromAddr, toAddr: dir.toAddr,
      amountIn: BigInt(r2?.amountIn || 10n ** 6n), log: () => {},
    });
    if (best) {
      const econ = await probeRouteEconomics({
        provider: f, factoryAddress: getFactoryAddress(), path: best.path,
        amountIn: BigInt(r2?.amountIn || 10n ** 6n), amountOut: best.amountOut, log: () => {},
      });
      console.error("[ECON-DEBUG]", JSON.stringify({
        path: best.path, gates: econ.gates, worstPoolShare: econ.worstPoolShare,
        legs: econ.legs.map(l => ({ g: l.gate ?? null, share: l.poolShare, impact: l.priceImpactExFee, in: l.amountIn, out: l.amountOut, ri: l.reserveIn, ro: l.reserveOut, fee: l.swapFeeBps })),
      }, null, 1));
    }
  }

  const fresh = BigInt(r1?.amountOutMin || 0) === want1 && BigInt(r2?.amountOutMin || 0) === want2;
  const moved = BigInt(r1?.amountOutMin || 0) !== BigInt(r2?.amountOutMin || 0);

  const ok = r1?.status === "dry" && r2?.status === "dry"
    && want1 > 0n && want2 > 0n && fresh && moved && f.sentRaw === 0;
  report(6, "stale quote — amountOutMin always equals applySlippage(FRESH quote, bps)",
    ok, `1st=${r1?.amountOutMin} want=${want1} 2nd=${r2?.amountOutMin} want=${want2} moved=${moved} sentRaw=${f.sentRaw}`
      + ` | 1stStatus=${r1?.status}/${r1?.code} 2ndStatus=${r2?.status}/${r2?.code}`
      + ` | 1stReason=${r1?.reason ?? "-"} 2ndReason=${r2?.reason ?? "-"}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// [7] BACKOFF — only the failing route is parked, the rest keep running
// ═══════════════════════════════════════════════════════════════════════════
{
  const f = mkFake();
  const t = mkTrader({ dryRun: false, fake: f });
  const dir = dirDAIUSDT(t);
  const all = t._swapDirections({}).directions;

  t._recordSwapRouteFailure(dir, "GAS_RESERVE");
  const parkedKey = t.swapBackoff.get("DAI>USDT");
  const eligible = all.filter(d => t.swapBackoff.canAttempt(d.key, Date.now()));
  const reverseAlive = t.swapBackoff.canAttempt("USDT>DAI", Date.now());

  // the engine's own queue filter must drop exactly the parked route
  let eligibleViaQueue = -1;
  try {
    const res = await runSwapRotationQueue({
      directions: all, maxSwaps: 999,
      attempt: async () => ({ status: "skip", code: "DRY", reason: "not used" }),
      canAttempt: (k) => t.swapBackoff.canAttempt(k, Date.now()),
    });
    eligibleViaQueue = res.eligible;
  } catch { /* reported by the assertion below */ }

  const ok = !!parkedKey && parkedKey.fails === 1
    && eligible.length === all.length - 1
    && !eligible.some(d => d.key === "DAI>USDT")
    && eligible.some(d => d.key === "USDT>DAI")
    && reverseAlive && eligibleViaQueue === all.length - 1;
  report(7, "backoff — only the failing route is parked; reverse + all others stay eligible",
    ok, `parked=${t.swapBackoff.size()} eligible=${eligible.length}/${all.length} viaQueue=${eligibleViaQueue} reverseAlive=${reverseAlive}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// [8] RECOVERY — backoff expiry and a success both re-arm the route
// ═══════════════════════════════════════════════════════════════════════════
{
  const bo = new SwapRouteBackoff({ maxConsecutiveFailures: 3, baseMs: 1000, maxMs: 4000 });
  const now = Date.now();
  bo.recordFailure("DAI>USDT", "GAS_RESERVE", now);
  const entry = bo.get("DAI>USDT");

  const blockedNow = !bo.canAttempt("DAI>USDT", now);
  const freeAtExpiry = bo.canAttempt("DAI>USDT", entry.until);
  const reverseFree = bo.canAttempt("USDT>DAI", now);
  const otherFree = bo.canAttempt("LINK>USDC", now);

  // repeated failures grow the delay but stay inside the configured cap
  bo.recordFailure("DAI>USDT", "GAS_RESERVE", now);
  bo.recordFailure("DAI>USDT", "GAS_RESERVE", now);
  const grown = bo.get("DAI>USDT");
  const capped = (grown.until - grown.lastAt) <= 4000;

  // a settled swap clears the entry completely → immediately eligible again
  bo.recordSuccess("DAI>USDT");
  const recovered = bo.get("DAI>USDT") === null && bo.canAttempt("DAI>USDT", now);

  // …and the engine's own success path does the same
  const f = mkFake();
  const t = mkTrader({ dryRun: false, fake: f });
  const dir = dirDAIUSDT(t);
  t._recordSwapRouteFailure(dir, "GAS_RESERVE");
  const before = t.swapBackoff.size();
  t._recordSwapRouteSuccess(dir);
  const after = t.swapBackoff.size();

  const ok = blockedNow && freeAtExpiry && reverseFree && otherFree && capped && recovered
    && entry.lastCode === "GAS_RESERVE" && before === 1 && after === 0;
  report(8, "recovery — backoff expiry and recordSuccess re-arm the route (no permanent lockout)",
    ok, `blocked=${blockedNow} freeAtExpiry=${freeAtExpiry} reverseFree=${reverseFree} capped=${capped} recovered=${recovered} engine ${before}→${after}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// [9] ACTIVE POSITION — only a verified close may clear it
// ═══════════════════════════════════════════════════════════════════════════
{
  const f = mkFake();
  const t = mkTrader({ dryRun: false, fake: f });
  const m = markets[0] || {};
  const POS = {
    positionId: 7, side: "SHORT",
    collateralToken: tokenList.find(x => x.symbol === "USDT")?.address || "0x0",
    positionIdx: 0,
    marketSymbol: m.marketSymbol || m.symbol || "USDT/DAI",
    managerAddr: m.managerAddr || "0x0000000000000000000000000000000000000001",
    poolAddr: m.poolAddr || "0x0000000000000000000000000000000000000002",
    openedAt: Date.now(),
  };
  const sig = "sig-abc";
  const cases = [
    ["null result", null],
    ["failed+clearState:false", { failed: true, clearState: false, code: "LIQUIDITY_LOW" }],
    ["pending tx", { pending: true, txHash: "0xdead" }],
    ["closed:false", { closed: false, code: "STILL_ACTIVE" }],
    ["dry-run close", { dryRun: true, txHash: "0xbeef" }],
  ];

  const kept = [];
  const codes = [];
  for (const [label, res] of cases) {
    t.state.activePosition = { ...POS };
    const out = t._applyCloseResult(res, sig);
    kept.push({ label, kept: t.state.activePosition?.positionId === 7, ok: out.ok, code: out.code });
    codes.push(out.code ?? (out.dryRun ? "DRY" : "OK"));
  }

  const allKept = kept.every(k => k.kept);

  // backoff bookkeeping was recorded by the failed attempts (before the clear)
  const retriesBeforeClear = t.state.closeRetry?.attempts ?? 0;
  const retrySigKept = t.state.closeRetry?.sig === sig;

  // a PROVEN close is still allowed to clear it — the guard is not sticky
  t.state.activePosition = { ...POS };
  const cleared = t._applyCloseResult({ closed: true, txHash: "0xabc" }, sig);
  const actuallyCleared = t.state.activePosition === null;
  const retryClearedOnSuccess = t.state.closeRetry == null;

  const ok = allKept
    && kept[0].ok === false && kept[0].code === "CLOSE_NO_RESULT"
    && kept[1].ok === false && kept[1].code === "LIQUIDITY_LOW"
    && kept[2].ok === false && kept[2].code === "TX_PENDING"
    && kept[3].ok === false && kept[3].code === "STILL_ACTIVE"
    && kept[4].ok === true && kept[4].code == null
    && cleared.ok === true && actuallyCleared
    && retriesBeforeClear === 4 && retrySigKept && retryClearedOnSuccess
    && f.sentRaw === 0;
  report(9, "active position — every non-conclusive CLOSE outcome KEEPS it; only a verified close clears",
    ok, `kept=${kept.filter(k => k.kept).length}/${kept.length} codes=[${codes.join(",")}] retries=${retriesBeforeClear} clearedOnVerified=${actuallyCleared} retryReset=${retryClearedOnSuccess}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// [10] STATE FILE UNCHANGED + 0 transactions sent
// ═══════════════════════════════════════════════════════════════════════════
{
  const STATE_AFTER = sha(REAL_STATE);
  const ok = STATE_BEFORE === STATE_AFTER && txSent() === 0;
  report(10, "state-file hash unchanged and no transaction was sent",
    ok, `sha=${STATE_BEFORE === STATE_AFTER ? "unchanged" : STATE_BEFORE + " → " + STATE_AFTER} txSent=${txSent()}`);
}

// ─── summary ────────────────────────────────────────────────────────────────
const passed = results.filter(r => r.ok).length;
console.log(`\n${"═".repeat(70)}`);
console.log(`  SWAP SAFETY EDGE TESTS: ${passed}/${results.length} PASS`);
if (passed !== results.length) {
  console.log("  FAILURES:");
  for (const r of results) if (!r.ok) console.log(`   - [${r.n}] ${r.name} :: ${r.detail}`);
}
console.log(`  state sha256=${sha(REAL_STATE)}`);
console.log(`  transactions sent: ${txSent()}`);
console.log(`${"═".repeat(70)}\n`);

fs.rmSync(SCRATCH_DIR, { recursive: true, force: true });

if (sha(REAL_STATE) !== STATE_BEFORE) { console.error("STATE FILE MODIFIED — aborting"); process.exit(2); }
process.exit(passed === results.length ? 0 : 1);
