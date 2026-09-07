import blessed from "blessed";
import chalk from "chalk";
import figlet from "figlet";
import { ethers } from "ethers";
import fs from "fs";
import { AutoTrader, STATES } from "./autoTrader.js";
import { getActiveDeployment, getConfirmedPools } from "./deployments/index.js";
import { DEFAULT_ETH_GUARD } from "./tokenInventory.js";

// ═══════════════════════════════════════════════════════════════════════════
//  NEMESIS AUTO BOT — TUI with Autonomous Trading (V2 CORRECTED)
// ═══════════════════════════════════════════════════════════════════════════

const SEPOLIA_RPC_URL = "https://ethereum-sepolia-rpc.publicnode.com";
const SEPOLIA_CHAIN_ID = 11155111;
const CONFIG_FILE = "config.json";

const WETH_ADDRESS = "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9";
const USDT_ADDRESS = "0x5f2E83cCDEa73D60aF400e03F1Cd8Fb9eaB07b20";
const USDC_ADDRESS = "0x5dcf1Db10F87CB7839640F9B85C4ECfA29b56e80";

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
};

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

function adjustLayout() {
  const W = screen.width;
  const H = screen.height;
  headerBox.height = Math.max(6, Math.floor(H * 0.15));
  statusBox.top = headerBox.height;
  statusBox.height = 3;
  statusBox.width = W;
  walletBox.top = headerBox.height + statusBox.height;
  walletBox.width = Math.floor(W * 0.4);
  walletBox.height = Math.floor(H * 0.3);
  autoStatusBox.top = walletBox.top;
  autoStatusBox.left = walletBox.left;
  autoStatusBox.width = walletBox.width;
  autoStatusBox.height = walletBox.height;
  logBox.top = headerBox.height + statusBox.height;
  logBox.left = Math.floor(W * 0.41);
  logBox.width = W - Math.floor(W * 0.41) - 2;
  logBox.height = H - (headerBox.height + statusBox.height) - 2;
  menuBox.top = headerBox.height + statusBox.height + walletBox.height + 1;
  menuBox.width = Math.floor(W * 0.4);
  menuBox.height = H - (headerBox.height + statusBox.height + walletBox.height) - 2;
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

  const pos = autoTrader?.state?.activePosition;
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
  const items = autoRunning
    ? [
        "[1] Stop Full Auto",
        "[2] Open LONG Now",
        "[3] Open SHORT Now",
        "[4] Close Position",
        "[5] Refresh Wallet",
        "[6] Exit",
      ]
    : [
        "[1] Start Full Auto",
        "[2] Open LONG Now",
        "[3] Open SHORT Now",
        "[4] Close Position",
        "[5] Refresh Wallet",
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
    const usdtContract = new ethers.Contract(USDT_ADDRESS, ERC20_ABI, provider);
    const wethContract = new ethers.Contract(WETH_ADDRESS, ERC20_ABI, provider);
    const usdcContract = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);

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

    const managerAddr = confirmedPools["ETH/USDT"]?.manager;
    const poolAddr = confirmedPools["ETH/USDT"]?.pool;

    if (!managerAddr) {
      addLog("No manager address found for ETH/USDT", "error");
      return;
    }

    // Import openPosition from autoTrader
    const { openPosition } = await import("./autoTrader.js");

    const collateralToken = side === "LONG" ? USDT_ADDRESS : WETH_ADDRESS;
    const targetStr = side === "LONG" ? "10" : "0.002";
    const collateralAmount = side === "LONG"
      ? ethers.parseUnits(targetStr, 6)
      : ethers.parseEther(targetStr);

    addLog(`Opening ${side} — collateral: ${side === "LONG" ? "USDT" : "WETH"} ${targetStr}`, "warn");

    const result = await openPosition({
      wallet, provider, managerAddr, poolAddr, side, collateralToken, collateralAmount,
      leverage: 2,
      config: {
        maxLeverage: 5,
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
    const managerAddr = confirmedPools["ETH/USDT"]?.manager;

    if (!managerAddr) {
      addLog("No manager address found", "error");
      return;
    }

    // Check LP balance
    const MANAGER_ABI = ["function balanceOf(address account) view returns (uint256)"];
    const manager = new ethers.Contract(managerAddr, MANAGER_ABI, provider);
    const lpBal = await manager.balanceOf(wallet.address);
    addLog(`LP balance: ${lpBal.toString()}`, "info");

    if (lpBal === 0n) {
      addLog("No active position to close", "warn");
      return;
    }

    // Find position ID from events or state
    const posState = autoTrader?.state?.activePosition;
    if (!posState) {
      addLog("No tracked position to close. Use Full Auto for automatic recovery.", "warn");
      return;
    }

    const { closePositionFn } = await import("./autoTrader.js");
    const result = await closePositionFn({
      wallet, provider, managerAddr,
      positionId: posState.positionId,
      config: { deadlineSeconds: 1200, dryRun: false },
      log: addLog,
      dryRun: false,
    });

    if (result?.failed) {
      addLog("Position may no longer exist", "warn");
    } else if (result) {
      addLog("Position CLOSED", "success");
      autoTrader.state.activePosition = null;
      autoTrader.state.sessionStats.closes++;
    }
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
    maxLeverage: 5,
    autoLoopIntervalMs: 30_000,
    ethGuard: { ...DEFAULT_ETH_GUARD },
    dryRun: false,
    targetCollateralUSDT: "10",
    targetCollateralWETH: "0.002",
    deadlineSeconds: config.deadlineSeconds || 1200,
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
    } else if (msg.includes("OPEN") && msg.includes("Position ID:")) {
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
