import { ethers } from "ethers";
import fs from "fs";
import { addLiquidity, getLpStatus, removeLiquidity } from "./lpExecutor.js";

const LP_PROOF_FILE = "lp-proof.log";

export class LpManager {
  constructor(deps) {
    this.deps = deps;
    this.autoRunning = false;
    this.stopRequested = false;
    this.autoRemoveTimer = null;
  }

  getRuntime() {
    const { accounts, selectedWalletIndex, proxies, getProvider, rpcUrl, chainId } = this.deps;
    if (!accounts.length) throw new Error("No wallet loaded for LP mode");
    const proxyUrl = proxies[selectedWalletIndex % proxies.length] || null;
    const provider = getProvider(rpcUrl, chainId, proxyUrl);
    const wallet = new ethers.Wallet(accounts[selectedWalletIndex].privateKey, provider);
    return { provider, wallet };
  }

  /**
   * Resolve the pool pair token address from config.
   * For the new Nemesis ecosystem, this is the collateral token (e.g., DAI).
   */
  getPairTokenAddress(config = this.deps.getConfig()) {
    const pair = String(config.lpPair || "ETH/DAI").toUpperCase();
    const tokenB = String(config.lpTokenB || pair.split("/")[1] || "DAI").toUpperCase();
    if (pair === "ETH/DAI" || tokenB === "DAI") return this.deps.tokenMap.DAI;
    if (pair === "ETH/USDC" || tokenB === "USDC") return this.deps.tokenMap.USDC;
    if (pair === "CUSTOM" || pair.startsWith("ETH/CUSTOM") || tokenB === "CUSTOM") {
      if (!ethers.isAddress(config.lpCustomTokenAddress)) throw new Error("LP custom pair requires lpCustomTokenAddress");
      return config.lpCustomTokenAddress;
    }
    throw new Error(`Unsupported LP pair ${config.lpPair}. Use ETH/DAI, ETH/USDC, or CUSTOM with lpCustomTokenAddress.`);
  }

  /**
   * Resolve pool and manager addresses for the given token pair.
   * Uses the Nemesis Factory to look up the pool, then the manager.
   */
  async resolvePoolAndManager(provider, tokenAAddress, tokenBAddress) {
    const FACTORY_ABI = [
      "function getPool(address tokenA,address tokenB) view returns (address)",
      "function getManager(address pool) view returns (address)"
    ];
    const factoryAddress = this.deps.leveragedFactory;
    if (!factoryAddress) throw new Error("No factory address configured");

    const [tokenA, tokenB] = [tokenAAddress, tokenBAddress].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    const factory = new ethers.Contract(factoryAddress, FACTORY_ABI, provider);
    const pool = await factory.getPool(tokenA, tokenB);
    if (!pool || pool === ethers.ZeroAddress) throw new Error(`No pool found for ${tokenA}/${tokenB}`);
    const manager = await factory.getManager(pool);
    if (!manager || manager === ethers.ZeroAddress) throw new Error(`No manager found for pool ${pool}`);
    return { pool, manager, factoryAddress };
  }

  getParams() {
    const config = this.deps.getConfig();
    return {
      config,
      chainId: this.deps.chainId,
      getFeeParams: this.deps.getFeeParams,
      getNextNonce: this.deps.getNextNonce,
      log: this.deps.log
    };
  }

  proof(message, payload = null) {
    const line = `[${new Date().toISOString()}] ${message}${payload ? ` ${JSON.stringify(payload)}` : ""}`;
    fs.appendFileSync(LP_PROOF_FILE, `${line}\n`);
    this.deps.log(message, "info");
  }

  async fetchUiLp(walletAddress, poolAddress) {
    try {
      const query = "query($user:String!){ _meta { block { number timestamp } } userLiquidityPositions(where:{user:$user}, first:20, orderBy:updatedAtTimestamp, orderDirection:desc){ id lpBalance amount0 amount1 status updatedAtTimestamp pool { address } } }";
      const response = await fetch("https://nemesis.trade/api/subgraph", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query, variables: { user: walletAddress.toLowerCase() } })
      });
      const json = await response.json();
      const position = json.data?.userLiquidityPositions?.find(item => item.pool.address.toLowerCase() === poolAddress.toLowerCase()) || null;
      return { block: json.data?._meta?.block, position };
    } catch (error) {
      return { error: error.message };
    }
  }

  async withRetry(label, operation) {
    const config = this.deps.getConfig();
    const attempts = Math.max(1, Number(config.lpRetryAttempts) || 1);
    const delayMs = Math.max(0, Number(config.lpRetryDelaySeconds) || 0) * 1000;
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        this.deps.log(`[LP] ${label} attempt ${attempt}/${attempts}`, "info");
        return await operation(attempt);
      } catch (error) {
        lastError = error;
        const reason = error?.shortMessage || error?.reason || error?.info?.error?.message || error?.message || String(error);
        this.proof(`[LP] ${label} failed attempt=${attempt} reason=${reason}`);
        if (attempt < attempts && delayMs > 0) await this.deps.sleep(delayMs);
      }
    }
    throw lastError;
  }

  /**
   * Add Liquidity using the Nemesis Manager contract.
   * Resolves pool/manager from Factory, then calls the unified addLiquidity function.
   */
  async addLiquidity() {
    const { provider, wallet } = this.getRuntime();
    const config = this.deps.getConfig();
    const WETH_ADDRESS = this.deps.tokenMap?.WETH || "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9";

    this.proof(`[LP] MENU PATH [10] Liquidity Pool Mode -> [1] Add Liquidity`);
    this.proof(`[LP] Add Liquidity starting pair=${config.lpPair} amountMode=${config.lpAmountMode}`);

    // Resolve pair token address (e.g., DAI)
    const pairTokenAddress = this.getPairTokenAddress(config);
    this.deps.log(`[LP] Resolving pool: WETH (${WETH_ADDRESS}) / pairToken (${pairTokenAddress})`, "info");

    // Resolve pool and manager from the Nemesis Factory
    const { pool, manager } = await this.resolvePoolAndManager(provider, WETH_ADDRESS, pairTokenAddress);
    this.deps.log(`[LP] Pool=${pool} Manager=${manager}`, "info");

    // Run the unified addLiquidity function
    const result = await this.withRetry("Add Liquidity", () =>
      addLiquidity({
        provider,
        wallet,
        config,
        managerAddress: manager,
        poolAddress: pool,
        tokenAAddress: WETH_ADDRESS,
        tokenBAddress: pairTokenAddress,
        ...this.getParams()
      })
    );

    // Fetch UI position
    const ui = await this.fetchUiLp(wallet.address, pool);
    this.proof("[LP] Add Liquidity proof", {
      txHash: result.txHash,
      receiptStatus: result.receiptStatus,
      managerAddress: result.managerAddress,
      poolAddress: result.poolAddress,
      tokenA: result.tokenA,
      tokenB: result.tokenB,
      amountADesired: result.amountADesired,
      amountBDesired: result.amountBDesired,
      amountADesiredDisplay: result.amountADesiredDisplay,
      amountBDesiredDisplay: result.amountBDesiredDisplay,
      lpBalanceBefore: result.lpBalanceBefore,
      lpBalanceAfter: result.lpBalanceAfter,
      lpDelta: result.lpDelta,
      lpTokensReceived: result.lpTokensReceived,
      ui
    });

    // Auto-remove if configured
    if (Number(config.lpAutoRemoveMinutes) > 0) {
      if (this.autoRemoveTimer) clearTimeout(this.autoRemoveTimer);
      this.autoRemoveTimer = setTimeout(() => {
        this.removeLiquidity().catch(error => this.deps.log(`[LP] Auto remove failed: ${error.message}`, "error"));
      }, Number(config.lpAutoRemoveMinutes) * 60 * 1000);
      this.deps.log(`[LP] Auto remove scheduled in ${config.lpAutoRemoveMinutes} minutes.`, "warn");
    }

    return result;
  }

  async removeLiquidity() {
    const { provider, wallet } = this.getRuntime();
    const config = this.deps.getConfig();
    const WETH_ADDRESS = this.deps.tokenMap?.WETH || "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9";
    const pairTokenAddress = this.getPairTokenAddress(config);
    const { pool, manager } = await this.resolvePoolAndManager(provider, WETH_ADDRESS, pairTokenAddress);

    this.deps.log("[LP] Remove Liquidity starting.", "info");
    return removeLiquidity({
      provider, wallet, config,
      managerAddress: manager,
      poolAddress: pool,
      ...this.getParams()
    });
  }

  async status() {
    const { provider, wallet } = this.getRuntime();
    const config = this.deps.getConfig();
    const WETH_ADDRESS = this.deps.tokenMap?.WETH || "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9";
    const pairTokenAddress = this.getPairTokenAddress(config);
    const { pool } = await this.resolvePoolAndManager(provider, WETH_ADDRESS, pairTokenAddress);

    const status = await getLpStatus({ provider, walletAddress: wallet.address, poolAddress: pool });
    this.deps.log(`[LP] Status pool=${status.poolAddress} lp=${status.lpBalance.toString()} total=${status.totalSupply.toString()}`, status.exists ? "success" : "warn");
    return status;
  }

  stopAutoCycle() {
    this.stopRequested = true;
    this.autoRunning = false;
    if (this.autoRemoveTimer) clearTimeout(this.autoRemoveTimer);
    this.autoRemoveTimer = null;
  }

  async autoCycle() {
    if (this.autoRunning) {
      this.deps.log("[LP] Auto LP Cycle already running.", "warn");
      return;
    }
    this.autoRunning = true;
    this.stopRequested = false;
    const config = this.deps.getConfig();
    const cycles = Math.max(1, Number(config.lpCycles) || 1);
    this.deps.log(`[LP] Auto LP Cycle started cycles=${cycles}.`, "info");

    try {
      for (let i = 0; i < cycles && !this.stopRequested; i++) {
        this.deps.log(`[LP] Cycle ${i + 1}/${cycles}: add.`, "info");
        await this.addLiquidity();
        await this.deps.sleep(Math.max(0, Number(config.lpWaitMinutes) || 0) * 60 * 1000);
        if (this.stopRequested) break;
        this.deps.log(`[LP] Cycle ${i + 1}/${cycles}: remove.`, "info");
        await this.removeLiquidity();
        if (i < cycles - 1) await this.deps.sleep(Math.max(0, Number(config.lpCooldownMinutes) || 0) * 60 * 1000);
      }
      this.deps.log("[LP] Auto LP Cycle finished.", "success");
    } finally {
      this.autoRunning = false;
    }
  }
}
