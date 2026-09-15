import { ethers } from "ethers";

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TOKEN INVENTORY & ETH SPENDING GUARD
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Purpose: Preserve ETH. Bot should trade with accumulated tokens (token→token),
 *          not burn ETH on every swap. ETH is only for GAS + collateral when needed.
 *
 * Features:
 *  1. ETH Spending Guard — per-tx, per-session, gas reserve, total exposure limits
 *  2. Token Inventory — min/target/max per token, prefer token→token over ETH→token
 *  3. Smart Source Selection — pick the best swap source from wallet balances
 *  4. Pre-swap logging — full details before every swap
 * ═══════════════════════════════════════════════════════════════════════════════
 */

// ─── Default Inventory Targets ───
// Each token: { minimum, target, maximum }
// minimum  = below this, bot WILL buy (even with ETH as last resort)
// target   = bot tries to maintain this level
// maximum  = above this, bot avoids buying more, sells/swaps away
const DEFAULT_INVENTORY = {
  ETH:     { minimum: 0.005,    target: 0.01,     maximum: 0.05,     decimals: 18, type: "native" },
  WETH:    { minimum: 0.005,    target: 0.01,     maximum: 0.05,     decimals: 18, type: "erc20" },
  USDC:    { minimum: 50,       target: 500,       maximum: 2000,     decimals: 6,  type: "erc20" },
  USDT:    { minimum: 50,       target: 500,       maximum: 2000,     decimals: 6,  type: "erc20" },
  DAI:     { minimum: 50,       target: 500,       maximum: 2000,     decimals: 6,  type: "erc20" },
  NEMESIS: { minimum: 1,        target: 10,        maximum: 100,      decimals: 6,  type: "erc20" },
  UNI:     { minimum: 0.1,      target: 5,         maximum: 50,       decimals: 6,  type: "erc20" },
  LINK:    { minimum: 0.1,      target: 2,         maximum: 20,       decimals: 6,  type: "erc20" },
};

// ─── Default ETH Spending Guard Limits ───
const DEFAULT_ETH_GUARD = {
  // Maximum ETH value in a single swap transaction (e.g., 0.02 ETH per tx)
  MAX_ETH_SWAP_PER_TX: 0.02,
  // Maximum total ETH value across all swaps in this session
  MAX_ETH_SWAP_PER_SESSION: 0.1,
  // Minimum ETH to always keep for gas (never swap below this)
  MIN_ETH_GAS_RESERVE: 0.003,
  // Maximum total ETH exposure (swap value + gas combined)
  MAX_TOTAL_ETH_EXPOSURE: 0.15,
  // If ETH balance drops below this, block ALL ETH→token swaps entirely
  ETH_BLOCK_THRESHOLD: 0.005,
  // Minimum token balance to be considered "has enough" (prevents dust swaps)
  MIN_TOKEN_DUST: 0.001,
};

// ═══════════════════════════════════════════════════════════════════════════════
//  Session ETH Tracker — tracks all ETH spent this session
// ═══════════════════════════════════════════════════════════════════════════════

class EthSessionTracker {
  constructor(limits = {}) {
    this.limits = { ...DEFAULT_ETH_GUARD, ...limits };
    this.totalSwapValueETH = 0;   // ETH value of tokens swapped (as swap input)
    this.totalGasSpentETH = 0;    // ETH spent on gas fees
    this.txCount = 0;
    this.history = [];             // per-swap history
    this.startTime = Date.now();
  }

  /**
   * Record an ETH→Token swap (ETH spent as swap value).
   */
  recordEthSwap(amountETH) {
    this.totalSwapValueETH += amountETH;
    this.txCount++;
  }

  /**
   * Record gas spent on any transaction (in ETH).
   */
  recordGas(gasUsed, gasPrice) {
    const gasETH = Number(gasUsed * gasPrice) / 1e18;
    this.totalGasSpentETH += gasETH;
  }

  /**
   * Add entry to swap history.
   */
  addHistory(entry) {
    this.history.push({
      timestamp: Date.now(),
      ...entry,
    });
  }

  /**
   * Total ETH spent this session = swap value + gas.
   */
  get totalSpent() {
    return this.totalSwapValueETH + this.totalGasSpentETH;
  }

  /**
   * Check if a new ETH swap of amountETH would exceed any guard limit.
   * Returns { allowed, reason }.
   */
  checkSwapLimit(amountETH) {
    const L = this.limits;

    // Per-transaction limit
    if (amountETH > L.MAX_ETH_SWAP_PER_TX) {
      return {
        allowed: false,
        reason: `Per-TX limit: ${amountETH.toFixed(6)} ETH > max ${L.MAX_ETH_SWAP_PER_TX} ETH`,
      };
    }

    // Per-session limit (swap value)
    if (this.totalSwapValueETH + amountETH > L.MAX_ETH_SWAP_PER_SESSION) {
      return {
        allowed: false,
        reason: `Session swap limit: ${(this.totalSwapValueETH + amountETH).toFixed(6)} > max ${L.MAX_ETH_SWAP_PER_SESSION} ETH`,
      };
    }

    // Total exposure (swap + gas)
    if (this.totalSpent + amountETH > L.MAX_TOTAL_ETH_EXPOSURE) {
      return {
        allowed: false,
        reason: `Total exposure: ${(this.totalSpent + amountETH).toFixed(6)} > max ${L.MAX_TOTAL_ETH_EXPOSURE} ETH`,
      };
    }

    return { allowed: true, reason: null };
  }

  /**
   * Check if ETH balance is above the gas reserve after a potential swap.
   */
  checkGasReserve(ethBalance, amountETH) {
    const remaining = ethBalance - amountETH;
    if (remaining < this.limits.MIN_ETH_GAS_RESERVE) {
      return {
        allowed: false,
        reason: `Gas reserve: ${remaining.toFixed(6)} ETH remaining < min ${this.limits.MIN_ETH_GAS_RESERVE} ETH`,
      };
    }
    return { allowed: true, reason: null };
  }

  /**
   * Check if ETH balance is above the block threshold.
   */
  checkBlockThreshold(ethBalance) {
    if (ethBalance < this.limits.ETH_BLOCK_THRESHOLD) {
      return {
        blocked: true,
        reason: `ETH balance ${ethBalance.toFixed(6)} < block threshold ${this.limits.ETH_BLOCK_THRESHOLD} ETH — ALL ETH swaps BLOCKED`,
      };
    }
    return { blocked: false, reason: null };
  }

  /**
   * Get a summary string for logging.
   */
  getSummary() {
    return [
      `ETH SPENT AS SWAP VALUE: ${this.totalSwapValueETH.toFixed(6)} ETH`,
      `ETH SPENT AS GAS:       ${this.totalGasSpentETH.toFixed(8)} ETH`,
      `TOTAL SESSION ETH SPENT: ${this.totalSpent.toFixed(6)} ETH`,
      `Swap TX count:           ${this.txCount}`,
      `Session duration:        ${Math.floor((Date.now() - this.startTime) / 60000)} min`,
    ].join("\n");
  }

  reset() {
    this.totalSwapValueETH = 0;
    this.totalGasSpentETH = 0;
    this.txCount = 0;
    this.history = [];
    this.startTime = Date.now();
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Token Inventory Manager
// ═══════════════════════════════════════════════════════════════════════════════

class TokenInventory {
  constructor(config = {}) {
    this.targets = { ...DEFAULT_INVENTORY };
    this.ethGuard = new EthSessionTracker(config.ethGuard || {});
    this.balances = {};
    this.lastRefresh = 0;
    this.refreshIntervalMs = 30_000; // refresh balances every 30s
  }

  /**
   * Refresh all token balances from on-chain data.
   * @param {ethers.Provider} provider
   * @param {string} walletAddress
   * @param {object} tokenMap — { symbol: { address, decimals } }
   * @param {Function} log — logging function
   */
  async refreshBalances(provider, walletAddress, tokenMap, log = () => {}) {
    const now = Date.now();
    if (now - this.lastRefresh < this.refreshIntervalMs && Object.keys(this.balances).length > 0) {
      return this.balances;
    }

    const ERC20_ABI = [
      "function balanceOf(address account) view returns (uint256)",
      "function decimals() view returns (uint8)",
    ];

    const balances = {};

    // ETH balance
    try {
      const ethBal = await provider.getBalance(walletAddress);
      balances.ETH = {
        raw: ethBal,
        float: Number(ethBal) / 1e18,
        decimals: 18,
      };
    } catch (e) {
      log(`[INVENTORY] Failed to fetch ETH balance: ${e.message}`, "warn");
      balances.ETH = { raw: 0n, float: 0, decimals: 18 };
    }

    // ERC20 balances
    const tokensToFetch = new Map();
    const seen = new Set();
    for (const [sym, info] of Object.entries(tokenMap)) {
      if (!info || !info.address) continue;
      if (sym === "WETH" || sym === "ETH") continue; // already fetched
      const addrLower = info.address.toLowerCase();
      if (seen.has(addrLower)) continue;
      seen.add(addrLower);
      tokensToFetch.set(sym, info);
    }

    for (const [sym, info] of tokensToFetch) {
      try {
        const contract = new ethers.Contract(info.address, ERC20_ABI, provider);
        const bal = await contract.balanceOf(walletAddress);
        balances[sym] = {
          raw: bal,
          float: Number(bal) / Math.pow(10, info.decimals || 6),
          decimals: info.decimals || 6,
        };
      } catch (e) {
        log(`[INVENTORY] Failed to fetch ${sym} balance: ${e.message}`, "warn");
        balances[sym] = { raw: 0n, float: 0, decimals: info.decimals || 6 };
      }
    }

    this.balances = balances;
    this.lastRefresh = now;
    return balances;
  }

  /**
   * Get the status of a token relative to its inventory targets.
   * Returns: "deficit" | "ok" | "surplus"
   */
  getTokenStatus(symbol) {
    const bal = this.balances[symbol];
    const target = this.targets[symbol];
    if (!bal || !target) return "unknown";

    if (bal.float < target.minimum) return "deficit";
    if (bal.float > target.maximum) return "surplus";
    return "ok";
  }

  /**
   * Get tokens in deficit (below minimum).
   */
  getDeficitTokens() {
    const deficits = [];
    for (const [sym, target] of Object.entries(this.targets)) {
      if (sym === "ETH" || sym === "WETH") continue; // ETH handled separately
      const status = this.getTokenStatus(sym);
      if (status === "deficit") {
        const bal = this.balances[sym];
        deficits.push({
          symbol: sym,
          balance: bal ? bal.float : 0,
          minimum: target.minimum,
          target: target.target,
          deficit: target.minimum - (bal ? bal.float : 0),
        });
      }
    }
    return deficits.sort((a, b) => b.deficit - a.deficit);
  }

  /**
   * Get tokens in surplus (above maximum).
   */
  getSurplusTokens() {
    const surplus = [];
    for (const [sym, target] of Object.entries(this.targets)) {
      if (sym === "ETH" || sym === "WETH") continue;
      const status = this.getTokenStatus(sym);
      if (status === "surplus") {
        const bal = this.balances[sym];
        surplus.push({
          symbol: sym,
          balance: bal ? bal.float : 0,
          maximum: target.maximum,
          target: target.target,
          surplus: (bal ? bal.float : 0) - target.maximum,
        });
      }
    }
    return surplus.sort((a, b) => b.surplus - a.surplus);
  }

  /**
   * Get tokens with "ok" balance (above minimum, below maximum).
   */
  getTradeableTokens() {
    const tradeable = [];
    for (const [sym, target] of Object.entries(this.targets)) {
      if (sym === "ETH" || sym === "WETH") continue;
      const status = this.getTokenStatus(sym);
      if (status === "ok" || status === "surplus") {
        const bal = this.balances[sym];
        if (bal && bal.float >= DEFAULT_ETH_GUARD.MIN_TOKEN_DUST) {
          tradeable.push({
            symbol: sym,
            balance: bal.float,
            status,
          });
        }
      }
    }
    return tradeable.sort((a, b) => b.balance - a.balance);
  }

  /**
   * Check if a specific token has enough balance to use as swap source.
   */
  canUseAsSource(symbol, amountFloat) {
    const bal = this.balances[symbol];
    if (!bal) return false;
    const target = this.targets[symbol];
    // If using this token would drop it below minimum, don't use it
    // (unless it's already in surplus)
    const status = this.getTokenStatus(symbol);
    if (status === "surplus") return bal.float >= amountFloat;
    if (status === "ok") {
      return bal.float - amountFloat >= (target ? target.minimum : 0);
    }
    // deficit — don't use as source
    return false;
  }

  /**
   * Check if ETH can be used for a swap.
   * Enforces: gas reserve, block threshold, per-tx limit, per-session limit.
   */
  canUseEthAsSource(amountETH, ethBalance) {
    // Block threshold check
    const blockCheck = this.ethGuard.checkBlockThreshold(ethBalance);
    if (blockCheck.blocked) {
      return { allowed: false, reason: blockCheck.reason };
    }

    // Gas reserve check
    const gasCheck = this.ethGuard.checkGasReserve(ethBalance, amountETH);
    if (!gasCheck.allowed) {
      return { allowed: false, reason: gasCheck.reason };
    }

    // Session limit check
    const limitCheck = this.ethGuard.checkSwapLimit(amountETH);
    if (!limitCheck.allowed) {
      return { allowed: false, reason: limitCheck.reason };
    }

    return { allowed: true, reason: null };
  }

  /**
   * Log inventory status.
   */
  logStatus(log = () => {}) {
    log("[INVENTORY] ═══ Token Inventory Status ═══", "info");
    for (const [sym, target] of Object.entries(this.targets)) {
      const bal = this.balances[sym];
      const status = this.getTokenStatus(sym);
      const balStr = bal ? bal.float.toFixed(target.decimals >= 18 ? 6 : 2) : "?";
      const icon = status === "deficit" ? "🔴" : status === "surplus" ? "🟡" : "🟢";
      log(`  ${icon} ${sym.padEnd(8)} bal=${balStr.padStart(10)} min=${target.minimum} target=${target.target} max=${target.maximum} [${status}]`, status === "deficit" ? "warn" : "info");
    }
    log("[INVENTORY] ═══════════════════════════════", "info");
    log(`[INVENTORY] ${this.ethGuard.getSummary()}`, "info");
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SWAP SOURCE SELECTOR — the brain of the inventory-aware swap engine
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Select the best swap source for acquiring a target token.
 *
 * Priority order:
 *  1. TOKEN → TOKEN (use surplus/ok tokens, never ETH)
 *  2. TOKEN → TOKEN (use any token above minimum)
 *  3. ETH → TOKEN  (only as LAST RESORT, with guard checks)
 *  4. Skip (nothing available)
 *
 * @param {TokenInventory} inventory
 * @param {string} targetSymbol — the token we want to acquire
 * @param {number} targetAmount — approximate amount desired (in token units)
 * @param {object} allPairs — all supported swap pairs [{from, to}]
 * @param {Function} log
 * @returns {{ source, sourceAmount, isEthSource, reason } | null}
 */
function selectSwapSource(inventory, targetSymbol, targetAmount, allPairs, log = () => {}) {
  const targetStatus = inventory.getTokenStatus(targetSymbol);

  // If we already have enough of the target, don't buy more
  if (targetStatus === "surplus") {
    log(`[INVENTORY] SKIP: ${targetSymbol} already at surplus level`, "info");
    return null;
  }

  // ── Strategy 1: Find a surplus token to swap FROM ──
  const surplusTokens = inventory.getSurplusTokens();
  for (const surplus of surplusTokens) {
    if (surplus.symbol === targetSymbol) continue;
    // Check if a swap pair exists: surplus → target
    const pairExists = allPairs.some(
      p => p.from === surplus.symbol && p.to === targetSymbol
    );
    if (pairExists && inventory.canUseAsSource(surplus.symbol, targetAmount)) {
      log(`[INVENTORY] SOURCE: ${surplus.symbol} (surplus ${surplus.balance.toFixed(2)}) → ${targetSymbol}`, "info");
      return {
        source: surplus.symbol,
        sourceAmount: targetAmount,
        isEthSource: false,
        reason: `Using surplus ${surplus.symbol} (${surplus.balance.toFixed(2)})`,
      };
    }
  }

  // ── Strategy 2: Find any "ok" token to swap FROM ──
  const tradeableTokens = inventory.getTradeableTokens();
  for (const token of tradeableTokens) {
    if (token.symbol === targetSymbol) continue;
    if (token.status !== "ok") continue; // only "ok", not "surplus" (already tried)
    const pairExists = allPairs.some(
      p => p.from === token.symbol && p.to === targetSymbol
    );
    if (pairExists && inventory.canUseAsSource(token.symbol, targetAmount)) {
      log(`[INVENTORY] SOURCE: ${token.symbol} (ok ${token.balance.toFixed(2)}) → ${targetSymbol}`, "info");
      return {
        source: token.symbol,
        sourceAmount: targetAmount,
        isEthSource: false,
        reason: `Using available ${token.symbol} (${token.balance.toFixed(2)})`,
      };
    }
  }

  // ── Strategy 3: ETH → TOKEN as LAST RESORT ──
  const ethBalance = inventory.balances.ETH ? inventory.balances.ETH.float : 0;
  // Rough ETH equivalent: assume 1 token ≈ 0.0001 ETH for small token amounts
  const ethEquiv = Math.min(targetAmount * 0.0001, 0.01);
  const ethCheck = inventory.canUseEthAsSource(ethEquiv, ethBalance);
  if (ethCheck.allowed) {
    // Check deficit: only use ETH if token is in deficit
    if (targetStatus === "deficit") {
      log(`[INVENTORY] LAST RESORT: ETH → ${targetSymbol} (${targetStatus} below minimum)`, "warn");
      return {
        source: "ETH",
        sourceAmount: ethEquiv,
        isEthSource: true,
        reason: `LAST RESORT: ${targetSymbol} below minimum, no token sources available`,
      };
    }
  } else {
    log(`[INVENTORY] ETH source BLOCKED: ${ethCheck.reason}`, "warn");
  }

  // ── Strategy 4: Skip ──
  log(`[INVENTORY] SKIP: No viable source for ${targetSymbol} (ETH blocked or insufficient)`, "warn");
  return null;
}

/**
 * Generate inventory-aware swap pairs for the cyclic engine.
 * Instead of random ETH↔Token pairs, generates:
 *  1. Token→Token pairs (preferred)
 *  2. ETH→Token pairs (only for deficit tokens, with guard)
 *  3. Token→ETH pairs (to rebalance surplus tokens)
 *
 * @param {TokenInventory} inventory
 * @param {Array} allPairs — all discovered pairs [{from, to}]
 * @param {Function} log
 * @returns {Array} pairs sorted by priority
 */
function generateInventoryAwarePairs(inventory, allPairs, log = () => {}) {
  const pairs = [];
  const deficits = inventory.getDeficitTokens();
  const surplus = inventory.getSurplusTokens();
  const tradeable = inventory.getTradeableTokens();

  // ── Priority 1: Token→Token swaps (surplus → deficit or ok) ──
  for (const s of surplus) {
    for (const token of [...deficits, ...tradeable]) {
      if (s.symbol === token.symbol) continue;
      const pairExists = allPairs.some(
        p => p.from === s.symbol && p.to === token.symbol
      );
      if (pairExists) {
        pairs.push({
          from: s.symbol,
          to: token.symbol,
          priority: 1,
          reason: `rebalance surplus ${s.symbol}`,
        });
      }
    }
  }

  // ── Priority 2: Token→Token swaps (ok tokens → deficit tokens) ──
  for (const token of tradeable) {
    if (token.status !== "ok") continue;
    for (const d of deficits) {
      if (token.symbol === d.symbol) continue;
      const pairExists = allPairs.some(
        p => p.from === token.symbol && p.to === d.symbol
      );
      if (pairExists) {
        pairs.push({
          from: token.symbol,
          to: d.symbol,
          priority: 2,
          reason: `fill deficit ${d.symbol} from ${token.symbol}`,
        });
      }
    }
  }

  // ── Priority 3: Token→ETH swaps — ONLY to replenish gas reserve (NOT for surplus rebalance) ──
  // We NEVER auto-convert tokens back to ETH for rebalancing purposes.
  // Only if ETH balance < MIN_ETH_GAS_RESERVE, a surplus token → ETH swap is allowed
  // to top up gas reserves.
  const ethBalance = inventory.balances.ETH ? inventory.balances.ETH.float : 0;
  const gasReserve = inventory.ethGuard.limits.MIN_ETH_GAS_RESERVE;
  const ethBelowGasReserve = ethBalance < gasReserve;

  if (ethBelowGasReserve && surplus.length > 0) {
    // Only allow the largest surplus token → ETH to replenish gas
    const biggestSurplus = surplus[0];
    const pairExists = allPairs.some(
      p => p.from === biggestSurplus.symbol && p.to === "ETH"
    );
    if (pairExists) {
      pairs.push({
        from: biggestSurplus.symbol,
        to: "ETH",
        priority: 3,
        reason: `EMERGENCY: replenish gas reserve (ETH ${ethBalance.toFixed(6)} < ${gasReserve} needed)`,
      });
    }
  }
  // NOTE: Under normal conditions, Token→ETH is NOT generated.
  // The bot should NOT convert accumulated tokens back into ETH.

  // ── Priority 4: ETH→deficit tokens (ABSOLUTE LAST RESORT only) ──
  const ethCheck = inventory.ethGuard.checkBlockThreshold(ethBalance);
  if (!ethCheck.blocked && deficits.length > 0) {
    for (const d of deficits) {
      const pairExists = allPairs.some(
        p => p.from === "ETH" && p.to === d.symbol
      );
      if (pairExists) {
        pairs.push({
          from: "ETH",
          to: d.symbol,
          priority: 4,
          reason: `fill deficit ${d.symbol} (last resort)`,
        });
      }
    }
  }

  // ── Priority 5: Token→Token activity swaps between tradeable tokens ──
  // These keep the bot active without touching ETH at all
  for (let i = 0; i < tradeable.length; i++) {
    for (let j = 0; j < tradeable.length; j++) {
      if (i === j) continue;
      const a = tradeable[i], b = tradeable[j];
      const pairExists = allPairs.some(
        p => p.from === a.symbol && p.to === b.symbol
      );
      if (pairExists) {
        const alreadyAdded = pairs.some(
          p => p.from === a.symbol && p.to === b.symbol
        );
        if (!alreadyAdded) {
          pairs.push({
            from: a.symbol,
            to: b.symbol,
            priority: 5,
            reason: `activity swap ${a.symbol}→${b.symbol}`,
          });
        }
      }
    }
  }

  log(`[INVENTORY] Generated ${pairs.length} inventory-aware pairs (${deficits.length} deficit, ${surplus.length} surplus, ${tradeable.length} tradeable)`, "info");

  // Sort by priority
  return pairs.sort((a, b) => a.priority - b.priority);
}

/**
 * Log pre-swap details.
 * Called before every swap with all relevant info.
 */
function logSwapDetails({ source, dest, amountIn, amountOutExpected, priceImpact, slippage, deployment, pool, router, ethSpentSwap, ethSpentGas, totalSessionEth }, log = () => {}) {
  log("┌──────────────── PRE-SWAP DETAILS ────────────────┐", "info");
  log(`│ SOURCE TOKEN:      ${String(source).padEnd(30)}│`, "info");
  log(`│ DESTINATION TOKEN: ${String(dest).padEnd(30)}│`, "info");
  log(`│ AMOUNT IN:         ${String(amountIn).padEnd(30)}│`, "info");
  log(`│ AMOUNT OUT EXPECT: ${String(amountOutExpected).padEnd(30)}│`, "info");
  log(`│ PRICE IMPACT:      ${String(priceImpact || "N/A").padEnd(30)}│`, "info");
  log(`│ SLIPPAGE:          ${String(slippage || "N/A").padEnd(30)}│`, "info");
  log(`│ DEPLOYMENT:        ${String(deployment || "N/A").padEnd(30)}│`, "info");
  log(`│ POOL:              ${String(pool || "N/A").padEnd(30)}│`, "info");
  log(`│ ROUTER:            ${String(router || "N/A").padEnd(30)}│`, "info");
  log("├──────────────── ETH SPENDING ────────────────────┤", "info");
  log(`│ ETH SPENT AS SWAP VALUE: ${String(ethSpentSwap || "0").padEnd(25)}│`, "warn");
  log(`│ ETH SPENT AS GAS:        ${String(ethSpentGas || "0").padEnd(25)}│`, "warn");
  log(`│ TOTAL SESSION ETH SPENT: ${String(totalSessionEth || "0").padEnd(25)}│`, "warn");
  log("└──────────────────────────────────────────────────┘", "info");
}

// ═══════════════════════════════════════════════════════════════════════════════
//  EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
//  BALANCE MAP — maps token symbols to their addresses and decimals
// ═══════════════════════════════════════════════════════════════════════════════

const BALANCE_MAP = {
  ETH:     { symbol: "ETH",  decimals: 18 },
  WETH:    { symbol: "WETH", decimals: 18 },
  USDC:    { symbol: "USDC", decimals: 6 },
  USDT:    { symbol: "USDT", decimals: 6 },
};

// ═══════════════════════════════════════════════════════════════════════════════
//  INVENTORY-AWARE COLLATERAL CALCULATOR
//  Used by Full Auto to determine if swap is needed
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Calculate how much of a collateral token needs to be swapped.
 *
 * @param {Object} opts
 * @param {bigint} opts.balance       — current collateral balance
 * @param {bigint} opts.required      — minimum required for position open
 * @param {bigint} opts.targetReserve — desired inventory reserve level
 * @param {number} opts.decimals      — token decimals (6 for USDT/USDC, 18 for WETH)
 * @param {string} opts.sym           — token symbol for logging
 * @param {Function} opts.log         — logging function
 *
 * @returns {{ action: string, swapAmount: bigint, reason: string }}
 *   action = "none" | "critical" | "topup"
 */
function calculateInventoryDeficit({ balance, required, targetReserve, decimals, sym, log = () => {} }) {
  if (balance >= targetReserve) {
    return { action: "none", swapAmount: 0n, reason: `${sym} balance ${formatUnits(balance, decimals)} >= target ${formatUnits(targetReserve, decimals)} — no swap needed` };
  }

  if (balance < required) {
    // Critical: not enough to open a position at all
    const deficit = targetReserve - balance;
    log(`[INVENTORY] ${sym} CRITICAL: balance ${formatUnits(balance, decimals)} < required ${formatUnits(required, decimals)}`, "warn");
    log(`[INVENTORY] ${sym} swap target: ${formatUnits(targetReserve, decimals)} (deficit ${formatUnits(deficit, decimals)})`, "warn");
    return { action: "critical", swapAmount: deficit, reason: `${sym} critical deficit: have ${formatUnits(balance, decimals)}, need ${formatUnits(targetReserve, decimals)}` };
  }

  // Between required and target — top-up to target
  const deficit = targetReserve - balance;
  log(`[INVENTORY] ${sym} TOP-UP: balance ${formatUnits(balance, decimals)} between required ${formatUnits(required, decimals)} and target ${formatUnits(targetReserve, decimals)}`, "info");
  log(`[INVENTORY] ${sym} swap amount: ${formatUnits(deficit, decimals)} to reach ${formatUnits(targetReserve, decimals)}`, "info");
  return { action: "topup", swapAmount: deficit, reason: `${sym} top-up: have ${formatUnits(balance, decimals)}, target ${formatUnits(targetReserve, decimals)}, swap ${formatUnits(deficit, decimals)}` };
}

function formatUnits(value, decimals) {
  if (!value) return "0";
  try {
    if (typeof ethers !== "undefined" && ethers.formatUnits) {
      return ethers.formatUnits(value, decimals);
    }
    return String(Number(value) / Math.pow(10, decimals));
  } catch { return String(value); }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SWAP JOURNAL — prevents circular swaps (USDC→USDT→USDC ping-pong)
// ═══════════════════════════════════════════════════════════════════════════════

class SwapJournal {
  constructor(maxHistory = 10) {
    this.history = [];
    this.maxHistory = maxHistory;
  }

  record(entry) {
    this.history.push({
      timestamp: Date.now(),
      from: entry.from,
      to: entry.to,
      amount: entry.amount,
    });
    if (this.history.length > this.maxHistory) {
      this.history = this.history.slice(-this.maxHistory);
    }
  }

  wouldCreateCycle(fromSym, toSym) {
    if (this.history.length === 0) return false;
    const recent = this.history.slice(-3);
    for (const prev of recent) {
      if (prev.from === toSym && prev.to === fromSym) {
        return true;
      }
    }
    return false;
  }

  wasRecentlySwapped(fromSym, toSym, cooldownMs = 60000) {
    const now = Date.now();
    for (const entry of this.history) {
      if (entry.from === fromSym && entry.to === toSym) {
        if (now - entry.timestamp < cooldownMs) return true;
      }
    }
    return false;
  }

  getStats() {
    const counts = {};
    for (const h of this.history) {
      const key = `${h.from}→${h.to}`;
      counts[key] = (counts[key] || 0) + 1;
    }
    return counts;
  }

  reset() {
    this.history = [];
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  RANDOM SWAP AMOUNT CALCULATOR
// ═══════════════════════════════════════════════════════════════════════════════

const DEFAULT_AUTO_SWAP_PAIRS = [
  { from: "USDC", to: "USDT" },
  { from: "USDT", to: "USDC" },
  { from: "USDT", to: "WETH" },
  { from: "WETH", to: "USDT" },
  { from: "USDC", to: "WETH" },
  { from: "WETH", to: "USDC" },
];

const TOKEN_DECIMALS = {
  USDC: 6,
  USDT: 6,
  WETH: 18,
  ETH: 18,
};

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomInRange(min, max) {
  return min + Math.random() * (max - min);
}

/**
 * Select a random swap pair from available pairs, avoiding:
 * - circular swaps (recent reverse pair)
 * - same-pair repeats
 * - ETH→token (when preferTokenToToken is true)
 *
 * @param {SwapJournal} journal
 * @param {Map<string, {raw: bigint, float: number}>} balances
 * @param {object} autoSwapConfig
 * @returns {{ from: string, to: string, fromAddr: string, toAddr: string } | null}
 */
function selectRandomSwapPair(journal, balances, autoSwapConfig, tokenAddrs, log = () => {}) {
  const preferTokenToToken = autoSwapConfig.preferTokenToToken !== false;
  const cooldownMs = autoSwapConfig.swapCooldownMs || 20000;

  let candidates = DEFAULT_AUTO_SWAP_PAIRS.filter(pair => {
    const fromBal = balances[pair.from];
    const toBal = balances[pair.to];
    if (!fromBal || fromBal.float <= 0) return false;
    if (preferTokenToToken && pair.from === "ETH") return false;
    if (journal.wasRecentlySwapped(pair.from, pair.to, cooldownMs)) return false;
    if (journal.wouldCreateCycle(pair.from, pair.to)) return false;
    return true;
  });

  if (candidates.length === 0) {
    log(`[AUTO-SWAP] No valid swap pairs available`, "warn");
    return null;
  }

  candidates.sort((a, b) => {
    const aBal = balances[a.from]?.float || 0;
    const bBal = balances[b.from]?.float || 0;
    return bBal - aBal;
  });

  const topN = candidates.slice(0, Math.min(3, candidates.length));
  const selected = pickRandom(topN);

  const fromAddr = tokenAddrs[selected.from];
  const toAddr = tokenAddrs[selected.to];

  log(`[AUTO-SWAP] Selected pair: ${selected.from} → ${selected.to} (from ${candidates.length} candidates)`, "info");

  return { from: selected.from, to: selected.to, fromAddr, toAddr };
}

/**
 * Calculate a random swap amount for the selected pair.
 * Uses percentage of available balance with min/max bounds.
 *
 * @param {string} fromSym
 * @param {number} fromBalanceFloat
 * @param {object} autoSwapConfig
 * @returns {{ amountFloat: number, reason: string } | null}
 */
function calculateRandomSwapAmount(fromSym, fromBalanceFloat, autoSwapConfig) {
  const minPercent = autoSwapConfig.swapMinPercent || 3;
  const maxPercent = autoSwapConfig.swapMaxPercent || 15;
  const decimals = TOKEN_DECIMALS[fromSym] || 6;

  const minAmountStr = autoSwapConfig[`minSwapAmount${fromSym}`] || "1";
  const maxAmountStr = autoSwapConfig[`maxSwapAmount${fromSym}`] || "100";
  const minAmount = parseFloat(minAmountStr);
  const maxAmount = parseFloat(maxAmountStr);

  const percent = randomInRange(minPercent, maxPercent);
  let amountFloat = fromBalanceFloat * (percent / 100);

  amountFloat = Math.max(amountFloat, minAmount);
  amountFloat = Math.min(amountFloat, maxAmount);

  if (amountFloat > fromBalanceFloat * 0.9) {
    amountFloat = fromBalanceFloat * randomInRange(0.05, 0.15);
  }

  if (amountFloat < minAmount * 0.5) {
    return null;
  }

  return {
    amountFloat,
    reason: `random ${percent.toFixed(1)}% of ${fromBalanceFloat.toFixed(2)} balance`,
  };
}

/**
 * Get token address from symbol.
 */
function getTokenAddress(sym, tokenAddrs) {
  return tokenAddrs[sym] || null;
}

function getSwapPairs() {
  return [...DEFAULT_AUTO_SWAP_PAIRS];
}

export {
  TokenInventory,
  EthSessionTracker,
  SwapJournal,
  selectSwapSource,
  generateInventoryAwarePairs,
  logSwapDetails,
  DEFAULT_INVENTORY,
  DEFAULT_ETH_GUARD,
  BALANCE_MAP,
  calculateInventoryDeficit,
  selectRandomSwapPair,
  calculateRandomSwapAmount,
  getTokenAddress,
  getSwapPairs,
  TOKEN_DECIMALS,
};
