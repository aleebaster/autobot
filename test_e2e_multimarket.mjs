// E2E multi-market: discover → SWAP both dirs → OPEN/CLOSE LONG + SHORT on different markets
import { ethers } from "ethers";
import fs from "fs";
import {
  openPosition, closePositionFn, resolveTradingMarket, TxManager,
} from "./autoTrader.js";
import {
  discoverMarkets, collateralForSide, collateralDecimalsForSide, collateralSymbolForSide,
  paymentTokenForMarket, supportsSide, formatMarketsTable, formatCoverageTable,
} from "./marketDiscovery.js";
import { discoverSwapRoutes, findRoute } from "./swapRoutes.js";
import {
  getFactoryAddress, getRouterAddress, getAllTokens, getConfirmedPools, getKnownMarkets,
} from "./deployments/index.js";
import { tokenMetaOnChain } from "./autoTrader.js";

const RPC = "https://ethereum-sepolia-rpc.publicnode.com";
const results = [];
const log = (msg, level = "info") => {
  const ts = new Date().toISOString().slice(11, 19);
  const icon = { info: " ", warn: "W", error: "E", success: "OK" }[level] || " ";
  console.log(`[${ts}] ${icon} ${msg}`);
};
function record(step, ok, detail = {}) {
  results.push({ step, ok, ...detail });
  log(`${ok ? "PASS" : "FAIL"} ${step} ${JSON.stringify(detail)}`, ok ? "success" : "error");
}

async function swapToken({ wallet, provider, fromAddr, toAddr, amountIn, txManager }) {
  const routerAbi = [
    "function getAmountsOut(uint256,address[]) view returns (uint256[])",
    "function swapExactTokensForTokens(uint256,uint256,address[],address,uint256) returns (uint256[])",
  ];
  const router = new ethers.Contract(getRouterAddress(), routerAbi, wallet);
  const erc = (a) => new ethers.Contract(a, [
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address,address) view returns (uint256)",
    "function approve(address,uint256) returns (bool)",
  ], wallet);
  const from = erc(fromAddr);
  const meta = await tokenMetaOnChain(provider, fromAddr);
  const bal = await from.balanceOf(wallet.address);
  const use = amountIn > bal ? bal : amountIn;
  if (use <= 0n) return null;
  const quote = await router.getAmountsOut(use, [fromAddr, toAddr]);
  const amountOutMin = quote[quote.length - 1] * 97n / 100n;
  const al = await from.allowance(wallet.address, router.target);
  if (al < use) {
    const atx = await from.approve(router.target, ethers.MaxUint256);
    await atx.wait();
  }
  const deadline = Math.floor(Date.now() / 1000) + 1200;
  const send = (nonce) => router.swapExactTokensForTokens(use, amountOutMin, [fromAddr, toAddr], wallet.address, deadline, { gasLimit: 300000n, nonce });
  const r = await txManager.sendAndWait({ wallet, provider, txType: "SWAP-E2E", sendFn: send, log });
  const out = ethers.formatUnits(quote[quote.length - 1], (await tokenMetaOnChain(provider, toAddr)).decimals);
  record(`SWAP ${meta.symbol}→? ${use}`, !!(r && r.status === 1), {
    hash: r?.hash, from: meta.symbol, amountIn: ethers.formatUnits(use, meta.decimals), expectedOut: out,
  });
  return !!(r && r.status === 1);
}

async function openCloseOn({ wallet, provider, market, side, leverage, config, txManager }) {
  const collToken = collateralForSide(market, side);
  const dec = collateralDecimalsForSide(market, side);
  const collSym = collateralSymbolForSide(market, side);
  const pay = paymentTokenForMarket(market);
  const amount = ethers.parseUnits(side === "LONG" ? "10" : "10", dec === 18 ? 3 : 6); // small: 10 units (or 0.001 WETH if 18)
  const amountUse = dec === 18 ? ethers.parseUnits("0.002", 18) : ethers.parseUnits("10", 6);
  const token = new ethers.Contract(collToken, [
    "function balanceOf(address) view returns (uint256)",
  ], provider);
  let bal = await token.balanceOf(wallet.address);
  log(`${market.marketSymbol} ${side}: coll=${collSym} bal=${ethers.formatUnits(bal, dec)} need=${ethers.formatUnits(amountUse, dec)}`);
  if (bal < amountUse) {
    const src = pay && String(pay).toLowerCase() !== String(collToken).toLowerCase() ? pay : getConfirmedPools()["NEMESIS/USDT"] && "0x5f2E83cCDEa73D60aF400e03F1Cd8Fb9eaB07b20";
    if (src) await swapToken({ wallet, provider, fromAddr: src, toAddr: collToken, amountIn: ethers.parseUnits("20", 6), txManager });
    bal = await token.balanceOf(wallet.address);
  }
  if (bal < amountUse) {
    record(`OPEN ${side} ${market.marketSymbol}`, false, { reason: "insufficient collateral" });
    return null;
  }

  const open = await openPosition({
    wallet, provider,
    managerAddr: market.managerAddr,
    poolAddr: market.poolAddr,
    side,
    collateralToken: collToken,
    collateralAmount: amountUse,
    leverage,
    config, log, dryRun: false, txManager,
    paymentToken: pay,
  });
  const openOk = !!(open && open.positionId);
  record(`OPEN ${side} ${market.marketSymbol}`, openOk, {
    positionId: open?.positionId, txHash: open?.txHash,
    market: market.marketSymbol, manager: market.managerAddr, collateral: collSym,
  });
  if (!openOk) return null;

  const close = await closePositionFn({
    wallet, provider,
    managerAddr: market.managerAddr,
    positionId: open.positionId,
    config, log, dryRun: false, txManager,
  });
  const closeOk = !!(close && !close.failed && !close.dryRun);
  record(`CLOSE ${side} ${market.marketSymbol} #${open.positionId}`, closeOk, {
    txHash: close?.txHash, positionId: open.positionId, manager: market.managerAddr,
  });
  return { open, close };
}

async function main() {
  const pk = fs.readFileSync("wallets/pk.txt", "utf8").trim();
  const provider = new ethers.JsonRpcProvider(RPC, 11155111);
  const wallet = new ethers.Wallet(pk, provider);
  const config = JSON.parse(fs.readFileSync("config.json", "utf8"));
  config.deadlineSeconds = config.deadlineSeconds || 1200;
  config.maxLeverage = 5;
  config.slippageBps = 50;
  config.ethGuard = { MIN_ETH_GAS_RESERVE: 0.003 };
  config.availableMarkets = config.availableMarkets || [];
  config.preferredMarket = null;

  const txManager = new TxManager();
  console.log("=== MULTI-MARKET E2E START ===");
  console.log("Wallet:", wallet.address);

  // 1) Discover markets
  const d = await discoverMarkets({
    provider,
    factoryAddress: getFactoryAddress(),
    tokens: getAllTokens(),
    availableMarkets: config.availableMarkets,
    confirmedPools: getConfirmedPools(),
    knownMarkets: getKnownMarkets(),
    runtime: {},
    log,
  });
  record("DISCOVER markets", d.markets.length >= 2, { count: d.markets.length });
  console.log(formatMarketsTable(d.markets));
  console.log(formatCoverageTable(d.markets, {}));

  // 2) Discover routes
  const tokens = [];
  const seen = new Set();
  for (const m of d.markets) {
    for (const [addr, sym, dec] of [[m.token0, m.token0Symbol, m.token0Decimals], [m.token1, m.token1Symbol, m.token1Decimals]]) {
      const k = String(addr).toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      tokens.push({ address: addr, symbol: sym, decimals: dec });
    }
  }
  const routes = await discoverSwapRoutes({
    provider, routerAddress: getRouterAddress(), factoryAddress: getFactoryAddress(),
    tokens, log,
  });
  record("DISCOVER routes", routes.length >= 2, { count: routes.length });

  // 3) SWAP both directions on first direct pair
  const direct = routes.find(r => r.type === "direct");
  if (direct) {
    await swapToken({ wallet, provider, fromAddr: direct.fromAddr, toAddr: direct.toAddr, amountIn: ethers.parseUnits("5", 6), txManager });
    await swapToken({ wallet, provider, fromAddr: direct.toAddr, toAddr: direct.fromAddr, amountIn: ethers.parseUnits("1", 18), txManager });
  }

  // 4) Pick two different active markets for LONG / SHORT
  // Prefer healthy oracles for E2E (NEMESIS TWAP often has extreme deviation on Sepolia)
  const longPrefer = ["USDC/USDT", "WETH/DAI", "USDT/DAI", "USDC/WETH"];
  const shortPrefer = ["USDT/DAI", "WETH/DAI", "USDC/WETH", "WETH/UNI", "USDC/DAI"];
  const findMkt = (prefs, excludeManager = null) => {
    for (const s of prefs) {
      const m = d.markets.find(x => x.marketSymbol === s);
      if (!m || !m.isActive) continue;
      if (excludeManager && m.managerAddr?.toLowerCase() === excludeManager.toLowerCase()) continue;
      return m;
    }
    return d.markets.find(m =>
      m.isActive && (!excludeManager || m.managerAddr?.toLowerCase() !== excludeManager.toLowerCase())
    ) || null;
  };
  const longMkt = findMkt(longPrefer);
  const shortMkt = findMkt(shortPrefer, longMkt?.managerAddr) || longMkt;
  if (!longMkt || !shortMkt) {
    record("PICK markets", false, { long: longMkt?.marketSymbol, short: shortMkt?.marketSymbol });
    throw new Error("need markets");
  }
  record("PICK markets", true, { long: longMkt.marketSymbol, short: shortMkt.marketSymbol });

  // 5) OPEN+CLOSE LONG on market A
  await openCloseOn({ wallet, provider, market: longMkt, side: "LONG", leverage: 2, config, txManager });

  // 6) OPEN+CLOSE SHORT on market B (different manager when possible)
  await openCloseOn({ wallet, provider, market: shortMkt, side: "SHORT", leverage: 2, config, txManager });

  // Summary
  const pass = results.filter(r => r.ok).length;
  const fail = results.filter(r => !r.ok).length;
  console.log("\n═══════════════════════════════════════");
  console.log(`  E2E RESULTS: ${pass} pass, ${fail} fail`);
  console.log("═══════════════════════════════════════");
  for (const r of results) console.log(`  ${r.ok ? "✅" : "❌"} ${r.step}`);
  fs.writeFileSync("E2E_MULTIMARKET_RESULTS.json", JSON.stringify({ pass, fail, results }, null, 2));
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => {
  console.error("E2E FATAL:", e);
  process.exit(1);
});
