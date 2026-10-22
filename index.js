import blessed from "blessed";
import chalk from "chalk";
import figlet from "figlet";
import { ethers } from "ethers";
import fs from "fs";
import { AutoTrader, STATES, resolveLeverageForOpen } from "./autoTrader.js";
import { getActiveDeployment, getConfirmedPools } from "./deployments/index.js";
import { DEFAULT_ETH_GUARD } from "./tokenInventory.js";

// ═══════════════════════════════════════════════════════════════════════════
//  NEMESIS AUTO BOT — TUI with Autonomous Trading (V2 CORRECTED)
// ═══════════════════════════════════════════════════════════════════════════

const SEPOLIA_RPC_URL = "https://ethereum-sepolia-rpc.publicnode.com";
const SEPOLIA_CHAIN_ID = 11155111;
const CONFIG_FILE = "config.json";

// Production manifest of nemesis.trade (site deployment). Since the 2026-10-15
// migration this IS the active bot deployment (v5). Kept as a named constant
// for the mismatch banner comparison against non-v5 active deployments.
const SITE_DEPLOYMENT = {
  id: "v5",
  factory: "0x35f75f9218c640335d7166628319c4d95d1b0ae8",
  router: "0x6c2844a5aFd10e22195d5f58227434b5b073b6D3",
  source: "nemesis.trade client chunk (module 49514) — deployments/v5.js",
  startBlock: 11873268,
};

const DEPLOYMENT_BANNER_HEIGHT = 7;

// Balance-display tokens — resolved from the ACTIVE deployment profile
// (v5 = site tokens; switching deployments via setActiveDeployment updates these).
const depTokens = () => {
  try { return getActiveDeployment()?.tokens || {}; } catch { return {}; }
};
const WETH_ADDRESS = "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9"; // same on v2 and v5
const USDT_ADDRESS = () => depTokens().USDT || "0x3a1ff83bfd63e5e2564aec95ade244234773049f";
const USDC_ADDRESS = () => depTokens().USDC || "0xdac9ea11f206a88e00d4d6b8e5e767ac429c17b6";

const ERC20_ABI = [
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

// ═══════════════════════════════════════════════════════════════════════════
//  CONFIG LOADING
// ═══════════════════════════════════════════════════════════════════════════

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")); } catch { return {}; }
}

/** Persist a partial patch into config.json (merges over existing keys). */
function saveConfig(patch) {
  const cfg = loadConfig();
  Object.assign(cfg, patch);
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
  return cfg;
}

/**
 * Push changed keys into a RUNNING autoTrader.config so the next cycle
 * picks them up without a restart. Safe no-op when auto is not running.
 */
function applyLiveConfig(patch) {
  if (!autoTrader || !autoRunning) return;
  const c = autoTrader.config;
  if ("leverage" in patch) c.defaultLeverage = Number(patch.leverage);
  if ("leverageMin" in patch) c.leverageMin = Number(patch.leverageMin);
  if ("leverageMax" in patch) c.leverageMax = Number(patch.leverageMax);
  if ("maxLeverage" in patch) c.maxLeverage = Number(patch.maxLeverage);
  if ("leverageAutoStep" in patch) c.leverageAutoStep = patch.leverageAutoStep;
  if ("targetCollateralLong" in patch) c.targetCollateralLong = patch.targetCollateralLong;
  if ("targetCollateralShort" in patch) c.targetCollateralShort = patch.targetCollateralShort;
  if ("maxOpenPositions" in patch) c.maxOpenPositions = Number(patch.maxOpenPositions);
  if ("maxTotalCollateral" in patch) c.maxTotalCollateral = patch.maxTotalCollateral;
  if ("maxDailyLoss" in patch) c.maxDailyLoss = patch.maxDailyLoss;
}

/** Small modal text prompt (blessed.prompt) for Config submenu values. */
function promptConfigValue(title, currentValue, onValue) {
  const prompt = blessed.prompt({
    parent: screen,
    label: ` ${title} `,
    tags: true,
    border: { type: "line" },
    style: { fg: "yellow", border: { fg: "yellow" }, label: { fg: "yellow", bold: true } },
    width: 70,
    height: 7,
    top: "center",
    left: "center",
    keys: true,
    vi: true,
  });
  screen.focusPush(prompt);
  safeRender();
  prompt.input(`${title}:`, String(currentValue ?? ""), (err, value) => {
    try { prompt.destroy(); } catch {}
    safeRender();
    if (err) return;
    onValue(String(value ?? "").trim());
  });
}

function loadAccounts() {
  try {
    const cfg = loadConfig();
    if (cfg.accounts && cfg.accounts.length > 0) return cfg.accounts;
  } catch {}
  try {
    const pk = fs.readFileSync("wallets/pk.txt", "utf8").trim();
    if (pk) {
      const wallet = new ethers.Wallet(pk);
      return [{ address: wallet.address, privateKey: pk }];
    }
  } catch {}
  return [];
}

// ═══════════════════════════════════════════════════════════════════════════
//  TUI STATE
// ═══════════════════════════════════════════════════════════════════════════

let transactionLogs = [];
let isCycleRunning = false;
let autoRunning = false;
let accounts = [];
let proxies = [];
let selectedWalletIndex = 0;
let autoTrader = null;
// Menu mode: "main" = trading actions; "config" = risk/leverage/collateral submenu.
let menuMode = "main";

let walletInfo = {
  address: "N/A",
  balanceETH: "0.000000",
  balanceUSDT: "0.00",
  balanceWETH: "0.000000",
  balanceUSDC: "0.00",
};

let autoStatus = {
  state: "IDLE",
  direction: "N/A",
  position: "NONE",
  leverage: "2x",
  collateral: "N/A",
  swap: "N/A",
  positionId: "N/A",
  lastAction: "N/A",
  onchain: null, // last read-only describePosition() report for the tracked position
};

// Throttled read-only on-chain status (getPositionRisk/positions/previewClose) —
// NEVER sends a TX, refreshed at most once per minute.
const ocStatusCache = { at: 0, inFlight: false, data: null };
function refreshOnChainPositionStatus() {
  if (ocStatusCache.inFlight) return;
  if (Date.now() - ocStatusCache.at < 60_000) return;
  // Multi-position: the on-chain detail panel shows the FIRST tracked record;
  // the TRACKED line below lists every id.
  const posState = autoTrader?.state?.activePositions?.[0] || null;
  const id = posState?.positionId;
  if (!id) {
    ocStatusCache.data = null;
    ocStatusCache.at = Date.now();
    return;
  }
  ocStatusCache.inFlight = true;
  autoTrader.describePosition(id)
    .then(rep => {
      ocStatusCache.data = rep && rep.found ? rep : null;
      autoStatus.onchain = ocStatusCache.data;
    })
    .catch(() => { /* keep the previous reading */ })
    .finally(() => { ocStatusCache.inFlight = false; ocStatusCache.at = Date.now(); });
}

const borderBlinkColors = ["cyan", "blue", "magenta", "red", "yellow", "green"];
let borderBlinkIndex = 0;
let spinnerIndex = 0;
const loadingSpinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// ═══════════════════════════════════════════════════════════════════════════
//  BLESSED TUI LAYOUT
// ═══════════════════════════════════════════════════════════════════════════

const screen = blessed.screen({
  smartCSR: true,
  title: "NT Exhaust — Nemesis Auto Bot",
  cursor: { artificial: true, shape: { type: "block", width: 1, height: 1 }, blink: true },
  fullUnicode: true,
});

const headerBox = blessed.box({
  label: " NT EXHAUST ",
  tags: true,
  border: { type: "line" },
  style: { fg: "cyan", border: { fg: "cyan" }, label: { fg: "white", bold: true } },
  width: "100%",
  height: 8,
  top: 0,
  left: 0,
  align: "center",
  valign: "middle",
});

const statusBox = blessed.box({
  label: " STATUS ",
  tags: true,
  border: { type: "line" },
  style: { fg: "cyan", border: { fg: "cyan" } },
  width: "100%",
  height: 3,
  top: 8,
  left: 0,
});

// Permanent warning: bot and site are on two different deployments.
const mismatchBox = blessed.box({
  label: " DEPLOYMENT WARNING ",
  tags: true,
  border: { type: "line" },
  style: { fg: "red", border: { fg: "red" }, label: { fg: "yellow", bold: true } },
  width: "100%",
  height: DEPLOYMENT_BANNER_HEIGHT,
  top: 11,
  left: 0,
  wrap: true,
});

const walletBox = blessed.list({
  label: " WALLET ",
  tags: true,
  border: { type: "line" },
  style: { fg: "cyan", border: { fg: "cyan" }, selected: { fg: "yellow" }, item: { fg: "white" } },
  width: "40%",
  height: "30%",
  top: 11,
  left: 0,
  keys: true,
  vi: true,
  mouse: true,
  scrollbar: { style: { bg: "cyan" } },
});

const logBox = blessed.log({
  label: " LIVE TRADING LOG ",
  tags: true,
  border: { type: "line" },
  style: { fg: "magenta", border: { fg: "magenta" } },
  width: "59%",
  height: "100%-14",
  top: 11,
  left: "41%",
  keys: true,
  vi: true,
  mouse: true,
  scrollable: true,
  alwaysScroll: true,
  scrollbar: { style: { bg: "magenta" } },
  wrap: true,
});

const menuBox = blessed.list({
  label: " MENU ",
  tags: true,
  border: { type: "line" },
  style: { fg: "green", border: { fg: "green" }, selected: { fg: "yellow", bold: true }, item: { fg: "white" } },
  width: "40%",
  height: "100%-41",
  top: "41%",
  left: 0,
  keys: true,
  vi: true,
  mouse: true,
  items: [],
});

// Auto status panel (overlays wallet box when running)
const autoStatusBox = blessed.box({
  label: " AUTO TRADING STATUS ",
  tags: true,
  border: { type: "line" },
  style: { fg: "yellow", border: { fg: "yellow" } },
  width: "40%",
  height: "30%",
  top: 11,
  left: 0,
  hidden: true,
  scrollable: true,
});

screen.append(headerBox);
screen.append(statusBox);
screen.append(mismatchBox);
screen.append(walletBox);
screen.append(logBox);
screen.append(menuBox);
screen.append(autoStatusBox);

// ═══════════════════════════════════════════════════════════════════════════
//  TUI RENDER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

function safeRender() {
  try { screen.render(); } catch {}
}

function shortEvm(addr) {
  if (!addr || typeof addr !== "string") return "?";
  return `${addr.slice(0, 10)}…${addr.slice(-5)}`;
}

function deploymentMismatchLines() {
  let bot = {};
  try { bot = getActiveDeployment() || {}; } catch { bot = {}; }
  if (bot.id === "v5") {
    return [
      `{bold}{green-fg}DEPLOYMENT OK:{/green-fg}{/bold} бот на production-деплої сайту nemesis.trade (v5).`,
      `{bold}Bot=Site:{/bold} Factory ${shortEvm(bot.factory)} · Router ${shortEvm(bot.router)}`,
      `{bold}Позиції:{/bold} відображатимуться на сайті (site subgraph).`,
    ];
  }
  return [
    `{bold}{red-fg}DEPLOYMENT MISMATCH:{/red-fg}{/bold} active deployment is ${bot.id || "?"} — NOT the site (v5). Позиції бота НЕ відображатимуться на nemesis.trade.`,
    `{bold}Bot:{/bold}  Factory ${shortEvm(bot.factory)} · Router ${shortEvm(bot.router)}`,
    `{bold}Site:{/bold} Factory ${shortEvm(SITE_DEPLOYMENT.factory)} · Router ${shortEvm(SITE_DEPLOYMENT.router)}`,
  ];
}

function updateDeploymentBanner() {
  try {
    let bot = {};
    try { bot = getActiveDeployment() || {}; } catch { bot = {}; }
    if (bot.id === "v5") {
      mismatchBox.style = { fg: "green", border: { fg: "green" }, label: { fg: "green", bold: true } };
      mismatchBox.setLabel(" DEPLOYMENT ");
    } else {
      mismatchBox.style = { fg: "red", border: { fg: "red" }, label: { fg: "yellow", bold: true } };
      mismatchBox.setLabel(" DEPLOYMENT WARNING ");
    }
    mismatchBox.setContent(deploymentMismatchLines().join("\n"));
    safeRender();
  } catch {}
}

function adjustLayout() {
  const W = screen.width;
  const H = screen.height;
  headerBox.height = Math.max(6, Math.floor(H * 0.15));
  statusBox.top = headerBox.height;
  statusBox.height = 3;
  statusBox.width = W;
  mismatchBox.top = headerBox.height + statusBox.height;
  mismatchBox.height = DEPLOYMENT_BANNER_HEIGHT;
  mismatchBox.width = W;
  const contentTop = headerBox.height + statusBox.height + DEPLOYMENT_BANNER_HEIGHT;
  walletBox.top = contentTop;
  walletBox.width = Math.floor(W * 0.4);
  walletBox.height = Math.floor(H * 0.3);
  autoStatusBox.top = walletBox.top;
  autoStatusBox.left = walletBox.left;
  autoStatusBox.width = walletBox.width;
  autoStatusBox.height = walletBox.height;
  logBox.top = contentTop;
  logBox.left = Math.floor(W * 0.41);
  logBox.width = W - Math.floor(W * 0.41) - 2;
  logBox.height = H - contentTop - 2;
  menuBox.top = contentTop + walletBox.height + 1;
  menuBox.width = Math.floor(W * 0.4);
  menuBox.height = H - contentTop - walletBox.height - 2;
  safeRender();
}

function updateHeader() {
  try {
    figlet.text("NT EXHAUST", { font: "Small Slant" }, (err, data) => {
      if (!err && data) {
        headerBox.setContent(`{center}{bold}{cyan-fg}${data}{/cyan-fg}{/bold}{/center}`);
      } else {
        headerBox.setContent("{center}{bold}{cyan-fg}NT EXHAUST — NEMESIS AUTO BOT{/cyan-fg}{/bold}{/center}");
      }
      safeRender();
    });
  } catch {
    headerBox.setContent("{center}{bold}{cyan-fg}NT EXHAUST — NEMESIS AUTO BOT{/cyan-fg}{/bold}{/center}");
    safeRender();
  }
}

function updateStatus() {
  const spinner = loadingSpinner[spinnerIndex % loadingSpinner.length];
  spinnerIndex++;
  borderBlinkIndex = (borderBlinkIndex + 1) % borderBlinkColors.length;

  const statusColor = autoRunning ? "green" : "white";
  const runState = autoRunning ? `{green-fg}RUNNING{/green-fg}` : `{white-fg}STOPPED{/white-fg}`;
  const cycleState = isCycleRunning ? `{yellow-fg}CYCLING{/yellow-fg}` : `{white-fg}WAITING{/white-fg}`;

  statusBox.setContent(
    ` {${statusColor}-fg}${spinner}{/${statusColor}-fg} Auto Trading: ${runState} | Cycle: ${cycleState} | ` +
    `Account: ${shortAddr(walletInfo.address)} | ` +
    `ETH: ${walletInfo.balanceETH} | USDT: ${walletInfo.balanceUSDT} | WETH: ${walletInfo.balanceWETH}`
  );
  statusBox.style.border.fg = borderBlinkColors[borderBlinkIndex];
  safeRender();
}

function shortAddr(addr) {
  if (!addr || addr === "N/A") return "N/A";
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function updateWallet() {
  const items = [
    `{bold}{cyan-fg}Address:{/cyan-fg}{/bold}       ${shortAddr(walletInfo.address)}`,
    `{bold}{cyan-fg}ETH:{/cyan-fg}{/bold}           ${walletInfo.balanceETH}`,
    `{bold}{cyan-fg}USDT:{/cyan-fg}{/bold}          ${walletInfo.balanceUSDT}`,
    `{bold}{cyan-fg}WETH:{/cyan-fg}{/bold}          ${walletInfo.balanceWETH}`,
    `{bold}{cyan-fg}USDC:{/cyan-fg}{/bold}          ${walletInfo.balanceUSDC}`,
  ];
  walletBox.setItems(items);
  walletBox.select(0);
  safeRender();
}

function updateAutoStatus() {
  if (!autoRunning) {
    autoStatusBox.hide();
    walletBox.show();
    safeRender();
    return;
  }

  walletBox.hide();
  autoStatusBox.show();
  refreshOnChainPositionStatus();

  const trackedList = autoTrader?.state?.activePositions || [];
  const pos = trackedList[0] || null;
  const stateColor = {
    IDLE: "white", SIGNAL: "yellow", SWAP: "yellow", ORACLE: "yellow",
    QUOTE: "yellow", PRE_FLIGHT: "yellow", OPEN: "green", MONITOR: "green",
    CLOSE: "red", COOLDOWN: "cyan", WAIT: "gray",
  }[autoStatus.state] || "white";

  const items = [
    `{bold}{yellow-fg}● AUTO TRADING: {green-fg}RUNNING{/green-fg}{/yellow-fg}{/bold}`,
    `{bold}{yellow-fg}● DIRECTION: {white-fg}${autoStatus.direction}{/white-fg}{/yellow-fg}{/bold}`,
    `{bold}{yellow-fg}● POSITION: {white-fg}${autoStatus.position}{/white-fg}{/yellow-fg}{/bold}`,
    `{bold}{yellow-fg}● COLLATERAL: {white-fg}${autoStatus.collateral}{/white-fg}{/yellow-fg}{/bold}`,
    `{bold}{yellow-fg}● SWAP: {white-fg}${autoStatus.swap}{/white-fg}{/yellow-fg}{/bold}`,
    `{bold}{yellow-fg}● LEVERAGE: {white-fg}${autoStatus.leverage}{/white-fg}{/yellow-fg}{/bold}`,
    `{bold}{yellow-fg}● POSITION ID: {white-fg}${autoStatus.positionId}{/white-fg}{/yellow-fg}{/bold}`,
    `{bold}{yellow-fg}● TRACKED: {white-fg}${trackedList.length} position(s)${trackedList.length ? ` — #${trackedList.map(p => p.positionId ?? "?").join(", #")}` : ""}{/white-fg}{/yellow-fg}{/bold}`,
    ...(() => {
      if (!pos) return [];
      const oc = ocStatusCache.data;
      if (!oc) return [`{bold}{yellow-fg}● ONCHAIN: {white-fg}refreshing… (read-only){/white-fg}{/yellow-fg}{/bold}`];
      const color = oc.status === "LIQUIDATION_RISK" ? "red"
        : oc.status === "ACTIVE" ? "green" : "yellow";
      const bits = [`${oc.side || "?"} #${oc.positionId}`, `status=${oc.status}`];
      if (oc.healthBps !== null && oc.healthBps !== undefined) bits.push(`health=${oc.healthBps}bps`);
      if (oc.currentDebtHuman) bits.push(`debt=${oc.currentDebtHuman} ${oc.debtSym || ""}`);
      if (oc.equityValueHuman !== null && oc.equityValueHuman !== undefined) bits.push(`PnL=${oc.equityValueHuman}`);
      if (oc.estimatedLeverageX10 !== null && oc.estimatedLeverageX10 !== undefined) bits.push(`lev≈${oc.estimatedLeverageX10 / 10}x`);
      if (oc.collateralAmountHuman) bits.push(`coll=${oc.collateralAmountHuman} ${oc.collateralSym || ""}`);
      bits.push(`liq=${oc.liquidatable}`);
      return [`{bold}{yellow-fg}● ONCHAIN: {${color}-fg}${bits.join(" | ")}{/${color}-fg}{/yellow-fg}{/bold}`];
    })(),
    "",
    `{bold}{cyan-fg}CURRENT STATE: {${stateColor}-fg}${autoStatus.state}{/${stateColor}-fg}{/cyan-fg}{/bold}`,
    `{bold}{cyan-fg}NEXT ACTION: {white-fg}${autoStatus.lastAction}{/white-fg}{/cyan-fg}{/bold}`,
    "",
    `{bold}{cyan-fg}WALLET:{/cyan-fg}  ${shortAddr(walletInfo.address)}`,
    `{bold}{cyan-fg}ETH:{/cyan-fg}    ${walletInfo.balanceETH}`,
    `{bold}{cyan-fg}USDT:{/cyan-fg}   ${walletInfo.balanceUSDT}`,
    `{bold}{cyan-fg}WETH:{/cyan-fg}   ${walletInfo.balanceWETH}`,
  ];

  autoStatusBox.setContent(items.join("\n"));
  safeRender();
}

function updateMenu() {
  if (menuMode === "config") {
    const cfg = loadConfig();
    const lev = Number(cfg.leverage ?? 2);
    const levStr = lev === 20 ? "20x" : `${lev}x`;
    const tLong = cfg.targetCollateralLong != null && String(cfg.targetCollateralLong).trim() !== ""
      ? String(cfg.targetCollateralLong) : "auto (per-token)";
    const tShort = cfg.targetCollateralShort != null && String(cfg.targetCollateralShort).trim() !== ""
      ? String(cfg.targetCollateralShort) : "auto (per-token)";
    const items = [
      `[L] Leverage: ${levStr}`,
      `[C] Collateral LONG: ${tLong}`,
      `[S] Collateral SHORT: ${tShort}`,
      `[M] Max Open Positions: ${Number(cfg.maxOpenPositions ?? 1)}`,
      `[T] Max Total Collateral: ${cfg.maxTotalCollateral ?? "0"}`,
      `[D] Max Daily Loss: ${cfg.maxDailyLoss ?? "0"} (USDT)`,
      "[B] Back to Main Menu",
    ];
    menuBox.setItems(items);
    menuBox.select(0);
    safeRender();
    return;
  }
  const items = autoRunning
    ? [
        "[1] Stop Full Auto",
        "[2] Open LONG Now",
        "[3] Open SHORT Now",
        "[4] Close Position",
        "[5] Refresh Wallet",
        "[7] Config",
        "[6] Exit",
      ]
    : [
        "[1] Start Full Auto",
        "[2] Open LONG Now",
        "[3] Open SHORT Now",
        "[4] Close Position",
        "[5] Refresh Wallet",
        "[7] Config",
        "[6] Exit",
      ];
  menuBox.setItems(items);
  menuBox.select(0);
  safeRender();
}

function addLog(msg, level = "info") {
  const ts = new Date().toISOString().slice(11, 19);
  const prefix = { info: " ", warn: " ", error: " ", success: " " }[level] || " ";
  const color = { info: "white", warn: "yellow", error: "red", success: "green" }[level] || "white";
  const line = `[${ts}] ${prefix} ${msg}`;
  transactionLogs.push(`{${color}-fg}${line}{/${color}-fg}`);
  if (transactionLogs.length > 500) transactionLogs = transactionLogs.slice(-500);
  if (typeof logBox !== "undefined" && logBox) {
    logBox.add(`{${color}-fg}${line}{/${color}-fg}`);
    logBox.scrollTo(transactionLogs.length);
  }
  safeRender();
}

// ═══════════════════════════════════════════════════════════════════════════
//  WALLET REFRESH
// ═══════════════════════════════════════════════════════════════════════════

async function refreshWallet() {
  if (accounts.length === 0) return;
  try {
    const config = loadConfig();
    const rpcUrl = config.rpcUrl || SEPOLIA_RPC_URL;
    const chainId = config.chainId || SEPOLIA_CHAIN_ID;
    const provider = new ethers.JsonRpcProvider(rpcUrl, chainId);
    const addr = accounts[selectedWalletIndex].address;

    const ethBal = await provider.getBalance(addr);
    const usdtContract = new ethers.Contract(USDT_ADDRESS(), ERC20_ABI, provider);
    const wethContract = new ethers.Contract(WETH_ADDRESS, ERC20_ABI, provider);
    const usdcContract = new ethers.Contract(USDC_ADDRESS(), ERC20_ABI, provider);

    const [usdtBal, wethBal, usdcBal] = await Promise.all([
      usdtContract.balanceOf(addr),
      wethContract.balanceOf(addr),
      usdcContract.balanceOf(addr),
    ]);

    walletInfo.address = addr;
    walletInfo.balanceETH = Number(ethers.formatEther(ethBal)).toFixed(6);
    walletInfo.balanceUSDT = Number(ethers.formatUnits(usdtBal, 6)).toFixed(2);
    walletInfo.balanceWETH = Number(ethers.formatEther(wethBal)).toFixed(6);
    walletInfo.balanceUSDC = Number(ethers.formatUnits(usdcBal, 6)).toFixed(2);

    updateWallet();
    addLog(`Wallet refreshed: ${shortAddr(addr)}`, "success");
  } catch (e) {
    addLog(`Wallet refresh failed: ${e.message?.slice(0, 60)}`, "error");
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  TRADING OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════

async function openManual(side) {
  if (isCycleRunning) {
    addLog("A cycle is already running — wait for it to finish", "warn");
    return;
  }
  isCycleRunning = true;
  try {
    const config = loadConfig();
    const deployment = getActiveDeployment();
    const confirmedPools = getConfirmedPools();

    const rpcUrl = config.rpcUrl || SEPOLIA_RPC_URL;
    const chainId = config.chainId || SEPOLIA_CHAIN_ID;
    const provider = new ethers.JsonRpcProvider(rpcUrl, chainId);
    const wallet = new ethers.Wallet(accounts[selectedWalletIndex].privateKey, provider);

    // Import openPosition + market discovery from autoTrader
    const { openPosition, resolveTradingMarket, getDiscoveredMarkets, setDiscoveredMarkets, tokenDecimalsOnChain, tokenSymbolOnChain } = await import("./autoTrader.js");
    const md = await import("./marketDiscovery.js");

    // Discover all markets on-chain (pool-address-first merge) — no single-market hardcode
    let discovered = getDiscoveredMarkets();
    if (!discovered.length) {
      try {
        const d = await md.discoverMarkets({
          provider,
          factoryAddress: getActiveDeployment().factory,
          tokens: getActiveDeployment().tokens,
          confirmedPools,
          availableMarkets: config.availableMarkets || [],
          knownMarkets: getActiveDeployment().knownMarkets || [],
          runtime: {},
          log: addLog,
        });
        discovered = d.markets || [];
        setDiscoveredMarkets(discovered, [], [], d.tokenMetaCache || null);
      } catch (e) {
        addLog(`Market discovery failed: ${e.message?.slice(0, 60)}`, "warn");
      }
    }

    const market = resolveTradingMarket({
      side,
      confirmedPools,
      availableMarkets: config.availableMarkets || [],
      discoveredMarkets: discovered,
      preferSymbol: config.preferredMarket || null,
    });
    if (!market?.managerAddr) {
      addLog("No active market supports this side", "error");
      return;
    }
    const resolvedManager = market.managerAddr;
    const resolvedPool = market.poolAddr;
    const collateralToken = market.collateralToken;
    if (!collateralToken) {
      addLog("Market has no collateral token for this side", "error");
      return;
    }
    // decimals/symbol ALWAYS from token contract — never hardcoded
    const decimals = market.decimals ?? await tokenDecimalsOnChain(provider, collateralToken);
    const collSym = market.collateralSym ?? await tokenSymbolOnChain(provider, collateralToken);
    // Per-SIDE override wins when set (human units in THIS market's collateral
    // token); otherwise the historical per-token defaults apply unchanged.
    const sideOverride = side === "LONG" ? config.targetCollateralLong : config.targetCollateralShort;
    const targetStr = (sideOverride != null && String(sideOverride).trim() !== "")
      ? String(sideOverride)
      : (collSym === "WETH" || collateralToken.toLowerCase() === WETH_ADDRESS.toLowerCase()
        ? (config.targetCollateralWETH || "0.002")
        : (config.targetCollateralUSDT || "10"));
    const collateralAmount = ethers.parseUnits(targetStr, decimals);

    addLog(`Opening ${side} — market=${market.symbol || "?"} collateral: ${targetStr} ${collSym} @ ${collateralToken.slice(0,8)}...`, "warn");

    // Leverage: config override → default, then clamp/probe against the CONTRACT
    // (MIN/MAX_LEVERAGE_X10 + previewOpenPosition) — read-only, no TX.
    let lev = Number(config.marketLeverage?.[market.symbol] ?? config.leverage ?? 2);
    try {
      const plan = await resolveLeverageForOpen(provider, {
        managerAddr: resolvedManager,
        marketSymbol: market.symbol || null,
        isLong: side === "LONG",
        collateralToken,
        collateralAmount,
        requestedLeverage: lev,
        config: {
          defaultLeverage: lev,
          leverageMin: Number(config.leverageMin ?? 1),
          leverageMax: Number(config.leverageMax ?? config.maxLeverage ?? 5),
          marketLeverage: (config.marketLeverage && typeof config.marketLeverage === "object") ? config.marketLeverage : {},
          leverageAutoStep: config.leverageAutoStep !== false,
        },
        log: addLog,
      });
      if (plan.ok) {
        if (plan.leverage !== lev) addLog(`Leverage adjusted ${lev}x → ${plan.leverage}x (${plan.code || "contract bounds"}: ${plan.reason || "ok"})`, "warn");
        lev = plan.leverage;
      } else {
        addLog(`Leverage unresolved (${plan.code}: ${plan.reason}) — contract will reject this open`, "error");
        return;
      }
    } catch (e) {
      addLog(`Leverage probe failed (${e.message}) — not opening without a validated plan`, "error");
      return;
    }

    const result = await openPosition({
      wallet, provider, managerAddr: resolvedManager, poolAddr: resolvedPool, side, collateralToken, collateralAmount,
      leverage: lev,
      paymentToken: market?.paymentToken,
      config: {
        maxLeverage: Number(config.maxLeverage ?? config.leverageMax ?? 5),
        deadlineSeconds: 1200,
        ethGuard: { ...DEFAULT_ETH_GUARD },
        dryRun: false,
      },
      log: addLog,
      dryRun: false,
    });

    if (result) {
      addLog(`${side} OPENED — position #${result.positionId}`, "success");
    } else {
      addLog(`${side} OPEN failed`, "error");
    }
  } catch (e) {
    addLog(`Open error: ${e.message?.slice(0, 80)}`, "error");
  } finally {
    isCycleRunning = false;
    await refreshWallet();
  }
}

async function closeManual() {
  if (isCycleRunning) {
    addLog("A cycle is already running", "warn");
    return;
  }
  isCycleRunning = true;
  try {
    const config = loadConfig();
    const confirmedPools = getConfirmedPools();
    const rpcUrl = config.rpcUrl || SEPOLIA_RPC_URL;
    const chainId = config.chainId || SEPOLIA_CHAIN_ID;
    const provider = new ethers.JsonRpcProvider(rpcUrl, chainId);
    const wallet = new ethers.Wallet(accounts[selectedWalletIndex].privateKey, provider);
    const trackedList = autoTrader?.state?.activePositions || [];
    if (!trackedList.length) {
      addLog("No tracked positions to close. Use Full Auto for automatic recovery.", "warn");
      return;
    }

    const dropRecord = (rec, reason) => {
      if (typeof autoTrader._clearPosition === "function") {
        autoTrader._clearPosition(rec, reason, true);
      } else {
        const a = autoTrader.state.activePositions || [];
        const i = a.indexOf(rec);
        if (i >= 0) a.splice(i, 1);
        autoTrader.state.sessionStats.closes++;
      }
    };
    const { closePositionFn } = await import("./autoTrader.js");
    let closed = 0;
    for (const posState of [...trackedList]) {
      // ALWAYS close via THIS position's own manager — never a side-derived
      // fallback, which can target a DIFFERENT market's manager (P7).
      const resolved = autoTrader?.resolveManagerForPosition?.(posState) || null;
      const managerAddr = resolved?.managerAddr || posState.managerAddr || null;
      if (!managerAddr) {
        addLog(`Cannot resolve manager for position #${posState.positionId} — NOT closing, NOT clearing`, "error");
        continue;
      }
      addLog(`Closing position #${posState.positionId} on manager ${managerAddr.slice(0,10)}... (market=${posState.marketSymbol || resolved?.marketSymbol || "?"}, src=${resolved?.source || "state"})`, "info");

      const result = await closePositionFn({
        wallet, provider, managerAddr,
        positionId: posState.positionId,
        config: { deadlineSeconds: 1200, dryRun: false },
        log: addLog,
        dryRun: false,
      });

      if (result?.pending) {
        addLog(`Close TX ${result.txHash || ""} pending — keeping position in state`, "warn");
      } else if (result?.failed) {
        if (result.clearState === false) {
          addLog(`Close blocked (${result.code || result.reason}) — keeping position in state`, "warn");
        } else {
          addLog(`Position #${posState.positionId} no longer exists`, "warn");
          dropRecord(posState, "manual: gone");
        }
      } else if (result?.closed === false) {
        addLog(`Close not finished (${result.code || "still active"}) — keeping position in state`, "warn");
      } else if (result) {
        addLog(`Position #${posState.positionId} CLOSED (verified on-chain)`, "success");
        dropRecord(posState, "manual: verified close");
        closed++;
      }
    }
    addLog(`Manual close pass done: ${closed}/${trackedList.length} verified`, closed ? "success" : "warn");
  } catch (e) {
    addLog(`Close error: ${e.message?.slice(0, 80)}`, "error");
  } finally {
    isCycleRunning = false;
    await refreshWallet();
  }
}

async function startAutoTrading() {
  if (autoRunning) {
    addLog("Auto trading already running", "warn");
    return;
  }

  const config = loadConfig();
  const deployment = getActiveDeployment();
  const confirmedPools = getConfirmedPools();

  const rpcUrl = config.rpcUrl || SEPOLIA_RPC_URL;
  const chainId = config.chainId || SEPOLIA_CHAIN_ID;

  const autoConfig = {
    defaultLeverage: config.leverage || 2,
    // Hard ceiling openPosition() enforces — consult leverageMax too so a
    // raised leverageMax (e.g. 20x) is not silently clipped back to 5.
    maxLeverage: Number(config.maxLeverage ?? config.leverageMax ?? 5),
    leverageMin: Number(config.leverageMin ?? 1),
    leverageMax: Number(config.leverageMax ?? config.maxLeverage ?? 5),
    marketLeverage: (config.marketLeverage && typeof config.marketLeverage === "object")
      ? config.marketLeverage : {},
    leverageAutoStep: config.leverageAutoStep !== false,
    autoLoopIntervalMs: 5_000,
    ethGuard: { ...DEFAULT_ETH_GUARD },
    dryRun: false,
    targetCollateralUSDT: config.targetCollateralUSDT || "10",
    targetCollateralWETH: config.targetCollateralWETH || "0.002",
    targetCollateralGeneric: config.targetCollateralGeneric || "10",
    targetCollateralLong: config.targetCollateralLong ?? null,
    targetCollateralShort: config.targetCollateralShort ?? null,
    maxTotalCollateral: config.maxTotalCollateral ?? "0",
    maxDailyLoss: config.maxDailyLoss ?? "0",
    maxCollateralTargetShort: config.maxCollateralTargetShort || "10000",
    targetReserveUSDT: config.targetReserveUSDT || "20",
    targetReserveWETH: config.targetReserveWETH || "0.004",
    targetReserveGeneric: config.targetReserveGeneric || "20",
    deadlineSeconds: config.deadlineSeconds || 1200,
    cooldownAfterOpenMs: 3_000,
    cooldownAfterCloseMs: 3_000,
    autoSwap: config.autoSwap,
    swap: config.swap,
    enableLong: config.enableLong !== false,
    enableShort: config.enableShort !== false,
    enableClose: config.enableClose !== false,
    availableMarkets: config.availableMarkets || [],
    preferredMarket: config.preferredMarket || null,
  };

  const deps = {
    accounts,
    selectedWalletIndex,
    proxies: config.proxies || [],
    rpcUrl,
    chainId,
    config: autoConfig,
    confirmedPools,
    getProvider: (url, chain) => new ethers.JsonRpcProvider(url, chain),
    log: addLog,
  };

  autoTrader = new AutoTrader(deps);
  autoRunning = true;

  // Set initial TUI leverage from config
  autoStatus.leverage = (autoConfig.defaultLeverage || 2) + "x";

  // Wire log events to update TUI auto status
  autoTrader.onLog((msg, level) => {
    // Parse state updates from log messages
    if (msg.includes("CYCLE START")) {
      autoStatus.state = "CYCLING";
      autoStatus.lastAction = "Starting new cycle...";
    } else if (msg.includes("DIRECTION:")) {
      const m = msg.match(/DIRECTION:\s*(\w+)/);
      if (m) { autoStatus.direction = m[1]; autoStatus.lastAction = `Direction: ${m[1]}`; }
    } else if (msg.includes("COLLATERAL") && msg.includes("target=")) {
      const m = msg.match(/target=(\w+)/);
      if (m) { autoStatus.collateral = m[1]; autoStatus.lastAction = `Collateral: ${m[1]}`; }
    } else if (msg.includes("SWAP") && msg.includes("Trying")) {
      autoStatus.swap = "IN PROGRESS";
      autoStatus.lastAction = "Swapping tokens...";
    } else if (msg.includes("COLLATERAL") && msg.includes("SUFFICIENT")) {
      autoStatus.swap = "NO";
    } else if (msg.includes("COLLATERAL") && msg.includes("VERIFIED")) {
      autoStatus.swap = "DONE";
    } else if (msg.includes("[ORACLE]")) {
      autoStatus.state = "ORACLE";
      autoStatus.lastAction = "Oracle checkpoint...";
    } else if (msg.includes("[QUOTE]")) {
      autoStatus.state = "QUOTE";
      autoStatus.lastAction = "Computing quote...";
    } else if (msg.includes("[LEVERAGE] resolved")) {
      // ACTUAL leverage the open will use (after contract∩config clamp/probe).
      // This is the value that ends up in leverageX10 — show IT, never the
      // requested value, so the status panel can never claim 20x while the
      // TX is built with 2x (or vice versa).
      const m = msg.match(/resolved (\d+)x/);
      if (m) { autoStatus.leverage = m[1] + "x"; autoStatus.lastAction = `Leverage resolved ${m[1]}x`; }
    } else if (msg.includes("[PREFLIGHT]") && msg.includes("leverageX10=")) {
      const m = msg.match(/leverageX10=(\d+)/);
      if (m) { autoStatus.leverage = (Math.floor(Number(m[1]) / 10)) + "x"; }
    } else if (msg.includes("[OPEN]") && /\bPENDING\b/.test(msg)) {
      // A submitted open is NOT an open: show it as unconfirmed, never as success.
      autoStatus.position = "PENDING";
      autoStatus.positionId = "?";
      autoStatus.lastAction = "Open TX unconfirmed — not counted";
    } else if (msg.includes("[OPEN]") && msg.includes("CONFIRMED")) {
      const m = msg.match(/position #(\d+)/);
      if (m) { autoStatus.positionId = m[1]; autoStatus.position = "OPEN"; autoStatus.lastAction = `Position #${m[1]} confirmed on-chain`; }
      else { autoStatus.position = "OPEN"; autoStatus.lastAction = "Open confirmed on-chain"; }
    } else if (msg.includes("[OPEN]") && msg.includes("Position ID:")) {
      const m = msg.match(/Position ID:\s*(\d+)/);
      if (m) { autoStatus.positionId = m[1]; autoStatus.position = "OPEN"; autoStatus.lastAction = `Position #${m[1]} opened`; }
    } else if (msg.includes("[OPEN]") && msg.match(/\b\d+x\.\.\./)) {
      const m = msg.match(/(\d+)x/);
      if (m) { autoStatus.leverage = m[1] + "x"; autoStatus.lastAction = `Opening ${m[1]}x...`; }
    } else if (msg.includes("OPEN") && msg.includes("Sending")) {
      autoStatus.state = "OPEN";
      autoStatus.lastAction = "Sending open TX...";
    } else if (msg.includes("CLOSE") && msg.includes("position")) {
      autoStatus.state = "CLOSE";
      autoStatus.lastAction = "Closing position...";
    } else if (msg.includes("CLOSE") && msg.includes("SUCCESS")) {
      autoStatus.position = "NONE";
      autoStatus.positionId = "N/A";
      autoStatus.lastAction = "Position closed";
    } else if (msg.includes("MONITOR")) {
      autoStatus.state = "MONITOR";
      autoStatus.lastAction = "Monitoring position...";
    } else if (msg.includes("COOLDOWN")) {
      autoStatus.state = "COOLDOWN";
      autoStatus.lastAction = "Cooldown...";
    } else if (msg.includes("CYCLE END")) {
      autoStatus.state = "IDLE";
      autoStatus.lastAction = "Cycle complete, waiting...";
    } else if (msg.includes("[AUTO] NEXT ACTION:")) {
      const m = msg.match(/NEXT ACTION:\s*(.+)/);
      if (m) { autoStatus.lastAction = m[1]; }
    } else if (msg.includes("[AUTO] SWAPPING")) {
      autoStatus.state = "SWAP";
      autoStatus.swap = "IN PROGRESS";
      const m = msg.match(/SWAPPING\s+(\S+\s*→\s*\S+)/);
      if (m) { autoStatus.lastAction = `Swapping ${m[1]}`; }
    } else if (msg.includes("[SWAP] SUCCESS")) {
      autoStatus.swap = "DONE";
      const m = msg.match(/SUCCESS\s+(\S+)/);
      if (m) { autoStatus.lastAction = `Swap OK ${m[1]}`; }
    } else if (msg.includes("[AUTO] OPENING")) {
      autoStatus.state = "OPEN";
      const m = msg.match(/OPENING\s+(\w+)/);
      if (m) { autoStatus.direction = m[1]; autoStatus.lastAction = `Opening ${m[1]}...`; }
    } else if (msg.includes("[AUTO] CLOSING")) {
      autoStatus.state = "CLOSE";
      autoStatus.lastAction = "Closing position...";
    } else if (msg.includes("CYCLE START")) {
      autoStatus.state = "CYCLING";
    } else if (msg.includes("DIRECTION:")) {
      const m = msg.match(/DIRECTION:\s*(\w+)/);
      if (m) { autoStatus.direction = m[1]; }
    } else if (msg.includes("BLOCKED")) {
      autoStatus.lastAction = "Blocked — see log";
    } else if (msg.includes("ERROR")) {
      autoStatus.lastAction = "Error — see log";
    }

    autoStatus.state = autoTrader.currentState || autoStatus.state;
    updateAutoStatus();
  });

  updateMenu();
  updateAutoStatus();
  addLog("═══ AUTONOMOUS TRADING STARTED ═══", "success");

  // Run in background (non-blocking)
  autoTrader.start().catch(e => {
    addLog(`Auto trader error: ${e.message?.slice(0, 80)}`, "error");
    autoRunning = false;
    updateMenu();
  });

  // Periodic wallet refresh while auto is running
  const refreshInterval = setInterval(async () => {
    if (!autoRunning) { clearInterval(refreshInterval); return; }
    await refreshWallet();
    updateAutoStatus();
  }, 15_000);
}

async function stopAutoTrading() {
  if (!autoRunning || !autoTrader) {
    addLog("Auto trading not running", "warn");
    return;
  }
  autoTrader.stop();
  autoRunning = false;
  autoStatus.state = "IDLE";
  autoStatus.lastAction = "Stopped";
  updateMenu();
  updateAutoStatus();
  addLog("═══ AUTONOMOUS TRADING STOPPED ═══", "warn");
  await refreshWallet();
}

// ═══════════════════════════════════════════════════════════════════════════
//  MENU HANDLER
// ═══════════════════════════════════════════════════════════════════════════

let _menuSelectLock = false;
menuBox.on("select", async (item, index) => {
  if (_menuSelectLock) return;
  _menuSelectLock = true;
  setTimeout(() => { _menuSelectLock = false; }, 500);
  const label = item.getText();

  // ── CONFIG SUBMENU ────────────────────────────────────────────────────────
  if (menuMode === "config") {
    if (label.includes("Back to Main")) {
      menuMode = "main";
      updateMenu();
      return;
    }
    if (label.includes("Leverage:")) {
      // Toggle 2x ↔ 20x. Writing leverage/leverageMax/maxLeverage together
      // guarantees the menu value and the TX leverageX10 can never diverge.
      const cfg = loadConfig();
      const cur = Number(cfg.leverage ?? 2);
      const next = cur === 20 ? 2 : 20;
      const patch = {
        leverage: next,
        leverageMin: 2,
        leverageMax: 20,
        maxLeverage: 20,
        // 20x is STRICT: a market that cannot quote exactly 20x is SKIPPED
        // (leverageAutoStep=false), never silently downgraded to 2x.
        leverageAutoStep: next !== 20,
      };
      saveConfig(patch);
      applyLiveConfig(patch);
      autoStatus.leverage = next + "x";
      addLog(`Leverage set to ${next}x${next === 20 ? " (STRICT — markets unable to quote 20x are skipped)" : " (auto-step restored)"}`, next === 20 ? "warn" : "info");
      updateMenu();
      updateAutoStatus();
      return;
    }
    if (label.includes("Collateral LONG:")) {
      promptConfigValue("Collateral per LONG (token units, empty=auto)", loadConfig().targetCollateralLong ?? "", (val) => {
        const patch = { targetCollateralLong: val === "" ? null : val };
        saveConfig(patch);
        applyLiveConfig(patch);
        addLog(`Collateral LONG = ${val === "" ? "auto (per-token)" : val}`, "info");
        updateMenu();
      });
      return;
    }
    if (label.includes("Collateral SHORT:")) {
      promptConfigValue("Collateral per SHORT (token units, empty=auto)", loadConfig().targetCollateralShort ?? "", (val) => {
        const patch = { targetCollateralShort: val === "" ? null : val };
        saveConfig(patch);
        applyLiveConfig(patch);
        addLog(`Collateral SHORT = ${val === "" ? "auto (per-token)" : val}`, "info");
        updateMenu();
      });
      return;
    }
    if (label.includes("Max Open Positions:")) {
      promptConfigValue("Max Open Positions", String(loadConfig().maxOpenPositions ?? 1), (val) => {
        const n = Number(val);
        if (!Number.isFinite(n) || n < 1) { addLog(`Invalid maxOpenPositions: ${val}`, "error"); return; }
        const patch = { maxOpenPositions: Math.floor(n) };
        saveConfig(patch);
        applyLiveConfig(patch);
        addLog(`maxOpenPositions = ${patch.maxOpenPositions}`, "info");
        updateMenu();
      });
      return;
    }
    if (label.includes("Max Total Collateral:")) {
      promptConfigValue("Max Total Collateral (per token, 0=off)", String(loadConfig().maxTotalCollateral ?? "0"), (val) => {
        if (Number(val) < 0) { addLog(`Invalid maxTotalCollateral: ${val}`, "error"); return; }
        const patch = { maxTotalCollateral: val };
        saveConfig(patch);
        applyLiveConfig(patch);
        addLog(`maxTotalCollateral = ${val}${val === "0" ? " (disabled)" : ""}`, "info");
        updateMenu();
      });
      return;
    }
    if (label.includes("Max Daily Loss:")) {
      promptConfigValue("Max Daily Loss (USDT, 0=off)", String(loadConfig().maxDailyLoss ?? "0"), (val) => {
        if (Number(val) < 0) { addLog(`Invalid maxDailyLoss: ${val}`, "error"); return; }
        const patch = { maxDailyLoss: val };
        saveConfig(patch);
        applyLiveConfig(patch);
        addLog(`maxDailyLoss = ${val}${val === "0" ? " (disabled)" : ""} USDT (stable-collateral realized losses, UTC day)`, "info");
        updateMenu();
      });
      return;
    }
    return;
  }

  // ── MAIN MENU ─────────────────────────────────────────────────────────────
  if (label.includes("Start Full Auto")) {
    await startAutoTrading();
  } else if (label.includes("Stop Full Auto")) {
    await stopAutoTrading();
  } else if (label.includes("Open LONG")) {
    await openManual("LONG");
  } else if (label.includes("Open SHORT")) {
    await openManual("SHORT");
  } else if (label.includes("Close Position")) {
    await closeManual();
  } else if (label.includes("Refresh Wallet")) {
    await refreshWallet();
  } else if (label.includes("Config")) {
    menuMode = "config";
    updateMenu();
  } else if (label.includes("Exit")) {
    if (autoRunning && autoTrader) autoTrader.stop();
    process.exit(0);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  KEY BINDINGS
// ═══════════════════════════════════════════════════════════════════════════

screen.key(["up"], () => { if (screen.focused === menuBox) menuBox.moveSelection(-1); safeRender(); });
screen.key(["down"], () => { if (screen.focused === menuBox) menuBox.moveSelection(1); safeRender(); });
// Enter is handled natively by blessed List.enterSelected() — no custom handler needed
screen.key(["q", "C-c"], async () => {
  if (autoRunning && autoTrader) autoTrader.stop();
  process.exit(0);
});

logBox.key(["up"], () => { logBox.scroll(-1); safeRender(); });
logBox.key(["down"], () => { logBox.scroll(1); safeRender(); });
logBox.on("click", () => { screen.focusPush(logBox); safeRender(); });

walletBox.key(["up"], () => { walletBox.moveSelection(-1); safeRender(); });
walletBox.key(["down"], () => { walletBox.moveSelection(1); safeRender(); });
walletBox.on("click", () => { screen.focusPush(walletBox); safeRender(); });

autoStatusBox.on("click", () => { screen.focusPush(autoStatusBox); safeRender(); });

menuBox.on("click", () => { screen.focusPush(menuBox); safeRender(); });

// ═══════════════════════════════════════════════════════════════════════════
//  INITIALIZATION
// ═══════════════════════════════════════════════════════════════════════════

async function initialize() {
  try {
    addLog("Initializing NT Exhaust...", "info");

    accounts = loadAccounts();
    if (accounts.length === 0) {
      addLog("No accounts found in config.json or wallets/pk.txt", "error");
      addLog("Please add a private key to wallets/pk.txt", "warn");
    } else {
      addLog(`Loaded ${accounts.length} account(s)`, "success");
    }

    const config = loadConfig();
    proxies = config.proxies || [];

    updateHeader();
    adjustLayout();
    updateDeploymentBanner();
    updateMenu();
    updateStatus();

    await refreshWallet();

    // Focus menu by default
    screen.focusPush(menuBox);

    addLog("NT Exhaust ready — select an option from the menu", "success");
    addLog("Press Q or Ctrl+C to exit", "info");

    // Status blink interval
    setInterval(updateStatus, 200);

    safeRender();
  } catch (e) {
    addLog(`Init error: ${e.message}`, "error");
    safeRender();
  }
}

// Handle resize
screen.on("resize", adjustLayout);

// Handle CLI mode (--long, --short)
const IS_CLI = process.argv.includes("--long") || process.argv.includes("--short");
if (IS_CLI) {
  const side = process.argv.includes("--long") ? "LONG" : "SHORT";
  (async () => {
    accounts = loadAccounts();
    if (accounts.length === 0) { console.error("No accounts"); process.exit(1); }
    await openManual(side);
    process.exit(0);
  })();
} else {
  initialize();
}
