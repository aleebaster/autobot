import blessed from "blessed";
import chalk from "chalk";
import figlet from "figlet";
import { ethers } from "ethers";
import fs from "fs";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";

const SEPOLIA_RPC_URL = "https://ethereum-sepolia-rpc.publicnode.com/";
const SEPOLIA_CHAIN_ID = 11155111;

const NEMESIS_ROUTER  = "0xA1f78beD1a79B9aec972e373E0e7F63d8cAce4a8";
const WETH_ADDRESS    = "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9";
const USDC_ADDRESS    = "0x10279e6333f9d0EE103F4715b8aaEA75BE61464C";
const DAI_ADDRESS     = "0xd67215fD6c0890493F34aF3C5E4231cE98871fCb";
const UNI_ADDRESS    = "0x7438eA86A89b7d53aF5264Fb3aBaE1172b046663";

const CONFIG_FILE = "config.json";
const isDebug = false;

const TOKENS = {
  USDC: { address: USDC_ADDRESS, decimals: 6,  symbol: "USDC" },
  DAI:  { address: DAI_ADDRESS,  decimals: 18, symbol: "DAI"  },
  UNI: { address: UNI_ADDRESS, decimals: 18, symbol: "UNI" }
};

const SWAP_PAIRS = [
  { from: "ETH",  to: "USDC" },
  { from: "USDC", to: "ETH"  },
  { from: "ETH",  to: "DAI"  },
  { from: "DAI",  to: "ETH"  },
  { from: "ETH",  to: "UNI" },
  { from: "UNI", to: "ETH"  }
];

const ROUTER_ABI = [
  "function swapExactETHForTokens(uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) payable returns (uint256[] memory)",
  "function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) returns (uint256[] memory)",
  "function getAmountsOut(uint256 amountIn, address[] calldata path) view returns (uint256[] memory)"
];

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)"
];

let walletInfo = {
  address:      "N/A",
  balanceETH:   "0.000000",
  balanceUSDC:  "0.00",
  balanceDAI:   "0.000000",
  balanceUNI:  "0.000000",
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

let dailyActivityConfig = {
  activityRepetitions: 1,
  ethRange:  { min: 0.00001, max: 0.00002 },
  usdcRange: { min: 500,     max: 1000    },
  daiRange:  { min: 0.5,     max: 1.0     },
  uniRange: { min: 0.01,    max: 0.05    },
  loopHours: 24
};

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = fs.readFileSync(CONFIG_FILE, "utf8");
      const cfg  = JSON.parse(data);
      dailyActivityConfig.activityRepetitions = Number(cfg.activityRepetitions) || 1;
      dailyActivityConfig.ethRange.min  = Number(cfg.ethRange?.min)  || 0.00001;
      dailyActivityConfig.ethRange.max  = Number(cfg.ethRange?.max)  || 0.00002;
      dailyActivityConfig.usdcRange.min = Number(cfg.usdcRange?.min) || 500;
      dailyActivityConfig.usdcRange.max = Number(cfg.usdcRange?.max) || 1000;
      dailyActivityConfig.daiRange.min  = Number(cfg.daiRange?.min)  || 0.5;
      dailyActivityConfig.daiRange.max  = Number(cfg.daiRange?.max)  || 1.0;
      dailyActivityConfig.uniRange.min = Number(cfg.uniRange?.min) || 0.01;
      dailyActivityConfig.uniRange.max = Number(cfg.uniRange?.max) || 0.05;
      dailyActivityConfig.loopHours     = Number(cfg.loopHours)      || 24;
    } else {
      addLog("No config file found, using default settings.", "info");
    }
  } catch (error) {
    addLog(`Failed to load config: ${error.message}`, "error");
  }
}

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(dailyActivityConfig, null, 2));
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
    addLog(`Loaded ${accounts.length} accounts from pk.txt`, "success");
  } catch (error) {
    addLog(`Failed to load accounts: ${error.message}`, "error");
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

      const [usdcBal, daiBal, uniBal] = await Promise.all([
        usdcContract.balanceOf(wallet.address),
        daiContract.balanceOf(wallet.address),
        uniContract.balanceOf(wallet.address)
      ]);

      const formattedUSDC = Number(ethers.formatUnits(usdcBal, 6)).toFixed(2);
      const formattedDAI  = Number(ethers.formatEther(daiBal)).toFixed(4);
      const formattedUNI = Number(ethers.formatEther(uniBal)).toFixed(4);

      if (i === selectedWalletIndex) {
        walletInfo.address      = wallet.address;
        walletInfo.activeAccount= `Account ${i + 1}`;
        walletInfo.balanceETH   = formattedETH;
        walletInfo.balanceUSDC  = formattedUSDC;
        walletInfo.balanceDAI   = formattedDAI;
        walletInfo.balanceUNI  = formattedUNI;
      }

      const prefix = i === selectedWalletIndex ? "→ " : "  ";
      return (
        `${prefix}${chalk.bold.magentaBright(getShortAddress(wallet.address))}` +
        `   ${chalk.bold.cyanBright(formattedETH.padEnd(10))}` +
        `  ${chalk.bold.greenBright(formattedUSDC.padEnd(10))}` +
        `  ${chalk.bold.yellowBright(formattedDAI.padEnd(8))}` +
        `  ${chalk.bold.blueBright(formattedUNI)}`
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

async function performSwap(wallet, fromToken, toToken, amount, proxyUrl) {
  const provider = getProvider(SEPOLIA_RPC_URL, SEPOLIA_CHAIN_ID, proxyUrl);
  wallet = wallet.connect(provider);
  const router   = new ethers.Contract(NEMESIS_ROUTER, ROUTER_ABI, wallet);
  const deadline  = Math.floor(Date.now() / 1000) + 60 * 20;
  const slippage  = 0.95; 

  const label = `${fromToken} ➪  ${toToken}`;
  addLog(`Preparing swap: ${amount} ${fromToken} ➪  ${toToken}`, "wait");

  const feeParams  = await getFeeParams(provider);
  const gasLimit   = 300000n;

  if (fromToken === "ETH") {
    const tokenInfo  = TOKENS[toToken];
    const path       = [WETH_ADDRESS, tokenInfo.address];
    const amountInWei = ethers.parseEther(amount.toFixed(8));

    let amountOutMin;
    try {
      const amounts  = await router.getAmountsOut(amountInWei, path);
      const amountOut = amounts[1];
      amountOutMin   = amountOut * BigInt(Math.floor(slippage * 100)) / 100n;
      addLog(
        `Quote: ${amount} ETH ➪ ${ethers.formatUnits(amountOut, tokenInfo.decimals)} ${toToken}` +
        ` (min: ${ethers.formatUnits(amountOutMin, tokenInfo.decimals)})`,
        "info"
      );
    } catch (err) {
      addLog(`getAmountsOut failed (${label}): ${err.message}. Using amountOutMin=0.`, "warn");
      amountOutMin = 0n;
    }

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

    const tokenContract = new ethers.Contract(tokenInfo.address, ERC20_ABI, provider);
    const tokenBal = await tokenContract.balanceOf(wallet.address);
    if (tokenBal < amountInWei) {
      throw new Error(`Insufficient ${fromToken}: have ${ethers.formatUnits(tokenBal, tokenInfo.decimals)}, need ${ethers.formatUnits(amountInWei, tokenInfo.decimals)}`);
    }

    let amountOutMin;
    try {
      const amounts  = await router.getAmountsOut(amountInWei, path);
      const amountOut = amounts[1];
      amountOutMin   = amountOut * BigInt(Math.floor(slippage * 100)) / 100n;
      addLog(
        `Quote: ${amount} ${fromToken} ➪ ${ethers.formatEther(amountOut)} ETH` +
        ` (min: ${ethers.formatEther(amountOutMin)})`,
        "info"
      );
    } catch (err) {
      addLog(`getAmountsOut failed (${label}): ${err.message}. Using amountOutMin=0.`, "warn");
      amountOutMin = 0n;
    }

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
  const receipt = await Promise.race([tx.wait(), timeoutPromise]);
  if (receipt.status === 0) throw new Error("Transaction reverted");
  return receipt;
}

function getSwapAmount(pair) {
  switch (pair.from) {
    case "ETH":  return getRandomAmount(dailyActivityConfig.ethRange.min,  dailyActivityConfig.ethRange.max);
    case "USDC": return getRandomAmount(dailyActivityConfig.usdcRange.min, dailyActivityConfig.usdcRange.max);
    case "DAI":  return getRandomAmount(dailyActivityConfig.daiRange.min,  dailyActivityConfig.daiRange.max);
    case "UNI": return getRandomAmount(dailyActivityConfig.uniRange.min, dailyActivityConfig.uniRange.max);
    default: return 0;
  }
}

async function runDailyActivity() {
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

      const shuffledPairs = [...SWAP_PAIRS].sort(() => Math.random() - 0.5);

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
  items:   isCycleRunning
    ? ["Stop Activity", "Set Manual Config", "Clear Logs", "Refresh", "Exit"]
    : ["Start Auto Daily Activity", "Set Manual Config", "Clear Logs", "Refresh", "Exit"],
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
    "Set ETH Range",
    "Set USDC Range",
    "Set DAI Range",
    "Set UNI Range",
    "Set Loop Daily",
    "Back to Main Menu"
  ],
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
screen.append(configForm);

let renderQueue  = [];
let isRendering  = false;
function safeRender() {
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
      addLog(`UI render error: ${error.message}`, "error");
    }
    renderQueue.shift();
    isRendering = false;
    if (renderQueue.length > 0) safeRender();
  }, 100);
}

function adjustLayout() {
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
    configForm.width  = Math.floor(W * 0.3);
    configForm.height = Math.floor(H * 0.4);
  }
  safeRender();
}

function updateStatus() {
  try {
    const isProcessing = activityRunning || (isCycleRunning && dailyActivityInterval !== null);
    const status = activityRunning
      ? `${loadingSpinner[spinnerIndex]} ${chalk.yellowBright("Running")}`
      : isCycleRunning && dailyActivityInterval !== null
      ? `${loadingSpinner[spinnerIndex]} ${chalk.yellowBright("Waiting next cycle")}`
      : chalk.green("Idle");

    statusBox.setContent(
      `Status: ${status} | Account: ${getShortAddress(walletInfo.address)} | ` +
      `Total: ${accounts.length} | Swaps: ${dailyActivityConfig.activityRepetitions}x | ` +
      `Loop: ${dailyActivityConfig.loopHours}h | NEMESIS TESTNET AUTO BOT`
    );

    if (isProcessing) {
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
      `  ${chalk.bold.blue("UNI")}`
    );
    const separator = chalk.gray("─".repeat(68));
    walletBox.setItems([header, separator, ...walletData]);
    walletBox.select(0);
    safeRender();
  } catch (error) {
    addLog(`Failed to update wallet data: ${error.message}`, "error");
  }
}

function updateLogs() {
  try {
    logBox.add(transactionLogs[transactionLogs.length - 1] || chalk.gray("No logs available."));
    logBox.scrollTo(transactionLogs.length);
    safeRender();
  } catch (error) {
    addLog(`Log update failed: ${error.message}`, "error");
  }
}

function updateMenu() {
  try {
    menuBox.setItems(
      isCycleRunning
        ? ["Stop Activity", "Set Manual Config", "Clear Logs", "Refresh", "Exit"]
        : ["Start Auto Daily Activity", "Set Manual Config", "Clear Logs", "Refresh", "Exit"]
    );
    safeRender();
  } catch (error) {
    addLog(`Menu update failed: ${error.message}`, "error");
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
  safeRender();
});

logBox.on("blur", () => {
  logBox.style.border.fg = "magenta";
  safeRender();
});

menuBox.on("select", async (item) => {
  const action = item.getText();
  switch (action) {
    case "Start Auto Daily Activity":
      if (isCycleRunning) {
        addLog("Cycle is still running. Stop the current cycle first.", "error");
      } else {
        await runDailyActivity();
      }
      break;

    case "Stop Activity":
      shouldStop = true;
      if (dailyActivityInterval) {
        clearTimeout(dailyActivityInterval);
        dailyActivityInterval = null;
        addLog("Cleared daily activity interval.", "info");
      }
      addLog("Stopping... waiting for current process to complete.", "info");
      safeRender();
      if (activeProcesses <= 0) {
        activityRunning = false;
        isCycleRunning  = false;
        shouldStop      = false;
        hasLoggedSleepInterrupt = false;
        addLog("Daily activity stopped successfully.", "success");
        updateMenu(); updateStatus(); safeRender();
      } else {
        const stopCheckInterval = setInterval(() => {
          if (activeProcesses <= 0) {
            clearInterval(stopCheckInterval);
            activityRunning = false;
            isCycleRunning  = false;
            shouldStop      = false;
            hasLoggedSleepInterrupt = false;
            activeProcesses = 0;
            addLog("Daily activity stopped successfully.", "success");
            updateMenu(); updateStatus(); safeRender();
          } else {
            addLog(`Waiting for ${activeProcesses} process(es)...`, "info");
            safeRender();
          }
        }, 1000);
      }
      break;

    case "Set Manual Config":
      menuBox.hide();
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

    case "Clear Logs":
      clearTransactionLogs();
      break;

    case "Refresh":
      await updateWallets();
      addLog("Data refreshed.", "success");
      break;

    case "Exit":
      clearInterval(statusInterval);
      process.exit(0);
  }
});

dailyActivitySubMenu.on("select", (item) => {
  const action = item.getText();

  const rangeTypes = {
    "Set Swap Repetitions": { type: "activityRepetitions", label: " Enter Swap Repetitions ",    hasRange: false, val: () => dailyActivityConfig.activityRepetitions.toString() },
    "Set ETH Range":        { type: "ethRange",            label: " Enter ETH Range (e.g. 0.00001)", hasRange: true, minVal: () => dailyActivityConfig.ethRange.min.toString(),  maxVal: () => dailyActivityConfig.ethRange.max.toString()  },
    "Set USDC Range":       { type: "usdcRange",           label: " Enter USDC Range (e.g. 500)",    hasRange: true, minVal: () => dailyActivityConfig.usdcRange.min.toString(), maxVal: () => dailyActivityConfig.usdcRange.max.toString() },
    "Set DAI Range":        { type: "daiRange",            label: " Enter DAI Range (e.g. 0.5)",     hasRange: true, minVal: () => dailyActivityConfig.daiRange.min.toString(),  maxVal: () => dailyActivityConfig.daiRange.max.toString()  },
    "Set UNI Range":       { type: "uniRange",           label: " Enter UNI Range (e.g. 0.01)",   hasRange: true, minVal: () => dailyActivityConfig.uniRange.min.toString(), maxVal: () => dailyActivityConfig.uniRange.max.toString() },
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

const rangeKeys = ["ethRange", "usdcRange", "daiRange", "uniRange"];
let isSubmitting = false;

configForm.on("submit", () => {
  if (isSubmitting) return;
  isSubmitting = true;

  const inputValue = configInput.getValue().trim();
  let value, maxValue;

  try {
    value = ["activityRepetitions", "loopHours"].includes(configForm.configType)
      ? parseInt(inputValue)
      : parseFloat(inputValue);

    if (rangeKeys.includes(configForm.configType)) {
      maxValue = parseFloat(configInputMax.getValue().trim());
      if (isNaN(maxValue) || maxValue <= 0) {
        addLog("Invalid Max value. Please enter a positive number.", "error");
        configInputMax.clearValue(); screen.focusPush(configInputMax); safeRender();
        isSubmitting = false; return;
      }
    }
    if (isNaN(value) || value <= 0) {
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
  updateStatus();
  configForm.hide();
  dailyActivitySubMenu.show();
  setTimeout(() => {
    if (dailyActivitySubMenu.visible) {
      screen.focusPush(dailyActivitySubMenu);
      dailyActivitySubMenu.style.border.fg = "yellow";
      logBox.style.border.fg = "magenta";
      safeRender();
    }
    isSubmitting = false;
  }, 100);
});

configInput.key(["enter"], () => {
  if (rangeKeys.includes(configForm.configType)) {
    screen.focusPush(configInputMax);
  } else {
    configForm.submit();
  }
});

configInputMax.key(["enter"], () => configForm.submit());
configSubmitButton.on("press", () => configForm.submit());
configSubmitButton.on("click", () => { screen.focusPush(configSubmitButton); configForm.submit(); });

configForm.key(["escape"], () => {
  configForm.hide();
  dailyActivitySubMenu.show();
  setTimeout(() => {
    if (dailyActivitySubMenu.visible) {
      screen.focusPush(dailyActivitySubMenu);
      dailyActivitySubMenu.style.border.fg = "yellow";
      logBox.style.border.fg = "magenta";
      safeRender();
    }
  }, 100);
});

dailyActivitySubMenu.key(["escape"], () => {
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
});

screen.key(["escape", "q", "C-c"], () => {
  addLog("Exiting application", "info");
  clearInterval(statusInterval);
  process.exit(0);
});

async function initialize() {
  try {
    loadConfig();
    loadAccounts();
    loadProxies();
    updateStatus();
    await updateWallets();
    updateLogs();
    addLog(`You Can Change the Default Config on set manual Config Menu`, "warn");
    safeRender();
    menuBox.focus();
  } catch (error) {
    addLog(`Initialization error: ${error.message}`, "error");
  }
}

setTimeout(() => {
  adjustLayout();
  screen.on("resize", adjustLayout);
}, 100);

initialize();