import { ethers } from "ethers";
import { addLiquidity, getLpStatus, removeLiquidity } from "./lpExecutor.js";

export class LpManager {
  constructor(deps) {
    this.deps = deps;
    this.autoRunning = false;
    this.stopRequested = false;
  }

  getRuntime() {
    const { accounts, selectedWalletIndex, proxies, getProvider, rpcUrl, chainId } = this.deps;
    if (!accounts.length) throw new Error("No wallet loaded for LP mode");
    const proxyUrl = proxies[selectedWalletIndex % proxies.length] || null;
    const provider = getProvider(rpcUrl, chainId, proxyUrl);
    const wallet = new ethers.Wallet(accounts[selectedWalletIndex].privateKey, provider);
    return { provider, wallet };
  }

  getParams() {
    return {
      config: this.deps.getConfig(),
      routerAddress: this.deps.routerAddress,
      tokenAddress: this.deps.daiAddress,
      tokenDecimals: 18,
      chainId: this.deps.chainId,
      getFeeParams: this.deps.getFeeParams,
      getNextNonce: this.deps.getNextNonce,
      log: this.deps.log
    };
  }

  async addLiquidity() {
    const { provider, wallet } = this.getRuntime();
    this.deps.log("[LP] Add Liquidity starting ETH/DAI.", "info");
    return addLiquidity({ provider, wallet, ...this.getParams() });
  }

  async removeLiquidity() {
    const { provider, wallet } = this.getRuntime();
    this.deps.log("[LP] Remove Liquidity starting ETH/DAI.", "info");
    return removeLiquidity({ provider, wallet, ...this.getParams() });
  }

  async status() {
    const { provider, wallet } = this.getRuntime();
    const status = await getLpStatus({
      provider,
      walletAddress: wallet.address,
      routerAddress: this.deps.routerAddress,
      tokenAddress: this.deps.daiAddress
    });
    this.deps.log(`[LP] Status pair=${status.pairAddress} lp=${status.lpBalance.toString()} total=${status.totalSupply.toString()}`, status.exists ? "success" : "warn");
    return status;
  }

  stopAutoCycle() {
    this.stopRequested = true;
    this.autoRunning = false;
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
