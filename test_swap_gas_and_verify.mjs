// ═══════════════════════════════════════════════════════════════════════════
//  SWAP GAS BUDGET + BLOCK-PINNED VERIFICATION — regression suite
//
//  Locks in the two defects proven against Sepolia receipts:
//
//   A) OUT-OF-GAS          gasLimit = estimate + estimate/5 (1.20x) was sized
//      from a measurement taken at a DIFFERENT block than the one that
//      executed. Observed: estimate 176 693, budget 212 031, REQUIRED 264 272
//      → every REVERTED swap (16/16 testable) burned its whole gas limit with
//      zero logs.
//   B) FALSE MISMATCH      two consecutive unpinned balanceOf() calls landed on
//      different RPC heads → 6/6 "CONFIRMED_STATE_MISMATCH" swaps had in fact
//      succeeded.
//
//  This suite sends NO transaction and writes NO state (shared isolation
//  module redirects STATE_FILE and installs the default-deny TX guard).
// ═══════════════════════════════════════════════════════════════════════════

import { realStateHash } from "./_test_state_isolation.mjs";
import { ethers } from "ethers";

const SHA_BEFORE = realStateHash();

const { computeSwapGasLimit, rawEstimateGas, balanceOfAtBlock, summarizeSwapTransfers, assessSwapOutcome, verifySwapBalances, SWAP_VERIFY } =
  await import("./autoTrader.js");

// ─── fixtures ───────────────────────────────────────────────────────────────
const WALLET = "0x315E5193633A962B3F369F9C3833D973D0588cCD";
const T_IN = "0x1111111111111111111111111111111111111111";
const T_OUT = "0x2222222222222222222222222222222222222222";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const topic = (a) => "0x" + String(a).toLowerCase().replace(/^0x/, "").padStart(64, "0");
const hex32 = (v) => "0x" + BigInt(v).toString(16).padStart(64, "0");

const tx = { from: WALLET, to: T_IN, data: "0x70a08231" + topic(WALLET).slice(2), value: 0n };

/**
 * A provider whose `eth_call` answers ONLY from explicit block-indexed state,
 * and which records the block tag of every read — so a test can prove that a
 * read was pinned instead of silently running at `latest`.
 */
class Chain extends ethers.JsonRpcProvider {
  constructor({ head = 200, history = true, balances = {} } = {}) {
    super("http://127.0.0.1:9", 11155111, { staticNetwork: true });
    this.head = head;
    this.history = history;
    this.balances = {};
    for (const [tok, byBlock] of Object.entries(balances)) {
      this.balances[String(tok).toLowerCase()] = Object.fromEntries(
        Object.entries(byBlock).map(([b, v]) => [Number(b), BigInt(v)]),
      );
    }
    this.tags = [];
    this.counts = { estimate: 0, call: 0 };
  }
  _at(token, block) {
    const m = this.balances[String(token).toLowerCase()];
    const v = m && m[block];
    if (v === undefined) throw new Error("missing revert data (data=null, reason=null)");
    return v;
  }
  async send(method, params) {
    if (method === "eth_chainId") return "0xaa36a7";
    if (method === "eth_blockNumber") return "0x" + BigInt(this.head).toString(16);
    if (method === "eth_gasPrice") return "0x3b9aca00";
    if (method === "eth_getBlockByNumber") return null;
    if (method === "eth_estimateGas") { this.counts.estimate++; return "0x30d40"; }
    if (method === "eth_call") {
      this.counts.call++;
      const [t, tag] = params;
      this.tags.push(tag);
      if (!this.history) throw new Error("missing revert data (data=null, reason=null)");
      const block = (!tag || tag === "latest" || tag === "pending")
        ? this.head
        : Number(BigInt(tag));
      return hex32(this._at(t.to, block));
    }
    return null;
  }
  async getBlockNumber() { return this.head; }
  async getBlock() { return { gasLimit: 30_000_000n, number: this.head }; }
}

const transferLog = ({ token, from, to, value }) => ({
  address: token, topics: [TRANSFER_TOPIC, topic(from), topic(to), hex32(1)], data: hex32(value),
});
const pair = { from: "TIN", to: "TOUT", fromAddr: T_IN, toAddr: T_OUT };

const results = [];
function report(n, name, ok, detail = "") {
  results.push({ n, name, ok: !!ok, detail });
  console.log((ok ? "PASS  [" : "FAIL  [") + String(n).padStart(2, "0") + "] " + name + (detail ? " — " + detail : ""));
  return !!ok;
}

// ═══════════════════════════════════════════════════════════════════════════
//  A. GAS BUDGET
// ═══════════════════════════════════════════════════════════════════════════

{ // [1] reproduce the production OOG: old formula under-budgets, new one does not
  const estimate = 176_693n;          // sampled by the bot
  const required = 264_272n;          // measured on a reverted Sepolia receipt
  const oldFormula = estimate + estimate / 5n;
  const gasLimit = computeSwapGasLimit({ estimate, hops: 1, blockGasLimit: 30_000_000n });
  report(1, "old budget (estimate+20%) is what OOGed; computeSwapGasLimit covers the measured requirement",
    oldFormula < required && gasLimit >= required && gasLimit >= estimate * 2n,
    `old=${oldFormula} required=${required} new=${gasLimit}`);
}

{ // [2] multi-hop routes cost more than direct ones — the budget tracks hops
  const a = computeSwapGasLimit({ estimate: 200_000n, hops: 1, blockGasLimit: 30_000_000n });
  const b = computeSwapGasLimit({ estimate: 200_000n, hops: 2, blockGasLimit: 30_000_000n });
  const c = computeSwapGasLimit({ estimate: 200_000n, hops: 3, blockGasLimit: 30_000_000n });
  report(2, "budget grows with hop count (1 < 2 < 3 hops)",
    a < b && b < c, `h1=${a} h2=${b} h3=${c}`);
}

{ // [3] clamp: never asks the block for more than 3/4 of its gas limit…
  const g = computeSwapGasLimit({ estimate: 100_000n, hops: 1, blockGasLimit: 200_000n });
  report(3, "budget clamped to 75% of the block gas limit but never below the estimate",
    g === 150_000n && g >= 100_000n, `got=${g} cap=${(200_000n * 3n) / 4n}`);
}

{ // [4] …and refuses to send when the bare estimate cannot fit the block
  const tooBig = computeSwapGasLimit({ estimate: 264_284n, hops: 1, blockGasLimit: 300_000n });
  report(4, "estimate > 75% of the block gas limit => null (caller must NOT broadcast)",
    tooBig === null, `got=${tooBig}`);
}

{ // [5] garbage input never yields a sendable number
  const bad = [
    computeSwapGasLimit({ estimate: 0n }),
    computeSwapGasLimit({ estimate: -1n }),
    computeSwapGasLimit({ estimate: undefined }),
    computeSwapGasLimit({ estimate: "200000" }),
    computeSwapGasLimit({}),
  ];
  report(5, "invalid/absent estimate always returns null (no NaN gasLimit ever leaves this function)",
    bad.every(v => v === null), `got=[${bad.map(String).join(",")}]`);
}

{ // [6] estimate with no block limit still gets a usable budget (defensive path)
  const g = computeSwapGasLimit({ estimate: 176_693n, hops: 1, blockGasLimit: null });
  report(6, "unknown block gas limit skips the clamp instead of blocking the swap",
    typeof g === "bigint" && g >= 176_693n * 2n, `got=${g}`);
}

// ═══════════════════════════════════════════════════════════════════════════
//  B. FRESH RE-MEASUREMENT
// ═══════════════════════════════════════════════════════════════════════════

{ // [7] ethers dedupes identical estimateGas calls inside 250 ms…
  const p = new Chain();
  await p.estimateGas(tx);
  await p.estimateGas(tx);
  const cached = p.counts.estimate;
  report(7, "provider.estimateGas() de-duplicates identical requests within 250 ms (why a raw call is needed)",
    cached <= 1, `raw eth_estimateGas calls after 2 provider.estimateGas = ${cached}`);
}

{ // [8] …so the pre-broadcast re-measurement must bypass that cache
  const p = new Chain();
  await p.estimateGas(tx);              // preview (may be cached)
  const before = p.counts.estimate;
  const v1 = await rawEstimateGas(p, tx);
  const v2 = await rawEstimateGas(p, tx);
  const delta = p.counts.estimate - before;
  report(8, "rawEstimateGas always issues its own eth_estimateGas (fresh, uncached)",
    delta === 2 && v1 === 200_000n && v2 === 200_000n,
    `previewCalls=${before} rawCalls=${delta} values=${v1}/${v2}`);
}

// ═══════════════════════════════════════════════════════════════════════════
//  C. BLOCK-PINNED VERIFICATION
// ═══════════════════════════════════════════════════════════════════════════

{ // [9] success receipt verified against fixed blocks while the head keeps moving
  const p = new Chain({
    head: 200, // head has moved far past the TX
    balances: {
      [T_IN]: { 100: 1_000n, 105: 900n, 200: 1_000n }, // head would show NO delta
      [T_OUT]: { 100: 50n, 105: 140n, 200: 50n },
    },
  });
  // caller-side snapshot, exactly like _attemptSwapDirection / the maintenance
  // cycle do it: BOTH sides pinned to ONE explicit block before the TX.
  const beforeFrom = await balanceOfAtBlock(p, T_IN, WALLET, 100);
  const beforeTo = await balanceOfAtBlock(p, T_OUT, WALLET, 100);
  const a = await assessSwapOutcome({
    provider: p, walletAddr: WALLET, tokenIn: T_IN, tokenOut: T_OUT,
    beforeFrom, beforeTo, beforeBlock: 100,
    receipt: { status: 1, blockNumber: 105 },
    amountIn: 100n, amountOutMin: 90n, retries: 1,
  });
  const tags = p.tags.map(String);
  report(9, "PASS verdict from before@100 vs after@105 even though the RPC head is 200",
    a.verdict === SWAP_VERIFY.PASS && a.basis === "balance-delta"
    && beforeFrom === 1_000n && beforeTo === 50n
    && a.inDelta === 100n && a.outDelta === 90n
    && tags.includes("0x64") && tags.includes("0x69") && !tags.includes("0xc8"),
    `verdict=${a.verdict} basis=${a.basis} tags=[${tags.join(",")}]`);
}

{ // [10] pruned history + no logs => INCONCLUSIVE, never FAIL
  const p = new Chain({ history: false });
  const a = await assessSwapOutcome({
    provider: p, walletAddr: WALLET, tokenIn: T_IN, tokenOut: T_OUT,
    beforeFrom: 1_000n, beforeTo: 50n, beforeBlock: 100,
    receipt: { status: 1, blockNumber: 105 },
    amountIn: 100n, amountOutMin: 90n, retries: 2, retryDelayMs: 1,
  });
  report(10, "unservable historical state => inconclusive (a mined TX is never downgraded to failure)",
    a.verdict === SWAP_VERIFY.INCONCLUSIVE && /verification-inconclusive/.test(a.reason),
    `verdict=${a.verdict} reason=${a.reason}`);
}

{ // [11] pruned history BUT matching Transfer logs => PASS
  const p = new Chain({ history: false });
  const receipt = {
    status: 1, blockNumber: 105,
    logs: [transferLog({ token: T_IN, from: WALLET, to: ethers.ZeroAddress, value: 100n }),
           transferLog({ token: T_OUT, from: ethers.ZeroAddress, to: WALLET, value: 90n })],
  };
  const a = await assessSwapOutcome({
    provider: p, walletAddr: WALLET, tokenIn: T_IN, tokenOut: T_OUT,
    beforeFrom: 1_000n, beforeTo: 50n, beforeBlock: 100,
    receipt, amountIn: 100n, amountOutMin: 90n, retries: 1, retryDelayMs: 1,
  });
  report(11, "Transfer logs exculpate a status-1 receipt whose balance state is pruned",
    a.verdict === SWAP_VERIFY.PASS && a.basis === "transfer-logs"
    && a.inDelta === 100n && a.outDelta === 90n,
    `verdict=${a.verdict} basis=${a.basis} in=${a.inDelta} out=${a.outDelta}`);
}

{ // [12] receipt.status === 0 is final
  const p = new Chain({ history: true, balances: { [T_IN]: { 105: 1_000n }, [T_OUT]: { 105: 50n } } });
  const a = await assessSwapOutcome({
    provider: p, walletAddr: WALLET, tokenIn: T_IN, tokenOut: T_OUT,
    beforeFrom: 1_000n, beforeTo: 50n, beforeBlock: 100,
    receipt: { status: 0, blockNumber: 105 },
    amountIn: 100n, amountOutMin: 90n, retries: 1,
  });
  report(12, "failed receipt (status 0) => fail, no further evidence considered",
    a.verdict === SWAP_VERIFY.FAIL && /receipt\.status=0/.test(a.reason),
    `verdict=${a.verdict} reason=${a.reason} calls=${p.counts.call}`);
}

{ // [13] status 1 + zero deltas + confirming Transfer logs => PASS (exculpation)
  const p = new Chain({
    balances: { [T_IN]: { 100: 1_000n, 105: 1_000n }, [T_OUT]: { 100: 50n, 105: 50n } },
  });
  const receipt = {
    status: 1, blockNumber: 105,
    logs: [transferLog({ token: T_IN, from: WALLET, to: ethers.ZeroAddress, value: 100n }),
           transferLog({ token: T_OUT, from: ethers.ZeroAddress, to: WALLET, value: 90n })],
  };
  const a = await assessSwapOutcome({
    provider: p, walletAddr: WALLET, tokenIn: T_IN, tokenOut: T_OUT,
    beforeFrom: 1_000n, beforeTo: 50n, beforeBlock: 100,
    receipt, amountIn: 100n, amountOutMin: 90n, retries: 1, retryDelayMs: 1,
  });
  report(13, "delta disagreement is overruled by matching Transfer logs (no false MISMATCH)",
    a.verdict === SWAP_VERIFY.PASS && a.basis === "transfer-logs",
    `verdict=${a.verdict} basis=${a.basis} reason=${a.reason}`);
}

{ // [14] status 1 + zero deltas + NO Transfer logs => FAIL (real contradiction)
  const p = new Chain({
    balances: { [T_IN]: { 100: 1_000n, 105: 1_000n }, [T_OUT]: { 100: 50n, 105: 50n } },
  });
  const a = await assessSwapOutcome({
    provider: p, walletAddr: WALLET, tokenIn: T_IN, tokenOut: T_OUT,
    beforeFrom: 1_000n, beforeTo: 50n, beforeBlock: 100,
    receipt: { status: 1, blockNumber: 105, logs: [] },
    amountIn: 100n, amountOutMin: 90n, retries: 1, retryDelayMs: 1,
  });
  report(14, "receipt mined but moved no tokens and logged nothing => fail (not inconclusive)",
    a.verdict === SWAP_VERIFY.FAIL, `verdict=${a.verdict} reason=${a.reason}`);
}

{ // [15] legacy call shape (no receipt) still FAILS on a no-op — closes the
      // "verification is vacuous" hole that test_close_partial.mjs guards.
  const p = new Chain({
    balances: { [T_IN]: { 200: 1_000n }, [T_OUT]: { 200: 50n } },
  });
  const v = await verifySwapBalances({
    provider: p, walletAddr: WALLET, pair, beforeFrom: 1_000n, beforeTo: 50n,
    amountIn: 1n, amountOutMin: 1n, retries: 1, retryDelayMs: 1, log: () => {},
  });
  report(15, "no-receipt path: unchanged balances => ok:false (legacy contract preserved)",
    v.ok === false && v.verdict === SWAP_VERIFY.FAIL && v.inDelta === 0n && v.outDelta === 0n,
    `ok=${v.ok} verdict=${v.verdict} in=${v.inDelta} out=${v.outDelta}`);
}

{ // [16] legacy call shape still passes on real deltas
  const p = new Chain({
    balances: { [T_IN]: { 200: 900n }, [T_OUT]: { 200: 140n } },
  });
  const v = await verifySwapBalances({
    provider: p, walletAddr: WALLET, pair, beforeFrom: 1_000n, beforeTo: 50n,
    amountIn: 100n, amountOutMin: 90n, retries: 1, retryDelayMs: 1, log: () => {},
  });
  report(16, "no-receipt path: real deltas => ok:true",
    v.ok === true && v.verdict === SWAP_VERIFY.PASS && v.inDelta === 100n && v.outDelta === 90n,
    `ok=${v.ok} basis=${v.basis} in=${v.inDelta} out=${v.outDelta}`);
}

{ // [17] inconclusive is surfaced as ok:false + inconclusive:true (never silent)
  const p = new Chain({ history: false });
  const v = await verifySwapBalances({
    provider: p, walletAddr: WALLET, pair, beforeFrom: 1_000n, beforeTo: 50n, beforeBlock: 100,
    receipt: { status: 1, blockNumber: 105 },
    amountIn: 100n, amountOutMin: 90n, retries: 1, retryDelayMs: 1, log: () => {},
  });
  report(17, "verifySwapBalances marks the outcome inconclusive instead of verifying or failing",
    v.ok === false && v.inconclusive === true && v.verdict === SWAP_VERIFY.INCONCLUSIVE,
    `ok=${v.ok} inconclusive=${v.inconclusive} verdict=${v.verdict}`);
}

{ // [18] balanceOfAtBlock refuses to answer without a block tag
  const p = new Chain({ head: 200, balances: { [T_IN]: { 105: 42n, 200: 7n } } });
  const at105 = await balanceOfAtBlock(p, T_IN, WALLET, 105);
  const at200 = await balanceOfAtBlock(p, T_IN, WALLET, 200);
  report(18, "balanceOfAtBlock is genuinely historical (42 @105 vs 7 @200, same address)",
    at105 === 42n && at200 === 7n && p.tags.every(t => String(t).startsWith("0x")),
    `@105=${at105} @200=${at200} tags=[${p.tags.join(",")}]`);
}

{ // [19] summarizeSwapTransfers only counts this wallet's own legs
  const s = summarizeSwapTransfers(
    { logs: [transferLog({ token: T_IN, from: WALLET, to: ethers.ZeroAddress, value: 100n }),
             transferLog({ token: T_OUT, from: ethers.ZeroAddress, to: WALLET, value: 90n }),
             transferLog({ token: T_OUT, from: ethers.ZeroAddress, to: "0x3333333333333333333333333333333333333333", value: 999n })] },
    T_IN, T_OUT, WALLET,
  );
  report(19, "summarizeSwapTransfers ignores legs that do not touch the wallet",
    s.available && s.outCount === 1 && s.inCount === 1 && s.outSum === 100n && s.inSum === 90n,
    `in=${s.inSum}/${s.inCount} out=${s.outSum}/${s.outCount}`);
}

// ─── summary ────────────────────────────────────────────────────────────────
const passed = results.filter(r => r.ok).length;
console.log(`\n${"═".repeat(70)}`);
console.log(`  SWAP GAS + VERIFY REGRESSION: ${passed}/${results.length} PASS`);
if (passed !== results.length) {
  console.log("  FAILURES:");
  for (const r of results) if (!r.ok) console.log(`   - [${r.n}] ${r.name} :: ${r.detail}`);
}
console.log("  transactions sent: 0 (read-only fake provider, live-TX guard active)");
console.log(`${"═".repeat(70)}\n`);

if (realStateHash() !== SHA_BEFORE) { console.error("STATE FILE MODIFIED — aborting"); process.exit(2); }
process.exit(passed === results.length ? 0 : 1);
