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

  getPairToken(config = this.deps.getConfig()) {
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

  getParams() {
    const config = this.deps.getConfig();
    return {
      config,
      routerAddress: this.deps.routerAddress,
      tokenAddress: this.getPairToken(config),
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

  async addLiquidity() {
    const { provider, wallet } = this.getRuntime();
    const config = this.deps.getConfig();
    this.proof(`[LP] MENU PATH [10] Liquidity Pool Mode -> [1] Add Liquidity`);
    this.proof(`[LP] Add Liquidity starting pair=${config.lpPair} amountMode=${config.lpAmountMode}`);
    const result = await this.withRetry("Add Liquidity", () => addLiquidity({ provider, wallet, ...this.getParams() }));
    const ui = await this.fetchUiLp(wallet.address, result.poolAddress);
    this.proof("[LP] Add Liquidity proof", {
      txHash: result.txHash,
      receiptStatus: result.receiptStatus,
      routerAddress: result.routerAddress,
      poolAddress: result.poolAddress,
      tokenAmountDesired: result.tokenAmountDesired,
      ethAmountDesired: result.ethAmountDesired,
      tokenAmountDisplay: result.tokenAmountDisplay,
      ethAmountDisplay: result.ethAmountDisplay,
      expectedLiquidity: result.expectedLiquidity,
      amountTokenMin: result.amountTokenMin,
      amountEthMin: result.amountEthMin,
      beforeLpBalance: result.beforeLpBalance,
      afterLpBalance: result.afterLpBalance,
      liquidityDelta: result.liquidityDelta,
      ui
    });
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
    this.deps.log("[LP] Remove Liquidity starting ETH/DAI.", "info");
    return removeLiquidity({ provider, wallet, ...this.getParams() });
  }

  async status() {
    const { provider, wallet } = this.getRuntime();
    const params = this.getParams();
    const status = await getLpStatus({
      provider,
      walletAddress: wallet.address,
      routerAddress: params.routerAddress,
      tokenAddress: params.tokenAddress
    });
    this.deps.log(`[LP] Status pair=${status.pairAddress} lp=${status.lpBalance.toString()} total=${status.totalSupply.toString()}`, status.exists ? "success" : "warn");
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
