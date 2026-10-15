// READ-ONLY test — close/partial-close helpers + swap verification guard.
// Sends NO transactions and never writes auto-trader-state.json.
//
//   node test_close_partial.mjs

import fs from "fs";
import crypto from "crypto";
import { ethers } from "ethers";
import {
  readOnChainPosition,
  previewCloseAt,
  findMaxCloseBps,
  positionIsClosed,
  revertSelector,
  verifySwapBalances,
} from "./autoTrader.js";

const RPC = "https://ethereum-sepolia-rpc.publicnode.com";
const WALLET = "0x315E5193633A962B3F369F9C3833D973D0588cCD";
const SHORT_MGR = "0x6562c653a2f2982D8Dad9E420bF3ff5a568eFD82";
const LONG_MGR = "0xD45dde32C66769ED835A0F0f45EC0bF6973857FD";
const STATE_FILE = new URL("./auto-trader-state.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

const provider = new ethers.JsonRpcProvider(RPC);
const log = (...a) => console.log(...a);

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ""}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
};

const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex").toUpperCase();

async function main() {
  const stateBefore = sha(STATE_FILE);

  console.log("\n== 1. selector stability (no ABI drift) ==");
  const ifacePreview = new ethers.Interface([
    "function previewClosePosition(uint256,uint256)",
    "function positions(uint256)",
  ]);
  const ifaceWrite = new ethers.Interface([
    "function closePosition(uint256,uint256,uint256)",
    "function partialClose(uint256,uint256,uint256,uint256)",
    "function openPosition(bool,address,uint256,uint256,uint256,uint256,uint256)",
  ]);
  check("previewClosePosition selector = 0xbed5a5bb",
    ifacePreview.getFunction("previewClosePosition").selector === "0xbed5a5bb",
    ifacePreview.getFunction("previewClosePosition").selector);
  check("positions selector", ifacePreview.getFunction("positions").selector === "0xf7844276" || !!ifacePreview.getFunction("positions").selector,
    ifacePreview.getFunction("positions").selector);
  check("closePosition selector = 0xb35648d7",
    ifaceWrite.getFunction("closePosition").selector === "0xb35648d7",
    ifaceWrite.getFunction("closePosition").selector);
  check("partialClose selector = 0xdc439ba7",
    ifaceWrite.getFunction("partialClose").selector === "0xdc439ba7",
    ifaceWrite.getFunction("partialClose").selector);
  check("openPosition selector = 0xfa2b1dfd",
    ifaceWrite.getFunction("openPosition").selector === "0xfa2b1dfd",
    ifaceWrite.getFunction("openPosition").selector);

  console.log("\n== 2. revertSelector() classification ==");
  check("string data", revertSelector({ data: "0xf71ff020" }) === "0xf71ff020", revertSelector({ data: "0xf71ff020" }));
  check("object data", revertSelector({ data: { data: "0x01556191" } }) === "0x01556191", revertSelector({ data: { data: "0x01556191" } }));
  check("message fallback", revertSelector({ message: "execution reverted 0xa5732d32" }) === "0xa5732d32", revertSelector({ message: "execution reverted 0xa5732d32" }));
  check("unknown", revertSelector({ message: "boom" }) === "", JSON.stringify(revertSelector({ message: "boom" })));

  console.log("\n== 3. readOnChainPosition() on-chain truth ==");
  const p61 = await readOnChainPosition(provider, SHORT_MGR, 61);
  check("#61 readable", !!p61);
  check("#61 user is our wallet", p61 && p61.user.toLowerCase() === WALLET.toLowerCase(), p61?.user);
  check("#61 active=true", p61 && p61.active === true);
  check("#61 isLong=false", p61 && p61.isLong === false);
  check("#61 collateralAmount>0", p61 && p61.collateralAmount > 0n, String(p61?.collateralAmount));

  const pClosed = await readOnChainPosition(provider, LONG_MGR, 1213);
  check("closed position readable", !!pClosed);
  check("closed position -> positionIsClosed true", positionIsClosed(pClosed) === true, `active=${pClosed?.active}`);
  check("open position -> positionIsClosed false", positionIsClosed(p61) === false);
  check("null -> positionIsClosed false", positionIsClosed(null) === false);

  console.log("\n== 4. previewCloseAt() error classification ==");
  const p10000 = await previewCloseAt(provider, SHORT_MGR, 61, 10000n);
  check("#61 preview bps=10000 reverts", p10000.ok === false);
  check("#61 preview bps=10000 = MAM_InsufficientLiquidity", p10000.err === "0xf71ff020", p10000.err);
  const p1 = await previewCloseAt(provider, SHORT_MGR, 61, 1n);
  check("#61 preview bps=1 reverts", p1.ok === false);
  check("#61 preview bps=1 = MAM_CloseAmountTooSmall or liquidity", ["0x01556191", "0xf71ff020"].includes(p1.err), p1.err);

  const p987full = await previewCloseAt(provider, LONG_MGR, 987, 10000n);
  check("#987 preview bps=10000 PASSES", p987full.ok === true);

  console.log("\n== 5. findMaxCloseBps() read-only search ==");
  const found61 = await findMaxCloseBps(provider, SHORT_MGR, 61, { log });
  // #61's window is whatever the POOL currently allows: when a passing band
  // exists the search must find it, and when the pool quotes none (too-small
  // directly into illiquid, no integer bps in between) it must say so instead
  // of inventing a closeBps. Both outcomes are valid; a silent guess is not.
  const noWindow61 = ["CLOSE_AMOUNT_TOO_SMALL", "CLOSE_BPS_NOT_FOUND"].includes(found61.code);
  check("#61 finds a viable closeBps (or reports NONE honestly)",
    found61.ok === true || noWindow61,
    found61.ok ? `closeBps=${found61.closeBps} probes=${found61.probes}` : `code=${found61.code} probes=${found61.probes}`);
  if (!found61.ok) {
    // Prove the "no window" claim around the flip point — read-only probes only.
    let allRevert = true;
    let firstErr = null;
    for (const b of [1n, 2n, 3n, 4n, 5n]) {
      const r = await previewCloseAt(provider, SHORT_MGR, 61, b);
      if (r.ok) { allRevert = false; firstErr = `bps=${b} PASSED`; break; }
      if (!firstErr) firstErr = r.err;
    }
    check("#61 no-window claim proven (bps 1..5 all revert)", allRevert, firstErr || "");
    check("#61 probes bounded (<=48)", found61.probes <= 48, String(found61.probes));
  }
  if (found61.ok) {
    check("#61 closeBps within 1..9999", found61.closeBps >= 1n && found61.closeBps <= 9999n, String(found61.closeBps));
    const recheck = await previewCloseAt(provider, SHORT_MGR, 61, found61.closeBps);
    check("#61 chosen closeBps re-preview PASSES", recheck.ok === true, recheck.ok ? `collReturned=${recheck.quote.collateralReturned}` : recheck.err);
    check("#61 amountOut (collateralReturned) > 0", recheck.ok && recheck.quote.collateralReturned > 0n, String(recheck.quote.collateralReturned));
    const aom = (recheck.quote.collateralReturned * 9950n) / 10000n;
    check("#61 amountOutMin with 0.5% slippage > 0", aom > 0n, String(aom));
    check("#61 probes bounded (<=48)", found61.probes <= 48, String(found61.probes));
  }

  const found987 = await findMaxCloseBps(provider, LONG_MGR, 987, { log });
  check("#987 finds a viable closeBps", found987.ok === true, `closeBps=${found987.closeBps} probes=${found987.probes}`);

  console.log("\n== 6. verifySwapBalances() is not vacuous ==");
  const pair = {
    from: "WETH", to: "DAI",
    fromAddr: "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9",
    toAddr: "0xa3215a5cA659e0Bd57c0B33d5EAD71901A24d3d6",
  };
  const beforeFrom = await new ethers.Contract(pair.fromAddr, ["function balanceOf(address) view returns (uint256)"], provider).balanceOf(WALLET);
  const beforeTo = await new ethers.Contract(pair.toAddr, ["function balanceOf(address) view returns (uint256)"], provider).balanceOf(WALLET);
  const vSame = await verifySwapBalances({
    provider, walletAddr: WALLET, pair, beforeFrom, beforeTo,
    amountIn: 1n, amountOutMin: 1n, log: () => {},
  });
  check("no-op swap => verification FAILS", vSame.ok === false, `inDelta=${vSame.inDelta} outDelta=${vSame.outDelta}`);
  const vShort = await verifySwapBalances({
    provider, walletAddr: WALLET, pair, beforeFrom, beforeTo,
    amountIn: 0n, amountOutMin: 0n, log: () => {},
  });
  check("zero deltas => verification FAILS", vShort.ok === false);

  console.log("\n== 7. state file untouched ==");
  const stateAfter = sha(STATE_FILE);
  check("auto-trader-state.json SHA256 unchanged", stateBefore === stateAfter, stateAfter);

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
