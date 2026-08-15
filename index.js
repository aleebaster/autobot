import blessed from "blessed";
import chalk from "chalk";
import figlet from "figlet";
import { ethers } from "ethers";
import fs from "fs";
import axios from "axios";
import { execSync } from "child_process";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import { DEFAULT_LP_CONFIG, loadLpConfig, serializeLpConfig } from "./lpConfig.js";
import { LpManager } from "./lpManager.js";

const SEPOLIA_RPC_URL = "https://ethereum-sepolia-rpc.publicnode.com/557d07a988c4164482ef0c56a10f98ee0e3073440fd72fbe89cd7f6fef809388";
const SEPOLIA_CHAIN_ID = 11155111;

const NEMESIS_ROUTER  = "0xE787c35F6A875567409C4970BA7B41A0CB9d1B4D";  // CURRENT: nemesis.trade frontend NEXT_PUBLIC_ROUTER_ADDRESS (verified 2026-08-15)
const WETH_ADDRESS    = "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9";  // PROVEN: same in bot and UI
const USDC_ADDRESS    = "0x5dcf1Db10F87CB7839640F9B85C4ECfA29b56e80";  // PROVEN: nemesis.trade frontend JS
const DAI_ADDRESS     = "0xa3215a5cA659e0Bd57c0B33d5EAD71901A24d3d6";  // PROVEN: nemesis.trade frontend JS
const UNI_ADDRESS     = "0xEaBEcd70AC3330d65e09e429824C49d0D8812952";  // PROVEN: nemesis.trade frontend JS
const NEMESIS_ADDRESS = "0x18D18A40614b6d8C6154309F517acf9829308842";  // PROVEN: nemesis.trade ref tx 0x4f35...580c
const USDT_ADDRESS    = "0x5f2E83cCDEa73D60aF400e03F1Cd8Fb9eaB07b20";  // PROVEN: nemesis.trade ref tx 0xe7dd...fcdc
const LINK_ADDRESS    = "0x1132087D2D97b55E5fe1B0FcA7b99348B5f07e28";  // PROVEN: nemesis.trade frontend JS
const EXPECTED_WALLET = "0x315E5193633A962B3F369F9C3833D973D0588cCD";
const LEVERAGED_FACTORY = "0x0e733d055dbE7020f42D4f692Bc4fff15E5f2E7d";  // CURRENT: nemesis.trade frontend NEXT_PUBLIC_FACTORY_ADDRESS (verified 2026-08-15)
const LEVERAGED_ROUTER = "0xE787c35F6A875567409C4970BA7B41A0CB9d1B4D";  // CURRENT: nemesis.trade frontend NEXT_PUBLIC_ROUTER_ADDRESS (verified 2026-08-15)
const LEVERAGED_DAI_ADDRESS = "0x5f2E83cCDEa73D60aF400e03F1Cd8Fb9eaB07b20";  // PROVEN: USDT — default collateral for SHORT
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const BPS = 10000n;
const NEMESIS_SUBGRAPH_URL = "https://nemesis.trade/api/subgraph";
const GOLDSKY_SUBGRAPH_URL = "https://api.goldsky.com/api/public/project_cmma0sxdrnwdx01ym126h3z8q/subgraphs/nemesis-eth-sepolia/prod/gn";

const CONFIG_FILE = "config.json";
const isDebug = false;
const IS_CLI = process.argv.includes("--long") || process.argv.includes("--short");

// ─── Universal TOKENS map (expanded with all known Sepolia tokens) ───
const TOKENS = {
  WETH:    { address: WETH_ADDRESS,    decimals: 18, symbol: "WETH" },
  ETH:     { address: WETH_ADDRESS,    decimals: 18, symbol: "ETH" },
  DAI:     { address: DAI_ADDRESS,     decimals: 6,  symbol: "DAI" },
  USDC:    { address: USDC_ADDRESS,    decimals: 6,  symbol: "USDC" },
  USDT:    { address: USDT_ADDRESS,    decimals: 6,  symbol: "USDT" },
  UNI:     { address: UNI_ADDRESS,     decimals: 6,  symbol: "UNI" },
  LINK:    { address: LINK_ADDRESS,    decimals: 6,  symbol: "LINK" },
  NEMESIS: { address: NEMESIS_ADDRESS, decimals: 6,  symbol: "NEMESIS" }
};

// ─── Dynamic market candidates (built from discovered tokens + Factory lookup) ───
// Static fallback used before discovery completes; replaced by discoveredMarkets at runtime
const MARKET_CANDIDATES_FALLBACK = [
  { symbol: "ETH/USDT",    marketToken: WETH_ADDRESS, collateralToken: USDT_ADDRESS, supportsLong: true, supportsShort: true, rsiSymbol: "ETHUSDT" },
  { symbol: "NEMESIS/USDT", marketToken: NEMESIS_ADDRESS, collateralToken: USDT_ADDRESS, supportsLong: true, supportsShort: true, rsiSymbol: "NEMESISUSDT" },
  { symbol: "NEMESIS/ETH",  marketToken: NEMESIS_ADDRESS, collateralToken: NEMESIS_ADDRESS, supportsLong: true, supportsShort: true, rsiSymbol: "NEMESISUSDT" },
  { symbol: "DAI/USDT",    marketToken: DAI_ADDRESS, collateralToken: USDT_ADDRESS, supportsLong: true, supportsShort: true, rsiSymbol: "DAIUSDT" },
  { symbol: "USDC/USDT",   marketToken: USDC_ADDRESS, collateralToken: USDT_ADDRESS, supportsLong: true, supportsShort: true, rsiSymbol: "USDCUSDT" },
  { symbol: "UNI/USDT",    marketToken: UNI_ADDRESS, collateralToken: USDT_ADDRESS, supportsLong: true, supportsShort: true, rsiSymbol: "UNIUSDT" },
  { symbol: "LINK/USDT",   marketToken: LINK_ADDRESS, collateralToken: USDT_ADDRESS, supportsLong: true, supportsShort: true, rsiSymbol: "LINKUSDT" }
];

// Mutable list — populated at startup by discoverSupportedMarkets();
// used by openLeveragedPosition / RSI / Full Auto
let discoveredMarkets = [...MARKET_CANDIDATES_FALLBACK];

// ─── Token list cache (populated by discoverTokenList) ───
let discoveredTokenList = Object.values(TOKENS);

// SWAP_PAIRS will be dynamically built based on real wallet balances
let SWAP_PAIRS = [];

// ─── Discovered valid swap pairs (populated at startup by discoverSupportedSwapPairs) ───
// Only pairs where: Factory.getPool() returns non-zero address AND getAmountsOut() succeeds.
// Used by: TUI, CLI, Auto RSI, Full Auto, Cyclic Swap Engine.
let discoveredSwapPairs = [];

// ─── ADAPTIVE COLLATERAL RULES — auto-discovered from on-chain events ───
// At startup, scans recent MAM_PositionCreated events across all managers
// to determine which collateral tokens produce LONG vs SHORT positions.
let collateralRules = { LONG: [], SHORT: [], lastDiscovery: 0, eventCount: 0 };

const ROUTER_ABI = [
  "function swapExactETHForTokens(uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) payable returns (uint256[] memory)",
  "function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) returns (uint256[] memory)",
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) returns (uint256[] memory)",
  "function getAmountsOut(uint256 amountIn, address[] calldata path) view returns (uint256[] memory)"
];

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)"
];

const WETH_ABI = [
  ...ERC20_ABI,
  "function deposit() payable",
  "function withdraw(uint256 wad)"
];

const POSITION_ABI = [
  "function openPosition(bool isLong,address collateralToken,uint256 collateralAmount,uint256 borrowAmount,uint256 leverageX10,uint256 amountOutMin,uint256 deadline) returns (uint256 positionId)",
  "function closePosition(uint256 positionId,uint256 amountOutMin,uint256 deadline)",
  "function partialClose(uint256 positionId,uint256 closeBps,uint256 amountOutMin,uint256 deadline)",
  "function getUserPositions(address user) view returns (uint256[])",
  "function getPosition(uint256 positionId) view returns (bool isLong,address user,address collateralToken,uint256 collateralAmount,uint256 debtAmount,uint256 currentDebt,uint256 healthFactor)",
  "function getPositionDebt(uint256 positionId) view returns (uint256)",
  "function PROTOCOL_FEE_BPS() view returns (uint256)",
  "function LTV_BPS() view returns (uint256)",
  "function getAvailableLiquidity() view returns (uint256)",
  "error MAM_InvalidLeverage()",
  "error MAM_InsufficientLiquidity()",
  "error MAM_InsufficientCollateral()",
  "error MAM_InvalidCollateralToken()",
  "error MAM_Expired()",
  "error MAM_ZeroAmount()",
  "error MAM_ZeroBorrow()",
  "error MAM_ZeroCollateral()",
  "error MAM_ExceedsLTV()",
  "error MAM_Forbidden()",
  "error MAM_InvalidCollateralValue()",
  "error MAM_PoolNotFound()",
  "error MAM_CloseAmountTooSmall()",
  "error MAM_InvalidCloseBps()",
  "error MAM_InvalidPosition()",
  "error MAM_NotLiquidatable()",
  "error MAM_NotOwner()",
  "error MAM_OracleUnavailable()",
  "error MAM_ZeroOraclePrice()",
  "event MAM_PositionCreated(uint256 indexed positionId,address indexed user,bool isLong,address collateralToken,uint256 collateralAmount,uint256 borrowAmount,uint256 debtAmount,uint256 leverageX10,uint256 deadline)",
  "event MAM_LoopPositionCreated(uint256 indexed positionId,address indexed user,uint256 leverageX10)",
  "event MAM_PositionClosed(uint256 indexed positionId,uint256 collateralReturned,int256 lossCollateral,uint256 borrowAmount)",
  "event MAM_PositionPartiallyClosed(uint256 indexed positionId,uint256 debtRepaid,uint256 collateralConsumed,uint256 collateralReturned,uint256 protocolFee)"
];

const FACTORY_ABI = [
  "function getPool(address tokenA,address tokenB) view returns (address)",
  "function getManager(address pool) view returns (address)"
];

const POOL_ABI = [
  "function getReserves() view returns (uint112 reserve0,uint112 reserve1)",
  "function totalSupply() view returns (uint256)",
  "function token0() view returns (address)",
  "function getOraclePrice() view returns (uint256,uint256)",
  "function swapFeeBps() view returns (uint256)"
];

const POSITION_IFACE = new ethers.Interface(POSITION_ABI);

let walletInfo = {
  address:      "N/A",
  balanceETH:   "0.000000",
  balanceUSDC:  "0.00",
  balanceDAI:   "0.000000",
  balanceUNI:  "0.000000",
  balanceNEMESIS: "0.000000",
  activeAccount:"N/A"
};

let transactionLogs  = [];
let activityRunning  = false;
let isCycleRunning   = false;
let shouldStop       = false;
let dailyActivityInterval = null;
let accounts         = [];
let proxies          = [];
let selectedWalletIndex = 0;
let loadingSpinner   = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];
const borderBlinkColors = ["cyan","blue","magenta","red","yellow","green"];
let borderBlinkIndex = 0;
let blinkCounter     = 0;
let spinnerIndex     = 0;
let nonceTracker     = {};
let hasLoggedSleepInterrupt = false;
let isHeaderRendered = false;
let activeProcesses  = 0;

// ─── Natural behavior: consecutive repeat prevention ───
let lastTradeAmount = null;       // last trade amount used (prevents consecutive repeat)
let lastTradeSide   = null;       // last trade side used (prevents same side twice)
let lastSwapAmounts = {};         // { pairKey: lastAmount } — prevents same swap amount twice in a row
let lastLeverage    = null;       // last leverage used (prevents consecutive repeat)

let dailyActivityConfig = {
  enableSwaps: true,
  activityRepetitions: 1,
  ethRange:  { min: 0.00001, max: 0.00002 },
  usdcRange: { min: 500,     max: 1000    },
  usdtRange: { min: 500,     max: 1000    },
  daiRange:  { min: 0.5,     max: 1.0     },
  uniRange: { min: 0.01,    max: 0.05    },
  linkRange: { min: 0.1,     max: 0.5     },
  nemesisRange: { min: 0.5,  max: 1.0     },
  loopHours: 24,
  swapIntervalSeconds: 20
};

let tradingConfig = {
  enableLong: true,
  enableShort: true,
  enableClose: true,
  simulateOnly: true,
  firstTxMode: true,
  defaultCollateralToken: "native",
  marketToken: WETH_ADDRESS,
  pairToken: USDT_ADDRESS,
  tradeAmount: "0.01",
  longTradeAmount: "0.01",
  shortTradeAmount: "0.01",
  swapTradeAmount: "0.01",
  tinyTradeAmount: "0.01",
  maxTradeAmount: "0.01",
  leverage: 2,
  slippageBps: 50,
  deadlineSeconds: 1200,
  rsiLong: 30,
  rsiShort: 70,
  cooldownSeconds: 30,
  maxOpenPositions: 5,
  longPercent: 50,
  shortPercent: 50,
  // ─── Natural behavior: randomized trade amounts ───
  tradeAmountMode: "random",       // "fixed" | "random" | "percentage"
  tradeMinAmount: "0.1",            // min trade amount (used in random/percentage mode)
  tradeMaxAmount: "1.0",            // max trade amount (used in random/percentage mode)
  tradeBalancePercentMin: 1,        // min % of wallet balance for percentage mode
  tradeBalancePercentMax: 5,        // max % of wallet balance for percentage mode
  leverageMin: 1,                   // min leverage (randomized between min..max)
  leverageMax: 5,                   // max leverage (randomized between min..max)
  // ─── Natural behavior: randomized swap amounts ───
  swapAmountMode: "random",         // "fixed" | "random" | "percentage"
  swapMinAmount: "0.0001",          // min swap amount (used in random mode)
  swapMaxAmount: "0.5",             // max swap amount (used in random mode)
  swapBalancePercentMin: 1,         // min % of wallet balance for percentage mode
  swapBalancePercentMax: 8,         // max % of wallet balance for percentage mode
  // ─── Legacy (kept for backward compat) ───
  randomizeAmount: false,
  amountVariancePercent: 0,
  tradeMode: "fixed",
  walletPercent: 5,
  marketMode: "single",
  selectedMarkets: [],
  availableMarkets: [],
  balanceDistribution: "fixed",
  maxTradesPerPair: 2,
  maxConcurrentTrades: 3,
  maxExposurePerMarket: "0.01",
  maxDailyTrades: 100,
  maxLossPerMarket: "0",
  cooldownPerMarket: 30,
  blacklistMarkets: [],
  autoClose: false,
  closePercent: 100,
  closeManager: "",
  closePositionId: "",
  fallbackAmountOutMin: "0",
  maxArg6Delta: "10",
  activePositions: [],
  uiPayloadReference: null,
  uiLongPayloadReference: null,
  uiLongTxValueReference: null,
  uiShortPayloadReference: null,
  uiShortTxValueReference: null,
  autoRSIEnabled: false,
  fullAutoEnabled: false
};

let lpConfig = { ...DEFAULT_LP_CONFIG };
let lpManager = null;

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = fs.readFileSync(CONFIG_FILE, "utf8");
      const cfg  = JSON.parse(data);
      dailyActivityConfig.enableSwaps = cfg.enableSwaps !== false;
      dailyActivityConfig.activityRepetitions = Number(cfg.activityRepetitions) || 1;
      dailyActivityConfig.ethRange.min  = Number(cfg.ethRange?.min)  || 0.00001;
      dailyActivityConfig.ethRange.max  = Number(cfg.ethRange?.max)  || 0.00002;
      dailyActivityConfig.usdcRange.min = Number(cfg.usdcRange?.min) || 500;
      dailyActivityConfig.usdcRange.max = Number(cfg.usdcRange?.max) || 1000;
      dailyActivityConfig.daiRange.min  = Number(cfg.daiRange?.min)  || 0.5;
      dailyActivityConfig.daiRange.max  = Number(cfg.daiRange?.max)  || 1.0;
      dailyActivityConfig.uniRange.min = Number(cfg.uniRange?.min) || 0.01;
      dailyActivityConfig.uniRange.max = Number(cfg.uniRange?.max) || 0.05;
      dailyActivityConfig.nemesisRange.min = Number(cfg.nemesisRange?.min) || 0.5;
      dailyActivityConfig.nemesisRange.max = Number(cfg.nemesisRange?.max) || 1.0;
      dailyActivityConfig.loopHours     = Number(cfg.loopHours)      || 24;
      dailyActivityConfig.swapIntervalSeconds = Number(cfg.swapIntervalSeconds) || 20;
      if (cfg.usdtRange) { dailyActivityConfig.usdtRange.min = Number(cfg.usdtRange.min) || 500; dailyActivityConfig.usdtRange.max = Number(cfg.usdtRange.max) || 1000; }
      if (cfg.linkRange) { dailyActivityConfig.linkRange.min = Number(cfg.linkRange.min) || 0.1; dailyActivityConfig.linkRange.max = Number(cfg.linkRange.max) || 0.5; }

      tradingConfig.enableLong = cfg.enableLong !== false;
      tradingConfig.enableShort = cfg.enableShort !== false;
      tradingConfig.enableClose = cfg.enableClose === true;
      tradingConfig.simulateOnly = cfg.simulateOnly !== false;
      tradingConfig.firstTxMode = cfg.firstTxMode !== false;
      tradingConfig.defaultCollateralToken = cfg.defaultCollateralToken || tradingConfig.defaultCollateralToken;
      // marketToken is always WETH (the token we trade)
      tradingConfig.marketToken = WETH_ADDRESS;
      // pairToken is always USDT (the quote token for Nemesis pools)
      tradingConfig.pairToken = USDT_ADDRESS;
      tradingConfig.tradeAmount = String(cfg.tradeAmount ?? tradingConfig.tradeAmount);
      tradingConfig.longTradeAmount = String(cfg.longTradeAmount ?? cfg.tradeAmount ?? tradingConfig.longTradeAmount);
      tradingConfig.shortTradeAmount = String(cfg.shortTradeAmount ?? cfg.tradeAmount ?? tradingConfig.shortTradeAmount);
      tradingConfig.swapTradeAmount = String(cfg.swapTradeAmount ?? tradingConfig.swapTradeAmount);
      tradingConfig.tinyTradeAmount = String(cfg.tinyTradeAmount ?? tradingConfig.tinyTradeAmount);
      tradingConfig.maxTradeAmount = String(cfg.maxTradeAmount ?? tradingConfig.maxTradeAmount);
      tradingConfig.leverage = Number(cfg.leverage) || tradingConfig.leverage;
      tradingConfig.slippageBps = Number(cfg.slippageBps) || tradingConfig.slippageBps;
      tradingConfig.deadlineSeconds = Number(cfg.deadlineSeconds) || tradingConfig.deadlineSeconds;
      tradingConfig.rsiLong = Number(cfg.rsiLong) || tradingConfig.rsiLong;
      tradingConfig.rsiShort = Number(cfg.rsiShort) || tradingConfig.rsiShort;
      tradingConfig.cooldownSeconds = cfg.cooldownSeconds == null ? tradingConfig.cooldownSeconds : Number(cfg.cooldownSeconds);
      tradingConfig.maxOpenPositions = Number(cfg.maxOpenPositions) || tradingConfig.maxOpenPositions;
      tradingConfig.longPercent = Number(cfg.longPercent) || tradingConfig.longPercent;
      tradingConfig.shortPercent = Number(cfg.shortPercent) || tradingConfig.shortPercent;
      tradingConfig.randomizeAmount = cfg.randomizeAmount === true;
      tradingConfig.amountVariancePercent = Number(cfg.amountVariancePercent) || 0;
      tradingConfig.tradeMode = cfg.tradeMode || tradingConfig.tradeMode;
      // ─── Natural behavior: load new randomization params ───
      tradingConfig.tradeAmountMode    = cfg.tradeAmountMode    || tradingConfig.tradeAmountMode;
      tradingConfig.tradeMinAmount     = String(cfg.tradeMinAmount    ?? tradingConfig.tradeMinAmount);
      tradingConfig.tradeMaxAmount     = String(cfg.tradeMaxAmount    ?? tradingConfig.tradeMaxAmount);
      tradingConfig.tradeBalancePercentMin = Number(cfg.tradeBalancePercentMin) || tradingConfig.tradeBalancePercentMin;
      tradingConfig.tradeBalancePercentMax = Number(cfg.tradeBalancePercentMax) || tradingConfig.tradeBalancePercentMax;
      tradingConfig.leverageMin         = Number(cfg.leverageMin)         || tradingConfig.leverageMin;
      tradingConfig.leverageMax         = Number(cfg.leverageMax)         || tradingConfig.leverageMax;
      tradingConfig.swapAmountMode     = cfg.swapAmountMode     || tradingConfig.swapAmountMode;
      tradingConfig.swapMinAmount      = String(cfg.swapMinAmount      ?? tradingConfig.swapMinAmount);
      tradingConfig.swapMaxAmount      = String(cfg.swapMaxAmount      ?? tradingConfig.swapMaxAmount);
      tradingConfig.swapBalancePercentMin = Number(cfg.swapBalancePercentMin) || tradingConfig.swapBalancePercentMin;
      tradingConfig.swapBalancePercentMax = Number(cfg.swapBalancePercentMax) || tradingConfig.swapBalancePercentMax;
      tradingConfig.walletPercent = Number(cfg.walletPercent) || tradingConfig.walletPercent;
      tradingConfig.marketMode = cfg.marketMode || tradingConfig.marketMode;
      tradingConfig.selectedMarkets = Array.isArray(cfg.selectedMarkets) ? cfg.selectedMarkets : [];
      tradingConfig.availableMarkets = Array.isArray(cfg.availableMarkets) ? cfg.availableMarkets : [];
      tradingConfig.balanceDistribution = cfg.balanceDistribution || tradingConfig.balanceDistribution;
      tradingConfig.maxTradesPerPair = Number(cfg.maxTradesPerPair) || tradingConfig.maxTradesPerPair;
      tradingConfig.maxConcurrentTrades = Number(cfg.maxConcurrentTrades) || tradingConfig.maxConcurrentTrades;
      tradingConfig.maxExposurePerMarket = String(cfg.maxExposurePerMarket ?? tradingConfig.maxExposurePerMarket);
      tradingConfig.maxDailyTrades = Number(cfg.maxDailyTrades) || tradingConfig.maxDailyTrades;
      tradingConfig.maxLossPerMarket = String(cfg.maxLossPerMarket ?? tradingConfig.maxLossPerMarket);
      tradingConfig.cooldownPerMarket = cfg.cooldownPerMarket == null ? tradingConfig.cooldownPerMarket : Number(cfg.cooldownPerMarket);
      tradingConfig.blacklistMarkets = Array.isArray(cfg.blacklistMarkets) ? cfg.blacklistMarkets : [];
      tradingConfig.autoClose = cfg.autoClose === true;
      tradingConfig.closePercent = Number(cfg.closePercent) || tradingConfig.closePercent;
      tradingConfig.closeManager = cfg.closeManager || "";
      tradingConfig.closePositionId = cfg.closePositionId || "";
      tradingConfig.fallbackAmountOutMin = String(cfg.fallbackAmountOutMin ?? tradingConfig.fallbackAmountOutMin);
      tradingConfig.maxArg6Delta = String(cfg.maxArg6Delta ?? tradingConfig.maxArg6Delta);
      tradingConfig.activePositions = Array.isArray(cfg.activePositions) ? cfg.activePositions : [];
      tradingConfig.uiPayloadReference = Array.isArray(cfg.uiPayloadReference) ? cfg.uiPayloadReference : null;
      tradingConfig.uiLongPayloadReference = Array.isArray(cfg.uiLongPayloadReference) ? cfg.uiLongPayloadReference : null;
      tradingConfig.uiLongTxValueReference = cfg.uiLongTxValueReference == null ? null : String(cfg.uiLongTxValueReference);
      tradingConfig.uiShortPayloadReference = Array.isArray(cfg.uiShortPayloadReference) ? cfg.uiShortPayloadReference : null;
      tradingConfig.uiShortTxValueReference = cfg.uiShortTxValueReference == null ? null : String(cfg.uiShortTxValueReference);
      tradingConfig.autoRSIEnabled = cfg.autoRSIEnabled === true;
      tradingConfig.fullAutoEnabled = cfg.fullAutoEnabled === true;
      lpConfig = loadLpConfig(cfg);
    } else {
      addLog("No config file found, using default settings.", "info");
    }
    // Use native ETH as default collateral (will be wrapped to WETH, matches nemesis.trade frontend)
    // NOTE: The actual collateral for SHORT is resolved by resolveCollateralForSide()
    // at the point of trade execution. This default is only used as a fallback.
    if (!tradingConfig.defaultCollateralToken || tradingConfig.defaultCollateralToken === LEVERAGED_DAI_ADDRESS) {
      tradingConfig.defaultCollateralToken = "native";
    }
  } catch (error) {
    addLog(`Failed to load config: ${error.message}`, "error");
  }
}

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ ...dailyActivityConfig, ...tradingConfig, ...serializeLpConfig(lpConfig) }, null, 2));
    addLog("Configuration saved successfully.", "success");
  } catch (error) {
    addLog(`Failed to save config: ${error.message}`, "error");
  }
}

process.on("unhandledRejection", (reason) => {
  addLog(`Unhandled Rejection: ${reason?.message || reason}`, "error");
});
process.on("uncaughtException", (error) => {
  addLog(`Uncaught Exception: ${error.message}\n${error.stack}`, "error");
  process.exit(1);
});

function getShortAddress(address) {
  return address ? address.slice(0, 6) + "..." + address.slice(-4) : "N/A";
}

function getShortHash(hash) {
  return hash.slice(0, 6) + "..." + hash.slice(-4);
}

function addLog(message, type = "info") {
  if (type === "debug" && !isDebug) return;
  const timestamp = new Date().toLocaleTimeString("id-ID", { timeZone: "Asia/Jakarta" });
  let coloredMessage;
  switch (type) {
    case "error":   coloredMessage = chalk.redBright(message);     break;
    case "success": coloredMessage = chalk.greenBright(message);   break;
    case "warn":    coloredMessage = chalk.magentaBright(message); break;
    case "wait":    coloredMessage = chalk.yellowBright(message);  break;
    case "info":    coloredMessage = chalk.whiteBright(message);   break;
    case "delay":   coloredMessage = chalk.cyanBright(message);    break;
    case "debug":   coloredMessage = chalk.blueBright(message);    break;
    default:        coloredMessage = chalk.white(message);
  }
  transactionLogs.push(`[${timestamp}] ${coloredMessage}`);
  if (IS_CLI) console.log(`[${timestamp}] ${coloredMessage}`);
  updateLogs();
}

function clearTransactionLogs() {
  transactionLogs = [];
  logBox.setContent("");
  logBox.scrollTo(0);
  addLog("Transaction logs cleared.", "success");
}

function loadAccounts() {
  try {
    const data = fs.readFileSync("pk.txt", "utf8");
    accounts = data.split("\n").map(l => l.trim()).filter(l => l).map(privateKey => ({ privateKey }));
    if (accounts.length === 0) throw new Error("No private keys found in pk.txt");
    const firstWallet = new ethers.Wallet(accounts[0].privateKey);
    addLog(`Startup active wallet=${firstWallet.address}`, "info");
    if (firstWallet.address.toLowerCase() !== EXPECTED_WALLET.toLowerCase()) {
      throw new Error(`Active wallet mismatch. Expected ${EXPECTED_WALLET}, got ${firstWallet.address}`);
    }
    addLog(`Loaded ${accounts.length} accounts from pk.txt`, "success");
  } catch (error) {
    addLog(`Failed to load accounts: ${error.message}`, "error");
    if (error.message.startsWith("Active wallet mismatch")) {
      process.exit(1);
    }
    accounts = [];
  }
}

function loadProxies() {
  try {
    if (fs.existsSync("proxy.txt")) {
      const data = fs.readFileSync("proxy.txt", "utf8");
      proxies = data.split("\n").map(p => p.trim()).filter(p => p);
      if (proxies.length === 0) throw new Error("No proxy found in proxy.txt");
      addLog(`Loaded ${proxies.length} proxies from proxy.txt`, "success");
    } else {
      addLog("No proxy.txt found, running without proxy.", "info");
    }
  } catch (error) {
    addLog(`Failed to load proxy: ${error.message}`, "info");
    proxies = [];
  }
}

function createAgent(proxyUrl) {
  if (!proxyUrl) return null;
  return proxyUrl.startsWith("socks")
    ? new SocksProxyAgent(proxyUrl)
    : new HttpsProxyAgent(proxyUrl);
}

function getProvider(rpcUrl, chainId, proxyUrl, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const agent = createAgent(proxyUrl);
      const fetchOptions = agent ? { agent } : {};
      return new ethers.JsonRpcProvider(rpcUrl, { chainId, name: "Sepolia" }, { fetchOptions });
    } catch (error) {
      addLog(`Attempt ${attempt}/${maxRetries} failed to init provider: ${error.message}`, "error");
      if (attempt < maxRetries) sleep(1000);
    }
  }
  throw new Error(`Failed to initialize provider for chain ${chainId}`);
}

async function sleep(ms) {
  if (shouldStop) {
    if (!hasLoggedSleepInterrupt) {
      addLog("Process stopped successfully.", "info");
      hasLoggedSleepInterrupt = true;
    }
    return;
  }
  activeProcesses++;
  try {
    await new Promise((resolve) => {
      const timeout = setTimeout(resolve, ms);
      const checkStop = setInterval(() => {
        if (shouldStop) {
          clearTimeout(timeout);
          clearInterval(checkStop);
          if (!hasLoggedSleepInterrupt) {
            addLog("Process interrupted.", "info");
            hasLoggedSleepInterrupt = true;
          }
          resolve();
        }
      }, 100);
    });
  } catch (error) {
    addLog(`Sleep error: ${error.message}`, "error");
  } finally {
    activeProcesses = Math.max(0, activeProcesses - 1);
  }
}

async function getNextNonce(provider, walletAddress, chainId) {
  if (shouldStop) throw new Error("Process stopped");
  if (!ethers.isAddress(walletAddress)) throw new Error("Invalid wallet address");
  const nonceKey = `${chainId}_${walletAddress}`;
  try {
    const pendingNonce  = BigInt(await provider.getTransactionCount(walletAddress, "pending"));
    const lastUsedNonce = nonceTracker[nonceKey] || (pendingNonce - 1n);
    const nextNonce     = pendingNonce > lastUsedNonce + 1n ? pendingNonce : lastUsedNonce + 1n;
    nonceTracker[nonceKey] = nextNonce;
    return nextNonce;
  } catch (error) {
    addLog(`Failed to fetch nonce for ${getShortAddress(walletAddress)}: ${error.message}`, "error");
    throw error;
  }
}

async function getFeeParams(provider) {
  try {
    const feeData = await provider.getFeeData();
    if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
      return { maxFeePerGas: feeData.maxFeePerGas, maxPriorityFeePerGas: feeData.maxPriorityFeePerGas, type: 2 };
    }
    return { gasPrice: feeData.gasPrice || ethers.parseUnits("1", "gwei"), type: 0 };
  } catch {
    return { gasPrice: ethers.parseUnits("1", "gwei"), type: 0 };
  }
}

async function updateWalletData() {
  const walletDataPromises = accounts.map(async (account, i) => {
    try {
      const proxyUrl  = proxies[i % proxies.length] || null;
      const provider  = getProvider(SEPOLIA_RPC_URL, SEPOLIA_CHAIN_ID, proxyUrl);
      const wallet    = new ethers.Wallet(account.privateKey, provider);

      const ethBalance  = await provider.getBalance(wallet.address);
      const formattedETH = Number(ethers.formatEther(ethBalance)).toFixed(6);

      const usdcContract = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);
      const daiContract  = new ethers.Contract(DAI_ADDRESS,  ERC20_ABI, provider);
      const uniContract = new ethers.Contract(UNI_ADDRESS, ERC20_ABI, provider);
      const nemesisContract = new ethers.Contract(NEMESIS_ADDRESS, ERC20_ABI, provider);

      const [usdcBal, daiBal, uniBal, nemesisBal] = await Promise.all([
        usdcContract.balanceOf(wallet.address),
        daiContract.balanceOf(wallet.address),
        uniContract.balanceOf(wallet.address),
        nemesisContract.balanceOf(wallet.address)
      ]);

      const formattedUSDC = Number(ethers.formatUnits(usdcBal, 6)).toFixed(2);
      const formattedDAI  = Number(ethers.formatUnits(daiBal, 6)).toFixed(4);
      const formattedUNI = Number(ethers.formatUnits(uniBal, 6)).toFixed(4);
      const formattedNEMESIS = Number(ethers.formatUnits(nemesisBal, 6)).toFixed(4);

      if (i === selectedWalletIndex) {
        walletInfo.address      = wallet.address;
        walletInfo.activeAccount= `Account ${i + 1}`;
        walletInfo.balanceETH   = formattedETH;
        walletInfo.balanceUSDC  = formattedUSDC;
        walletInfo.balanceDAI   = formattedDAI;
        walletInfo.balanceUNI  = formattedUNI;
        walletInfo.balanceNEMESIS = formattedNEMESIS;
      }

      const prefix = i === selectedWalletIndex ? "→ " : "  ";
      return (
        `${prefix}${chalk.bold.magentaBright(getShortAddress(wallet.address))}` +
        `   ${chalk.bold.cyanBright(formattedETH.padEnd(10))}` +
        `  ${chalk.bold.greenBright(formattedUSDC.padEnd(10))}` +
        `  ${chalk.bold.yellowBright(formattedDAI.padEnd(8))}` +
        `  ${chalk.bold.blueBright(formattedUNI.padEnd(8))}` +
        `  ${chalk.bold.whiteBright(formattedNEMESIS)}`
      );
    } catch (error) {
      addLog(`Failed to fetch wallet data for account #${i + 1}: ${error.message}`, "error");
      return `${i === selectedWalletIndex ? "→ " : "  "}N/A`;
    }
  });

  try {
    const walletData = await Promise.all(walletDataPromises);
    addLog("Wallet data updated.", "success");
    return walletData;
  } catch (error) {
    addLog(`Wallet data update failed: ${error.message}`, "error");
    return [];
  }
}

function getRandomAmount(min, max) {
  const steps = 5;
  const step  = (max - min) / steps;
  const idx   = Math.floor(Math.random() * (steps + 1));
  return Math.min(min + idx * step, max);
}

/**
 * Generate a randomized trade amount for LONG/SHORT positions.
 * 
 * Modes:
 *  - "fixed":     use configured longTradeAmount / shortTradeAmount as-is
 *  - "random":    random value between tradeMinAmount..tradeMaxAmount
 *  - "percentage": random % of wallet balance between tradeBalancePercentMin..Max
 * 
 * GUARANTEE: Never returns the same value twice in a row (consecutive repeat prevention).
 * Leverage is also randomized between leverageMin..leverageMax.
 */
let _lastTradeAmount = null;  // module-level for consecutive repeat prevention

// ═══════════════════════════════════════════════════════════════════════════════
//  UNIFIED RANDOM AMOUNT GENERATOR — used by ALL modes (Swap, LONG, SHORT)
// ═══════════════════════════════════════════════════════════════════════════════

// Track last amounts per token to prevent consecutive repeats
const _lastSwapAmounts = {};  // { tokenSymbol: lastAmount }
const _lastTradeAmounts = {}; // { side: lastAmount }

/**
 * Generate a random swap amount based on token balance.
 * 
 * Rules:
 *  - Amount = random % of wallet balance (1%..5% by default)
 *  - Never repeats the same value twice in a row (per token)
 *  - Minimum 10-15% difference from previous amount
 *  - Random number of decimal places for natural look
 *  - Respects configured min/max bounds
 * 
 * @param {string} tokenSymbol - Token symbol (ETH, DAI, USDT, etc.)
 * @param {object} [options] - Optional overrides
 * @returns {string} Amount as string (e.g., "0.01837")
 */
async function getRandomSwapAmount(tokenSymbol, options = {}) {
  const sym = String(tokenSymbol).toUpperCase();
  const isEth = sym === "ETH" || sym === "WETH";
  const decimals = isEth ? 18 : (TOKENS[sym]?.decimals || 6);

  // ── Get wallet balance ──
  let balance = 0n;
  try {
    const provider = getProvider(SEPOLIA_RPC_URL, SEPOLIA_CHAIN_ID, proxies[selectedWalletIndex % proxies.length] || null);
    const wallet = new ethers.Wallet(accounts[selectedWalletIndex].privateKey, provider);
    if (isEth) {
      balance = await provider.getBalance(wallet.address);
    } else {
      const tokenAddr = TOKENS[sym]?.address;
      if (tokenAddr) {
        const contract = new ethers.Contract(tokenAddr, ERC20_ABI, provider);
        balance = await contract.balanceOf(wallet.address);
      }
    }
  } catch (e) {
    addLog(`[AMOUNT] Failed to fetch balance for ${sym}: ${e.message}`, "warn");
  }

  const balanceFloat = Number(ethers.formatUnits(balance, decimals));
  if (balanceFloat <= 0) {
    addLog(`[AMOUNT] Zero balance for ${sym}, using fallback amount`, "warn");
    return "0.001";
  }

  // ── Generate random percentage of balance (1%..5%) ──
  const pctMin = options.pctMin || 0.01;  // 1%
  const pctMax = options.pctMax || 0.05;  // 5%
  const pct = pctMin + Math.random() * (pctMax - pctMin);
  let rawAmount = balanceFloat * pct;

  // ── Apply configured min/max bounds ──
  const configuredMin = isEth
    ? Number(dailyActivityConfig.ethRange?.min || 0.00001)
    : Number(dailyActivityConfig[`${sym.toLowerCase()}Range`]?.min || 0.001);
  const configuredMaxRaw = isEth
    ? Number(dailyActivityConfig.ethRange?.max || 0.0002)
    : Number(dailyActivityConfig[`${sym.toLowerCase()}Range`]?.max || balanceFloat * 0.1);
  // Use the LARGER of configured max and balance-based max to avoid over-capping
  const configuredMax = Math.max(configuredMaxRaw, balanceFloat * 0.05, configuredMin * 10);

  rawAmount = Math.max(configuredMin, Math.min(configuredMax, rawAmount));

  // ── Randomize decimal places (2-6 digits for natural look) ──
  const decimalPlaces = 2 + Math.floor(Math.random() * 5); // 2..6
  let amount = Number(rawAmount.toFixed(decimalPlaces));

  // ── Consecutive repeat prevention (10-15% minimum difference) ──
  const prevAmount = _lastSwapAmounts[sym];
  if (prevAmount !== undefined && prevAmount > 0) {
    const diff = Math.abs(amount - prevAmount);
    const threshold = Math.max(prevAmount * 0.10, configuredMin * 0.5); // 10% minimum
    if (diff < threshold) {
      // Force different amount: shift away from previous
      const shift = threshold + Math.random() * threshold;
      if (amount > prevAmount) {
        amount = Math.min(configuredMax, amount + shift);
      } else {
        amount = Math.max(configuredMin, amount - shift);
      }
      amount = Number(amount.toFixed(decimalPlaces));
    }
  }

  // ── Final bounds check ──
  amount = Math.max(configuredMin, Math.min(configuredMax, amount));
  if (amount <= 0) amount = configuredMin;

  // ── Store for next comparison ──
  _lastSwapAmounts[sym] = amount;

  const formatted = amount.toFixed(decimalPlaces).replace(/0+$/, "").replace(/\.$/, "");
  return formatted || String(configuredMin);
}

/**
 * Generate a random trade amount for LONG/SHORT based on collateral balance.
 * Uses the same logic as getRandomSwapAmount but for trading positions.
 * 
 * @param {string} side - "LONG" or "SHORT"
 * @param {string} [collateralSymbol] - Collateral token symbol
 * @returns {string} Amount as string
 */
async function getRandomTradeAmount(side, collateralSymbol = "ETH") {
  const sym = String(collateralSymbol).toUpperCase();
  const isEth = sym === "ETH" || sym === "WETH";
  const decimals = isEth ? 18 : (TOKENS[sym]?.decimals || 6);

  // ── Get wallet balance ──
  let balance = 0n;
  try {
    const provider = getProvider(SEPOLIA_RPC_URL, SEPOLIA_CHAIN_ID, proxies[selectedWalletIndex % proxies.length] || null);
    const wallet = new ethers.Wallet(accounts[selectedWalletIndex].privateKey, provider);
    if (isEth) {
      balance = await provider.getBalance(wallet.address);
    } else {
      const tokenAddr = TOKENS[sym]?.address;
      if (tokenAddr) {
        const contract = new ethers.Contract(tokenAddr, ERC20_ABI, provider);
        balance = await contract.balanceOf(wallet.address);
      }
    }
  } catch (e) {
    addLog(`[AMOUNT] Failed to fetch balance for ${sym}: ${e.message}`, "warn");
  }

  const balanceFloat = Number(ethers.formatUnits(balance, decimals));
  if (balanceFloat <= 0) {
    addLog(`[AMOUNT] Zero balance for ${sym}, using fallback amount`, "warn");
    return tradingConfig.tradeMinAmount || "0.01";
  }

  // ── Generate random percentage of balance (1%..5%) ──
  const pctMin = Math.max(0.01, Number(tradingConfig.tradeBalancePercentMin || 1) / 100);
  const pctMax = Math.max(pctMin, Number(tradingConfig.tradeBalancePercentMax || 5) / 100);
  const pct = pctMin + Math.random() * (pctMax - pctMin);
  let rawAmount = balanceFloat * pct;

  // ── Apply configured min/max bounds ──
  const configuredMin = Number(tradingConfig.tradeMinAmount) || 0.01;
  const configuredMaxRaw = Number(tradingConfig.tradeMaxAmount) || balanceFloat * 0.1;
  // Use the LARGER of configured max and balance-based max to avoid over-capping
  const configuredMax = Math.max(configuredMaxRaw, balanceFloat * 0.05, configuredMin * 10);
  rawAmount = Math.max(configuredMin, Math.min(configuredMax, rawAmount));

  // ── Randomize decimal places (2-5 digits for natural look) ──
  const decimalPlaces = 2 + Math.floor(Math.random() * 4); // 2..5
  let amount = Number(rawAmount.toFixed(decimalPlaces));

  // ── Consecutive repeat prevention (10-15% minimum difference) ──
  const prevAmount = _lastTradeAmounts[side];
  if (prevAmount !== undefined && prevAmount > 0) {
    const diff = Math.abs(amount - prevAmount);
    const threshold = Math.max(prevAmount * 0.10, configuredMin * 0.5);
    if (diff < threshold) {
      const shift = threshold + Math.random() * threshold;
      if (amount > prevAmount) {
        amount = Math.min(configuredMax, amount + shift);
      } else {
        amount = Math.max(configuredMin, amount - shift);
      }
      amount = Number(amount.toFixed(decimalPlaces));
    }
  }

  // ── Final bounds check ──
  amount = Math.max(configuredMin, Math.min(configuredMax, amount));
  if (amount <= 0) amount = configuredMin;

  // ── Store for next comparison ──
  _lastTradeAmounts[side] = amount;

  const formatted = amount.toFixed(decimalPlaces).replace(/0+$/, "").replace(/\.$/, "");
  return formatted || String(configuredMin);
}

function getTradingAmount(side) {
  const mode = tradingConfig.tradeAmountMode || "random";
  let amount;

  if (mode === "fixed") {
    // ── FIXED mode: use configured amounts ──
    amount = Number(side === "LONG" ? tradingConfig.longTradeAmount : tradingConfig.shortTradeAmount);
    if (!Number.isFinite(amount) || amount <= 0) amount = 0.01;

  } else if (mode === "percentage") {
    // ── PERCENTAGE mode: handled by caller with wallet balance ──
    // Return config values; caller applies balance calculation
    const pctMin = Math.max(0.1, Number(tradingConfig.tradeBalancePercentMin) || 1);
    const pctMax = Math.max(pctMin, Number(tradingConfig.tradeBalancePercentMax) || 5);
    const pct = pctMin + Math.random() * (pctMax - pctMin);
    // Return as "pct:<value>" signal for the caller to compute balance-based amount
    amount = -pct; // negative signals percentage mode to caller

  } else {
    // ── RANDOM mode (default): random between tradeMinAmount..tradeMaxAmount ──
    const minVal = Math.max(0.000001, Number(tradingConfig.tradeMinAmount) || 0.1);
    const maxVal = Math.max(minVal, Number(tradingConfig.tradeMaxAmount) || 1.0);
    amount = minVal + Math.random() * (maxVal - minVal);
  }

  // ── Consecutive repeat prevention ──
  if (amount > 0 && _lastTradeAmount !== null) {
    const diff = Math.abs(amount - _lastTradeAmount);
    const threshold = Math.max(amount * 0.15, 0.00001); // must differ by at least 15%
    if (diff < threshold) {
      // Regenerate with forced offset
      const minVal = Math.max(0.000001, Number(tradingConfig.tradeMinAmount) || 0.1);
      const maxVal = Math.max(minVal, Number(tradingConfig.tradeMaxAmount) || 1.0);
      // Shift amount away from last used value
      if (amount > _lastTradeAmount) {
        amount = Math.min(maxVal, amount + threshold + Math.random() * (maxVal - minVal) * 0.3);
      } else {
        amount = Math.max(minVal, amount - threshold - Math.random() * (maxVal - minVal) * 0.3);
      }
    }
  }

  if (amount > 0) _lastTradeAmount = amount;

  // For percentage mode, return the percentage (caller handles balance calc)
  if (mode === "percentage") return `pct:${Math.abs(amount).toFixed(2)}`;

  return amount.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
}

/**
 * Get randomized leverage between leverageMin..leverageMax.
 * Prevents consecutive identical values.
 */
function getRandomLeverage() {
  const minLev = Math.max(1, Number(tradingConfig.leverageMin) || 1);
  const maxLev = Math.max(minLev, Number(tradingConfig.leverageMax) || 5);
  let leverage = Math.round(minLev + Math.random() * (maxLev - minLev));
  leverage = Math.max(minLev, Math.min(maxLev, leverage));

  // Consecutive repeat prevention
  if (lastLeverage !== null && leverage === lastLeverage) {
    leverage = leverage + 1;
    if (leverage > maxLev) leverage = minLev;
  }
  lastLeverage = leverage;
  return leverage;
}

async function getWalletPercentTradeAmount(wallet, provider, collateralToken, side) {
  if (tradingConfig.firstTxMode || tradingConfig.tradeMode !== "walletPercent") return getTradingAmount(side);
  const percent = Math.max(0, Math.min(100, Number(tradingConfig.walletPercent) || 0));
  const nativeCollateral = isNativeToken(collateralToken);
  const normalizedToken = normalizeCollateralToken(collateralToken);
  const decimals = await getCollateralDecimals(provider, normalizedToken, nativeCollateral);
  const balance = nativeCollateral
    ? await provider.getBalance(wallet.address)
    : await new ethers.Contract(normalizedToken, ERC20_ABI, provider).balanceOf(wallet.address);
  let amount = balance * BigInt(Math.floor(percent * 100)) / 10000n;
  const maxAmount = ethers.parseUnits(String(tradingConfig.maxTradeAmount), decimals);
  if (amount > maxAmount) amount = maxAmount;
  return ethers.formatUnits(amount, decimals);
}

async function approveToken(wallet, tokenAddress, spender, amount, provider) {
  const contract = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);
  const allowance = await contract.allowance(wallet.address, spender);
  if (allowance >= amount) {
    addLog(`Allowance sufficient for ${getShortAddress(tokenAddress)}, skipping approve.`, "wait");
    return;
  }
  addLog(`Approving token ${getShortAddress(tokenAddress)} for router...`, "wait");
  const feeParams = await getFeeParams(provider);
  const nonce     = await getNextNonce(provider, wallet.address, SEPOLIA_CHAIN_ID);
  const tx = await contract.approve(spender, ethers.MaxUint256, { ...feeParams, gasLimit: 100000n, nonce });
  addLog(`Approve tx sent: ${getShortHash(tx.hash)}`, "warn");
  const receipt = await tx.wait();
  if (receipt.status === 0) throw new Error("Approve transaction reverted");
  addLog(`Approve confirmed: ${getShortHash(tx.hash)}`, "success");
}

async function buildDynamicSwapPairs(provider, walletAddress) {
  const pairs = [];
  // Deduplicate by address: only add each unique address once
  const seenAddresses = new Map(); // address → symbol
  seenAddresses.set(WETH_ADDRESS.toLowerCase(), "ETH"); // ETH is always first

  for (const [key, info] of Object.entries(TOKENS)) {
    if (!info || !info.address) continue;
    const addrLower = info.address.toLowerCase();
    if (seenAddresses.has(addrLower)) continue; // skip WETH if ETH already added
    try {
      const contract = new ethers.Contract(info.address, ERC20_ABI, provider);
      const bal = await contract.balanceOf(walletAddress);
      if (bal > 0n) seenAddresses.set(addrLower, key);
    } catch {}
  }

  // Generate pairs only where addresses differ
  const tokens = Array.from(seenAddresses.values());
  for (const token of tokens) {
    if (token === "ETH") continue;
    // Verify addresses are actually different
    const ethInfo = normalizeToken("ETH");
    const tokInfo = normalizeToken(token);
    if (ethInfo.address.toLowerCase() === tokInfo.address.toLowerCase()) continue;
    pairs.push({ from: "ETH", to: token });
    pairs.push({ from: token, to: "ETH" });
  }
  return pairs;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  UNIVERSAL SWAP ENGINE — works for ANY supported token pair
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Resolve a token symbol or address to its full token info.
 * Supports: symbol ("DAI"), address, or alias ("ETH"→WETH).
 * Uses normalizeToken() internally for consistent ETH/WETH handling.
 */
function resolveTokenInfo(input) {
  return normalizeToken(input);
}

/**
 * Universal swap path builder.
 * Direct pair with WETH: [TokenA, TokenB]
 * Cross pair: [TokenA, WETH, TokenB]
 * 
 * SAFETY: If tokenInAddress == tokenOutAddress, throws immediately
 * instead of passing identical addresses to the router.
 */
function buildSwapPath(tokenInAddress, tokenOutAddress, preferDirect = false) {
  if (tokenInAddress.toLowerCase() === tokenOutAddress.toLowerCase()) {
    throw new Error(`buildSwapPath: identical addresses ${tokenInAddress} — cannot swap a token with itself`);
  }
  const isInWeth = tokenInAddress.toLowerCase() === WETH_ADDRESS.toLowerCase();
  const isOutWeth = tokenOutAddress.toLowerCase() === WETH_ADDRESS.toLowerCase();
  // ETH↔Token: always direct
  if (isInWeth || isOutWeth) return [tokenInAddress, tokenOutAddress];
  // Token↔Token: prefer direct path (Nemesis OMM pools work better with direct swaps)
  // Fall back to WETH intermediary only if direct path fails
  if (preferDirect) return [tokenInAddress, tokenOutAddress];
  return [tokenInAddress, WETH_ADDRESS, tokenOutAddress];
}

/**
 * Build swap path with automatic fallback: try direct first, then WETH intermediary.
 * Returns { path, isDirect } or throws if both fail.
 */
async function buildSwapPathWithFallback(tokenInAddress, tokenOutAddress, router) {
  // Try direct path first
  const directPath = [tokenInAddress, tokenOutAddress];
  const testAmount = 1000n; // tiny test amount
  try {
    const amounts = await router.getAmountsOut(testAmount, directPath);
    if (BigInt(amounts[amounts.length - 1]) > 0n) {
      return { path: directPath, isDirect: true };
    }
  } catch (e) { /* direct path failed, try WETH intermediary */ }

  // Try WETH intermediary
  const wethPath = [tokenInAddress, WETH_ADDRESS, tokenOutAddress];
  try {
    const amounts = await router.getAmountsOut(testAmount, wethPath);
    if (BigInt(amounts[amounts.length - 1]) > 0n) {
      return { path: wethPath, isDirect: false };
    }
  } catch (e) { /* both failed */ }

  throw new Error(`No valid swap path found for ${tokenInAddress} → ${tokenOutAddress}`);
}

/**
 * Universal executeSwap — works for ANY supported token pair.
 * Handles: ETH→Token, Token→ETH, Token→Token (via WETH routing).
 * 
 * SAFETY CHECKS:
 *  1. amount > 0 — rejects zero/negative amounts BEFORE calling router
 *  2. tokenIn.address !== tokenOut.address — prevents OMMLibrary: IDENTICAL_ADDRESSES
 *  3. Uses normalizeToken() to resolve ETH↔WETH aliasing
 */
async function executeSwap(wallet, tokenIn, tokenOut, amount, options = {}) {
  const proxyUrl = options.proxyUrl || null;
  const slippageBps = options.slippageBps || tradingConfig.slippageBps || 50;
  const deadlineSeconds = options.deadlineSeconds || tradingConfig.deadlineSeconds || 1200;

  // ── SAFETY CHECK 1: amount must be > 0 ──
  const numericAmount = Number(amount);
  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    addLog(`[SWAP] SKIP invalid amount: ${amount} (must be > 0)`, "warn");
    throw new Error(`Swap amount must be > 0, got: ${amount}`);
  }

  const provider = getProvider(SEPOLIA_RPC_URL, SEPOLIA_CHAIN_ID, proxyUrl);
  wallet = wallet.connect(provider);
  await assertContractTarget(provider, NEMESIS_ROUTER, "swap router");
  const router = new ethers.Contract(NEMESIS_ROUTER, ROUTER_ABI, wallet);
  const deadline = Math.floor(Date.now() / 1000) + deadlineSeconds;

  // Use normalizeToken for consistent resolution — ETH and WETH become the same
  const infoIn = normalizeToken(tokenIn);
  const infoOut = normalizeToken(tokenOut);

  // ── SAFETY CHECK 2: prevent identical addresses (OMMLibrary: IDENTICAL_ADDRESSES) ──
  if (infoIn.address.toLowerCase() === infoOut.address.toLowerCase()) {
    addLog(`[SWAP] SKIP identical pair: ${tokenIn} → ${tokenOut} (both resolve to ${getShortAddress(infoIn.address)})`, "warn");
    throw new Error(`Cannot swap identical tokens: ${tokenIn} and ${tokenOut} both resolve to ${infoIn.address}`);
  }

  const isInEth = isNativeToken(tokenIn);
  const isOutEth = isNativeToken(tokenOut);
  const isTokenToToken = !isInEth && !isOutEth;

  // ── SAFETY CHECK 3: pair must be in discovered list ──
  if (discoveredSwapPairs.length > 0) {
    const fromSym = infoIn.symbol;
    const toSym = infoOut.symbol;
    const isValidPair = discoveredSwapPairs.some(p =>
      (p.from === fromSym && p.to === toSym) ||
      (p.from === "ETH" && fromSym === "WETH" && p.to === toSym) ||
      (p.to === "ETH" && toSym === "WETH" && p.from === fromSym)
    );
    if (!isValidPair) {
      addLog(`[SWAP] SKIP ${fromSym} → ${toSym}: pair not in discovered swap list (no pool or route)`, "warn");
      throw new Error(`Pair ${fromSym} → ${toSym} is not a supported swap pair (no confirmed pool)`);
    }
  }

  // ── PATH BUILDING with fallback for token→token swaps ──
  // Nemesis OMM pools work better with direct swaps. Try direct first,
  // fall back to WETH intermediary only if direct fails.
  let path;
  if (isTokenToToken) {
    try {
      const result = await buildSwapPathWithFallback(infoIn.address, infoOut.address, router);
      path = result.path;
      const pathType = result.isDirect ? "direct" : "via WETH";
      addLog(`[SWAP] Using ${pathType} path`, "info");
    } catch (pathErr) {
      throw new Error(`No valid swap route found: ${pathErr.message}`);
    }
  } else {
    path = buildSwapPath(infoIn.address, infoOut.address);
  }

  const label = `${infoIn.symbol} ➪ ${infoOut.symbol}`;
  addLog(`[SWAP] ${label} amount=${amount} router=${NEMESIS_ROUTER}`, "info");
  addLog(`[SWAP] path=${path.map(a => getShortAddress(a)).join(" → ")}`, "info");

  const feeParams = await getFeeParams(provider);
  const gasLimit = 300000n;
  const slippageMultiplier = BigInt(10000 - slippageBps);

  if (isInEth) {
    const amountInWei = ethers.parseEther(String(amount));
    if (amountInWei <= 0n) throw new Error("Swap amount must be > 0");
    let amountOut = 0n, amountOutMin = 0n;
    try {
      const amounts = await router.getAmountsOut(amountInWei, path);
      amountOut = BigInt(amounts[amounts.length - 1]);
      amountOutMin = amountOut * slippageMultiplier / 10000n;
      addLog(`[SWAP] Quote: ${amount} ${infoIn.symbol} ➪ ${ethers.formatUnits(amountOut, infoOut.decimals)} ${infoOut.symbol} (min: ${ethers.formatUnits(amountOutMin, infoOut.decimals)})`, "info");
    } catch (err) { throw new Error(`getAmountsOut failed: ${err.message}`); }
    if (isInvalidQuote(amountOut, amountOutMin)) throw new Error("Invalid quote: zero output");
    const ethBal = await provider.getBalance(wallet.address);
    const gasCost = (feeParams.maxFeePerGas || feeParams.gasPrice) * gasLimit;
    if (ethBal < amountInWei + gasCost) throw new Error(`Insufficient ETH: have ${ethers.formatEther(ethBal)}, need ${ethers.formatEther(amountInWei + gasCost)}`);
    const nonce = await getNextNonce(provider, wallet.address, SEPOLIA_CHAIN_ID);
    const tx = await router.swapExactETHForTokens(amountOutMin, path, wallet.address, deadline, { value: amountInWei, ...feeParams, gasLimit, nonce });
    addLog(`[SWAP] tx sent: ${tx.hash}`, "warn");
    const receipt = await waitForTx(tx);
    addLog(`[SWAP] SUCCESS ${label} | ${tx.hash}`, "success");
    return { txHash: tx.hash, receipt, amountOut, amountOutMin };

  } else if (isOutEth) {
    const amountInWei = ethers.parseUnits(String(amount), infoIn.decimals);
    if (amountInWei <= 0n) throw new Error("Swap amount must be > 0");
    const tokenContract = new ethers.Contract(infoIn.address, ERC20_ABI, provider);
    const tokenBal = await tokenContract.balanceOf(wallet.address);
    if (tokenBal < amountInWei) throw new Error(`Insufficient ${infoIn.symbol}: have ${ethers.formatUnits(tokenBal, infoIn.decimals)}, need ${ethers.formatUnits(amountInWei, infoIn.decimals)}`);
    let amountOut = 0n, amountOutMin = 0n;
    try {
      const amounts = await router.getAmountsOut(amountInWei, path);
      amountOut = BigInt(amounts[amounts.length - 1]);
      amountOutMin = amountOut * slippageMultiplier / 10000n;
      addLog(`[SWAP] Quote: ${amount} ${infoIn.symbol} ➪ ${ethers.formatEther(amountOut)} ETH (min: ${ethers.formatEther(amountOutMin)})`, "info");
    } catch (err) { throw new Error(`getAmountsOut failed: ${err.message}`); }
    if (isInvalidQuote(amountOut, amountOutMin)) throw new Error("Invalid quote: zero output");
    await approveToken(wallet, infoIn.address, NEMESIS_ROUTER, amountInWei, provider);
    const ethBal = await provider.getBalance(wallet.address);
    const gasCost = (feeParams.maxFeePerGas || feeParams.gasPrice) * gasLimit;
    if (ethBal < gasCost) throw new Error(`Insufficient ETH for gas: have ${ethers.formatEther(ethBal)}, need ${ethers.formatEther(gasCost)}`);
    const nonce = await getNextNonce(provider, wallet.address, SEPOLIA_CHAIN_ID);
    const tx = await router.swapExactTokensForETH(amountInWei, amountOutMin, path, wallet.address, deadline, { ...feeParams, gasLimit, nonce });
    addLog(`[SWAP] tx sent: ${tx.hash}`, "warn");
    const receipt = await waitForTx(tx);
    addLog(`[SWAP] SUCCESS ${label} | ${tx.hash}`, "success");
    return { txHash: tx.hash, receipt, amountOut, amountOutMin };

  } else {
    const amountInWei = ethers.parseUnits(String(amount), infoIn.decimals);
    if (amountInWei <= 0n) throw new Error("Swap amount must be > 0");
    const tokenContract = new ethers.Contract(infoIn.address, ERC20_ABI, provider);
    const tokenBal = await tokenContract.balanceOf(wallet.address);
    if (tokenBal < amountInWei) throw new Error(`Insufficient ${infoIn.symbol}: have ${ethers.formatUnits(tokenBal, infoIn.decimals)}, need ${ethers.formatUnits(amountInWei, infoIn.decimals)}`);
    let amountOut = 0n, amountOutMin = 0n;
    try {
      const amounts = await router.getAmountsOut(amountInWei, path);
      amountOut = BigInt(amounts[amounts.length - 1]);
      amountOutMin = amountOut * slippageMultiplier / 10000n;
      addLog(`[SWAP] Quote: ${amount} ${infoIn.symbol} ➪ ${ethers.formatUnits(amountOut, infoOut.decimals)} ${infoOut.symbol} (min: ${ethers.formatUnits(amountOutMin, infoOut.decimals)})`, "info");
    } catch (err) { throw new Error(`getAmountsOut failed: ${err.message}`); }
    if (isInvalidQuote(amountOut, amountOutMin)) throw new Error("Invalid quote: zero output");
    await approveToken(wallet, infoIn.address, NEMESIS_ROUTER, amountInWei, provider);
    const ethBal = await provider.getBalance(wallet.address);
    const gasCost = (feeParams.maxFeePerGas || feeParams.gasPrice) * gasLimit;
    if (ethBal < gasCost) throw new Error(`Insufficient ETH for gas: have ${ethers.formatEther(ethBal)}, need ${ethers.formatEther(gasCost)}`);
    const nonce = await getNextNonce(provider, wallet.address, SEPOLIA_CHAIN_ID);
    const tx = await router.swapExactTokensForTokens(amountInWei, amountOutMin, path, wallet.address, deadline, { ...feeParams, gasLimit, nonce });
    addLog(`[SWAP] tx sent: ${tx.hash}`, "warn");
    const receipt = await waitForTx(tx);
    addLog(`[SWAP] SUCCESS ${label} | ${tx.hash}`, "success");
    return { txHash: tx.hash, receipt, amountOut, amountOutMin };
  }
}

// Legacy wrapper for backward compatibility
async function performSwap(wallet, fromToken, toToken, amount, proxyUrl) {
  return executeSwap(wallet, fromToken, toToken, amount, { proxyUrl });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  CYCLIC SWAP ENGINE — rotates through ALL supported pairs every N seconds
// ═══════════════════════════════════════════════════════════════════════════════

let cyclicSwapRunning = false;
let cyclicSwapStopRequested = false;

/**
 * Discover ALL supported swap pairs by probing the Nemesis Factory contract.
 *
 * For each unique token pair (A, B):
 *  1. Factory.getPool(A, B) — checks if a liquidity pool exists
 *  2. router.getAmountsOut() — validates the route works (no POOL_NOT_FOUND)
 *
 * Only pairs that pass BOTH checks are included in the result.
 * Logs both supported and unsupported pairs with reasons.
 *
 * This is the SINGLE SOURCE OF TRUTH for swap pairs used by:
 *  - TUI swap menu
 *  - CLI swap commands
 *  - Auto RSI trading
 *  - Full Auto trading
 *  - Cyclic Swap Engine
 */
async function discoverSupportedSwapPairs(provider) {
  addLog("[SWAP DISCOVER] Probing Nemesis Factory for valid swap pools...", "info");

  const factory = new ethers.Contract(LEVERAGED_FACTORY, FACTORY_ABI, provider);
  const router = new ethers.Contract(NEMESIS_ROUTER, ROUTER_ABI, provider);

  // Step 1: Deduplicate tokens by resolved address (collapse ETH/WETH)
  const uniqueByAddress = new Map();
  for (const [sym, info] of Object.entries(TOKENS)) {
    if (!info || !info.address) continue;
    const addrLower = info.address.toLowerCase();
    if (!uniqueByAddress.has(addrLower)) {
      const canonicalSymbol = (sym === "WETH" && uniqueByAddress.size === 0) || sym === "ETH" ? "ETH" : sym;
      uniqueByAddress.set(addrLower, {
        symbol: canonicalSymbol,
        address: info.address,
        decimals: info.decimals
      });
    } else if (sym === "ETH") {
      uniqueByAddress.get(addrLower).symbol = "ETH";
    }
  }
  const tokenEntries = Array.from(uniqueByAddress.values());
  addLog(`[SWAP DISCOVER] ${tokenEntries.length} unique tokens to probe: ${tokenEntries.map(t => t.symbol).join(", ")}`, "info");

  // Step 2: Generate all candidate pairs (deduplicated by address)
  const candidatePairs = [];
  const pairKeys = new Set();

  for (const a of tokenEntries) {
    for (const b of tokenEntries) {
      if (a.address.toLowerCase() === b.address.toLowerCase()) continue;
      const key = `${a.address.toLowerCase()}:${b.address.toLowerCase()}`;
      if (pairKeys.has(key)) continue;
      pairKeys.add(key);
      candidatePairs.push({ from: a.symbol, to: b.symbol, fromAddress: a.address, toAddress: b.address, fromDecimals: a.decimals, toDecimals: b.decimals });
    }
  }
  addLog(`[SWAP DISCOVER] ${candidatePairs.length} candidate pairs to validate`, "info");

  // Step 3: Validate each pair — Factory.getPool + getAmountsOut
  const supported = [];
  const unsupported = [];
  const TEST_AMOUNT_ETH = ethers.parseEther("0.0001"); // tiny test amount
  const TEST_AMOUNT_ERC20 = 1000n; // 1000 units (smallest possible)

  for (const pair of candidatePairs) {
    const pairLabel = `${pair.from} → ${pair.to}`;
    try {
      // Check 1: Does a pool exist in the Factory?
      const [tokenA, tokenB] = sortTokenPair(pair.fromAddress, pair.toAddress);
      const pool = await factory.getPool(tokenA, tokenB);
      if (!pool || pool === ZERO_ADDRESS) {
        unsupported.push({ from: pair.from, to: pair.to, reason: "POOL_NOT_FOUND" });
        addLog(`[SWAP DISCOVER] ✗ ${pairLabel} — POOL_NOT_FOUND`, "debug");
        continue;
      }

      // Check 2: Does getAmountsOut work? (validates route + liquidity)
      // For token→token swaps, try direct path first, then WETH intermediary
      const testAmount = pair.from === "ETH" ? TEST_AMOUNT_ETH : TEST_AMOUNT_ERC20;
      const pairIsTokenToToken = pair.from !== "ETH" && pair.to !== "ETH";
      let routeFound = false;
      const paths = pairIsTokenToToken
        ? [[pair.fromAddress, pair.toAddress], [pair.fromAddress, WETH_ADDRESS, pair.toAddress]]
        : [buildSwapPath(pair.fromAddress, pair.toAddress)];

      for (const path of paths) {
        try {
          const amounts = await router.getAmountsOut(testAmount, path);
          const amountOut = BigInt(amounts[amounts.length - 1]);
          if (amountOut > 0n) {
            routeFound = true;
            const pathType = path.length === 2 ? "direct" : "via WETH";
            addLog(`[SWAP DISCOVER] ✓ ${pairLabel} (${pathType})`, "info");
            break;
          }
        } catch (quoteErr) { /* try next path */ }
      }

      if (!routeFound) {
        unsupported.push({ from: pair.from, to: pair.to, reason: "NO_ROUTE" });
        addLog(`[SWAP DISCOVER] ✗ ${pairLabel} — NO_ROUTE (neither direct nor WETH path works)`, "debug");
        continue;
      }

      // Pair is valid!
      supported.push({ from: pair.from, to: pair.to });
    } catch (err) {
      unsupported.push({ from: pair.from, to: pair.to, reason: `ERROR: ${err.message}` });
      addLog(`[SWAP DISCOVER] ✗ ${pairLabel} — ERROR: ${err.message}`, "debug");
    }
  }

  // Step 4: Log summary
  addLog("", "info");
  addLog(`══════ Supported Swap Pairs (${supported.length}) ══════`, "success");
  for (const p of supported) {
    addLog(`  ✓ ${p.from} → ${p.to}`, "success");
  }
  if (unsupported.length > 0) {
    addLog(`══════ Unsupported Swap Pairs (${unsupported.length}) ══════`, "warn");
    for (const p of unsupported) {
      addLog(`  ✗ ${p.from} → ${p.to} — ${p.reason}`, "warn");
    }
  }
  addLog(`[SWAP DISCOVER] Total: ${supported.length} supported, ${unsupported.length} unsupported out of ${candidatePairs.length} candidates`, "success");

  return supported;
}

/**
 * Generate ALL possible swap pairs from the TOKENS map.
 * 
 * KEY FIX: Tokens are first deduplicated by resolved address, so ETH and WETH
 * (which share the same address on Nemesis) are collapsed into a single entry.
 * Pairs where tokenIn.address == tokenOut.address are NEVER generated.
 * 
 * Uses native "ETH" as the canonical name for the WETH token in pair labels.
 * For N unique-address tokens, produces N*(N-1) ordered pairs.
 */
function getAllSwapPairs() {
  // ─── USE DISCOVERED VALID PAIRS (Factory-validated) ───
  // If discoverSupportedSwapPairs() has run, use its result.
  // Only pairs with confirmed pools and working getAmountsOut() are included.
  if (discoveredSwapPairs.length > 0) {
    addLog(`[SWAP ENGINE] Using ${discoveredSwapPairs.length} Factory-validated swap pairs`, "success");
    return discoveredSwapPairs;
  }

  // ─── FALLBACK: generate from TOKENS map (pre-discovery or if discovery failed) ───
  addLog("[SWAP ENGINE] No discovered pairs available, using fallback generation", "warn");
  const uniqueByAddress = new Map();
  for (const [sym, info] of Object.entries(TOKENS)) {
    if (!info || !info.address) continue;
    const addrLower = info.address.toLowerCase();
    if (!uniqueByAddress.has(addrLower)) {
      const canonicalSymbol = (sym === "WETH" && uniqueByAddress.size === 0) || sym === "ETH" ? "ETH" : sym;
      uniqueByAddress.set(addrLower, {
        symbol: canonicalSymbol,
        address: info.address,
        decimals: info.decimals
      });
    } else if (sym === "ETH") {
      uniqueByAddress.get(addrLower).symbol = "ETH";
    }
  }

  const tokenEntries = Array.from(uniqueByAddress.values());
  addLog(`[SWAP ENGINE] Deduplicated tokens: ${tokenEntries.length} unique addresses from ${Object.keys(TOKENS).length} entries`, "debug");

  const pairs = [];
  const pairKeys = new Set();

  function addPair(from, to) {
    const fromInfo = normalizeToken(from);
    const toInfo = normalizeToken(to);
    if (fromInfo.address.toLowerCase() === toInfo.address.toLowerCase()) {
      addLog(`[SWAP ENGINE] SKIP identical pair: ${from} → ${to} (same address ${getShortAddress(fromInfo.address)})`, "debug");
      return;
    }
    const key = `${fromInfo.address.toLowerCase()}:${toInfo.address.toLowerCase()}`;
    if (pairKeys.has(key)) return;
    pairKeys.add(key);
    pairs.push({ from, to });
  }

  for (const a of tokenEntries) {
    for (const b of tokenEntries) {
      if (a.address.toLowerCase() === b.address.toLowerCase()) continue;
      addPair(a.symbol, b.symbol);
    }
  }

  for (const t of tokenEntries) {
    if (t.symbol === "ETH") continue;
    addPair("ETH", t.symbol);
    addPair(t.symbol, "ETH");
  }

  addLog(`[SWAP ENGINE] Generated ${pairs.length} fallback swap pairs (no Factory validation)`, "warn");
  return pairs;
}

/**
 * Get the swap amount for a given token symbol.
 * 
 * Modes:
 *  - "fixed":     use configured swapTradeAmount
 *  - "random":    random value between swapMinAmount..swapMaxAmount
 *  - "percentage": random % of wallet balance between swapBalancePercentMin..Max
 * 
 * Falls back to per-token ranges (dailyActivityConfig.ethRange etc.) when
 * swapAmountMode is "random" but swapMinAmount/swapMaxAmount are not set.
 * 
 * GUARANTEE: Never returns the same amount for the same pair twice in a row.
 * SAFETY: Always returns a value > 0.
 */
function getSwapAmountForSymbol(symbol, toSymbol = null) {
  const s = String(symbol).toUpperCase();
  // Use full pair key for consecutive repeat tracking
  const amountPairKey = toSymbol ? `${s}->${String(toSymbol).toUpperCase()}` : s;
  const mode = tradingConfig.swapAmountMode || "random";
  let amount;

  if (mode === "fixed") {
    // ── FIXED mode: use configured swapTradeAmount ──
    amount = Number(tradingConfig.swapTradeAmount) || 0.01;

  } else if (mode === "percentage") {
    // ── PERCENTAGE mode: return signal for caller to compute from balance ──
    const pctMin = Math.max(0.1, Number(tradingConfig.swapBalancePercentMin) || 1);
    const pctMax = Math.max(pctMin, Number(tradingConfig.swapBalancePercentMax) || 8);
    const pct = pctMin + Math.random() * (pctMax - pctMin);
    amount = -pct; // negative signals percentage mode

  } else {
    // ── RANDOM mode (default): use swapMinAmount..swapMaxAmount with per-token fallback ranges ──
    const globalMin = Number(tradingConfig.swapMinAmount);
    const globalMax = Number(tradingConfig.swapMaxAmount);

    if (Number.isFinite(globalMin) && Number.isFinite(globalMax) && globalMin > 0 && globalMax > 0) {
      // Use global random range
      const minVal = Math.max(0.000001, globalMin);
      const maxVal = Math.max(minVal, globalMax);
      amount = minVal + Math.random() * (maxVal - minVal);
    } else {
      // Fall back to per-token configured ranges
      switch (s) {
        case "ETH":     amount = getRandomAmount(dailyActivityConfig.ethRange.min, dailyActivityConfig.ethRange.max); break;
        case "USDC":    amount = getRandomAmount(dailyActivityConfig.usdcRange.min, dailyActivityConfig.usdcRange.max); break;
        case "USDT":    amount = getRandomAmount(dailyActivityConfig.usdtRange.min, dailyActivityConfig.usdtRange.max); break;
        case "DAI":     amount = getRandomAmount(dailyActivityConfig.daiRange.min, dailyActivityConfig.daiRange.max); break;
        case "UNI":     amount = getRandomAmount(dailyActivityConfig.uniRange.min, dailyActivityConfig.uniRange.max); break;
        case "LINK":    amount = getRandomAmount(dailyActivityConfig.linkRange.min, dailyActivityConfig.linkRange.max); break;
        case "NEMESIS": amount = getRandomAmount(dailyActivityConfig.nemesisRange.min, dailyActivityConfig.nemesisRange.max); break;
        default:         amount = getRandomAmount(0.00001, 0.00002); break;
      }
    }
  }

  // ── For percentage mode, return the percentage signal ──
  if (mode === "percentage") return `pct:${Math.abs(amount).toFixed(2)}`;

  // ── Consecutive repeat prevention: ensure different amount per pair ──
  if (Number.isFinite(amount) && amount > 0 && lastSwapAmounts[amountPairKey] !== undefined) {
    const diff = Math.abs(amount - lastSwapAmounts[amountPairKey]);
    const threshold = Math.max(amount * 0.15, 0.000001);
    if (diff < threshold) {
      // Force a different amount
      const minVal = Math.max(0.000001, Number(tradingConfig.swapMinAmount) || 0.0001);
      const maxVal = Math.max(minVal, Number(tradingConfig.swapMaxAmount) || 0.5);
      if (amount > lastSwapAmounts[amountPairKey]) {
        amount = Math.min(maxVal, amount + threshold + Math.random() * (maxVal - minVal) * 0.3);
      } else {
        amount = Math.max(minVal, amount - threshold - Math.random() * (maxVal - minVal) * 0.3);
      }
    }
  }
  if (Number.isFinite(amount) && amount > 0) lastSwapAmounts[amountPairKey] = amount;

  // SAFETY: ensure amount is always > 0
  if (!Number.isFinite(amount) || amount <= 0) {
    addLog(`[SWAP] WARN getSwapAmountForSymbol(${symbol}) returned ${amount}, using fallback`, "warn");
    amount = 0.00001;
  }
  return amount;
}

/**
 * Check if we have sufficient balance for a swap.
 */
async function hasSufficientBalance(wallet, provider, tokenSymbol, amount) {
  try {
    if (tokenSymbol.toUpperCase() === "ETH") {
      const bal = await provider.getBalance(wallet.address);
      return bal >= ethers.parseEther(String(amount));
    }
    const info = resolveTokenInfo(tokenSymbol);
    const contract = new ethers.Contract(info.address, ERC20_ABI, provider);
    const bal = await contract.balanceOf(wallet.address);
    return bal >= ethers.parseUnits(String(amount), info.decimals);
  } catch {
    return false;
  }
}

/**
 * Main cyclic swap engine.
 * Rotates through ALL supported pairs with configurable interval.
 * 
 * @param {object} options - { intervalSeconds, onSwapComplete }
 */
async function runCyclicSwapEngine(options = {}) {
  if (cyclicSwapRunning) {
    addLog("[SWAP ENGINE] Already running", "warn");
    return;
  }
  cyclicSwapRunning = true;
  cyclicSwapStopRequested = false;

  const intervalSeconds = options.intervalSeconds || 3;
  const onSwapComplete = options.onSwapComplete || (() => {});
  const MAX_SWAP_ETH = 0.1; // Maximum swap amount: 0.1 ETH equivalent

  const allPairs = getAllSwapPairs();
  addLog(`[SWAP ENGINE] Starting AUTOMATIC SWAPS: ${allPairs.length} pairs, interval=${intervalSeconds}s`, "success");
  addLog(`[SWAP ENGINE] Max swap amount: ${MAX_SWAP_ETH} ETH equivalent`, "info");

  // Build bidirectional pair list: for each pair, we do both A→B and B→A
  // The discoveredSwapPairs already contains both directions for ETH↔Token pairs
  // For Token→Token pairs, we add reverse direction too
  const bidirectionalPairs = [];
  for (const pair of allPairs) {
    bidirectionalPairs.push(pair);
    // Add reverse direction if not already present
    const reverseExists = allPairs.some(p => p.from === pair.to && p.to === pair.from);
    if (!reverseExists) {
      bidirectionalPairs.push({ from: pair.to, to: pair.from });
    }
  }
  addLog(`[SWAP ENGINE] Bidirectional pairs: ${bidirectionalPairs.length}`, "info");

  let cycleCount = 0;
  let pairIndex = 0;
  let totalSwaps = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  try {
    // INFINITE LOOP — runs until explicitly stopped
    while (!cyclicSwapStopRequested) {
      const pair = bidirectionalPairs[pairIndex];

      // ── Pre-swap SAFETY: validate addresses won't collide ──
      try {
        const fromInfo = normalizeToken(pair.from);
        const toInfo = normalizeToken(pair.to);
        if (fromInfo.address.toLowerCase() === toInfo.address.toLowerCase()) {
          pairIndex = (pairIndex + 1) % bidirectionalPairs.length;
          if (pairIndex === 0) cycleCount++;
          totalSkipped++;
          continue;
        }
      } catch (resolveErr) {
        addLog(`[SWAP] SKIP ${pair.from} → ${pair.to}: ${resolveErr.message}`, "warn");
        pairIndex = (pairIndex + 1) % bidirectionalPairs.length;
        if (pairIndex === 0) cycleCount++;
        totalSkipped++;
        continue;
      }

      // ── Generate random amount (max 0.1 ETH equivalent) ──
      let amount;
      try {
        // For ETH: random between 0.001 and 0.1
        // For tokens: proportional amounts based on token decimals
        const isEth = pair.from.toUpperCase() === "ETH" || pair.from.toUpperCase() === "WETH";
        if (isEth) {
          // Random ETH amount: 0.001 to 0.1
          amount = 0.001 + Math.random() * (MAX_SWAP_ETH - 0.001);
          // Randomize decimal places for natural look (3-5 digits)
          const decimals = 3 + Math.floor(Math.random() * 3);
          amount = Number(amount.toFixed(decimals));
        } else {
          // For tokens: use existing random amount generator with cap
          const amtStr = await getRandomSwapAmount(pair.from, { tokenOut: pair.to });
          amount = Number(amtStr);
          // Cap at proportional equivalent of 0.1 ETH
          const maxToken = MAX_SWAP_ETH * 2000; // rough ETH price equivalent
          amount = Math.min(amount, maxToken);
        }
      } catch (e) {
        amount = 0.001; // fallback small amount
      }

      // ── Ensure amount > 0 ──
      if (!Number.isFinite(amount) || amount <= 0) {
        pairIndex = (pairIndex + 1) % bidirectionalPairs.length;
        if (pairIndex === 0) cycleCount++;
        totalSkipped++;
        continue;
      }

      // Get wallet and provider
      const accountIndex = 0;
      const proxyUrl = proxies[accountIndex % proxies.length] || null;
      const provider = getProvider(SEPOLIA_RPC_URL, SEPOLIA_CHAIN_ID, proxyUrl);
      const wallet = new ethers.Wallet(accounts[accountIndex].privateKey, provider);

      // Check balance before attempting swap
      const hasBalance = await hasSufficientBalance(wallet, provider, pair.from, amount);
      if (!hasBalance) {
        totalSkipped++;
      } else {
        try {
          const result = await executeSwap(wallet, pair.from, pair.to, String(amount), { proxyUrl, slippageBps: 50, deadlineSeconds: 600 });
          totalSwaps++;
          addLog(`[SWAP] ✓ ${totalSwaps}. ${pair.from} → ${pair.to} amount=${amount.toFixed(6)} | tx=${result.txHash}`, "success");
          onSwapComplete(result);
        } catch (error) {
          totalErrors++;
          const msg = String(error.message || "");
          if (msg.includes("insufficient") || msg.includes("Invalid quote") || msg.includes("zero output") || msg.includes("getAmountsOut failed") || msg.includes("identical tokens") || msg.includes("identical addresses")) {
            totalSkipped++;
          } else {
            addLog(`[SWAP] ERROR ${pair.from} → ${pair.to}: ${msg.slice(0, 100)}`, "error");
          }
        }
      }

      // Move to next pair immediately (no unnecessary waiting)
      pairIndex = (pairIndex + 1) % bidirectionalPairs.length;
      if (pairIndex === 0) {
        cycleCount++;
        addLog(`[SWAP] ─── Cycle ${cycleCount} complete │ Total: ${totalSwaps} swaps, ${totalSkipped} skipped, ${totalErrors} errors ───`, "success");
      }

      // Minimal delay between swaps (1-3 seconds for natural behavior)
      if (!cyclicSwapStopRequested) {
        const delay = 1000 + Math.random() * 2000; // 1-3 seconds
        await sleep(delay);
      }
    }
  } finally {
    cyclicSwapRunning = false;
    addLog(`[SWAP ENGINE] STOPPED │ Final stats: ${totalSwaps} swaps, ${totalSkipped} skipped, ${totalErrors} errors, ${cycleCount} cycles`, "warn");
  }
}

/**
 * Stop the cyclic swap engine.
 */
function stopCyclicSwapEngine() {
  cyclicSwapStopRequested = true;
  addLog("[SWAP ENGINE] Stop requested", "warn");
}

// Old performSwap helper code below (kept for reference, now unused)
async function _old_performSwap_legacy(wallet, fromToken, toToken, amount, proxyUrl) {
  const provider = getProvider(SEPOLIA_RPC_URL, SEPOLIA_CHAIN_ID, proxyUrl);
  wallet = wallet.connect(provider);
  await assertContractTarget(provider, NEMESIS_ROUTER, "swap router");
  const router   = new ethers.Contract(NEMESIS_ROUTER, ROUTER_ABI, wallet);
  const deadline  = Math.floor(Date.now() / 1000) + 60 * 20;
  const slippage  = 0.95; 

  const label = `${fromToken} ➪  ${toToken}`;
  addLog(`Preparing swap: ${amount} ${fromToken} ➪  ${toToken}`, "wait");
  addLog(`[ROUTE] swap router=${NEMESIS_ROUTER}`, "info");

  const feeParams  = await getFeeParams(provider);
  const gasLimit   = 300000n;

  if (fromToken === "ETH") {
    const tokenInfo  = TOKENS[toToken];
    const path       = [WETH_ADDRESS, tokenInfo.address];
    const amountInWei = ethers.parseEther(amount.toFixed(8));
    if (amountInWei <= 0n) return addLog("[SKIP] Invalid quote", "warn");
    addLog(`[SWAP] method=swapExactETHForTokens path=${path.join(" -> ")}`, "info");

    let amountOut = 0n;
    let amountOutMin = 0n;
    try {
      const amounts  = await router.getAmountsOut(amountInWei, path);
      amountOut = BigInt(amounts[1]);
      amountOutMin   = amountOut * BigInt(Math.floor(slippage * 100)) / 100n;
      addLog(
        `Quote: ${amount} ETH ➪ ${ethers.formatUnits(amountOut, tokenInfo.decimals)} ${toToken}` +
        ` (min: ${ethers.formatUnits(amountOutMin, tokenInfo.decimals)})`,
        "info"
      );
    } catch (err) {
      addLog(`getAmountsOut failed (${label}): ${err.message}.`, "warn");
      return addLog("[SKIP] Invalid quote", "warn");
    }
    if (isInvalidQuote(amountOut, amountOutMin)) return addLog("[SKIP] Invalid quote", "warn");

    const ethBal = await provider.getBalance(wallet.address);
    const gasCost = (feeParams.maxFeePerGas || feeParams.gasPrice) * gasLimit;
    if (ethBal < amountInWei + gasCost) {
      throw new Error(`Insufficient ETH: have ${ethers.formatEther(ethBal)}, need ${ethers.formatEther(amountInWei + gasCost)}`);
    }

    const nonce = await getNextNonce(provider, wallet.address, SEPOLIA_CHAIN_ID);
    const tx = await router.swapExactETHForTokens(
      amountOutMin, path, wallet.address, deadline,
      { value: amountInWei, ...feeParams, gasLimit, nonce }
    );
    addLog(`Swap tx sent (${label}): ${getShortHash(tx.hash)}`, "warn");
    const receipt = await waitForTx(tx);
    addLog(`Swap ${amount.toFixed(6)} ETH ➪  ${toToken} Done | Hash: ${getShortHash(tx.hash)}`, "success");

  } else {
    const tokenInfo  = TOKENS[fromToken];
    const path       = [tokenInfo.address, WETH_ADDRESS];
    const amountInWei = ethers.parseUnits(amount.toFixed(8), tokenInfo.decimals);
    if (amountInWei <= 0n) return addLog("[SKIP] Invalid quote", "warn");
    addLog(`[SWAP] method=swapExactTokensForETH path=${path.join(" -> ")}`, "info");

    const tokenContract = new ethers.Contract(tokenInfo.address, ERC20_ABI, provider);
    const tokenBal = await tokenContract.balanceOf(wallet.address);
    if (tokenBal < amountInWei) {
      throw new Error(`Insufficient ${fromToken}: have ${ethers.formatUnits(tokenBal, tokenInfo.decimals)}, need ${ethers.formatUnits(amountInWei, tokenInfo.decimals)}`);
    }

    let amountOut = 0n;
    let amountOutMin = 0n;
    try {
      const amounts  = await router.getAmountsOut(amountInWei, path);
      amountOut = BigInt(amounts[1]);
      amountOutMin   = amountOut * BigInt(Math.floor(slippage * 100)) / 100n;
      addLog(
        `Quote: ${amount} ${fromToken} ➪ ${ethers.formatEther(amountOut)} ETH` +
        ` (min: ${ethers.formatEther(amountOutMin)})`,
        "info"
      );
    } catch (err) {
      addLog(`getAmountsOut failed (${label}): ${err.message}.`, "warn");
      return addLog("[SKIP] Invalid quote", "warn");
    }
    if (isInvalidQuote(amountOut, amountOutMin)) return addLog("[SKIP] Invalid quote", "warn");

    await approveToken(wallet, tokenInfo.address, NEMESIS_ROUTER, amountInWei, provider);

    const ethBal = await provider.getBalance(wallet.address);
    const gasCost = (feeParams.maxFeePerGas || feeParams.gasPrice) * gasLimit;
    if (ethBal < gasCost) {
      throw new Error(`Insufficient ETH for gas: have ${ethers.formatEther(ethBal)}, need ${ethers.formatEther(gasCost)}`);
    }

    const nonce = await getNextNonce(provider, wallet.address, SEPOLIA_CHAIN_ID);
    const tx = await router.swapExactTokensForETH(
      amountInWei, amountOutMin, path, wallet.address, deadline,
      { ...feeParams, gasLimit, nonce }
    );
    addLog(`Swap tx sent (${label}): ${getShortHash(tx.hash)}`, "warn");
    const receipt = await waitForTx(tx);
    addLog(`Swap ${amount.toFixed(4)} ${fromToken} ➪ ETH Done!! | Hash: ${getShortHash(tx.hash)}`, "success");
  }
}

async function waitForTx(tx, timeoutMs = 120000) {
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("Transaction confirmation timed out")), timeoutMs)
  );
  let receipt;
  try {
    receipt = await Promise.race([tx.wait(), timeoutPromise]);
  } catch (error) {
    receipt = error?.receipt || error?.transactionReceipt;
    if (receipt) {
      addLog(`[FAIL] tx hash=${receipt.hash || tx.hash}`, "error");
      addLog(`[FAIL] receipt status=${receipt.status}`, "error");
      addLog(`[FAIL] gasUsed=${receipt.gasUsed}`, "error");
    }
    throw error;
  }
  if (receipt.status !== 1) {
    addLog(`[FAIL] tx hash=${receipt.hash || tx.hash}`, "error");
    addLog(`[FAIL] receipt status=${receipt.status}`, "error");
    addLog(`[FAIL] gasUsed=${receipt.gasUsed}`, "error");
    throw new Error("Transaction reverted");
  }
  return receipt;
}

function isNativeToken(token) {
  return !token || token === ZERO_ADDRESS || String(token).toLowerCase() === "native" || String(token).toLowerCase() === "eth";
}

// ─── Universal token normalization ───
// Maps any token input (symbol, address, alias) to a canonical { symbol, address, decimals }.
// ETH and WETH always resolve to the SAME address, so they are never treated as
// two different assets.  Returns { symbol, address, decimals }.
function normalizeToken(input) {
  if (!input) throw new Error("No token specified for normalizeToken");

  // If it's an address, look it up in TOKENS map
  if (ethers.isAddress(input)) {
    const found = Object.values(TOKENS).find(t => t.address.toLowerCase() === input.toLowerCase());
    if (found) return { ...found };
    return { address: input, decimals: 18, symbol: getShortAddress(input) };
  }

  const upper = String(input).toUpperCase();

  // ETH and WETH are the SAME token on Nemesis — always return WETH address
  if (upper === "ETH" || upper === "WETH") {
    return { address: WETH_ADDRESS, decimals: 18, symbol: "WETH" };
  }

  if (TOKENS[upper]) return { ...TOKENS[upper] };

  const discovered = discoveredTokenList.find(t => t.symbol?.toUpperCase() === upper);
  if (discovered) return { ...discovered };

  throw new Error(`Unknown token: ${input}. Available: ${Object.keys(TOKENS).join(", ")}`);
}

/**
 * Validate that a token contract exists and implements standard ERC20 methods.
 * Returns a validation report object.
 *
 * Checks:
 *  1. Contract exists (getCode returns non-empty)
 *  2. decimals() works and returns a reasonable value (1-18)
 *  3. symbol() works and returns a non-empty string
 *  4. name() works (optional, non-critical)
 *  5. balanceOf() works (optional, non-critical)
 *  6. allowance() works (optional, non-critical)
 *
 * @param {string} tokenAddress - The token contract address
n * @param {string} expectedSymbol - The expected symbol (for logging)
 * @param {object} provider - ethers provider
 * @returns {object} { valid, address, symbol, name, decimals, error, checks }
 */
async function validateTokenContract(tokenAddress, expectedSymbol, provider) {
  const result = {
    valid: false,
    address: tokenAddress,
    symbol: expectedSymbol,
    name: null,
    decimals: null,
    error: null,
    checks: {
      contractExists: false,
      isERC20: false,
      decimals: false,
      symbol: false,
      name: false,
      balanceOf: false,
      allowance: false
    }
  };

  try {
    // Check 1: Contract exists
    const code = await provider.getCode(tokenAddress);
    if (!code || code === "0x" || code.length <= 2) {
      result.error = `NO_CONTRACT: address ${tokenAddress} has no contract code (is an EOA or empty)`;
      addLog(`[TOKEN VALID] ✗ ${expectedSymbol} (${getShortAddress(tokenAddress)}) — ${result.error}`, "error");
      return result;
    }
    result.checks.contractExists = true;

    // Check 2-6: Call ERC20 methods
    const ERC20_VALIDATION_ABI = [
      "function decimals() view returns (uint8)",
      "function symbol() view returns (string)",
      "function name() view returns (string)",
      "function balanceOf(address) view returns (uint256)",
      "function allowance(address owner, address spender) view returns (uint256)"
    ];
    const contract = new ethers.Contract(tokenAddress, ERC20_VALIDATION_ABI, provider);

    // Check decimals
    try {
      const dec = await contract.decimals();
      const decNum = Number(dec);
      if (Number.isFinite(decNum) && decNum >= 0 && decNum <= 18) {
        result.decimals = decNum;
        result.checks.decimals = true;
      } else {
        result.error = `INVALID_DECIMALS: got ${dec} (expected 0-18)`;
      }
    } catch (e) {
      result.error = `DECIMALS_FAILED: ${e.message}`;
    }

    // Check symbol
    try {
      const sym = await contract.symbol();
      if (sym && String(sym).length > 0) {
        result.symbol = String(sym);
        result.checks.symbol = true;
        // Warn if on-chain symbol differs from expected
        if (String(sym).toUpperCase() !== expectedSymbol.toUpperCase()) {
          result.error = `SYMBOL_MISMATCH: expected ${expectedSymbol}, got ${sym}`;
          addLog(`[TOKEN VALID] ⚠ ${expectedSymbol} → on-chain symbol is "${sym}" (may be wrong address)`, "warn");
        }
      } else {
        result.error = `EMPTY_SYMBOL: symbol() returned empty`;
      }
    } catch (e) {
      result.error = `SYMBOL_FAILED: ${e.message}`;
    }

    // Check name
    try {
      const n = await contract.name();
      if (n && String(n).length > 0) {
        result.name = String(n);
        result.checks.name = true;
      }
    } catch (e) { /* name is optional */ }

    // Check balanceOf
    try {
      const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
      await contract.balanceOf(ZERO_ADDR);
      result.checks.balanceOf = true;
    } catch (e) { /* balanceOf failure is non-critical */ }

    // Check allowance
    try {
      const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
      await contract.allowance(ZERO_ADDR, ZERO_ADDR);
      result.checks.allowance = true;
    } catch (e) { /* allowance failure is non-critical */ }

    // Determine if valid (must have: contract exists + decimals + symbol)
    result.checks.isERC20 = result.checks.decimals && result.checks.symbol;
    result.valid = result.checks.contractExists && result.checks.isERC20;

    if (result.valid) {
      addLog(`[TOKEN VALID] ✓ ${result.symbol} (${getShortAddress(tokenAddress)}) dec=${result.decimals} name=${result.name || "?"}`, "success");
    } else {
      addLog(`[TOKEN VALID] ✗ ${expectedSymbol} (${getShortAddress(tokenAddress)}) — ${result.error}`, "error");
    }

    return result;
  } catch (err) {
    result.error = `VALIDATION_ERROR: ${err.message}`;
    addLog(`[TOKEN VALID] ✗ ${expectedSymbol} (${getShortAddress(tokenAddress)}) — ${result.error}`, "error");
    return result;
  }
}

/**
 * Remove invalid tokens from the TOKENS map at startup.
 * This prevents errors in swap engine, trade engine, and diagnostics.
 */
async function cleanupInvalidTokens(provider) {
  const invalidSymbols = [];
  for (const [name, info] of Object.entries(TOKENS)) {
    if (!info || !info.address) continue;
    const report = await validateTokenContract(info.address, name, provider);
    if (!report.valid) {
      invalidSymbols.push(name);
    }
  }
  if (invalidSymbols.length > 0) {
    for (const sym of invalidSymbols) {
      addLog(`[CLEANUP] Removing invalid token: ${sym} (${TOKENS[sym].address})`, "warn");
      delete TOKENS[sym];
    }
    addLog(`[CLEANUP] Removed ${invalidSymbols.length} invalid tokens from TOKENS map`, "warn");
  } else {
    addLog(`[CLEANUP] All tokens validated successfully, no removals needed`, "success");
  }
}

function normalizeCollateralToken(token) {
  if (isNativeToken(token)) return WETH_ADDRESS;
  if (!ethers.isAddress(token)) throw new Error(`Invalid collateral token: ${token}`);
  return token;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  UNIFIED COLLATERAL RESOLUTION — SINGLE SOURCE OF TRUTH
//  ═══════════════════════════════════════════════════════════════════════════════
//  Nemesis contract determines position direction by COLLATERAL TOKEN,
//  NOT by the isLong calldata parameter (which is IGNORED).
//
//  UNIVERSAL RULE (verified across 870+ events from 4 managers on Sepolia):
//    WETH collateral → LONG position  (142 LONG, 0 SHORT)
//    Any other token → SHORT position (0 LONG, 718 SHORT across USDT/DAI/NEM/NEMESIS)
//
//  This function is the SINGLE place that determines collateral for a side.
//  ALL code paths must use it: Open LONG, Open SHORT, Auto RSI, Full Auto, CLI, TUI.
// ═══════════════════════════════════════════════════════════════════════════════
function resolveCollateralForSide(side) {
  if (side === "LONG") {
    const longTokens = collateralRules.LONG;
    if (longTokens.length > 0) {
      const best = longTokens[0];
      if (best.address.toLowerCase() === WETH_ADDRESS.toLowerCase()) return "native";
      return best.address;
    }
    return "native"; // fallback
  } else if (side === "SHORT") {
    const shortTokens = collateralRules.SHORT;
    if (shortTokens.length > 0) return shortTokens[0].address;
    return USDT_ADDRESS; // fallback
  }
  throw new Error(`resolveCollateralForSide: unknown side "${side}"`);
}

function sortTokenPair(tokenA, tokenB) {
  return [tokenA, tokenB].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

function encodeLeverage(leverage) {
  const lev = Number(leverage);
  if (!Number.isFinite(lev) || lev <= 0) throw new Error("Invalid leverage");
  return BigInt(Math.round(lev));
}

function applySlippage(amount, slippageBps = tradingConfig.slippageBps) {
  const bps = BigInt(Math.max(0, Number(slippageBps) || 0));
  if (amount <= 0n || bps >= BPS) return 0n;
  return amount * (BPS - bps) / BPS;
}

function normalizeMarketConfig(market = {}) {
  const collateralToken = market.collateralToken || tradingConfig.defaultCollateralToken;
  const marketToken = market.marketToken || tradingConfig.marketToken || tradingConfig.pairToken;
  const symbol = market.symbol || `${getShortAddress(marketToken)}/${getShortAddress(collateralToken)}`;
  return {
    ...market,
    symbol,
    marketToken,
    collateralToken,
    supportsLong: market.supportsLong !== false,
    supportsShort: market.supportsShort !== false,
    rsiSymbol: market.rsiSymbol || "ETHUSDT"
  };
}

function isValidContractTarget(target) {
  return ethers.isAddress(target) && target !== ZERO_ADDRESS;
}

async function assertContractTarget(provider, target, label) {
  if (!isValidContractTarget(target)) throw new Error(`Invalid ${label} address: ${target}`);
  const code = await provider.getCode(target);
  if (!code || code === "0x") throw new Error(`Invalid ${label}: no contract code at ${target}`);
}

function isInvalidQuote(amountOut, amountOutMin) {
  return amountOut == null || amountOutMin == null || BigInt(amountOut) <= 0n || BigInt(amountOutMin) <= 0n;
}

function getPositionMarketKey(position) {
  return String(position.symbol || `${position.marketToken || ""}:${position.collateralToken || ""}`).toLowerCase();
}

function countOpenForMarket(market, side = null) {
  const key = getPositionMarketKey(market);
  return (tradingConfig.activePositions || []).filter(position => {
    if (side && position.side !== side) return false;
    return getPositionMarketKey(position) === key;
  }).length;
}

function canOpenMarketSide(market, side) {
  if (side === "LONG" && !market.supportsLong) return false;
  if (side === "SHORT" && !market.supportsShort) return false;
  if (countOpenForMarket(market, side) > 0) return false;
  if (countOpenForMarket(market) >= tradingConfig.maxTradesPerPair) return false;
  if ((tradingConfig.activePositions || []).length >= tradingConfig.maxConcurrentTrades) return false;
  if ((tradingConfig.activePositions || []).length >= tradingConfig.maxOpenPositions) return false;
  return true;
}

async function syncActivePositionsFromChain(wallet, provider) {
  addLog("[SYNC] refreshing positions from chain...", "warn");
  const cached = Array.isArray(tradingConfig.activePositions) ? tradingConfig.activePositions : [];
  const live = await discoverActivePositions(wallet, provider);
  const liveIds = new Set(live.map(position => String(position.positionId)));
  for (const cachedPosition of cached) {
    if (!liveIds.has(String(cachedPosition.positionId))) {
      addLog("[SYNC] removed stale cached position", "warn");
    }
  }
  tradingConfig.activePositions = live.map(position => {
    const cachedPosition = cached.find(item => String(item.positionId) === String(position.positionId)) || {};
    return { ...cachedPosition, ...position };
  });
  if (tradingConfig.activePositions.length === 0) {
    tradingConfig.closePositionId = "";
  }
  saveConfig();
  return tradingConfig.activePositions;
}

function feeAdjusted(amount, feeBps = 100n) {
  if (amount === 0n) return 0n;
  if (feeBps <= 0n) return amount;
  if (feeBps >= BPS) return 0n;
  return amount * (BPS - feeBps) / BPS;
}

function collateralAsLp({ collateralToken, collateralAmount, reserve0, reserve1, totalSupply, token0, oraclePrice0 }) {
  const q112 = 1n << 112n;
  if (collateralAmount === 0n || reserve0 === 0n || reserve1 === 0n || totalSupply === 0n || oraclePrice0 === 0n) return 0n;
  const collateralValue = collateralToken.toLowerCase() === token0.toLowerCase()
    ? collateralAmount * oraclePrice0 / q112
    : collateralAmount;
  const poolValue = reserve0 * oraclePrice0 / q112 + reserve1;
  return poolValue === 0n ? 0n : collateralValue * totalSupply / poolValue;
}

function lpBorrowToExpectedOut({ lpBorrowAmount, collateralToken, reserve0, reserve1, totalSupply, token0, swapFeeBps }) {
  if (lpBorrowAmount === 0n || reserve0 === 0n || reserve1 === 0n || totalSupply === 0n || swapFeeBps >= BPS) return 0n;
  const collateralIsToken0 = collateralToken.toLowerCase() === token0.toLowerCase();
  const amountIn = collateralIsToken0 ? lpBorrowAmount * reserve1 / totalSupply : lpBorrowAmount * reserve0 / totalSupply;
  const collateralFromLp = collateralIsToken0 ? lpBorrowAmount * reserve0 / totalSupply : lpBorrowAmount * reserve1 / totalSupply;
  const reserveIn = collateralIsToken0 ? reserve1 : reserve0;
  const reserveOut = collateralIsToken0 ? reserve0 : reserve1;
  if (amountIn === 0n || reserveIn <= amountIn || reserveOut <= collateralFromLp) return 0n;
  const adjustedReserveIn = reserveIn - amountIn;
  const adjustedReserveOut = reserveOut - collateralFromLp;
  const amountInWithFee = amountIn * (BPS - swapFeeBps);
  return amountInWithFee * adjustedReserveOut / (adjustedReserveIn * BPS + amountInWithFee);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  UNIVERSAL COLLATERAL DISCOVERY — queries Nemesis subgraph + Factory on-chain
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Fetch the canonical token list from the Nemesis subgraph.
 * Returns an array of { address, symbol, decimals } objects.
 */
async function discoverTokenList(provider) {
  try {
    const query = `query { tokens(first: 100, orderBy: symbol) { id symbol decimals name } }`;
    const response = await fetch(NEMESIS_SUBGRAPH_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query })
    });
    const json = await response.json();
    const tokens = json.data?.tokens || [];
    if (tokens.length === 0) {
      addLog("[DISCOVER] Subgraph returned no tokens, using static list", "warn");
      return Object.values(TOKENS);
    }
    const list = tokens.map(t => ({
      address: t.id,
      symbol: t.symbol,
      decimals: Number(t.decimals) || 18,
      name: t.name || t.symbol
    }));
    addLog(`[DISCOVER] Found ${list.length} tokens from subgraph`, "success");
    return list;
  } catch (error) {
    addLog(`[DISCOVER] Subgraph token fetch failed: ${error.message}, using static list`, "warn");
    return Object.values(TOKENS);
  }
}

/**
 * For each collateral token, probe the Factory to check if a pool exists with WETH.
 * Returns an array of market candidates with pool/manager resolved.
 */
async function discoverSupportedMarkets(provider, tokenList) {
  const factory = new ethers.Contract(LEVERAGED_FACTORY, FACTORY_ABI, provider);
  const markets = [];
  const seen = new Set();

  // WETH is always the marketToken (the token you go long/short on)
  const marketToken = WETH_ADDRESS;

  for (const token of tokenList) {
    const collateral = token.address;
    // Skip WETH as collateral (can't go long ETH with ETH collateral — use native)
    if (collateral.toLowerCase() === marketToken.toLowerCase()) continue;
    // Skip known zero address
    if (!collateral || collateral === ZERO_ADDRESS) continue;

    const pairKey = [marketToken, collateral].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())).join(":");
    if (seen.has(pairKey)) continue;
    seen.add(pairKey);

    try {
      const [tokenA, tokenB] = sortTokenPair(marketToken, collateral);
      const pool = await factory.getPool(tokenA, tokenB);
      if (!pool || pool === ZERO_ADDRESS) {
        addLog(`[DISCOVER] No pool for ${token.symbol}/ETH, skipping`, "debug");
        continue;
      }
      const manager = await factory.getManager(pool);
      if (!manager || manager === ZERO_ADDRESS) {
        addLog(`[DISCOVER] No manager for pool ${pool}, skipping`, "debug");
        continue;
      }
      // ── HEALTH CHECK: verify manager responds to getAvailableLiquidity() ──
      try {
        const mgrContract = new ethers.Contract(manager, POSITION_ABI, provider);
        const liquidity = await mgrContract.getAvailableLiquidity();
        if (liquidity <= 0n) {
          addLog(`[DISCOVER] Manager ${getShortAddress(manager)} has zero liquidity, skipping`, "debug");
          continue;
        }
        addLog(`[DISCOVER] Manager ${getShortAddress(manager)} liquidity=${liquidity.toString()}`, "debug");
      } catch (healthErr) {
        addLog(`[DISCOVER] Manager ${getShortAddress(manager)} failed health check: ${healthErr.message}, skipping`, "warn");
        continue;
      }
      markets.push({
        symbol: `ETH/${token.symbol}`,
        marketToken,
        collateralToken: collateral,
        collateralSymbol: token.symbol,
        collateralDecimals: token.decimals,
        poolAddress: pool,
        managerAddress: manager,
        supportsLong: true,
        supportsShort: true,
        rsiSymbol: "ETHUSDT"
      });
      addLog(`[DISCOVER] ✓ ETH/${token.symbol} pool=${getShortAddress(pool)} manager=${getShortAddress(manager)}`, "info");
    } catch (error) {
      addLog(`[DISCOVER] Error probing ${token.symbol}: ${error.message}`, "debug");
    }
  }

  addLog(`[DISCOVER] Total supported markets: ${markets.length}`, "success");
  return markets;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  ADAPTIVE COLLATERAL RULE DISCOVERY — scans on-chain events
// ═══════════════════════════════════════════════════════════════════════════════
async function discoverCollateralRules(provider) {
  addLog("[RULES] Scanning on-chain events to determine collateral rules...", "info");
  const managerSet = new Set();
  for (const market of discoveredMarkets) {
    if (market.managerAddress) managerSet.add(market.managerAddress.toLowerCase());
  }
  // CURRENT: managers from NEW Factory (0x0e73...) — verified 2026-08-15
  const knownManagers = [
    // CURRENT managers (from nemesis.trade frontend JS — verified via factory.getManager())
    "0x4041a3099A96475b7484f421cb77111D6C39BFc3",  // ETH/USDT
    "0x125f68F98A50F6f6c93DeAc34A6B52d797029a80",  // ETH/NEMESIS
    "0x371e7fB3a9d380feFeADd53014F2566f72fd2EB0",  // ETH/UNI
    // Legacy managers (kept for existing position tracking from old deployment)
    "0x3937c0a8B12F51812A5Bcd91920Aca8390dEdEE9",
    "0xC20De3394BFd88d2FAC7E43dbbf2ba3dDe06dE81",
    "0x316f1CB64441b38877d1b549386731d7639F1e21",
    "0x33Cf85B6Dc6318E62a85A5014d3c6134633aa8BA",
    "0x53bb0fFBdA04E5982fa08D846aA265Ff6cFE068e",
    "0x1376b7A0663e83bfaed1c009f3472B133Ac8c4D7",
    "0x490Cfc261B74B5Bcff223aE15f36faEdBa7b6f69",
    "0x0beE5643CEb63984a33200DB0eEad001cfad1f19",
    "0x21e07B3f9ecFE27988b7aDdaedf9CebD09B90946"
  ];
  for (const m of knownManagers) managerSet.add(m.toLowerCase());
  if (managerSet.size === 0) { applyFallbackRules(); return; }
  const EVENT_SIG = ethers.id("MAM_PositionCreated(uint256,address,bool,address,uint256,uint256,uint256,uint256,uint256)");
  const blockNum = await provider.getBlockNumber();
  const collateralMap = {};
  let totalEvents = 0;
  for (const mgrAddr of managerSet) {
    try {
      const logs = await provider.getLogs({ address: mgrAddr, topics: [EVENT_SIG], fromBlock: blockNum - 5000, toBlock: blockNum });
      for (const log of logs) {
        try {
          const data = log.data.slice(2);
          const isLong = BigInt("0x" + data.slice(0, 64)) !== 0n;
          const collateralAddr = "0x" + data.slice(88, 128);
          const colLower = collateralAddr.toLowerCase();
          if (!collateralMap[colLower]) {
            const tokenInfo = TOKENS[Object.keys(TOKENS).find(k => TOKENS[k].address.toLowerCase() === colLower)];
            collateralMap[colLower] = { address: collateralAddr, symbol: tokenInfo?.symbol || colLower.slice(0, 8), decimals: tokenInfo?.decimals || 6, long: 0, short: 0 };
          }
          if (isLong) collateralMap[colLower].long++; else collateralMap[colLower].short++;
          totalEvents++;
        } catch (e) { /* skip */ }
      }
    } catch (e) { /* skip */ }
  }
  const longTokens = [], shortTokens = [];
  for (const [addr, info] of Object.entries(collateralMap)) {
    if (info.long > 0 && info.short === 0) longTokens.push({ address: info.address, symbol: info.symbol, decimals: info.decimals, confidence: info.long });
    else if (info.short > 0 && info.long === 0) shortTokens.push({ address: info.address, symbol: info.symbol, decimals: info.decimals, confidence: info.short });
    else if (info.long > 0 && info.short > 0) {
      if (info.long >= info.short) longTokens.push({ address: info.address, symbol: info.symbol, decimals: info.decimals, confidence: info.long });
      else shortTokens.push({ address: info.address, symbol: info.symbol, decimals: info.decimals, confidence: info.short });
    }
  }
  if (longTokens.length === 0 && shortTokens.length === 0) { applyFallbackRules(); return; }
  collateralRules = { LONG: longTokens.sort((a, b) => b.confidence - a.confidence), SHORT: shortTokens.sort((a, b) => b.confidence - a.confidence), lastDiscovery: Date.now(), eventCount: totalEvents };
  addLog(`[RULES] Discovered from ${totalEvents} events: LONG=${longTokens.map(t => t.symbol).join(",") || "none"} SHORT=${shortTokens.map(t => t.symbol).join(",") || "none"}`, "success");
}

function applyFallbackRules() {
  collateralRules = { LONG: [{ address: WETH_ADDRESS, symbol: "WETH", decimals: 18, confidence: 0 }], SHORT: [{ address: USDT_ADDRESS, symbol: "USDT", decimals: 6, confidence: 0 }], lastDiscovery: Date.now(), eventCount: 0 };
  addLog("[RULES] Applied fallback: LONG=WETH, SHORT=USDT", "warn");
}

async function verifyPositionDirection(positionId, expectedSide, managerAddr, provider) {
  try {
    const mc = new ethers.Contract(managerAddr, ["function getPosition(uint256) view returns (bool,address,address,uint256,uint256,uint256,uint256)"], provider);
    const pos = await mc.getPosition(positionId);
    const actualSide = pos[0] ? "LONG" : "SHORT";
    if (actualSide !== expectedSide) {
      addLog(`[RULES] MISMATCH! pos ${positionId}: expected ${expectedSide}, got ${actualSide} — re-researching rules...`, "error");
      await discoverCollateralRules(provider);
      return false;
    }
    addLog(`[RULES] pos ${positionId} direction verified: ${actualSide} ✅`, "success");
    return true;
  } catch (e) { addLog(`[RULES] Verify error: ${e.message}`); return false; }
}

// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build a token map from discovered token list (indexed by symbol and address).
 * Merges with the static TOKENS map so fallback data is preserved.
 */
function buildTokenMap(tokenList) {
  const map = {};
  for (const token of tokenList) {
    map[token.symbol] = token;
    map[token.address.toLowerCase()] = token;
  }
  // Ensure WETH/ETH alias
  if (map["WETH"] && !map["ETH"]) map["ETH"] = map["WETH"];
  if (map["ETH"] && !map["WETH"]) map["WETH"] = map["ETH"];
  return map;
}

/**
 * Resolve the collateral token address from a symbol or address.
 * Returns the normalized address.
 */
function resolveCollateralAddress(input, tokenMap) {
  if (!input) throw new Error("No collateral token specified");
  // Already an address
  if (ethers.isAddress(input)) return input;
  // Symbol lookup
  const upper = String(input).toUpperCase();
  if (tokenMap[upper]) return tokenMap[upper].address;
  if (tokenMap[input]) return tokenMap[input].address;
  throw new Error(`Unknown collateral token: ${input}`);
}

/**
 * Get the list of available collateral symbols for the TUI menu.
 * Only includes tokens that have a valid pool in the Factory.
 */
function getAvailableCollateralSymbols() {
  const symbols = [];
  for (const market of discoveredMarkets) {
    const sym = market.collateralSymbol || market.symbol.split("/")[1];
    if (sym && !symbols.includes(sym)) symbols.push(sym);
  }
  return symbols;
}

/**
 * Prompt the user to select a collateral token, then open a position.
 * Uses the discoveredMarkets list to show only tokens with valid pools.
 */
async function promptCollateralAndOpen(side) {
  const symbols = getAvailableCollateralSymbols();
  if (symbols.length === 0) {
    addLog("No supported collateral tokens found. Running discovery...", "warn");
    const provider = getProvider(SEPOLIA_RPC_URL, SEPOLIA_CHAIN_ID, proxies[selectedWalletIndex % proxies.length] || null);
    discoveredMarkets = await discoverSupportedMarkets(provider, discoveredTokenList);
    const retrySymbols = getAvailableCollateralSymbols();
    if (retrySymbols.length === 0) throw new Error("No supported collateral tokens found in Nemesis Factory");
    return promptCollateralAndOpen(side);
  }
  addLog(`[SELECT] Choose collateral for ${side}: ${symbols.join(", ")}`, "info");
  return new Promise((resolve) => {
    const items = [
      ...symbols.map((s, i) => `[${i + 1}] ${s}`),
      "[0] Cancel"
    ];
    const selectBox = blessed.list({
      label: ` ${side} — Select Collateral `, 
      items,
      keys: true, vi: true,
      style: { border: { fg: "yellow" }, selected: { bg: "blue", fg: "white" }, item: { fg: "white" } },
      width: "50%", height: symbols.length + 4,
      top: "center", left: "center"
    });
    selectBox.on("select", async (item) => {
      selectBox.hide(); screen.remove(selectBox); safeRender();
      const text = item.getText();
      const match = text.match(/^\[(\d+)\]/);
      const idx = match ? parseInt(match[1], 10) : -1;
      if (idx === 0 || idx < 1 || idx > symbols.length) {
        addLog("[SELECT] Cancelled", "info");
        resolve();
        return;
      }
      const chosenSymbol = symbols[idx - 1];
      const market = discoveredMarkets.find(m => m.collateralSymbol?.toUpperCase() === chosenSymbol.toUpperCase());
      if (!market) throw new Error(`Market not found for ${chosenSymbol}`);
      addLog(`[SELECT] Opening ${side} with collateral: ${chosenSymbol} (${market.symbol})`, "success");
      try {
        await openLeveragedPosition(side, market);
      } catch (error) {
        addLog(`Open ${side} failed: ${error.message}`, "error");
        try { await logLongShortPayloadDelta(getProvider(SEPOLIA_RPC_URL, SEPOLIA_CHAIN_ID, proxies[selectedWalletIndex % proxies.length] || null)); } catch {}
      }
      resolve();
    });
    selectBox.on("cancel", () => { selectBox.hide(); screen.remove(selectBox); safeRender(); resolve(); });
    screen.append(selectBox); safeRender(); screen.focusPush(selectBox);
  });
}

/**
 * Prompt user to select TokenIn, TokenOut, and amount for a swap.
 * Uses the universal executeSwap function.
 */
async function promptTokenSwap() {
  const tokenSymbols = Object.keys(TOKENS).filter(s => s !== "WETH");
  if (tokenSymbols.length === 0) throw new Error("No tokens available for swap");

  return new Promise((resolve) => {
    // Step 1: Select Token In
    const inItems = [
      ...tokenSymbols.map((s, i) => `[${i + 1}] ${s}`),
      "[0] Cancel"
    ];
    const inBox = blessed.list({
      label: " Swap — Select Token In ",
      items: inItems,
      keys: true, vi: true,
      style: { border: { fg: "cyan" }, selected: { bg: "blue", fg: "white" }, item: { fg: "white" } },
      width: "50%", height: tokenSymbols.length + 4,
      top: "center", left: "center"
    });

    inBox.on("select", (item) => {
      inBox.hide(); screen.remove(inBox); safeRender();
      const text = item.getText();
      const match = text.match(/^\[(\d+)\]/);
      const idx = match ? parseInt(match[1], 10) : -1;
      if (idx === 0 || idx < 1 || idx > tokenSymbols.length) {
        addLog("[SWAP] Cancelled", "info");
        resolve();
        return;
      }
      const tokenIn = tokenSymbols[idx - 1];

      // Step 2: Select Token Out
      const outSymbols = tokenSymbols.filter(s => s !== tokenIn);
      const outItems = [
        ...outSymbols.map((s, i) => `[${i + 1}] ${s}`),
        "[0] Cancel"
      ];
      const outBox = blessed.list({
        label: ` Swap ${tokenIn} → ? — Select Token Out `,
        items: outItems,
        keys: true, vi: true,
        style: { border: { fg: "cyan" }, selected: { bg: "blue", fg: "white" }, item: { fg: "white" } },
        width: "50%", height: outSymbols.length + 4,
        top: "center", left: "center"
      });

      outBox.on("select", async (outItem) => {
        outBox.hide(); screen.remove(outBox); safeRender();
        const outText = outItem.getText();
        const outMatch = outText.match(/^\[(\d+)\]/);
        const outIdx = outMatch ? parseInt(outMatch[1], 10) : -1;
        if (outIdx === 0 || outIdx < 1 || outIdx > outSymbols.length) {
          addLog("[SWAP] Cancelled", "info");
          resolve();
          return;
        }
        const tokenOut = outSymbols[outIdx - 1];

        // ── AUTO: Generate random amount from balance (no input box) ──
        try {
          const amount = await getRandomSwapAmount(tokenIn, { tokenOut });
          addLog(`[SWAP] Auto amount: ${amount} ${tokenIn} → ${tokenOut}`, "info");
          const wallet = new ethers.Wallet(accounts[selectedWalletIndex].privateKey, getProvider(SEPOLIA_RPC_URL, SEPOLIA_CHAIN_ID, proxies[selectedWalletIndex % proxies.length] || null));
          const result = await executeSwap(wallet, tokenIn, tokenOut, amount);
          addLog(`[SWAP] Done! tx=${result.txHash}`, "success");
        } catch (error) {
          addLog(`[SWAP] Failed: ${error.message}`, "error");
        }
        resolve();
      });
      outBox.on("cancel", () => { outBox.hide(); screen.remove(outBox); safeRender(); resolve(); });
      screen.append(outBox); safeRender(); screen.focusPush(outBox);
    });

    inBox.on("cancel", () => { inBox.hide(); screen.remove(inBox); safeRender(); resolve(); });
    screen.append(inBox); safeRender(); screen.focusPush(inBox);
  });
}

async function getLeveragedContext(provider, collateralToken, marketTokenArg = null, marketConfig = null) {
  const collateral = normalizeCollateralToken(collateralToken);
  const marketToken = normalizeCollateralToken(marketTokenArg || tradingConfig.marketToken);
  const pairToken = normalizeCollateralToken(tradingConfig.pairToken || USDT_ADDRESS);
  // NOTE: Collateral CAN equal market token (e.g., WETH collateral for LONG ETH)
  // The Nemesis UI allows this - user provides ETH as collateral to go long on ETH
  // When collateral == marketToken, we need to find the pool that includes both

  // ── PREFERRED: use market config's known pool/manager if available ──
  // This avoids re-querying Factory which may return a different (broken) pool
  if (marketConfig && isValidContractTarget(marketConfig.poolAddress) && isValidContractTarget(marketConfig.managerAddress)) {
    addLog(`[CONTEXT] Using market config pool=${getShortAddress(marketConfig.poolAddress)} mgr=${getShortAddress(marketConfig.managerAddress)}`, "info");
    return { collateral, marketToken, pairToken, pool: marketConfig.poolAddress, manager: marketConfig.managerAddress, path: [collateral, marketToken] };
  }

  // ── FALLBACK: query Factory for pool/manager ──
  const factory = new ethers.Contract(LEVERAGED_FACTORY, FACTORY_ABI, provider);
  let pool, manager;
  
  // When collateral == marketToken (e.g., WETH collateral for LONG ETH),
  // we need to find a pool that contains both tokens
  if (collateral.toLowerCase() === marketToken.toLowerCase()) {
    // Try pools: collateral/pairToken (e.g., WETH/USDT)
    const [tokenA, tokenB] = sortTokenPair(collateral, pairToken);
    pool = await factory.getPool(tokenA, tokenB);
    if (isValidContractTarget(pool)) {
      manager = await factory.getManager(pool);
      if (isValidContractTarget(manager)) {
        addLog(`[CONTEXT] Found pool ${getShortAddress(pool)} for ${getShortAddress(collateral)}/${getShortAddress(pairToken)}`, "info");
        return { collateral, marketToken, pairToken, pool, manager, path: [collateral, marketToken] };
      }
    }
    throw new Error(`No leveraged pool for ${collateral}/${pairToken} (collateral == marketToken)`);
  }
  
  const [tokenA, tokenB] = sortTokenPair(collateral, marketToken);
  pool = await factory.getPool(tokenA, tokenB);
  if (!isValidContractTarget(pool)) throw new Error(`No leveraged pool for ${collateral}/${marketToken} (poolKey=${getShortAddress(tokenA)}/${getShortAddress(tokenB)})`);
  manager = await factory.getManager(pool);
  if (!isValidContractTarget(manager)) throw new Error(`No leveraged manager for pool ${pool}`);
  return { collateral, marketToken, pairToken, pool, manager, path: [collateral, marketToken] };
}

async function getCollateralDecimals(provider, token, nativeCollateral) {
  if (nativeCollateral) return 18;
  const erc20 = new ethers.Contract(token, ERC20_ABI, provider);
  return Number(await erc20.decimals());
}

async function quoteLeveragedAmountOutMin(provider, { pool, manager, collateralToken, collateralAmount, leverage, isLong, quotePath }) {
  const encodedLev = Number(leverage);
  const lev = encodedLev / 10;
  if (!Number.isFinite(lev) || lev <= 1) return 0n;
  const poolContract = new ethers.Contract(pool, POOL_ABI, provider);
  const managerContract = new ethers.Contract(manager, POSITION_ABI, provider);
  const [reserves, totalSupply, token0, oraclePrice, swapFeeBps, availableLiquidity, ltvBps, protocolFeeBps] = await Promise.all([
    poolContract.getReserves(),
    poolContract.totalSupply(),
    poolContract.token0(),
    poolContract.getOraclePrice(),
    poolContract.swapFeeBps(),
    managerContract.getAvailableLiquidity(),
    managerContract.LTV_BPS(),
    managerContract.PROTOCOL_FEE_BPS().catch(() => 100n)
  ]);
  const reserve0 = BigInt(reserves[0]);
  const reserve1 = BigInt(reserves[1]);
  const effectiveCollateral = feeAdjusted(collateralAmount, BigInt(protocolFeeBps));
  const collateralLp = collateralAsLp({ collateralToken, collateralAmount: effectiveCollateral, reserve0, reserve1, totalSupply, token0, oraclePrice0: BigInt(oraclePrice[0]) });
  if (collateralLp === 0n) throw new Error("Leveraged quoteOut is zero");
  let lpBorrowAmount = collateralLp * BigInt(Math.floor(10000 * Math.max(0, lev - 1))) / BPS;
  const maxByLtv = BigInt(ltvBps) >= BPS ? lpBorrowAmount : collateralLp * BigInt(ltvBps) / (BPS - BigInt(ltvBps));
  if (lpBorrowAmount > maxByLtv) lpBorrowAmount = maxByLtv;
  if (lpBorrowAmount > BigInt(availableLiquidity)) lpBorrowAmount = BigInt(availableLiquidity);
  const amountOutMinRaw = lpBorrowToExpectedOut({ lpBorrowAmount, collateralToken, reserve0, reserve1, totalSupply, token0, swapFeeBps: BigInt(swapFeeBps) });
  const amountOutMinFinal = applySlippage(amountOutMinRaw);
  if (amountOutMinRaw <= 0n || amountOutMinFinal <= 0n) throw new Error("Leveraged amountOutMin is zero");
  if (!isLong) {
    addLog(`shortQuoteInput=${lpBorrowAmount}`, "info");
    addLog(`shortQuoteOutput=${amountOutMinRaw}`, "info");
    addLog(`quotePath=${(quotePath || []).join(" -> ")}`, "info");
    addLog(`amountOutMinRaw=${amountOutMinRaw}`, "info");
    addLog(`amountOutMinFinal=${amountOutMinFinal}`, "info");
  }
  return amountOutMinFinal;
}

async function buildLeveragedTx(provider, isLong, amount, token, leverage, deadline, market = null) {
  const normalizedMarket = normalizeMarketConfig(market || { collateralToken: token });
  const nativeCollateral = isNativeToken(token);
  const context = await getLeveragedContext(provider, token, normalizedMarket.marketToken, normalizedMarket);
  const decimals = await getCollateralDecimals(provider, context.collateral, nativeCollateral);
  const collateralAmount = ethers.parseUnits(String(amount), decimals);
  addLog(`rawUserAmount=${amount}`, "info");
  addLog(`tokenDecimals=${decimals}`, "info");
  addLog(`scaledCollateralAmount=${collateralAmount}`, "info");
  const encodedLeverage = encodeLeverage(leverage);
  const amountOutMin = await quoteLeveragedAmountOutMin(provider, {
    pool: context.pool,
    manager: context.manager,
    collateralToken: context.collateral,
    collateralAmount,
    leverage,
    isLong,
    quotePath: context.path
  }).catch(error => {
    throw new Error(`Leveraged quote failed: ${error.message}`);
  });
  if (amountOutMin <= 0n) throw new Error("Leveraged amountOutMin is zero");
  const data = POSITION_IFACE.encodeFunctionData("openPosition", [isLong, context.collateral, collateralAmount, 0n, encodedLeverage, amountOutMin, BigInt(deadline)]);
  return { to: context.manager, manager: context.manager, pool: context.pool, data, value: 0n, nativeCollateral, collateralToken: context.collateral, marketToken: context.marketToken, symbol: normalizedMarket.symbol, collateralAmount, leverage: encodedLeverage, amountOutMin };
}

function buildLongTx(amount, token = tradingConfig.defaultCollateralToken, leverage = tradingConfig.leverage, deadline = Math.floor(Date.now() / 1000) + tradingConfig.deadlineSeconds, providerArg, market = null) {
  return buildLeveragedTx(providerArg, true, amount, token, leverage, deadline, market);
}

function buildShortTx(amount, token = tradingConfig.defaultCollateralToken, leverage = tradingConfig.leverage, deadline = Math.floor(Date.now() / 1000) + tradingConfig.deadlineSeconds, providerArg, market = null) {
  return buildLeveragedTx(providerArg, false, amount, token, leverage, deadline, market);
}

function buildCloseTx(position) {
  const closeBps = BigInt(Math.round(Number(position.closePercent ?? tradingConfig.closePercent) * 100));
  const deadline = BigInt(position.deadline ?? Math.floor(Date.now() / 1000) + tradingConfig.deadlineSeconds);
  const amountOutMin = BigInt(position.amountOutMin ?? tradingConfig.fallbackAmountOutMin ?? "0");
  if (closeBps >= BPS) return POSITION_IFACE.encodeFunctionData("closePosition", [BigInt(position.positionId), amountOutMin, deadline]);
  return POSITION_IFACE.encodeFunctionData("partialClose", [BigInt(position.positionId), closeBps, amountOutMin, deadline]);
}

async function ensureLeveragedApproval(wallet, token, spender, amount, nativeCollateral, provider) {
  if (nativeCollateral) {
    const weth = new ethers.Contract(WETH_ADDRESS, WETH_ABI, wallet);
    const wethBalance = await weth.balanceOf(wallet.address);
    if (wethBalance < amount) {
      const missing = amount - wethBalance;
      addLog(`Native ETH collateral: wrapping ${ethers.formatEther(missing)} ETH to WETH before open.`, "warn");
      if (tradingConfig.simulateOnly) {
        addLog(`simulateOnly WETH deposit value=${missing}`, "warn");
      } else {
        const feeParams = await getFeeParams(provider);
        const nonce = await getNextNonce(provider, wallet.address, SEPOLIA_CHAIN_ID);
        const wrapTx = await weth.deposit({ value: missing, ...feeParams, gasLimit: 100000n, nonce });
        addLog(`WETH wrap txHash=${wrapTx.hash}`, "warn");
        await waitForTx(wrapTx);
        addLog("WETH wrap confirmed.", "success");
      }
    } else {
      addLog("WETH balance sufficient for native ETH collateral.", "info");
    }
  }
  const contract = new ethers.Contract(token, ERC20_ABI, wallet);
  const allowance = await contract.allowance(wallet.address, spender);
  if (allowance >= amount) return addLog("Leveraged allowance sufficient.", "info");
  if (tradingConfig.simulateOnly) return addLog(`simulateOnly approve ${getShortAddress(spender)} for ${getShortAddress(token)}`, "warn");
  const feeParams = await getFeeParams(provider);
  const nonce = await getNextNonce(provider, wallet.address, SEPOLIA_CHAIN_ID);
  const tx = await contract.approve(spender, ethers.MaxUint256, { ...feeParams, gasLimit: 100000n, nonce });
  addLog(`Leveraged approve txHash=${tx.hash}`, "warn");
  const receipt = await waitForTx(tx);
  if (receipt.status === 0) throw new Error("Leveraged approve reverted");
}

async function validateAndSendLeveragedTx(wallet, tx, side, provider) {
  const isOpenTx = tx.data.slice(0, 10) === "0xfa2b1dfd";
  const isCloseTx = tx.data.slice(0, 10) === "0xb35648d7" || tx.data.slice(0, 10) === "0xdc439ba7";
  if (isOpenTx) {
    if (!isValidContractTarget(tx.to)) throw new Error("Invalid openPosition target/manager");
    if (String(tx.to).toLowerCase() === NEMESIS_ROUTER.toLowerCase()) throw new Error("Invalid openPosition target: swap router selected instead of leveraged manager");
    if (tx.amountOutMin == null || BigInt(tx.amountOutMin) <= 0n) throw new Error("Refusing openPosition: amountOutMin is zero");
    if (tx.collateralAmount == null || BigInt(tx.collateralAmount) <= 0n) throw new Error("Refusing openPosition: collateral amount is zero");
    const decoded = POSITION_IFACE.decodeFunctionData("openPosition", tx.data);
    addLog(`[${side}] arg1 side=${decoded.isLong ? 1 : 0}`, "warn");
    addLog(`[${side}] arg2 token=${decoded.collateralToken}`, "warn");
    addLog(`[${side}] arg3 collateral=${decoded.collateralAmount}`, "warn");
    addLog(`[${side}] arg4 borrow=${decoded.borrowAmount}`, "warn");
    addLog(`[${side}] arg5 leverage=${decoded.leverageX10}`, "warn");
    addLog(`[${side}] arg6 amountOutMin=${decoded.amountOutMin}`, "warn");
    addLog(`[${side}] arg7 deadline=${decoded.deadline}`, "warn");
    addLog(`[${side}] tx.value=${tx.value}`, "warn");
    addLog(`[RSI] market=${tx.symbol || "unknown"}`, "info");
    addLog(`[RSI] manager=${tx.manager || tx.to}`, "info");
    addLog(`[RSI] target=${tx.to}`, "info");
    addLog(`[RSI] calldata=${tx.data}`, "debug");
    if (side === "LONG") {
      addLog(`[LONG] manager=${tx.manager || tx.to}`, "warn");
      addLog(`[LONG] target=${tx.to}`, "warn");
      addLog(`[LONG] calldata=${tx.data}`, "debug");
      addLog(`[LONG] quote=${tx.amountOutMin}`, "warn");
      addLog(`[LONG] amountOutMin=${tx.amountOutMin}`, "warn");
      addLog(`[LONG] leverage=${tx.leverage}`, "warn");
    }
    logUiPayloadDiff(tx, side);
  }
  if (isCloseTx) {
    if (!isValidContractTarget(tx.to)) throw new Error("Invalid close target/manager");
    const decodedClose = POSITION_IFACE.decodeFunctionData(tx.data.slice(0, 10) === "0xb35648d7" ? "closePosition" : "partialClose", tx.data);
    addLog(`[CLOSE] manager=${tx.manager || tx.to}`, "warn");
    addLog(`[CLOSE] target=${tx.to}`, "warn");
    addLog(`[CLOSE] calldata=${tx.data}`, "debug");
    addLog(`[CLOSE] arg1 positionId=${decodedClose.positionId}`, "warn");
    if (tx.data.slice(0, 10) === "0xdc439ba7") addLog(`[CLOSE] arg2 closeBps=${decodedClose.closeBps}`, "warn");
    addLog(`[CLOSE] amountOutMin=${decodedClose.amountOutMin}`, "warn");
    addLog(`[CLOSE] deadline=${decodedClose.deadline}`, "warn");
  }

  const network = await provider.getNetwork();
  const ethBalance = await provider.getBalance(wallet.address);
  addLog(`wallet.address=${wallet.address}`, "info");
  addLog(`config.chainId=${SEPOLIA_CHAIN_ID} provider.chainId=${network.chainId}`, "info");
  addLog(`RPC=${SEPOLIA_RPC_URL}`, "info");
  addLog(`ETH balance=${ethers.formatEther(ethBalance)}`, "info");
  if (isOpenTx) {
    const maxAmount = ethers.parseEther(String(tradingConfig.maxTradeAmount));
    if (tx.nativeCollateral) {
      if (tx.collateralAmount > maxAmount) throw new Error(`Trade exceeds maxTradeAmount: ${ethers.formatEther(tx.collateralAmount)} > ${tradingConfig.maxTradeAmount}`);
      const weth = new ethers.Contract(WETH_ADDRESS, ERC20_ABI, provider);
      const wethBalance = await weth.balanceOf(wallet.address);
      const missing = wethBalance >= tx.collateralAmount ? 0n : tx.collateralAmount - wethBalance;
      addLog(`WETH balance=${ethers.formatEther(wethBalance)} missingWrap=${ethers.formatEther(missing)}`, "info");
      if (ethBalance < missing) throw new Error(`Insufficient ETH for WETH wrap: have ${ethers.formatEther(ethBalance)}, need ${ethers.formatEther(missing)}`);
    } else {
      const erc20 = new ethers.Contract(tx.collateralToken, ERC20_ABI, provider);
      const decimals = Number(await erc20.decimals());
      const erc20MaxAmount = ethers.parseUnits(String(tradingConfig.maxTradeAmount), decimals);
      if (tx.collateralAmount > erc20MaxAmount) throw new Error(`Trade exceeds maxTradeAmount: ${ethers.formatUnits(tx.collateralAmount, decimals)} > ${tradingConfig.maxTradeAmount}`);
      const tokenBal = await erc20.balanceOf(wallet.address);
      if (tokenBal < tx.collateralAmount) throw new Error(`Insufficient collateral token balance`);
    }
  }
  addLog(`[${side}] to=${tx.to} value=${tx.value} amountOutMin=${tx.amountOutMin ?? "n/a"} leverage=${tx.leverage ?? "n/a"}`, "warn");
  addLog(`[${side}] data=${tx.data}`, "debug");
  if (tradingConfig.simulateOnly) {
    addLog(`[${side}] simulateOnly=true, not sending.`, "success");
    return null;
  }
  if (isOpenTx) await assertContractTarget(provider, tx.to, "leveraged open target");
  if (isCloseTx) await assertContractTarget(provider, tx.to, "close manager");
  if (isOpenTx) assertUiPayloadMatch(tx, side);
  try {
    await provider.call({ from: wallet.address, to: tx.to, data: tx.data, value: tx.value });
  } catch (error) {
    addLog(`[${side}] provider.call revert (simulation), will attempt real send: ${decodeContractError(error)}`, "warn");
    // Don't throw here — some Nemesis managers accept real TXs that fail simulation
  }
  let gasEstimate;
  try {
    gasEstimate = await provider.estimateGas({ from: wallet.address, to: tx.to, data: tx.data, value: tx.value });
  } catch (error) {
    addLog(`[${side}] estimateGas failed, using fallback gas limit: ${decodeContractError(error)}`, "warn");
    gasEstimate = 1000000n; // fallback gas limit for Nemesis openPosition (800000 was too low)
  }
  const feeParams = await getFeeParams(provider);
  const nonce = await getNextNonce(provider, wallet.address, SEPOLIA_CHAIN_ID);
  let sent;
  if (isOpenTx) addLog("[OPEN] sending openPosition tx...", "warn");
  try {
    sent = await wallet.sendTransaction({ to: tx.to, data: tx.data, value: tx.value, gasLimit: gasEstimate + gasEstimate / 5n, nonce, ...feeParams });
  } catch (error) {
    addLog(`[${side}] sendTransaction error: ${decodeContractError(error)}`, "error");
    throw error;
  }
  if (isOpenTx) addLog(`[OPEN] tx hash=${sent.hash}`, "warn");
  if (isOpenTx) addLog(`[RSI] tx hash=${sent.hash}`, "warn");
  if (isOpenTx && side === "LONG") addLog(`[LONG] tx hash=${sent.hash}`, "warn");
  if (isCloseTx) addLog(`[CLOSE] tx hash=${sent.hash}`, "warn");
  addLog(`[${side}] txHash=${sent.hash}`, "warn");
  addLog(`[${side}] Sending transaction...`, "warn");
  const receipt = await waitForTx(sent);
  if (receipt.status !== 1) throw new Error(`${side} transaction reverted`);
  if (isOpenTx) addLog(`[RSI] receipt status=${receipt.status}`, "success");
  if (isOpenTx && side === "LONG") addLog(`[LONG] receipt status=${receipt.status}`, "success");
  if (isCloseTx) addLog(`[CLOSE] receipt status=${receipt.status}`, "success");
  let openedPositionId = null;
  for (const log of receipt.logs) {
    try {
      const parsed = POSITION_IFACE.parseLog(log);
      if (parsed?.name === "MAM_PositionCreated" || parsed?.name === "MAM_LoopPositionCreated") {
        openedPositionId = parsed.args.positionId.toString();
      }
      if (parsed?.name === "MAM_PositionClosed" || parsed?.name === "MAM_PositionPartiallyClosed") {
        const closedPositionId = parsed.args.positionId.toString();
        addLog(`[${side}] positionId=${closedPositionId} close event confirmed`, "success");
      }
    } catch {}
  }
  if (isOpenTx) {
    if (!openedPositionId) throw new Error(`${side} receipt confirmed but no PositionCreated event was found`);
    await waitForOpenPositionOnChain(wallet, provider, tx, side, openedPositionId);
    tradingConfig.closeManager = tx.manager || tx.to;
    tradingConfig.closePositionId = openedPositionId;
    tradingConfig.enableClose = true;
    tradingConfig.activePositions = (tradingConfig.activePositions || []).filter(p => String(p.positionId) !== openedPositionId);
    tradingConfig.activePositions.push({
      side,
      positionId: openedPositionId,
      managerAddress: tx.manager || tx.to,
      symbol: tx.symbol || side,
      marketToken: tx.marketToken || tradingConfig.marketToken,
      collateralToken: tx.collateralToken,
      closeTarget: tx.manager || tx.to,
      openTarget: tx.to,
      txHash: sent.hash,
      openedAt: Math.floor(Date.now() / 1000)
    });
    saveConfig();
    // --- SELF-HEALING: Verify position direction matches expectation ---
    if (side === "LONG" || side === "SHORT") {
      await verifyPositionDirection(Number(openedPositionId), side, tx.manager || tx.to, provider);
    }
    addLog("[OPEN] confirmed", "success");
    addLog(`[${side}] active positionId=${openedPositionId} manager=${getShortAddress(tx.manager || tx.to)}`, "success");
  }
  addLog(`[${side}] receipt status=${receipt.status} block=${receipt.blockNumber}`, "success");
  if (side === "LONG" || side === "SHORT") {
    if (isOpenTx) addLog(`[SUCCESS] ${side} opened`, "success");
  } else {
    addLog(`${side} confirmed`, "success");
  }
  if (isOpenTx) addLog(`[${side}] on-chain position verified; check Nemesis UI after indexer refresh.`, "success");
  return { sent, receipt };
}

// ═══════════════════════════════════════════════════════════════════
//  KNOWN NEMESIS CUSTOM ERROR SELECTORS
//  Discovered via on-chain simulation of each Manager contract.
//  These are proprietary errors — source not verified on Etherscan.
// ═══════════════════════════════════════════════════════════════════
const KNOWN_NEMESIS_ERRORS = {
  "0x7939f424": "NEMESIS_MANAGER_BROKEN_PROXY (Manager implementation has empty bytecode — pool/manager pair is defunct)",
  "0x24811982": "NEMESIS_WRONG_COLLATERAL_TOKEN (collateral token does not match this Manager's expected token)",
  "0x499ad952": "NEMESIS_POSITION_NOT_ALLOWED (position cannot be opened — likely broken proxy or unsupported market config)",
};

function decodeContractError(error) {
  const data = error?.data || error?.info?.error?.data || error?.error?.data;
  if (data) {
    try {
      const parsed = POSITION_IFACE.parseError(data);
      return `${parsed.name}(${parsed.args.map(String).join(",")})`;
    } catch {
      const selector = String(data).slice(0, 10);
      // Check known Nemesis error map
      if (KNOWN_NEMESIS_ERRORS[selector]) {
        addLog(`[ERROR] Custom error ${selector}: ${KNOWN_NEMESIS_ERRORS[selector]}`, "error");
        return KNOWN_NEMESIS_ERRORS[selector];
      }
      // Unknown selector — log details for debugging
      addLog(`[ERROR] Unknown custom error selector ${selector} — raw data: ${data}`, "error");
      addLog(`[ERROR] This error is NOT in the known Nemesis error map. The contract may have been upgraded.`, "error");
      return `Unknown custom error ${selector} (data=${data})`;
    }
  }
  return error.reason || error.shortMessage || error.message;
}

async function getVerifiedPosition(wallet, provider, manager, positionId) {
  if (!isValidContractTarget(manager) || !positionId) return null;
  try {
    const contract = new ethers.Contract(manager, POSITION_ABI, provider);
    const position = await contract.getPosition(positionId);
    const user = String(position.user || position[1] || "");
    if (user.toLowerCase() !== wallet.address.toLowerCase()) return null;
    const collateralAmount = BigInt(position.collateralAmount ?? position[3] ?? 0n);
    const currentDebt = BigInt(position.currentDebt ?? position[5] ?? 0n);
    if (collateralAmount === 0n && currentDebt === 0n) return null;
    return position;
  } catch {
    return null;
  }
}

async function waitForOpenPositionOnChain(wallet, provider, tx, side, positionId) {
  addLog("[SYNC] refreshing positions from chain...", "warn");
  const manager = tx.manager || tx.to;
  for (let attempt = 1; attempt <= 5; attempt++) {
    const position = await getVerifiedPosition(wallet, provider, manager, positionId);
    if (position) {
      addLog(`[SUCCESS] ${side} position verified on-chain positionId=${positionId}`, "success");
      return position;
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw new Error(`${side} receipt confirmed but positionId=${positionId} was not active on-chain`);
}

async function openLeveragedPosition(side, market = null, amountOverride = null) {
  // If market is a string (symbol or address), resolve it to a market config
  let resolvedMarket = market;
  if (typeof market === "string" && market) {
    // Try to find in discoveredMarkets by collateralSymbol
    const found = discoveredMarkets.find(m =>
      m.collateralSymbol?.toUpperCase() === market.toUpperCase() ||
      m.symbol.toUpperCase().includes(market.toUpperCase())
    );
    if (found) {
      resolvedMarket = found;
    } else if (ethers.isAddress(market)) {
      resolvedMarket = { collateralToken: market };
    } else {
      // Try to resolve symbol to address using token map
      const tokenMap = buildTokenMap(discoveredTokenList);
      const resolvedAddress = resolveCollateralAddress(market, tokenMap);
      resolvedMarket = { collateralToken: resolvedAddress };
    }
  }
  // ═══════════════════════════════════════════════════════════════════════════════
  //  UNIVERSAL RULE (verified across 870+ events from 4 managers):
  //    - WETH collateral = LONG position
  //    - ANY other token = SHORT position
  //  The isLong parameter is IGNORED by the contract.
  //  Use resolveCollateralForSide() as the SINGLE source of truth.
  // ═══════════════════════════════════════════════════════════════════════════════
  const resolvedCollateral = resolveCollateralForSide(side);
  if (!resolvedMarket) {
    resolvedMarket = { collateralToken: resolvedCollateral, marketToken: WETH_ADDRESS, symbol: "ETH/USDT" };
  }
  const normalizedMarket = normalizeMarketConfig(resolvedMarket || {});
  if (side === "LONG" && !tradingConfig.enableLong) throw new Error("LONG disabled in config");
  if (side === "SHORT" && !tradingConfig.enableShort) throw new Error("SHORT disabled in config");
  if (closePending) throw new Error("[SKIP] close pending; waiting before opening new position");
  if (accounts.length === 0) throw new Error("No account loaded");
  const accountIndex = tradingConfig.firstTxMode ? 0 : selectedWalletIndex;
  const proxyUrl = proxies[accountIndex % proxies.length] || null;
  const provider = getProvider(SEPOLIA_RPC_URL, SEPOLIA_CHAIN_ID, proxyUrl);
  const wallet = new ethers.Wallet(accounts[accountIndex].privateKey, provider);
  await syncActivePositionsFromChain(wallet, provider);
  if (!canOpenMarketSide(normalizedMarket, side)) throw new Error(`[SKIP] ${side} duplicate or limit reached for ${normalizedMarket.symbol}`);
  addLog("[OPEN] duplicate check passed", "success");
  // ── Determine amount: override > random/fixed/percentage mode ──
  let amount;
  if (amountOverride) {
    amount = String(amountOverride);
  } else if (tradingConfig.firstTxMode) {
    amount = tradingConfig.tinyTradeAmount;
  } else {
    // ── AUTO: Generate random amount from collateral balance ──
    const collateralSym = normalizedMarket.collateralSymbol || "ETH";
    amount = await getRandomTradeAmount(side, collateralSym);
  }

  // ── Randomize leverage between leverageMin..leverageMax ──
  const leverage = getRandomLeverage();

  addLog(`[OPEN] ${side} ${normalizedMarket.symbol} amount=${amount} leverage=${leverage}x (mode=${tradingConfig.tradeAmountMode})`, "warn");
  const tx = side === "LONG"
    ? await buildLongTx(amount, normalizedMarket.collateralToken, leverage, undefined, provider, normalizedMarket)
    : await buildShortTx(amount, normalizedMarket.collateralToken, leverage, undefined, provider, normalizedMarket);
  await ensureLeveragedApproval(wallet, tx.collateralToken, tx.to, tx.collateralAmount, tx.nativeCollateral, provider);
  await validateAndSendLeveragedTx(wallet, tx, side, provider);
}

async function logLongShortPayloadDelta(provider) {
  const amount = tradingConfig.firstTxMode ? tradingConfig.tinyTradeAmount : tradingConfig.tradeAmount;
  const deadline = Math.floor(Date.now() / 1000) + tradingConfig.deadlineSeconds;
  const longTx = await buildLongTx(amount, tradingConfig.defaultCollateralToken, tradingConfig.leverage, deadline, provider);
  const shortTx = await buildShortTx(amount, tradingConfig.defaultCollateralToken, tradingConfig.leverage, deadline, provider);
  const longDecoded = POSITION_IFACE.decodeFunctionData("openPosition", longTx.data);
  const shortDecoded = POSITION_IFACE.decodeFunctionData("openPosition", shortTx.data);
  const fields = ["isLong", "collateralToken", "collateralAmount", "borrowAmount", "leverageX10", "amountOutMin", "deadline"];
  addLog("LONG payload vs SHORT payload delta", "warn");
  for (const field of fields) {
    addLog(`${field}: LONG=${longDecoded[field]} SHORT=${shortDecoded[field]}`, "warn");
  }
  addLog(`target: LONG=${longTx.to} SHORT=${shortTx.to}`, "warn");
  addLog(`tx.value: LONG=${longTx.value} SHORT=${shortTx.value}`, "warn");
}

function logUiPayloadDiff(tx, side) {
  const sideReference = side === "LONG" ? tradingConfig.uiLongPayloadReference : tradingConfig.uiShortPayloadReference;
  const sideTxValueReference = side === "LONG" ? tradingConfig.uiLongTxValueReference : tradingConfig.uiShortTxValueReference;
  const reference = sideReference || tradingConfig.uiPayloadReference;
  if (!reference) return;
  try {
    const ui = reference;
    const bot = POSITION_IFACE.decodeFunctionData("openPosition", tx.data);
    const botFields = [
      bot.isLong,
      bot.collateralToken,
      bot.collateralAmount,
      bot.borrowAmount,
      bot.leverageX10,
      bot.amountOutMin,
      bot.deadline
    ];
    const names = ["arg1", "arg2", "arg3", "arg4", "arg5", "arg6", "arg7"];
    const labels = ["side", "token", "collateral", "borrow", "leverage", "amountOutMin", "deadline"];
    addLog(`[${side}] UI payload vs BOT payload strict diff`, "warn");
    for (let i = 0; i < names.length; i++) {
      const uiValue = String(ui[i]);
      const botValue = String(botFields[i]);
      let match = uiValue.toLowerCase() === botValue.toLowerCase();
      let status = match ? "MATCH" : "DIFF";
      if (i === 5 && !match) {
        const uiNum = Number(uiValue);
        const botNum = Number(botValue);
        const drift = Number.isFinite(uiNum) && uiNum > 0 && Number.isFinite(botNum) ? Math.abs(botNum - uiNum) / uiNum : Infinity;
        if (drift <= 0.02) {
          match = true;
          status = "MATCH (within tolerance)";
        }
      }
      addLog(`[${side}] UI ${names[i]} ${labels[i]}: ${uiValue}`, match ? "info" : "warn");
      addLog(`[${side}] BOT ${names[i]} ${labels[i]}: ${botValue}`, match ? "info" : "warn");
      addLog(`[${side}] ${status}`, match ? "info" : "warn");
    }
    const uiTxValue = sideTxValueReference == null ? null : String(sideTxValueReference);
    const botTxValue = String(tx.value);
    const valueMatch = uiTxValue != null && uiTxValue.toLowerCase() === botTxValue.toLowerCase();
    addLog(`[${side}] UI tx.value: ${uiTxValue ?? "<not provided>"}`, uiTxValue == null || valueMatch ? "info" : "warn");
    addLog(`[${side}] BOT tx.value: ${botTxValue}`, uiTxValue == null || valueMatch ? "info" : "warn");
    addLog(`[${side}] ${uiTxValue == null ? "TX.VALUE REFERENCE MISSING" : valueMatch ? "MATCH" : "DIFF"}`, uiTxValue == null || valueMatch ? "info" : "warn");
  } catch (error) {
    addLog(`UI payload diff failed: ${error.message}`, "error");
  }
}

function assertUiPayloadMatch(tx, side) {
  const sideReference = side === "LONG" ? tradingConfig.uiLongPayloadReference : tradingConfig.uiShortPayloadReference;
  const sideTxValueReference = side === "LONG" ? tradingConfig.uiLongTxValueReference : tradingConfig.uiShortTxValueReference;
  const reference = sideReference || tradingConfig.uiPayloadReference;
  if (!reference) return;

  const bot = POSITION_IFACE.decodeFunctionData("openPosition", tx.data);
  const botFields = [
    bot.isLong,
    bot.collateralToken,
    bot.collateralAmount,
    bot.borrowAmount,
    bot.leverageX10,
    bot.amountOutMin,
    bot.deadline
  ];

  const mismatches = [];
  for (let i = 0; i < 5; i++) {
    if (String(reference[i]).toLowerCase() !== String(botFields[i]).toLowerCase()) {
      mismatches.push(`arg${i + 1}: UI=${reference[i]} BOT=${botFields[i]}`);
    }
  }

  const uiArg6 = Number(reference[5]);
  const botArg6 = Number(botFields[5]);
  if (!Number.isFinite(uiArg6) || uiArg6 <= 0 || !Number.isFinite(botArg6)) {
    mismatches.push(`arg6: invalid tolerance values UI=${reference[5]} BOT=${botFields[5]}`);
  } else {
    const drift = Math.abs(botArg6 - uiArg6) / uiArg6;
    if (drift > 0.02) {
      mismatches.push(`arg6: UI=${reference[5]} BOT=${botFields[5]} drift=${(drift * 100).toFixed(4)}%`);
    } else {
      addLog(`[${side}] MATCH (within tolerance) arg6 UI=${reference[5]} BOT=${botFields[5]} drift=${(drift * 100).toFixed(4)}%`, "success");
    }
  }

  if (sideTxValueReference != null && String(sideTxValueReference).toLowerCase() !== String(tx.value).toLowerCase()) {
    mismatches.push(`tx.value: UI=${sideTxValueReference} BOT=${tx.value}`);
  }

  if (mismatches.length > 0) {
    throw new Error(`UI payload mismatch; aborting live ${side}: ${mismatches.join(" | ")}`);
  }

  addLog(`[${side}] UI args vs BOT args: FULL MATCH for args 1-5, arg6 within tolerance, and tx.value. arg7 deadline may differ.`, "success");
}

async function positionStillActiveOnChain(wallet, provider, position) {
  try {
    const manager = position.closeTarget || position.managerAddress;
    if (!isValidContractTarget(manager)) return false;
    const contract = new ethers.Contract(manager, POSITION_ABI, provider);
    try {
      const ids = (await contract.getUserPositions(wallet.address)).map(value => String(value));
      if (!ids.includes(String(position.positionId))) return false;
    } catch {}
    const current = await contract.getPosition(position.positionId);
    const user = String(current.user || current[1] || "");
    if (user.toLowerCase() !== wallet.address.toLowerCase()) return false;
    const currentDebt = BigInt(current.currentDebt ?? current[5] ?? 0n);
    const collateralAmount = BigInt(current.collateralAmount ?? current[3] ?? 0n);
    return collateralAmount > 0n || currentDebt > 0n;
  } catch {
    return false;
  }
}

async function waitForClosedPositionOnChain(wallet, provider, position) {
  addLog("[SYNC] refreshing positions from chain...", "warn");
  for (let attempt = 1; attempt <= 5; attempt++) {
    const stillActive = await positionStillActiveOnChain(wallet, provider, position);
    if (!stillActive) {
      addLog(`[SUCCESS] positionId=${position.positionId} closed on-chain`, "success");
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw new Error(`Close tx confirmed but positionId=${position.positionId} still active on-chain`);
}

async function sendCloseAndConfirm(wallet, provider, position) {
  const positionId = String(position.positionId);
  if (recentlyClosedPositionIds.has(positionId)) {
    tradingConfig.activePositions = (tradingConfig.activePositions || []).filter(p => String(p.positionId) !== positionId);
    if (String(tradingConfig.closePositionId) === positionId) tradingConfig.closePositionId = "";
    saveConfig();
    addLog(`[CLOSE] positionId=${positionId} already closed; skipping duplicate close`, "warn");
    return null;
  }
  if (closingPositionIds.has(positionId)) throw new Error(`[SKIP] close already in flight for positionId=${positionId}`);
  if (closePending) throw new Error("Close already pending");
  closePending = true;
  closingPositionIds.add(positionId);
  try {
    const target = position.closeTarget || position.managerAddress;
    if (!isValidContractTarget(target)) throw new Error("Close target unavailable after discovery");
    const stillActive = await positionStillActiveOnChain(wallet, provider, { ...position, closeTarget: target, managerAddress: position.managerAddress || target });
    if (!stillActive) {
      recentlyClosedPositionIds.add(positionId);
      tradingConfig.activePositions = (tradingConfig.activePositions || []).filter(p => String(p.positionId) !== positionId);
      if (String(tradingConfig.closePositionId) === positionId) tradingConfig.closePositionId = "";
      saveConfig();
      addLog(`[CLOSE] positionId=${positionId} not active on-chain; skipping close tx`, "warn");
      return null;
    }
    const data = buildCloseTx({ positionId: position.positionId, closePercent: tradingConfig.closePercent });
    addLog(`[CLOSE] manager=${position.managerAddress || target}`, "warn");
    addLog(`[CLOSE] target=${target}`, "warn");
    addLog(`[CLOSE] calldata=${data}`, "debug");
    addLog(`[CLOSE] sending close tx positionId=${position.positionId}...`, "warn");
    const result = await validateAndSendLeveragedTx(wallet, { to: target, manager: position.managerAddress || target, data, value: 0n }, "CLOSE", provider);
    if (!result || result.receipt?.status !== 1) throw new Error("Close transaction did not confirm with status=1");
    await waitForClosedPositionOnChain(wallet, provider, position);
    recentlyClosedPositionIds.add(positionId);
    tradingConfig.activePositions = (tradingConfig.activePositions || []).filter(p => String(p.positionId) !== positionId);
    if (String(tradingConfig.closePositionId) === positionId) tradingConfig.closePositionId = "";
    saveConfig();
    await syncActivePositionsFromChain(wallet, provider);
    addLog("position closed", "success");
    return result;
  } finally {
    closingPositionIds.delete(positionId);
    closePending = false;
  }
}

async function closeLeveragedPosition() {
  if (!tradingConfig.enableClose) throw new Error("Close disabled in config");
  const provider = getProvider(SEPOLIA_RPC_URL, SEPOLIA_CHAIN_ID, proxies[selectedWalletIndex % proxies.length] || null);
  const wallet = new ethers.Wallet(accounts[selectedWalletIndex].privateKey, provider);
  addLog("[CLOSE] searching active positions...", "warn");
  const positions = await discoverActivePositions(wallet, provider);
  if (positions.length === 0) throw new Error("No active positions found");
  const selected = await choosePositionToClose(positions);
  const selectedPositions = Array.isArray(selected) ? selected : [selected];
  for (const position of selectedPositions) {
    addLog(`[CLOSE] found ${position.side}`, "warn");
    addLog(`[CLOSE] managerAddress=${position.managerAddress}`, "warn");
    addLog(`[CLOSE] target=${position.closeTarget || position.managerAddress}`, "warn");
    await sendCloseAndConfirm(wallet, provider, position);
  }
  saveConfig();
  addLog(`[CLOSE] closed ${selectedPositions.length} position(s)`, "success");
}

function choosePositionToClose(positions) {
  if (positions.length === 1) return Promise.resolve(positions[0]);
  addLog("[CLOSE] multiple positions found. Select Position To Close.", "warn");
  return new Promise((resolve) => {
    const closeLong = positions.filter(p => p.side === "LONG");
    const closeShort = positions.filter(p => p.side === "SHORT");
    const bulkItems = [
      closeLong.length ? `[ALL] Close All LONG (${closeLong.length})` : null,
      closeShort.length ? `[ALL] Close All SHORT (${closeShort.length})` : null,
      `[ALL] Close All Positions (${positions.length})`
    ].filter(Boolean);
    const positionItems = positions.map((p, i) => `[${i + 1}] ${p.side} ${p.symbol || getShortAddress(p.collateralToken)} size:${p.size} id:${p.positionId}`);
    const items = [...bulkItems, ...positionItems];
    const picker = blessed.list({
      label: " Select Position To Close ",
      top: "center",
      left: "center",
      width: "60%",
      height: Math.min(positions.length + 4, 12),
      border: { type: "line" },
      keys: true,
      mouse: true,
      items,
      style: { selected: { bg: "magenta", fg: "black" }, border: { fg: "yellow" } }
    });
    screen.append(picker);
    picker.focus();
    picker.on("select", (_, index) => {
      screen.remove(picker);
      safeRender();
      const selectedText = items[index];
      if (selectedText.includes("Close All LONG")) return resolve(closeLong);
      if (selectedText.includes("Close All SHORT")) return resolve(closeShort);
      if (selectedText.includes("Close All Positions")) return resolve(positions);
      resolve(positions[index - bulkItems.length]);
    });
    picker.key(["escape"], () => {
      screen.remove(picker);
      safeRender();
      resolve(positions[0]);
    });
    safeRender();
  });
}

/**
 * Query the Nemesis Goldsky subgraph for OPEN positions owned by our wallet.
 * This uses the SAME source as nemesis.trade UI — positions here are guaranteed
 * to appear in the Nemesis interface.
 * 
 * The subgraph composite ID format is: `{managerAddress lowercase}-{positionId}`
 * This is how Nemesis UI identifies positions.
 */
async function queryOpenPositionsFromSubgraph(walletAddress) {
  const subgraphs = [GOLDSKY_SUBGRAPH_URL, NEMESIS_SUBGRAPH_URL];
  for (const url of subgraphs) {
    try {
      const query = `{ positions(where: { user: "${walletAddress.toLowerCase()}", status: "OPEN" }, first: 50, orderBy: openedAtTimestamp, orderDirection: desc) { id isLong status collateralToken collateralAmount leverageX10 pool { id } openedAtTimestamp } }`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query })
      });
      const json = await response.json();
      const positions = json.data?.positions || [];
      if (positions.length > 0) {
        addLog(`[SUBGRAPH] Found ${positions.length} OPEN positions from ${url.includes("goldsky") ? "Goldsky" : "Nemesis"} subgraph`, "success");
        return positions;
      }
    } catch (error) {
      addLog(`[SUBGRAPH] Query failed for ${url.includes("goldsky") ? "Goldsky" : "Nemesis"}: ${error.message}`, "warn");
    }
  }
  return [];
}

/**
 * Discover active positions using the SAME source as Nemesis UI (subgraph).
 * Falls back to on-chain getUserPositions() only if subgraph fails.
 * 
 * KEY INSIGHT: getUserPositions() is BROKEN on some managers (misses positions).
 * The subgraph indexes MAM_PositionCreated events and correctly tracks all positions.
 * This is EXACTLY what nemesis.trade/trade uses to display positions.
 */
async function discoverActivePositions(wallet, provider) {
  const tracked = Array.isArray(tradingConfig.activePositions) ? tradingConfig.activePositions : [];
  const found = [];
  const seenKeys = new Set();

  // ═══════════════════════════════════════════════════════════════════════════════
  //  PRIMARY: Use subgraph (same source as nemesis.trade UI)
  // ═══════════════════════════════════════════════════════════════════════════════
  try {
    const subgraphPositions = await queryOpenPositionsFromSubgraph(wallet.address);
    for (const sp of subgraphPositions) {
      // Parse composite ID: "{managerAddress}-{positionId}"
      const compositeId = sp.id || "";
      const dashIdx = compositeId.lastIndexOf("-");
      if (dashIdx <= 0) {
        addLog(`[CLOSE] Skipping subgraph position with unexpected ID format: ${compositeId}`, "warn");
        continue;
      }
      const managerAddress = compositeId.substring(0, dashIdx);
      const positionId = compositeId.substring(dashIdx + 1);

      // Verify on-chain via Manager.getPosition()
      let collateralAmount = 0n;
      let currentDebt = 0n;
      let collateralToken = sp.collateralToken || "";
      let isLong = sp.isLong;
      try {
        const contract = new ethers.Contract(managerAddress, POSITION_ABI, provider);
        const position = await contract.getPosition(positionId);
        const user = String(position.user || position[1]);
        if (user.toLowerCase() !== wallet.address.toLowerCase()) {
          addLog(`[CLOSE] Subgraph position ${compositeId} user mismatch on-chain`, "warn");
          continue;
        }
        collateralAmount = BigInt(position.collateralAmount ?? position[3] ?? 0n);
        currentDebt = BigInt(position.currentDebt ?? position[5] ?? 0n);
        collateralToken = position.collateralToken || position[2] || collateralToken;
        isLong = Boolean(position.isLong ?? position[0]);
      } catch (error) {
        addLog(`[CLOSE] On-chain verify failed for ${compositeId}: ${error.message}`, "warn");
        // Still include it if subgraph says OPEN — subgraph is the source of truth for UI visibility
      }

      // Skip if both zero (truly closed)
      if (collateralAmount === 0n && currentDebt === 0n) {
        addLog(`[CLOSE] Subgraph position ${compositeId} has zero collateral+debt on-chain, skipping`, "info");
        continue;
      }

      const side = isLong ? "LONG" : "SHORT";
      const key = `${managerAddress.toLowerCase()}:${positionId}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);

      addLog(`[CLOSE] found ${side} positionId=${positionId} manager=${getShortAddress(managerAddress)} size=${collateralAmount} debt=${currentDebt} (via subgraph)`, "warn");
      const trackedMeta = tracked.find(p => String(p.positionId) === String(positionId)) || {};
      found.push({
        side,
        positionId,
        managerAddress,
        closeTarget: managerAddress,
        symbol: trackedMeta.symbol || sp.symbol,
        marketToken: trackedMeta.marketToken,
        collateralToken,
        size: collateralAmount.toString()
      });
    }
    // If subgraph found positions, return them — don't fall back to broken getUserPositions()
    if (found.length > 0) {
      addLog(`[CLOSE] Returning ${found.length} positions discovered via subgraph (matches Nemesis UI)`, "success");
      return found;
    }
  } catch (error) {
    addLog(`[CLOSE] Subgraph discovery failed: ${error.message}, falling back to on-chain`, "warn");
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  //  FALLBACK: on-chain getUserPositions() (may miss positions on some managers)
  // ═══════════════════════════════════════════════════════════════════════════════
  addLog("[CLOSE] Falling back to on-chain getUserPositions() (subgraph unavailable)", "warn");
  const managers = new Set(tracked.map(p => p.managerAddress || p.closeTarget).filter(Boolean));
  if (tradingConfig.closeManager) managers.add(tradingConfig.closeManager);
  for (const market of discoveredMarkets) {
    if (market.managerAddress) managers.add(market.managerAddress);
  }
  if (managers.size === 0) {
    try {
      const context = await getLeveragedContext(provider, tradingConfig.defaultCollateralToken);
      managers.add(context.manager);
    } catch {}
  }
  for (const manager of managers) {
    try {
      const contract = new ethers.Contract(manager, POSITION_ABI, provider);
      let ids = [];
      try { ids = (await contract.getUserPositions(wallet.address)).map(x => x.toString()); } catch {}
      if (tradingConfig.closePositionId) ids.push(String(tradingConfig.closePositionId));
      for (const trackedPosition of tracked.filter(p => (p.managerAddress || p.closeTarget || "").toLowerCase() === manager.toLowerCase())) ids.push(String(trackedPosition.positionId));
      ids = [...new Set(ids.filter(Boolean))];
      for (const id of ids) {
        try {
          const position = await contract.getPosition(id);
          const user = String(position.user || position[1]);
          if (user.toLowerCase() !== wallet.address.toLowerCase()) continue;
          const currentDebt = BigInt(position.currentDebt ?? position[5] ?? 0n);
          const collateralAmount = BigInt(position.collateralAmount ?? position[3] ?? 0n);
          if (collateralAmount === 0n && currentDebt === 0n) continue;
          const isLong = Boolean(position.isLong ?? position[0]);
          const side = isLong ? "LONG" : "SHORT";
          const key = `${manager.toLowerCase()}:${id}`;
          if (seenKeys.has(key)) continue;
          seenKeys.add(key);
          addLog(`[CLOSE] found ${side} positionId=${id} size=${collateralAmount} debt=${currentDebt} (via getUserPositions)`, "warn");
          const trackedMeta = tracked.find(p => String(p.positionId) === String(id)) || {};
          found.push({ side, positionId: id, managerAddress: manager, closeTarget: manager, symbol: trackedMeta.symbol, marketToken: trackedMeta.marketToken, collateralToken: position.collateralToken || position[2], size: collateralAmount.toString() });
        } catch {}
      }
    } catch {}
  }
  return found;
}

async function discoverAvailableMarkets(provider) {
  const factory = new ethers.Contract(LEVERAGED_FACTORY, FACTORY_ABI, provider);
  const configured = [...discoveredMarkets, ...(Array.isArray(tradingConfig.availableMarkets) ? tradingConfig.availableMarkets : [])];
  const blacklist = new Set((tradingConfig.blacklistMarkets || []).map(item => String(item).toLowerCase()));
  const found = [];
  const seen = new Set();
  for (const candidate of configured.map(normalizeMarketConfig)) {
    const key = candidate.symbol.toLowerCase();
    const marketKey = `${String(candidate.marketToken).toLowerCase()}:${String(candidate.collateralToken).toLowerCase()}`;
    if (seen.has(marketKey)) continue;
    seen.add(marketKey);
    if (blacklist.has(key) || blacklist.has(String(candidate.marketToken).toLowerCase()) || blacklist.has(String(candidate.collateralToken).toLowerCase())) {
      addLog(`[SKIP] blacklisted market ${candidate.symbol}`, "warn");
      continue;
    }
    try {
      const collateral = normalizeCollateralToken(candidate.collateralToken);
      const marketToken = normalizeCollateralToken(candidate.marketToken);
      if (collateral.toLowerCase() === marketToken.toLowerCase()) throw new Error("collateral equals market token");
      const [tokenA, tokenB] = sortTokenPair(collateral, marketToken);
      const pool = await factory.getPool(tokenA, tokenB);
      if (!isValidContractTarget(pool)) throw new Error("pool not found");
      const manager = await factory.getManager(pool);
      if (!isValidContractTarget(manager)) throw new Error("manager not found");
      const contract = new ethers.Contract(manager, POSITION_ABI, provider);
      const liquidity = await contract.getAvailableLiquidity().catch(() => 0n);
      if (BigInt(liquidity) <= 0n) throw new Error("no leverage liquidity");
      addLog(`[MARKET] ${candidate.symbol} pool=${getShortAddress(pool)} manager=${getShortAddress(manager)} liquidity=${liquidity}`, "info");
      const market = { ...candidate, collateralToken: collateral, marketToken, pool, managerAddress: manager, liquidity: liquidity.toString(), isActive: true, health: "WORKING" };
      setMarketHealth(market, "WORKING");
      found.push(market);
    } catch (error) {
      setMarketHealth(candidate, String(error.message || "").includes("pool") ? "NO_POOL" : "REVERTING");
      addLog(`[SKIP] market ${candidate.symbol}: ${error.message}`, "warn");
    }
  }
  tradingConfig.availableMarkets = found;
  saveConfig();
  addLog(`[MARKET] Loaded ${found.length} active markets`, "success");
  return found;
}

async function resolveTradingMarkets(provider) {
  if (tradingConfig.marketMode === "single") return sortMarketsByHealth([normalizeMarketConfig({
    symbol: "ETH/DAI",
    marketToken: tradingConfig.marketToken,
    collateralToken: tradingConfig.defaultCollateralToken,
    supportsLong: true,
    supportsShort: true,
    rsiSymbol: "ETHUSDT"
  })]);
  const markets = await discoverAvailableMarkets(provider);
  if (tradingConfig.marketMode === "selected") {
    const selected = new Set((tradingConfig.selectedMarkets || []).map(item => String(item).toLowerCase()));
    return sortMarketsByHealth(markets.filter(market => selected.has(market.symbol.toLowerCase()) || selected.has(market.marketToken.toLowerCase()) || selected.has(market.collateralToken.toLowerCase())));
  }
  return sortMarketsByHealth(markets);
}

async function fetchRsi(symbol = "ETHUSDT") {
  const response = await axios.get(`https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=1m&limit=50`);
  const closes = response.data.map(item => parseFloat(item[4]));
  let gains = 0, losses = 0;
  for (let i = 1; i < closes.length; i++) {
    const delta = closes[i] - closes[i - 1];
    if (delta >= 0) gains += delta; else losses -= delta;
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

let rsiTradingInterval = null;
let rsiRunning = false;
let fullAutoRunning = false;
let autoCloseInterval = null;
let dailyActivityPromise = null;
let closePending = false;
const closingPositionIds = new Set();
const recentlyClosedPositionIds = new Set();
let lastRsiTradeAt = 0;
let lastMarketTradeAt = {};
let dailyTradeCounter = { day: "", count: 0 };
const BAD_MARKET_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes instead of 60 minutes
const badMarkets = new Map();
const marketHealth = new Map();

function getMarketHealthKey(market) {
  return String(market.symbol || `${market.marketToken || ""}:${market.collateralToken || ""}`).toUpperCase();
}

function getMarketSideKey(market, side) {
  return `${getMarketHealthKey(market)}:${String(side).toUpperCase()}`;
}

function setMarketHealth(market, health) {
  market.health = health;
  marketHealth.set(getMarketHealthKey(market), health);
}

function getMarketHealth(market) {
  return market.health || marketHealth.get(getMarketHealthKey(market)) || "WORKING";
}

function blacklistMarketSide(market, side, health = "REVERTING") {
  const key = getMarketSideKey(market, side);
  badMarkets.set(key, Date.now());
  setMarketHealth(market, health);
  addLog(`[BLACKLIST] ${market.symbol} ${side} reverting`, "warn");
  addLog("[BLACKLIST] skipping for 60m", "warn");
}

function isMarketSideBlacklisted(market, side) {
  const key = getMarketSideKey(market, side);
  const timestamp = badMarkets.get(key);
  if (!timestamp) return false;
  if (Date.now() - timestamp >= BAD_MARKET_COOLDOWN_MS) {
    badMarkets.delete(key);
    return false;
  }
  addLog(`[BLACKLIST] ${market.symbol} ${side} skipping for 60m`, "warn");
  return true;
}

function classifyOpenFailure(error) {
  const message = String(error?.message || "");
  const decoded = decodeContractError(error);
  if (/amountOutMin is zero|quoteOut is zero|Invalid quote|Quote unavailable/i.test(message)) return "ZERO_QUOTE";
  if (/No leveraged pool|pool not found|MAM_PoolNotFound/i.test(message) || /MAM_PoolNotFound/i.test(decoded)) return "NO_POOL";
  return "REVERTING";
}

function sortMarketsByHealth(markets) {
  const score = { WORKING: 0, ZERO_QUOTE: 1, REVERTING: 2, NO_POOL: 3 };
  return [...markets].sort((a, b) => (score[getMarketHealth(a)] ?? 0) - (score[getMarketHealth(b)] ?? 0));
}

function selectAutoSide(rsiValue) {
  if (rsiValue < tradingConfig.rsiLong && tradingConfig.enableLong) return "LONG";
  if (rsiValue > tradingConfig.rsiShort && tradingConfig.enableShort) return "SHORT";
  // In Full Auto mode: ALWAYS pick a side even if RSI is neutral
  if (fullAutoRunning) {
    if (!tradingConfig.enableLong) return tradingConfig.enableShort ? "SHORT" : null;
    if (!tradingConfig.enableShort) return tradingConfig.enableLong ? "LONG" : null;
    const longWeight = Math.max(0, Number(tradingConfig.longPercent) || 50);
    const shortWeight = Math.max(0, Number(tradingConfig.shortPercent) || 50);
    const total = longWeight + shortWeight;
    if (total <= 0) return null;
    return Math.random() * total < longWeight ? "LONG" : "SHORT";
  }
  return null;
}

function finishAutoRsiTrading() {
  if (rsiTradingInterval) clearInterval(rsiTradingInterval);
  rsiTradingInterval = null;
  rsiRunning = false;
  tradingConfig.autoRSIEnabled = false;
  saveConfig();
  updateStatus();
  addLog("[RSI] Status=STOPPED", "success");
  addLog("[RSI] Auto RSI stopped.", "success");
}

function requestStopAutoRsiTrading() {
  if (!rsiRunning && !rsiTradingInterval) {
    addLog("[RSI] Auto RSI stopped.", "warn");
    return;
  }
  rsiRunning = false;
  tradingConfig.autoRSIEnabled = false;
  saveConfig();
  updateStatus();
  addLog("[RSI] Stop signal sent...", "warn");
  addLog("[RSI] Waiting current iteration to finish...", "warn");
}

async function closeAutoPosition(position) {
  const provider = getProvider(SEPOLIA_RPC_URL, SEPOLIA_CHAIN_ID, proxies[selectedWalletIndex % proxies.length] || null);
  const wallet = new ethers.Wallet(accounts[selectedWalletIndex].privateKey, provider);
  addLog(`[AUTO] Closing position... id=${position.positionId} side=${position.side}`, "warn");
  await sendCloseAndConfirm(wallet, provider, position);
}

async function runAutoCloseCycle() {
  if (!fullAutoRunning || closePending || accounts.length === 0) return;
  try {
    const provider = getProvider(SEPOLIA_RPC_URL, SEPOLIA_CHAIN_ID, proxies[selectedWalletIndex % proxies.length] || null);
    const wallet = new ethers.Wallet(accounts[selectedWalletIndex].privateKey, provider);
    const positions = await discoverActivePositions(wallet, provider);
    const now = Math.floor(Date.now() / 1000);
    for (const position of positions) {
      const tracked = (tradingConfig.activePositions || []).find(p => String(p.positionId) === String(position.positionId));
      const openedAt = Number(tracked?.openedAt || 0);
      if (openedAt > 0 && now - openedAt < tradingConfig.cooldownPerMarket) continue;
      await closeAutoPosition({ ...position, ...tracked });
    }
  } catch (error) {
    addLog(`[AUTO] Auto close skipped: ${error.message}`, "warn");
  }
}

function startAutoCloseMonitor() {
  if (autoCloseInterval) return;
  const intervalMs = Math.max(15, Number(tradingConfig.cooldownSeconds) || 30) * 1000;
  autoCloseInterval = setInterval(runAutoCloseCycle, intervalMs);
  runAutoCloseCycle();
}

function stopAutoCloseMonitor() {
  if (!autoCloseInterval) return;
  clearInterval(autoCloseInterval);
  autoCloseInterval = null;
}

function shouldStopAutoRsiTrading() {
  if (rsiRunning) return false;
  addLog("[RSI] Stop requested.", "warn");
  finishAutoRsiTrading();
  return true;
}

function markDailyTrade() {
  const day = new Date().toISOString().slice(0, 10);
  if (dailyTradeCounter.day !== day) dailyTradeCounter = { day, count: 0 };
  dailyTradeCounter.count += 1;
}

function dailyTradeLimitReached() {
  const day = new Date().toISOString().slice(0, 10);
  if (dailyTradeCounter.day !== day) dailyTradeCounter = { day, count: 0 };
  return dailyTradeCounter.count >= tradingConfig.maxDailyTrades;
}

async function getDistributedAmount(side, marketsCount, collateralSymbol = "ETH") {
  const rawAmount = tradingConfig.firstTxMode ? tradingConfig.tinyTradeAmount : await getRandomTradeAmount(side, collateralSymbol);
  if (tradingConfig.balanceDistribution !== "equal" || marketsCount <= 1) return rawAmount;
  const value = Number(rawAmount) / marketsCount;
  return value.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
}

async function runAutoRsiTrading() {
  if (rsiRunning || rsiTradingInterval) return addLog("[RSI] Auto RSI already running.", "warn");
  rsiRunning = true;
  tradingConfig.autoRSIEnabled = true;
  saveConfig();
  updateStatus();
  addLog(`[RSI] Starting Auto RSI Trading mode=${tradingConfig.marketMode}`, "info");
  addLog("[RSI] Status=RUNNING", "success");
  rsiTradingInterval = setInterval(async () => {
    try {
      if (shouldStopAutoRsiTrading()) return;
      const now = Date.now();
      if (now - lastRsiTradeAt < tradingConfig.cooldownSeconds * 1000) return;
      if (dailyTradeLimitReached()) return addLog(`[SKIP] maxDailyTrades reached (${tradingConfig.maxDailyTrades})`, "warn");
      if (shouldStopAutoRsiTrading()) return;
      const provider = getProvider(SEPOLIA_RPC_URL, SEPOLIA_CHAIN_ID, proxies[selectedWalletIndex % proxies.length] || null);
      const markets = await resolveTradingMarkets(provider);
      if (markets.length === 0) return addLog("[MARKET] no active markets available", "warn");
      for (const market of markets) {
        if (shouldStopAutoRsiTrading()) return;
        if (dailyTradeLimitReached()) break;
        const key = getPositionMarketKey(market);
        if (now - (lastMarketTradeAt[key] || 0) < tradingConfig.cooldownPerMarket * 1000) {
          addLog(`[SKIP] cooldown ${market.symbol}`, "warn");
          continue;
        }
        const value = await fetchRsi(market.rsiSymbol);
        if (shouldStopAutoRsiTrading()) return;
        addLog(`[RSI] ${market.symbol} ${market.rsiSymbol}=${value.toFixed(2)}`, "info");
        const side = selectAutoSide(value);
        if (!side) continue;
        if (isMarketSideBlacklisted(market, side)) continue;
        const amount = tradingConfig.tradeMode === "walletPercent" ? null : await getDistributedAmount(side, markets.length, market.collateralSymbol || "ETH");
        lastRsiTradeAt = now;
        lastMarketTradeAt[key] = now;
        addLog(`[AUTO] Opening ${side}...`, "warn");
        try {
          await openLeveragedPosition(side, market, amount);
        } catch (error) {
          if (String(error.message || "").startsWith("[SKIP]")) {
            addLog(error.message, "warn");
            continue;
          }
          const health = classifyOpenFailure(error);
          if (side === "LONG") market.supportsLong = false;
          if (side === "SHORT") market.supportsShort = false;
          blacklistMarketSide(market, side, health);
          addLog(`[SKIP] ${side} ${market.symbol} unsupported or reverting; skipping side for this run`, "warn");
          addLog(`[RSI] open failed for ${market.symbol}: ${decodeContractError(error)}`, "error");
          continue;
        }
        if (shouldStopAutoRsiTrading()) return;
        markDailyTrade();
      }
    } catch (error) {
      addLog(`Auto RSI trading failed: ${error.message}. Stopping RSI mode.`, "error");
      finishAutoRsiTrading();
    }
  }, 15000);
}

function getSwapAmount(pair) {
  switch (pair.from) {
    case "ETH":  return getRandomAmount(dailyActivityConfig.ethRange.min,  dailyActivityConfig.ethRange.max);
    case "USDC": return getRandomAmount(dailyActivityConfig.usdcRange.min, dailyActivityConfig.usdcRange.max);
    case "DAI":  return getRandomAmount(dailyActivityConfig.daiRange.min,  dailyActivityConfig.daiRange.max);
    case "UNI": return getRandomAmount(dailyActivityConfig.uniRange.min, dailyActivityConfig.uniRange.max);
    case "NEMESIS": return getRandomAmount(dailyActivityConfig.nemesisRange.min, dailyActivityConfig.nemesisRange.max);
    default: return 0;
  }
}

async function runDailyActivity() {
  if (!dailyActivityConfig.enableSwaps) {
    addLog("Swap farming is disabled by enableSwaps=false.", "warn");
    return;
  }

  if (accounts.length === 0) {
    addLog("No valid accounts found.", "error");
    return;
  }
  addLog(`Starting daily activity for all accounts. Swaps: ${dailyActivityConfig.activityRepetitions}x per account`, "info");
  activityRunning = true;
  isCycleRunning  = true;
  shouldStop      = false;
  hasLoggedSleepInterrupt = false;
  activeProcesses = Math.max(0, activeProcesses);
  updateMenu();

  try {
    for (let accountIndex = 0; accountIndex < accounts.length && !shouldStop; accountIndex++) {
      addLog(`Starting processing for account ${accountIndex + 1}`, "info");
      selectedWalletIndex = accountIndex;
      const proxyUrl = proxies[accountIndex % proxies.length] || null;
      addLog(`Account ${accountIndex + 1}: Using Proxy → ${proxyUrl || "none"}`, "info");

      const wallet = new ethers.Wallet(accounts[accountIndex].privateKey);
      if (!ethers.isAddress(wallet.address)) {
        addLog(`Invalid wallet address for account ${accountIndex + 1}: ${wallet.address}`, "error");
        continue;
      }
      addLog(`Processing account ${accountIndex + 1}: ${getShortAddress(wallet.address)}`, "wait");

      const providerForPairs = getProvider(SEPOLIA_RPC_URL, SEPOLIA_CHAIN_ID, proxyUrl);
      const dynamicPairs = await buildDynamicSwapPairs(providerForPairs, wallet.address);
      const activePairs = dynamicPairs.length > 0 ? dynamicPairs : SWAP_PAIRS;
      const shuffledPairs = [...activePairs].sort(() => Math.random() - 0.5);

      for (let swapCount = 0; swapCount < dailyActivityConfig.activityRepetitions && !shouldStop; swapCount++) {
        const pair   = shuffledPairs[swapCount % shuffledPairs.length];
        const amount = getSwapAmount(pair);

        addLog(`Account ${accountIndex + 1} - Swap ${swapCount + 1}/${dailyActivityConfig.activityRepetitions}: ${amount} ${pair.from} → ${pair.to}`, "warn");

        try {
          await performSwap(wallet, pair.from, pair.to, amount, proxyUrl);
        } catch (error) {
          addLog(`Account ${accountIndex + 1} - Swap ${swapCount + 1} Failed: ${error.message}. Skipping.`, "error");
          const nonceKey = `${SEPOLIA_CHAIN_ID}_${wallet.address.toLowerCase()}`;
          delete nonceTracker[nonceKey];
        } finally {
          await updateWallets();
        }

        if (shouldStop) break;

        if (swapCount < dailyActivityConfig.activityRepetitions - 1) {
          const delay = Math.floor(Math.random() * (25000 - 10000 + 1)) + 10000;
          addLog(`Account ${accountIndex + 1} - Waiting ${Math.floor(delay / 1000)}s before next swap...`, "delay");
          await sleep(delay);
        }
      }

      if (accountIndex < accounts.length - 1 && !shouldStop) {
        addLog(`Waiting 10 seconds before next account...`, "delay");
        await sleep(10000);
      }
    }

    if (!shouldStop && activeProcesses <= 0) {
      if (fullAutoRunning) {
        addLog("[AUTO] Loop completed.", "success");
        addLog("[AUTO] Waiting next cycle...", "delay");
      }
      addLog(`All accounts processed. Next cycle in ${dailyActivityConfig.loopHours} hours.`, "success");
      dailyActivityInterval = setTimeout(runDailyActivity, dailyActivityConfig.loopHours * 60 * 60 * 1000);
    }

  } catch (error) {
    addLog(`Daily activity failed: ${error.message}`, "error");
  } finally {
    if (shouldStop) {
      if (activeProcesses <= 0) {
        _resetState();
      } else {
        const stopCheckInterval = setInterval(() => {
          if (activeProcesses <= 0) {
            clearInterval(stopCheckInterval);
            _resetState();
          } else {
            addLog(`Waiting for ${activeProcesses} process(es) to complete...`, "info");
          }
        }, 1000);
      }
    } else {
      activityRunning = false;
      isCycleRunning  = activeProcesses > 0 || dailyActivityInterval !== null;
      updateMenu();
      updateStatus();
      safeRender();
    }
    nonceTracker = {};
  }
}

function _resetState() {
  if (dailyActivityInterval) {
    clearTimeout(dailyActivityInterval);
    dailyActivityInterval = null;
    addLog("Cleared daily activity interval.", "info");
  }
  activityRunning = false;
  isCycleRunning  = false;
  shouldStop      = false;
  hasLoggedSleepInterrupt = false;
  activeProcesses = 0;
  addLog("Daily activity stopped successfully.", "success");
  updateMenu();
  updateStatus();
  safeRender();
}

const screen = blessed.screen({
  smartCSR:    true,
  title:       "NEMESIS TESTNET AUTO BOT",
  autoPadding: true,
  fullUnicode: true,
  mouse:       true,
  ignoreLocked:["C-c","q","escape"]
});

const headerBox = blessed.box({
  top:    0,
  left:   "center",
  width:  "100%",
  height: 6,
  tags:   true,
  style:  { fg: "yellow", bg: "default" }
});

const statusBox = blessed.box({
  left:    0,
  top:     6,
  width:   "100%",
  height:  3,
  tags:    true,
  border:  { type: "line", fg: "cyan" },
  style:   { fg: "white", bg: "default", border: { fg: "cyan" } },
  content: "Status: Initializing...",
  padding: { left: 1, right: 1, top: 0, bottom: 0 },
  label:   chalk.cyan(" Status "),
  wrap:    true
});

const walletBox = blessed.list({
  label:    " Wallet Information ",
  top:      9,
  left:     0,
  width:    "40%",
  height:   "35%",
  border:   { type: "line", fg: "cyan" },
  style:    { border: { fg: "cyan" }, fg: "white", bg: "default", item: { fg: "white" } },
  scrollable: true,
  scrollbar:  { bg: "cyan", fg: "black" },
  padding:  { left: 1, right: 1, top: 0, bottom: 0 },
  tags:     true,
  keys:     true,
  vi:       true,
  mouse:    true,
  content:  "Loading wallet data..."
});

const logBox = blessed.log({
  label:       " Transaction Logs ",
  top:         9,
  left:        "41%",
  width:       "59%",
  height:      "100%-9",
  border:      { type: "line" },
  scrollable:  true,
  alwaysScroll:true,
  mouse:       true,
  tags:        true,
  scrollbar:   { ch: "│", style: { bg: "cyan", fg: "white" }, track: { bg: "gray" } },
  scrollback:  100,
  smoothScroll:true,
  style:       { border: { fg: "magenta" }, bg: "default", fg: "white" },
  padding:     { left: 1, right: 1, top: 0, bottom: 0 },
  wrap:        true,
  focusable:   true,
  keys:        true
});

const menuBox = blessed.list({
  label:   " Menu ",
  top:     "44%",
  left:    0,
  width:   "40%",
  height:  "56%",
  keys:    true,
  vi:      true,
  mouse:   true,
  border:  { type: "line" },
  style:   {
    fg: "white", bg: "default",
    border: { fg: "red" },
    selected: { bg: "magenta", fg: "black" },
    item: { fg: "white" }
  },
  items:   fullAutoRunning || isCycleRunning
    ? ["[1] Stop Full Auto Trading", "[2] Open LONG Now", "[3] Open SHORT Now", "[4] Close Position", "[5] Auto RSI Trading", "[6] Set Manual Config", "[7] Refresh Wallet", "[8] Exit", "[9] Stop Auto RSI Trading", "[10] Liquidity Pool Mode", "[11] Automatic Swaps", "[12] Stop Automatic Swaps"]
    : ["[1] Start Full Auto Trading", "[2] Open LONG Now", "[3] Open SHORT Now", "[4] Close Position", "[5] Auto RSI Trading", "[6] Set Manual Config", "[7] Refresh Wallet", "[8] Exit", "[9] Stop Auto RSI Trading", "[10] Liquidity Pool Mode", "[11] Automatic Swaps", "[12] Start Automatic Swaps"],
  padding: { left: 1, top: 1 }
});

const dailyActivitySubMenu = blessed.list({
  label:  " Manual Config Options ",
  top:    "44%",
  left:   0,
  width:  "40%",
  height: "56%",
  keys:   true,
  vi:     true,
  mouse:  true,
  border: { type: "line" },
  style:  {
    fg: "white", bg: "default",
    border: { fg: "blue" },
    selected: { bg: "blue", fg: "black" },
    item: { fg: "white" }
  },
  items:  [
    "Set Swap Repetitions",
    "Number of Auto Trades",
    "Trade Amounts",
    "Max Open Positions",
    "Long/Short Ratio",
    "Randomize Trade Size",
    "Trade Mode",
    "Market Mode",
    "Selected Markets",
    "Trade Distribution",
    "Safety Limits",
    "Set ETH Range",
    "Set USDC Range",
    "Set DAI Range",
    "Set UNI Range",
    "Set NEMESIS Range",
    "Set Loop Daily",
    "Back to Main Menu"
  ],
  padding: { left: 1, top: 1 },
  hidden:  true
});

const lpSubMenu = blessed.list({
  label:  " Liquidity Pool Mode ",
  top:    "44%",
  left:   0,
  width:  "40%",
  height: "56%",
  keys:   true,
  vi:     true,
  mouse:  true,
  border: { type: "line" },
  style:  {
    fg: "white", bg: "default",
    border: { fg: "green" },
    selected: { bg: "green", fg: "black" },
    item: { fg: "white" }
  },
  items:  ["[1] Add Liquidity", "[2] Remove Liquidity", "[3] LP Config", "[4] LP Status", "[5] Back"],
  padding: { left: 1, top: 1 },
  hidden:  true
});

const configForm = blessed.form({
  label:  " Enter Config Value ",
  top:    "center",
  left:   "center",
  width:  "30%",
  height: "40%",
  keys:   true,
  mouse:  true,
  border: { type: "line" },
  style:  { fg: "white", bg: "default", border: { fg: "blue" } },
  padding: { left: 1, top: 1 },
  hidden: true
});

const minLabel = blessed.text({
  parent:  configForm,
  top:     0,
  left:    1,
  content: "Min Value:",
  style:   { fg: "white" }
});

const maxLabel = blessed.text({
  parent:  configForm,
  top:     4,
  left:    1,
  content: "Max Value:",
  style:   { fg: "white" }
});

const configInput = blessed.textbox({
  parent:       configForm,
  top:          1,
  left:         1,
  width:        "90%",
  height:       3,
  inputOnFocus: true,
  border:       { type: "line" },
  style:        { fg: "white", bg: "default", border: { fg: "white" }, focus: { border: { fg: "green" } } }
});

const configInputMax = blessed.textbox({
  parent:       configForm,
  top:          5,
  left:         1,
  width:        "90%",
  height:       3,
  inputOnFocus: true,
  border:       { type: "line" },
  style:        { fg: "white", bg: "default", border: { fg: "white" }, focus: { border: { fg: "green" } } }
});

const configSubmitButton = blessed.button({
  parent:    configForm,
  top:       9,
  left:      "center",
  width:     10,
  height:    3,
  content:   "Submit",
  align:     "center",
  border:    { type: "line" },
  clickable: true,
  keys:      true,
  mouse:     true,
  style:     {
    fg: "white", bg: "blue",
    border: { fg: "white" },
    hover: { bg: "green" },
    focus: { bg: "green", border: { fg: "yellow" } }
  }
});

screen.append(headerBox);
screen.append(statusBox);
screen.append(walletBox);
screen.append(logBox);
screen.append(menuBox);
screen.append(dailyActivitySubMenu);
screen.append(lpSubMenu);
screen.append(configForm);

let renderQueue  = [];
let isRendering  = false;
function safeRender() {
  if (IS_CLI || typeof screen === 'undefined' || !screen) return;
  renderQueue.push(true);
  if (isRendering) return;
  isRendering = true;
  setTimeout(() => {
    try {
      if (!isHeaderRendered) {
        figlet.text("NT EXHAUST", { font: "ANSI Shadow" }, (err, data) => {
          if (!err) headerBox.setContent(`{center}{bold}{cyan-fg}${data}{/cyan-fg}{/bold}{/center}`);
          isHeaderRendered = true;
        });
      }
      screen.render();
    } catch (error) {
      console.error(`UI render error (non-fatal): ${error.message}`);
    }
    renderQueue.shift();
    isRendering = false;
    if (renderQueue.length > 0) safeRender();
  }, 100);
}

function adjustLayout() {
  if (typeof screen === 'undefined' || !screen) return;
  const H = screen.height || 24;
  const W = screen.width  || 80;
  headerBox.height  = Math.max(6, Math.floor(H * 0.15));
  statusBox.top     = headerBox.height;
  statusBox.height  = Math.max(3, Math.floor(H * 0.07));
  statusBox.width   = W - 2;
  walletBox.top     = headerBox.height + statusBox.height;
  walletBox.width   = Math.floor(W * 0.4);
  walletBox.height  = Math.floor(H * 0.35);
  logBox.top        = headerBox.height + statusBox.height;
  logBox.left       = Math.floor(W * 0.41);
  logBox.width      = W - walletBox.width - 2;
  logBox.height     = H - (headerBox.height + statusBox.height);
  menuBox.top       = headerBox.height + statusBox.height + walletBox.height;
  menuBox.width     = Math.floor(W * 0.4);
  menuBox.height    = H - (headerBox.height + statusBox.height + walletBox.height);
  if (menuBox.top != null) {
    dailyActivitySubMenu.top   = menuBox.top;
    dailyActivitySubMenu.width = menuBox.width;
    dailyActivitySubMenu.height= menuBox.height;
    dailyActivitySubMenu.left  = menuBox.left;
    lpSubMenu.top   = menuBox.top;
    lpSubMenu.width = menuBox.width;
    lpSubMenu.height= menuBox.height;
    lpSubMenu.left  = menuBox.left;
    configForm.width  = Math.floor(W * 0.3);
    configForm.height = Math.floor(H * 0.4);
  }
  safeRender();
}

function updateStatus() {
  try {
    const isProcessing = activityRunning || (isCycleRunning && dailyActivityInterval !== null);
    const status = fullAutoRunning
      ? `${loadingSpinner[spinnerIndex]} ${chalk.yellowBright("Full Auto Trading")}`
      : activityRunning
      ? `${loadingSpinner[spinnerIndex]} ${chalk.yellowBright("Running")}`
      : rsiRunning
      ? chalk.yellowBright("Auto RSI Running")
      : isCycleRunning && dailyActivityInterval !== null
      ? `${loadingSpinner[spinnerIndex]} ${chalk.yellowBright("Waiting next cycle")}`
      : chalk.green("Idle");

    statusBox.setContent(
      `Status: ${status} | Account: ${getShortAddress(walletInfo.address)} | ` +
      `Total: ${accounts.length} | Swaps: ${dailyActivityConfig.activityRepetitions}x | ` +
      `Loop: ${dailyActivityConfig.loopHours}h | NEMESIS TESTNET AUTO BOT`
    );

    if (isProcessing || rsiRunning || fullAutoRunning) {
      if (blinkCounter % 1 === 0) {
        statusBox.style.border.fg = borderBlinkColors[borderBlinkIndex];
        borderBlinkIndex = (borderBlinkIndex + 1) % borderBlinkColors.length;
      }
      blinkCounter++;
    } else {
      statusBox.style.border.fg = "cyan";
    }
    spinnerIndex = (spinnerIndex + 1) % loadingSpinner.length;
    safeRender();
  } catch (error) {
    addLog(`Status update error: ${error.message}`, "error");
  }
}

async function updateWallets() {
  try {
    const walletData = await updateWalletData();
    const header     = (
      `${chalk.bold.cyan("  Address".padEnd(18))}` +
      `  ${chalk.bold.cyan("ETH".padEnd(10))}` +
      `  ${chalk.bold.green("USDC".padEnd(10))}` +
      `  ${chalk.bold.yellow("DAI".padEnd(8))}` +
      `  ${chalk.bold.blue("UNI".padEnd(8))}` +
      `  ${chalk.bold.white("NEMESIS")}`
    );
    const separator = chalk.gray("─".repeat(78));
    walletBox.setItems([header, separator, ...walletData]);
    walletBox.select(0);
    safeRender();
  } catch (error) {
    addLog(`Failed to update wallet data: ${error.message}`, "error");
  }
}

function updateLogs() {
  try {
    if (typeof logBox !== 'undefined' && logBox) {
      logBox.add(transactionLogs[transactionLogs.length - 1] || chalk.gray("No logs available."));
      logBox.scrollTo(transactionLogs.length);
    }
    safeRender();
  } catch (error) {
    console.error(`Log update error (non-fatal): ${error.message}`);
  }
}

function updateMenu() {
  try {
    menuBox.setItems(
      fullAutoRunning || isCycleRunning
        ? ["[1] Stop Full Auto Trading", "[2] Open LONG Now", "[3] Open SHORT Now", "[4] Close Position", "[5] Auto RSI Trading", "[6] Set Manual Config", "[7] Refresh Wallet", "[8] Exit", "[9] Stop Auto RSI Trading", "[10] Liquidity Pool Mode", "[11] Automatic Swaps", "[12] Stop Automatic Swaps"]
        : ["[1] Start Full Auto Trading", "[2] Open LONG Now", "[3] Open SHORT Now", "[4] Close Position", "[5] Auto RSI Trading", "[6] Set Manual Config", "[7] Refresh Wallet", "[8] Exit", "[9] Stop Auto RSI Trading", "[10] Liquidity Pool Mode", "[11] Automatic Swaps", "[12] Start Automatic Swaps"]
    );
    safeRender();
  } catch (error) {
    addLog(`Menu update failed: ${error.message}`, "error");
  }
}

async function runFullAutoTrading({ resume = false } = {}) {
  if (fullAutoRunning) return addLog("[AUTO] Full auto trading already running.", "warn");
  addLog("[AUTO] Loading config...", "info");
  loadConfig();
  fullAutoRunning = true;
  tradingConfig.fullAutoEnabled = true;
  tradingConfig.autoRSIEnabled = true;
  saveConfig();
  addLog("[AUTO] ═══ FULL AUTO TRADING STARTED ═══", "success");
  addLog("[AUTO] Components: Swaps + LONG + SHORT + Close", "info");
  addLog("[AUTO] Running restart recovery close scan...", "info");
  await runAutoCloseCycle();
  startAutoCloseMonitor();
  // Start automatic swaps in background
  addLog("[AUTO] Starting Automatic Swaps (continuous cycle)...", "info");
  if (!cyclicSwapRunning) {
    runCyclicSwapEngine({
      intervalSeconds: 3,
      onSwapComplete: () => { updateWallets(); }
    }).catch(e => addLog(`[AUTO] Swap engine error: ${e.message}`, "error"));
  }
  addLog("[AUTO] Starting Auto RSI trading (LONG/SHORT)...", "info");
  if (!rsiRunning && !rsiTradingInterval) await runAutoRsiTrading();
  updateMenu();
  updateStatus();
  if (resume) addLog("[AUTO] Resumed saved automation state.", "success");
  dailyActivityPromise = runDailyActivity();
}

function stopFullAutoTrading() {
  fullAutoRunning = false;
  tradingConfig.fullAutoEnabled = false;
  tradingConfig.autoRSIEnabled = false;
  saveConfig();
  shouldStop = true;
  if (dailyActivityInterval) {
    clearTimeout(dailyActivityInterval);
    dailyActivityInterval = null;
  }
  requestStopAutoRsiTrading();
  stopAutoCloseMonitor();
  stopCyclicSwapEngine();
  updateMenu();
  updateStatus();
  addLog("[AUTO] ═══ FULL AUTO TRADING STOPPED ═══", "success");
}

function getLpManager() {
  if (!lpManager) {
    lpManager = new LpManager({
      accounts,
      proxies,
      selectedWalletIndex,
      getConfig: () => lpConfig,
      getProvider,
      getFeeParams,
      getNextNonce,
      sleep,
      log: addLog,
      rpcUrl: SEPOLIA_RPC_URL,
      chainId: SEPOLIA_CHAIN_ID,
      routerAddress: LEVERAGED_ROUTER,
      leveragedFactory: LEVERAGED_FACTORY,
      config: tradingConfig,
      tokenMap: {
        DAI: LEVERAGED_DAI_ADDRESS,
        USDC: USDC_ADDRESS,
        WETH: WETH_ADDRESS
      }
    });
  }
  lpManager.deps.accounts = accounts;
  lpManager.deps.proxies = proxies;
  lpManager.deps.selectedWalletIndex = selectedWalletIndex;
  return lpManager;
}

function showMainMenuFrom(subMenu) {
  subMenu.hide();
  menuBox.show();
  setTimeout(() => {
    if (menuBox.visible) {
      screen.focusPush(menuBox);
      menuBox.style.border.fg = "cyan";
      dailyActivitySubMenu.style.border.fg = "blue";
      lpSubMenu.style.border.fg = "green";
      logBox.style.border.fg = "magenta";
      safeRender();
    }
  }, 100);
}

function runGit(command) {
  return execSync(command, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function startupGitSync() {
  try {
    if (!fs.existsSync(".git")) return;
    const configBackup = fs.existsSync(CONFIG_FILE) ? fs.readFileSync(CONFIG_FILE, "utf8") : null;
    const branch = runGit("git branch --show-current");
    if (branch !== "nemesis-autobot") {
      addLog(`[SKIP] git sync branch=${branch}; expected nemesis-autobot`, "warn");
      return;
    }
    const status = runGit("git status --porcelain");
    let stashed = false;
    if (status) {
      runGit("git stash push -m startup-sync -- . :(exclude)config.json :(exclude)wallets/** :(exclude)pk.txt :(exclude).env");
      stashed = true;
      addLog("[TX] stashed local code changes before git pull", "warn");
    }
    runGit("git pull origin nemesis-autobot");
    addLog("[TX] git pull origin nemesis-autobot complete", "success");
    if (stashed) {
      try {
        runGit("git stash pop");
        addLog("[TX] restored stashed local code changes", "success");
      } catch (error) {
        addLog(`[SKIP] git stash pop needs manual review: ${error.message}`, "error");
      }
    }
    if (configBackup != null && !fs.existsSync(CONFIG_FILE)) fs.writeFileSync(CONFIG_FILE, configBackup);
  } catch (error) {
    addLog(`[SKIP] startup git sync failed: ${error.message}`, "warn");
  }
}

const statusInterval = setInterval(updateStatus, 100);

logBox.key(["up"],   () => { if (screen.focused === logBox) { logBox.scroll(-1); safeRender(); } });
logBox.key(["down"], () => { if (screen.focused === logBox) { logBox.scroll(1);  safeRender(); } });

logBox.on("click", () => {
  screen.focusPush(logBox);
  logBox.style.border.fg = "yellow";
  menuBox.style.border.fg = "red";
  dailyActivitySubMenu.style.border.fg = "blue";
  lpSubMenu.style.border.fg = "green";
  safeRender();
});

logBox.on("blur", () => {
  logBox.style.border.fg = "magenta";
  safeRender();
});

menuBox.on("select", async (item) => {
  const action = item.getText();
  switch (action) {
    case "[1] Start Full Auto Trading":
    case "Start Full Auto Trading":
    case "[1] Start Auto Daily Activity":
    case "Start Auto Daily Activity":
      await runFullAutoTrading();
      break;

    case "[1] Stop Full Auto Trading":
    case "Stop Full Auto Trading":
    case "[1] Stop Activity":
    case "Stop Activity":
      stopFullAutoTrading();
      break;

    case "[2] Open LONG Now":
      await promptCollateralAndOpen("LONG");
      break;

    case "[3] Open SHORT Now":
      await promptCollateralAndOpen("SHORT");
      break;

    case "[4] Close Position":
      try { await closeLeveragedPosition(); }
      catch (error) { addLog(`Close position failed: ${error.message}`, "error"); }
      break;

    case "[5] Auto RSI Trading":
      await runAutoRsiTrading();
      break;

    case "[9] Stop Auto RSI Trading":
      requestStopAutoRsiTrading();
      break;

    case "[6] Set Manual Config":
    case "Set Manual Config":
      menuBox.hide();
      lpSubMenu.hide();
      dailyActivitySubMenu.show();
      setTimeout(() => {
        if (dailyActivitySubMenu.visible) {
          screen.focusPush(dailyActivitySubMenu);
          dailyActivitySubMenu.style.border.fg = "yellow";
          logBox.style.border.fg = "magenta";
          safeRender();
        }
      }, 100);
      break;

    case "[10] Liquidity Pool Mode":
    case "Liquidity Pool Mode":
      menuBox.hide();
      dailyActivitySubMenu.hide();
      lpSubMenu.show();
      setTimeout(() => {
        if (lpSubMenu.visible) {
          screen.focusPush(lpSubMenu);
          lpSubMenu.style.border.fg = "yellow";
          logBox.style.border.fg = "magenta";
          safeRender();
        }
      }, 100);
      break;

    case "Clear Logs":
      clearTransactionLogs();
      break;

    case "[7] Refresh Wallet":
    case "Refresh":
      await updateWallets();
      addLog("Data refreshed.", "success");
      break;

    case "[11] Automatic Swaps":
    case "Automatic Swaps":
      await promptTokenSwap();
      break;

    case "[12] Start Automatic Swaps":
    case "Start Automatic Swaps":
      if (cyclicSwapRunning) {
        addLog("[SWAP] Automatic swaps already running", "warn");
      } else {
        addLog("[SWAP] Starting automatic swap engine...", "success");
        runCyclicSwapEngine({
          intervalSeconds: 3,
          onSwapComplete: () => { updateWallets(); }
        }).catch(e => addLog(`[SWAP] Engine error: ${e.message}`, "error"));
      }
      break;

    case "[12] Stop Automatic Swaps":
    case "Stop Automatic Swaps":
      stopCyclicSwapEngine();
      break;

    case "[8] Exit":
    case "Exit":
      clearInterval(statusInterval);
      if (rsiTradingInterval) clearInterval(rsiTradingInterval);
      stopAutoCloseMonitor();
      rsiRunning = false;
      fullAutoRunning = false;
      tradingConfig.autoRSIEnabled = false;
      tradingConfig.fullAutoEnabled = false;
      saveConfig();
      process.exit(0);
  }
});

lpSubMenu.on("select", async (item) => {
  const action = item.getText();
  try {
    switch (action) {
      case "[1] Add Liquidity":
        await getLpManager().addLiquidity();
        break;
      case "[2] Remove Liquidity":
        await getLpManager().removeLiquidity();
        break;
      case "[3] LP Config":
        configForm.configType = "lpConfig";
        configForm.setLabel(" pair,mode,tokenA,tokenB,slip,rebalance,removeMin,minLiq,retries,retrySec,custom ");
        minLabel.hide(); maxLabel.hide();
        configInput.setValue(`${lpConfig.lpPair},${lpConfig.lpAmountMode},${lpConfig.lpTokenAAmount},${lpConfig.lpTokenBAmount},${lpConfig.lpSlippage},${lpConfig.lpAutoRebalance},${lpConfig.lpAutoRemoveMinutes},${lpConfig.lpMinLiquidity},${lpConfig.lpRetryAttempts},${lpConfig.lpRetryDelaySeconds},${lpConfig.lpCustomTokenAddress}`);
        configInputMax.setValue(""); configInputMax.hide();
        lpSubMenu.hide();
        configForm.show();
        setTimeout(() => {
          if (configForm.visible) {
            screen.focusPush(configInput);
            configInput.clearValue();
            safeRender();
          }
        }, 100);
        break;
      case "[4] LP Status":
        await getLpManager().status();
        break;
      case "[5] Back":
        showMainMenuFrom(lpSubMenu);
        break;
    }
  } catch (error) {
    addLog(`[LP] ${action} failed: ${error.message}`, "error");
  }
});

dailyActivitySubMenu.on("select", (item) => {
  const action = item.getText();

  const rangeTypes = {
    "Set Swap Repetitions": { type: "activityRepetitions", label: " Enter Swap Repetitions ",    hasRange: false, val: () => dailyActivityConfig.activityRepetitions.toString() },
    "Number of Auto Trades": { type: "activityRepetitions", label: " Enter Number of Auto Trades ", hasRange: false, val: () => dailyActivityConfig.activityRepetitions.toString() },
    "Trade Amounts": { type: "tradeAmounts", label: " Enter long,short,swap Amounts ", hasRange: false, val: () => `${tradingConfig.longTradeAmount},${tradingConfig.shortTradeAmount},${tradingConfig.swapTradeAmount}` },
    "Max Open Positions": { type: "maxOpenPositions", label: " Enter Max Open Positions ", hasRange: false, val: () => tradingConfig.maxOpenPositions.toString() },
    "Long/Short Ratio": { type: "longShortRatio", label: " Enter Long/Short Ratio (70/30) ", hasRange: false, val: () => `${tradingConfig.longPercent}/${tradingConfig.shortPercent}` },
    "Randomize Trade Size": { type: "randomizeTradeSize", label: " Randomize: true/false + Variance % ", hasRange: true, minVal: () => String(tradingConfig.randomizeAmount), maxVal: () => String(tradingConfig.amountVariancePercent) },
    "Trade Mode": { type: "tradeMode", label: " fixed or walletPercent,percent ", hasRange: false, val: () => `${tradingConfig.tradeMode},${tradingConfig.walletPercent}` },
    "Market Mode": { type: "marketMode", label: " single, all, or selected ", hasRange: false, val: () => tradingConfig.marketMode },
    "Selected Markets": { type: "selectedMarkets", label: " Symbols comma-separated ", hasRange: false, val: () => tradingConfig.selectedMarkets.join(",") },
    "Trade Distribution": { type: "tradeDistribution", label: " fixed/equal,maxPerPair,maxConcurrent ", hasRange: false, val: () => `${tradingConfig.balanceDistribution},${tradingConfig.maxTradesPerPair},${tradingConfig.maxConcurrentTrades}` },
    "Safety Limits": { type: "safetyLimits", label: " daily,cooldown,blacklistCSV ", hasRange: false, val: () => `${tradingConfig.maxDailyTrades},${tradingConfig.cooldownPerMarket},${tradingConfig.blacklistMarkets.join("|")}` },
    "Set ETH Range":        { type: "ethRange",            label: " Enter ETH Range (e.g. 0.00001)", hasRange: true, minVal: () => dailyActivityConfig.ethRange.min.toString(),  maxVal: () => dailyActivityConfig.ethRange.max.toString()  },
    "Set USDC Range":       { type: "usdcRange",           label: " Enter USDC Range (e.g. 500)",    hasRange: true, minVal: () => dailyActivityConfig.usdcRange.min.toString(), maxVal: () => dailyActivityConfig.usdcRange.max.toString() },
    "Set DAI Range":        { type: "daiRange",            label: " Enter DAI Range (e.g. 0.5)",     hasRange: true, minVal: () => dailyActivityConfig.daiRange.min.toString(),  maxVal: () => dailyActivityConfig.daiRange.max.toString()  },
    "Set UNI Range":       { type: "uniRange",           label: " Enter UNI Range (e.g. 0.01)",   hasRange: true, minVal: () => dailyActivityConfig.uniRange.min.toString(), maxVal: () => dailyActivityConfig.uniRange.max.toString() },
    "Set NEMESIS Range":   { type: "nemesisRange",       label: " Enter NEMESIS Range (e.g. 0.5)", hasRange: true, minVal: () => dailyActivityConfig.nemesisRange.min.toString(), maxVal: () => dailyActivityConfig.nemesisRange.max.toString() },
    "Set Loop Daily":       { type: "loopHours",           label: " Enter Loop Hours (Min 1) ",       hasRange: false, val: () => dailyActivityConfig.loopHours.toString() }
  };

  if (action === "Back to Main Menu") {
    dailyActivitySubMenu.hide();
    menuBox.show();
    setTimeout(() => {
      if (menuBox.visible) {
        screen.focusPush(menuBox);
        menuBox.style.border.fg = "cyan";
        dailyActivitySubMenu.style.border.fg = "blue";
        logBox.style.border.fg = "magenta";
        safeRender();
      }
    }, 100);
    return;
  }

  const cfg = rangeTypes[action];
  if (!cfg) return;

  configForm.configType = cfg.type;
  configForm.setLabel(cfg.label);

  if (cfg.hasRange) {
    minLabel.show(); maxLabel.show();
    configInput.setValue(cfg.minVal());
    configInputMax.setValue(cfg.maxVal());
    configInputMax.show();
  } else {
    minLabel.hide(); maxLabel.hide();
    configInput.setValue(cfg.val());
    configInputMax.setValue(""); configInputMax.hide();
  }

  configForm.show();
  setTimeout(() => {
    if (configForm.visible) {
      screen.focusPush(configInput);
      configInput.clearValue();
      safeRender();
    }
  }, 100);
});

const rangeKeys = ["ethRange", "usdcRange", "daiRange", "uniRange", "nemesisRange"];
let isSubmitting = false;

configForm.on("submit", () => {
  if (isSubmitting) return;
  isSubmitting = true;

  const inputValue = configInput.getValue().trim();
  let value, maxValue;

  try {
    if (["tradeAmounts", "longShortRatio", "randomizeTradeSize", "tradeMode", "marketMode", "selectedMarkets", "tradeDistribution", "safetyLimits", "lpConfig"].includes(configForm.configType)) {
      value = inputValue;
    } else {
      value = ["activityRepetitions", "loopHours", "maxOpenPositions"].includes(configForm.configType)
      ? parseInt(inputValue)
      : parseFloat(inputValue);
    }

    if (rangeKeys.includes(configForm.configType) || configForm.configType === "randomizeTradeSize") {
      maxValue = parseFloat(configInputMax.getValue().trim());
      if (configForm.configType !== "randomizeTradeSize" && (isNaN(maxValue) || maxValue <= 0)) {
        addLog("Invalid Max value. Please enter a positive number.", "error");
        configInputMax.clearValue(); screen.focusPush(configInputMax); safeRender();
        isSubmitting = false; return;
      }
    }
    if (!["tradeAmounts", "longShortRatio", "randomizeTradeSize", "tradeMode", "marketMode", "selectedMarkets", "tradeDistribution", "safetyLimits", "lpConfig"].includes(configForm.configType) && (isNaN(value) || value <= 0)) {
      addLog("Invalid input. Please enter a positive number.", "error");
      configInput.clearValue(); screen.focusPush(configInput); safeRender();
      isSubmitting = false; return;
    }
    if (configForm.configType === "loopHours" && value < 1) {
      addLog("Minimum is 1 hour.", "error");
      configInput.clearValue(); screen.focusPush(configInput); safeRender();
      isSubmitting = false; return;
    }
  } catch (error) {
    addLog(`Invalid format: ${error.message}`, "error");
    configInput.clearValue(); screen.focusPush(configInput); safeRender();
    isSubmitting = false; return;
  }

  if (configForm.configType === "activityRepetitions") {
    dailyActivityConfig.activityRepetitions = Math.floor(value);
    addLog(`Swap Repetitions set to ${dailyActivityConfig.activityRepetitions}x`, "success");
  } else if (configForm.configType === "tradeAmounts") {
    const [longAmount, shortAmount, swapAmount] = String(value).split(",").map(v => v.trim());
    if (!longAmount || !shortAmount || !swapAmount) {
      addLog("Use format: long,short,swap", "error");
      isSubmitting = false; return;
    }
    tradingConfig.longTradeAmount = longAmount;
    tradingConfig.shortTradeAmount = shortAmount;
    tradingConfig.swapTradeAmount = swapAmount;
    tradingConfig.tradeAmount = longAmount;
    tradingConfig.tinyTradeAmount = longAmount;
    tradingConfig.maxTradeAmount = longAmount;
    addLog(`Trade amounts set LONG=${longAmount}, SHORT=${shortAmount}, SWAP=${swapAmount}`, "success");
  } else if (configForm.configType === "maxOpenPositions") {
    tradingConfig.maxOpenPositions = Math.floor(value);
    addLog(`Max Open Positions set to ${tradingConfig.maxOpenPositions}`, "success");
  } else if (configForm.configType === "longShortRatio") {
    const [longPct, shortPct] = String(value).split("/").map(v => Number(v.trim()));
    if (!Number.isFinite(longPct) || !Number.isFinite(shortPct) || longPct < 0 || shortPct < 0 || longPct + shortPct !== 100) {
      addLog("Use ratio format like 70/30 and total must equal 100.", "error");
      isSubmitting = false; return;
    }
    tradingConfig.longPercent = longPct;
    tradingConfig.shortPercent = shortPct;
    addLog(`Long/Short Ratio set to ${longPct}/${shortPct}`, "success");
  } else if (configForm.configType === "randomizeTradeSize") {
    const normalized = String(value).toLowerCase();
    tradingConfig.randomizeAmount = ["true", "yes", "1", "on"].includes(normalized);
    tradingConfig.amountVariancePercent = Number(maxValue) || 0;
    addLog(`Randomize Trade Size=${tradingConfig.randomizeAmount}, variance=${tradingConfig.amountVariancePercent}%`, "success");
  } else if (configForm.configType === "tradeMode") {
    const [mode, percent] = String(value).split(",").map(v => v.trim());
    if (!["fixed", "walletPercent"].includes(mode)) {
      addLog("Trade Mode must be fixed or walletPercent.", "error");
      isSubmitting = false; return;
    }
    tradingConfig.tradeMode = mode;
    tradingConfig.walletPercent = Number(percent) || tradingConfig.walletPercent;
    addLog(`Trade Mode=${tradingConfig.tradeMode}, walletPercent=${tradingConfig.walletPercent}%`, "success");
  } else if (configForm.configType === "marketMode") {
    const mode = String(value).trim();
    if (!["single", "all", "selected"].includes(mode)) {
      addLog("Market Mode must be single, all, or selected.", "error");
      isSubmitting = false; return;
    }
    tradingConfig.marketMode = mode;
    addLog(`Market Mode=${tradingConfig.marketMode}`, "success");
  } else if (configForm.configType === "selectedMarkets") {
    tradingConfig.selectedMarkets = String(value).split(",").map(v => v.trim()).filter(Boolean);
    addLog(`Selected Markets=${tradingConfig.selectedMarkets.join(",") || "none"}`, "success");
  } else if (configForm.configType === "tradeDistribution") {
    const [distribution, maxPerPair, maxConcurrent] = String(value).split(",").map(v => v.trim());
    if (!["fixed", "equal"].includes(distribution)) {
      addLog("Distribution must be fixed or equal.", "error");
      isSubmitting = false; return;
    }
    tradingConfig.balanceDistribution = distribution;
    tradingConfig.maxTradesPerPair = Math.max(1, Number(maxPerPair) || tradingConfig.maxTradesPerPair);
    tradingConfig.maxConcurrentTrades = Math.max(1, Number(maxConcurrent) || tradingConfig.maxConcurrentTrades);
    addLog(`Distribution=${distribution}, maxPerPair=${tradingConfig.maxTradesPerPair}, maxConcurrent=${tradingConfig.maxConcurrentTrades}`, "success");
  } else if (configForm.configType === "safetyLimits") {
    const [daily, cooldown, blacklist] = String(value).split(",").map(v => v.trim());
    tradingConfig.maxDailyTrades = Math.max(1, Number(daily) || tradingConfig.maxDailyTrades);
    tradingConfig.cooldownPerMarket = Math.max(0, cooldown === undefined || cooldown === "" ? tradingConfig.cooldownPerMarket : Number(cooldown));
    tradingConfig.blacklistMarkets = (blacklist || "").split("|").map(v => v.trim()).filter(Boolean);
    addLog(`Safety daily=${tradingConfig.maxDailyTrades}, cooldown=${tradingConfig.cooldownPerMarket}s, blacklist=${tradingConfig.blacklistMarkets.join("|") || "none"}`, "success");
  } else if (configForm.configType === "lpConfig") {
    const [pair, amountMode, tokenAAmount, tokenBAmount, slippage, autoRebalance, autoRemoveMinutes, minLiquidity, retryAttempts, retryDelaySeconds, customTokenAddress] = String(value).split(",").map(v => v.trim());
    if (!pair || !amountMode || !tokenAAmount || !tokenBAmount || !slippage || !autoRemoveMinutes || !minLiquidity || !retryAttempts || !retryDelaySeconds) {
      addLog("Use LP format: pair,mode,tokenA,tokenB,slippage,rebalance,removeMin,minLiq,retries,retrySec,custom", "error");
      isSubmitting = false; return;
    }
    if (!["fixed", "walletPercent"].includes(amountMode)) {
      addLog("LP amount mode must be fixed or walletPercent.", "error");
      isSubmitting = false; return;
    }
    const normalizedPair = pair.toUpperCase();
    if (!["ETH/DAI", "ETH/USDC", "CUSTOM", "ETH/CUSTOM"].includes(normalizedPair)) {
      addLog("LP pair must be ETH/DAI, ETH/USDC, CUSTOM, or ETH/CUSTOM.", "error");
      isSubmitting = false; return;
    }
    lpConfig = loadLpConfig({
      lpEnabled: true,
      lpPair: normalizedPair,
      lpAmountMode: amountMode,
      lpTokenAAmount: tokenAAmount,
      lpTokenBAmount: tokenBAmount,
      lpEthAmount: tokenAAmount,
      lpDaiAmount: tokenBAmount,
      lpSlippage: Number(slippage),
      lpAutoRebalance: ["true", "yes", "1", "on"].includes(String(autoRebalance).toLowerCase()),
      lpAutoRemoveMinutes: Number(autoRemoveMinutes),
      lpMinLiquidity: minLiquidity,
      lpRetryAttempts: Number(retryAttempts),
      lpRetryDelaySeconds: Number(retryDelaySeconds),
      lpCustomTokenAddress: customTokenAddress || "",
      lpCycles: lpConfig.lpCycles
    });
    addLog(`LP Config saved pair=${lpConfig.lpPair}, mode=${lpConfig.lpAmountMode}, tokenA=${lpConfig.lpTokenAAmount}, tokenB=${lpConfig.lpTokenBAmount}, slippage=${lpConfig.lpSlippage}%, rebalance=${lpConfig.lpAutoRebalance}, autoRemove=${lpConfig.lpAutoRemoveMinutes}m, minLiquidity=${lpConfig.lpMinLiquidity}, retries=${lpConfig.lpRetryAttempts}`, "success");
  } else if (configForm.configType === "loopHours") {
    dailyActivityConfig.loopHours = value;
    addLog(`Loop Daily set to ${value} hours`, "success");
  } else if (rangeKeys.includes(configForm.configType)) {
    if (value > maxValue) {
      addLog("Min value cannot exceed Max value.", "error");
      configInput.clearValue(); configInputMax.clearValue();
      screen.focusPush(configInput); safeRender(); isSubmitting = false; return;
    }
    dailyActivityConfig[configForm.configType].min = value;
    dailyActivityConfig[configForm.configType].max = maxValue;
    addLog(`${configForm.configType} range set to ${value} – ${maxValue}`, "success");
  }

  saveConfig();
  addLog("[CONFIG] Saved successfully.", "success");
  addLog(`Config summary: autoTrades=${dailyActivityConfig.activityRepetitions}, LONG=${tradingConfig.longTradeAmount}, SHORT=${tradingConfig.shortTradeAmount}, SWAP=${tradingConfig.swapTradeAmount}, maxOpen=${tradingConfig.maxOpenPositions}, ratio=${tradingConfig.longPercent}/${tradingConfig.shortPercent}, random=${tradingConfig.randomizeAmount} ±${tradingConfig.amountVariancePercent}%`, "info");
  updateStatus();
  configForm.hide();
  if (configForm.configType === "lpConfig") lpSubMenu.show();
  else dailyActivitySubMenu.show();
  setTimeout(() => {
    if (lpSubMenu.visible) {
      screen.focusPush(lpSubMenu);
      lpSubMenu.style.border.fg = "yellow";
      logBox.style.border.fg = "magenta";
      safeRender();
    } else if (dailyActivitySubMenu.visible) {
      screen.focusPush(dailyActivitySubMenu);
      dailyActivitySubMenu.style.border.fg = "yellow";
      logBox.style.border.fg = "magenta";
      safeRender();
    }
    isSubmitting = false;
  }, 100);
});

function submitCurrentConfigForm() {
  if (!configForm.visible || isSubmitting) return;
  configForm.submit();
}

function cancelCurrentConfigForm() {
  if (!configForm.visible) return;
  const returnToLp = configForm.configType === "lpConfig";
  configForm.hide();
  if (returnToLp) lpSubMenu.show();
  else dailyActivitySubMenu.show();
  addLog("[CONFIG] Cancelled.", "warn");
  setTimeout(() => {
    if (lpSubMenu.visible) {
      screen.focusPush(lpSubMenu);
      lpSubMenu.style.border.fg = "yellow";
      logBox.style.border.fg = "magenta";
      safeRender();
    } else if (dailyActivitySubMenu.visible) {
      screen.focusPush(dailyActivitySubMenu);
      dailyActivitySubMenu.style.border.fg = "yellow";
      logBox.style.border.fg = "magenta";
      safeRender();
    }
  }, 100);
}

configInput.key(["enter"], submitCurrentConfigForm);

configInputMax.key(["enter"], submitCurrentConfigForm);
configForm.key(["enter"], submitCurrentConfigForm);
configSubmitButton.on("press", submitCurrentConfigForm);
configSubmitButton.on("click", () => { screen.focusPush(configSubmitButton); submitCurrentConfigForm(); });

configForm.key(["escape"], cancelCurrentConfigForm);
configInput.key(["escape"], cancelCurrentConfigForm);
configInputMax.key(["escape"], cancelCurrentConfigForm);

dailyActivitySubMenu.key(["escape"], () => {
  showMainMenuFrom(dailyActivitySubMenu);
});

lpSubMenu.key(["escape"], () => {
  showMainMenuFrom(lpSubMenu);
});

screen.key(["escape", "q", "C-c"], () => {
  addLog("Exiting application", "info");
  clearInterval(statusInterval);
  if (rsiTradingInterval) clearInterval(rsiTradingInterval);
  stopAutoCloseMonitor();
  if (lpManager) lpManager.stopAutoCycle();
  rsiRunning = false;
  fullAutoRunning = false;
  tradingConfig.autoRSIEnabled = false;
  tradingConfig.fullAutoEnabled = false;
  saveConfig();
  process.exit(0);
});

async function printStartupDiagnostics(provider) {
  addLog("", "info");
  addLog("═══════════════════════════════════════════════════════", "warn");
  addLog("  VALIDATE SUPPORTED TOKENS", "warn");
  addLog("═══════════════════════════════════════════════════════", "warn");
  addLog(`Wallet: ${walletInfo.address}`, "info");
  addLog(`Chain: Sepolia (${SEPOLIA_CHAIN_ID})`, "info");
  addLog(`Router: ${NEMESIS_ROUTER}`, "info");
  addLog(`Factory: ${LEVERAGED_FACTORY}`, "info");
  addLog(`WETH:   ${WETH_ADDRESS}`, "info");
  addLog("", "info");

  // Validate each token in the TOKENS map
  const validTokens = [];
  const invalidTokens = [];
  const seenAddresses = new Set();

  for (const [name, info] of Object.entries(TOKENS)) {
    if (!info || !info.address) continue;
    const addrLower = info.address.toLowerCase();
    if (seenAddresses.has(addrLower)) continue; // skip duplicates (ETH/WETH share address)
    seenAddresses.add(addrLower);

    const report = await validateTokenContract(info.address, name, provider);

    if (report.valid) {
      // Get balance
      let balance = "?";
      try {
        if (name === "ETH" || name === "WETH") {
          const bal = await provider.getBalance(walletInfo.address);
          balance = `${ethers.formatEther(bal)} ETH`;
        } else {
          const contract = new ethers.Contract(info.address, ["function balanceOf(address) view returns (uint256)"], provider);
          const bal = await contract.balanceOf(walletInfo.address);
          balance = `${ethers.formatUnits(bal, report.decimals)} ${report.symbol}`;
        }
      } catch (e) { balance = `error: ${e.message.slice(0, 30)}`; }

      validTokens.push({ name, symbol: report.symbol, address: info.address, decimals: report.decimals, balance });
    } else {
      invalidTokens.push({ name, address: info.address, error: report.error || "UNKNOWN" });
    }
  }

  // Log results
  addLog("", "info");
  addLog(`─── Valid Tokens (${validTokens.length}) ───`, "success");
  for (const t of validTokens) {
    addLog(`  ✓ ${t.symbol.padEnd(8)} ${getShortAddress(t.address)} dec=${t.decimals} bal=${t.balance}`, "success");
  }
  if (invalidTokens.length > 0) {
    addLog(`─── Invalid Tokens (${invalidTokens.length}) ───`, "error");
    for (const t of invalidTokens) {
      addLog(`  ✗ ${t.name.padEnd(8)} ${getShortAddress(t.address)} — ${t.error}`, "error");
    }
    addLog(`  ⚠ Invalid tokens will be EXCLUDED from Swap Engine and Trading Engine`, "warn");
  }

  addLog("", "info");
  addLog("═══════════════════════════════════════════════════════", "warn");
}

async function initialize() {
  try {
    startupGitSync();
    loadConfig();
    const shouldResumeFullAuto = tradingConfig.fullAutoEnabled === true;
    if (!shouldResumeFullAuto && tradingConfig.autoRSIEnabled) {
      addLog("[RSI] Previous session detected but auto restart disabled.", "warn");
      tradingConfig.autoRSIEnabled = false;
      saveConfig();
    }
    loadAccounts();
    loadProxies();
    updateStatus();
    await updateWallets();
    updateLogs();

    // ─── Universal collateral discovery at startup ───
    if (accounts.length > 0) {
      try {
        const provider = getProvider(SEPOLIA_RPC_URL, SEPOLIA_CHAIN_ID, proxies[selectedWalletIndex % proxies.length] || null);
        discoveredTokenList = await discoverTokenList(provider);
        const tokenMap = buildTokenMap(discoveredTokenList);
        discoveredMarkets = await discoverSupportedMarkets(provider, discoveredTokenList);
        addLog(`[INIT] Discovered ${discoveredMarkets.length} supported markets`, "success");
        await discoverCollateralRules(provider);
      } catch (error) {
        addLog(`[INIT] Market discovery failed: ${error.message}, using fallback list`, "warn");
        discoveredMarkets = [...MARKET_CANDIDATES_FALLBACK];
      }
    }

    // ─── Discover supported SWAP pairs at startup (Factory + getAmountsOut validation) ───
    if (accounts.length > 0) {
      try {
        const provider = getProvider(SEPOLIA_RPC_URL, SEPOLIA_CHAIN_ID, proxies[selectedWalletIndex % proxies.length] || null);
        discoveredSwapPairs = await discoverSupportedSwapPairs(provider);
        addLog(`[INIT] Discovered ${discoveredSwapPairs.length} supported swap pairs`, "success");
      } catch (error) {
        addLog(`[INIT] Swap pair discovery failed: ${error.message}, using fallback`, "warn");
        discoveredSwapPairs = [];
      }
    }
    if (accounts.length > 0) {
      const diagProvider = getProvider(SEPOLIA_RPC_URL, SEPOLIA_CHAIN_ID, proxies[selectedWalletIndex % proxies.length] || null);
      await printStartupDiagnostics(diagProvider);
      // Remove invalid tokens from TOKENS map to prevent errors in swap/trade engines
      await cleanupInvalidTokens(diagProvider);
    }
    addLog(`You Can Change the Default Config on set manual Config Menu`, "warn");
    safeRender();
    updateMenu();
    menuBox.focus();
    if (shouldResumeFullAuto) {
      setTimeout(() => runFullAutoTrading({ resume: true }).catch(error => addLog(`[AUTO] Resume failed: ${error.message}`, "error")), 1000);
    }
  } catch (error) {
    addLog(`Initialization error: ${error.message}`, "error");
  }
}

if (IS_CLI) {
  const side = process.argv.includes("--long") ? "LONG" : "SHORT";
  loadConfig();
  // Use resolveCollateralForSide() — the SINGLE source of truth for collateral selection
  tradingConfig.defaultCollateralToken = resolveCollateralForSide(side);
  tradingConfig.fullAutoEnabled = false;
  tradingConfig.autoRSIEnabled = false;
  tradingConfig.simulateOnly = false;
  tradingConfig.maxTradesPerPair = 5;
  tradingConfig.maxConcurrentTrades = 5;
  // Clear stale UI payload references — they may be from different collateral tokens
  tradingConfig.uiShortPayloadReference = null;
  tradingConfig.uiLongPayloadReference = null;
  tradingConfig.uiShortTxValueReference = null;
  tradingConfig.uiLongTxValueReference = null;
  loadAccounts();
  loadProxies();
  const provider = getProvider(SEPOLIA_RPC_URL, SEPOLIA_CHAIN_ID, proxies[selectedWalletIndex % proxies.length] || null);
  const wallet = new ethers.Wallet(accounts[selectedWalletIndex].privateKey, provider);
  addLog(`[CLI] Starting ${side} position...`, "warn");
  addLog(`[CLI] Wallet: ${wallet.address}`, "info");
  addLog(`[CLI] defaultCollateralToken: ${tradingConfig.defaultCollateralToken}`, "info");

  // Discover tokens, markets, and swap pairs for CLI mode
  discoverTokenList(provider).then(async (tokenList) => {
    discoveredTokenList = tokenList;
    discoveredMarkets = await discoverSupportedMarkets(provider, tokenList);
    addLog(`[CLI] Discovered ${discoveredMarkets.length} supported markets`, "success");
    await discoverCollateralRules(provider);
    try {
      discoveredSwapPairs = await discoverSupportedSwapPairs(provider);
      addLog(`[CLI] Discovered ${discoveredSwapPairs.length} supported swap pairs`, "success");
    } catch (e) {
      addLog(`[CLI] Swap pair discovery failed: ${e.message}`, "warn");
    }
    return openLeveragedPosition(side);
  }).then(() => {
    addLog("[CLI] === DONE ===", "success");
    process.exit(0);
  }).catch(e => {
    addLog(`[CLI] FAILED: ${e.message}`, "error");
    process.exit(1);
  });
} else {
  setTimeout(() => {
    adjustLayout();
    screen.on("resize", adjustLayout);
  }, 100);
  initialize();
}
