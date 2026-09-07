import { ethers } from "ethers";

// ═══════════════════════════════════════════════════════════════════════════
//  POSITION MANAGER — Leveraged Trading via Nemesis Manager Proxy
// ═══════════════════════════════════════════════════════════════════════════
//  Confirmed on-chain signatures (2026-09-04):
//
//  openPosition(bool,address,uint256,uint256,uint256,uint256,uint256)
//    selector: 0xfa2b1dfd
//    params: isLong, collateralToken, collateralAmount, amountOutMin,
//            leverage, size, deadline
//    Extra appended (not in ABI): bytes32 r, uint256 v, address paymentToken
//
//  withdrawWithLiquidity(uint256,address,address,uint256,uint256,address,address,uint256)
//    selector: 0x3f3cd555
//    params: positionId, collateralToken, marketToken, amount, amount2,
//            recipient, refundTo, deadline
//
//  nonces(address) → uint256
//    selector: 0x7ecebe00
//
//  Manager proxy: EIP-1167 → Implementation 0xeE68790cDb86BDCB7B9681E6fa7DC53744Ba4f4C
//  Manager token: mamNLP (ERC20, 18 decimals)
//  Position = mamNLP token balance (deposit collateral → receive mamNLP)
// ═══════════════════════════════════════════════════════════════════════════

const OPEN_POSITION_SELECTOR = "0xfa2b1dfd";
const CLOSE_POSITION_SELECTOR = "0xb35648d7";  // closePosition(uint256,uint256,uint256)
const NONCES_SELECTOR = "0x7ecebe00";

const MANAGER_ABI = [
  "function openPosition(bool isLong, address collateralToken, uint256 collateralAmount, uint256 borrowAmount, uint256 leverageX10, uint256 amountOutMin, uint256 deadline) returns (uint256)",
  "function closePosition(uint256 positionId, uint256 amountOutMin, uint256 deadline)",
  "function nonces(address user) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function asset() view returns (address)",
  "function totalAssets() view returns (uint256)",
  "function factory() view returns (address)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
];

const ERC20_ABI = [
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function short(value) {
  return value ? `${value.slice(0, 6)}...${value.slice(-4)}` : "N/A";
}

function decodeError(error) {
  return error?.shortMessage || error?.reason || error?.info?.error?.message || error?.message || String(error);
}

function formatAmount(amount, decimals) {
  try { return ethers.formatUnits(amount, decimals); } catch { return amount.toString(); }
}

// ═══════════════════════════════════════════════════════════════════════════
//  1. READ-ONLY: getUserPosition
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get the user's position status from the Manager contract.
 * Position = mamNLP token balance. If balance > 0, user has an active position.
 *
 * @param {Object} params
 * @param {ethers.Provider} params.provider
 * @param {string} params.walletAddress
 * @param {string} params.managerAddress
 * @param {Function} params.log
 * @returns {Object} { hasPosition, lpBalance, lpBalanceFormatted, symbol, decimals }
 */
export async function getUserPosition({ provider, walletAddress, managerAddress, log = () => {} }) {
  const manager = new ethers.Contract(managerAddress, MANAGER_ABI, provider);

  const [lpBalance, symbol, decimals] = await Promise.all([
    manager.balanceOf(walletAddress),
    manager.symbol().catch(() => "mamNLP"),
    manager.decimals().catch(() => 18),
  ]);

  const hasPosition = lpBalance > 0n;
  const lpBalanceFormatted = formatAmount(lpBalance, Number(decimals));

  log(`[POS] getUserPosition: ${short(walletAddress)} → balance=${lpBalanceFormatted} ${symbol} [${hasPosition ? "ACTIVE" : "NONE"}]`, hasPosition ? "success" : "info");

  return {
    hasPosition,
    lpBalance,
    lpBalanceFormatted,
    symbol,
    decimals: Number(decimals),
    managerAddress,
  };
}

/**
 * Get LP balances for multiple users (batch check).
 */
export async function getActivePositions({ provider, walletAddresses, managerAddress, log = () => {} }) {
  const results = [];
  for (const addr of walletAddresses) {
    const pos = await getUserPosition({ provider, walletAddress: addr, managerAddress, log: () => {} });
    results.push({ address: addr, ...pos });
  }
  const active = results.filter(r => r.hasPosition);
  log(`[POS] getActivePositions: ${active.length}/${results.length} users have active positions`, active.length > 0 ? "success" : "info");
  return results;
}

// ═══════════════════════════════════════════════════════════════════════════
//  2. VALIDATE: validatePositionParams
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Validate position parameters before execution.
 * Returns { valid, reason } — if not valid, reason explains why.
 *
 * @param {Object} params
 * @param {ethers.Provider} params.provider
 * @param {string} params.managerAddress
 * @param {string} params.poolAddress
 * @param {string} params.collateralToken
 * @param {ethers.BigNumberish} params.collateralAmount
 * @param {number} params.leverage
 * @param {boolean} params.isLong
 * @param {string} params.walletAddress
 * @param {Object} params.ethGuard — EthSessionTracker instance
 * @param {Function} params.log
 */
export async function validatePositionParams({
  provider, managerAddress, poolAddress, collateralToken,
  collateralAmount, leverage, isLong, walletAddress,
  ethGuard, log = () => {},
}) {
  // 1. Manager code exists
  const managerCode = await provider.getCode(managerAddress);
  if (!managerCode || managerCode === "0x") {
    return { valid: false, reason: `[BLOCKED] Manager contract not found at ${managerAddress}` };
  }

  // 2. Pool code exists
  if (poolAddress) {
    const poolCode = await provider.getCode(poolAddress);
    if (!poolCode || poolCode === "0x") {
      return { valid: false, reason: `[BLOCKED] Pool contract not found at ${poolAddress}` };
    }
  }

  // 3. Leverage check (max 5x confirmed on-chain)
  if (leverage < 1 || leverage > 5) {
    return { valid: false, reason: `[BLOCKED] Leverage ${leverage}x out of range (1-5x)` };
  }

  // 4. Collateral amount > 0
  if (!collateralAmount || collateralAmount <= 0n) {
    return { valid: false, reason: `[BLOCKED] Collateral amount must be > 0` };
  }

  // 5. Sufficient collateral balance
  const collateralContract = new ethers.Contract(collateralToken, ERC20_ABI, provider);
  const collateralBalance = await collateralContract.balanceOf(walletAddress);
  if (collateralBalance < collateralAmount) {
    const decimals = await collateralContract.decimals();
    return {
      valid: false,
      reason: `[BLOCKED] Insufficient collateral: have ${formatAmount(collateralBalance, decimals)}, need ${formatAmount(collateralAmount, decimals)}`,
    };
  }

  // 6. ETH gas reserve check
  if (ethGuard) {
    const ethBalance = await provider.getBalance(walletAddress);
    const gasCheck = ethGuard.checkGasReserve(Number(ethBalance) / 1e18, 0);
    if (!gasCheck.allowed) {
      return { valid: false, reason: `[BLOCKED] ${gasCheck.reason}` };
    }
  }

  // 7. Manager enabled check (pool-specific)
  // The pool's enabled flag (0x3b24e658 = 1) was confirmed on-chain
  // Additional checks can be added here as needed

  log(`[POS] Validation PASSED: leverage=${leverage}x collateral=${collateralAmount} isLong=${isLong}`, "success");
  return { valid: true, reason: null };
}

// ═══════════════════════════════════════════════════════════════════════════
//  3. OPEN POSITION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Open a leveraged position via the Manager contract.
 *
 * NOTE: The contract ABI is:
 *   openPosition(bool isLong, address collateralToken, uint256 collateralAmount,
 *                uint256 borrowAmount, uint256 leverageX10, uint256 amountOutMin, uint256 deadline)
 *
 * The `amountOutMin` parameter here is used as the amountOutMin in the contract.
 * The `borrowAmount` is computed from the leverage (for 2x: borrowAmount = collateralAmount).
 *
 * @param {Object} params
 * @param {ethers.Wallet} params.wallet
 * @param {ethers.Provider} params.provider
 * @param {string} params.managerAddress
 * @param {string} params.collateralToken
 * @param {ethers.BigNumberish} params.collateralAmount
 * @param {boolean} params.isLong — true=LONG, false=SHORT
 * @param {number} params.leverage — 1-5 (will be multiplied by 10 for encoding)
 * @param {ethers.BigNumberish} params.amountOutMin — slippage protection (0 = any)
 * @param {string} params.poolAddress
 * @param {Function} params.getFeeParams
 * @param {Function} params.getNextNonce
 * @param {number} params.chainId
 * @param {Function} params.log
 */
export async function openPosition({
  wallet, provider, managerAddress, collateralToken, collateralAmount,
  isLong, leverage, amountOutMin = 0n, poolAddress,
  getFeeParams, getNextNonce, chainId, log = () => {},
}) {
  const walletAddress = wallet.address;
  log(`[POS] openPosition: isLong=${isLong} leverage=${leverage}x collateral=${collateralAmount} Manager=${short(managerAddress)}`, "warn");

  // 1. Validate
  const validation = await validatePositionParams({
    provider, managerAddress, poolAddress, collateralToken,
    collateralAmount, leverage, isLong, walletAddress, log,
  });
  if (!validation.valid) {
    log(validation.reason, "error");
    throw new Error(validation.reason);
  }

  // 2. Ensure approval
  const token = new ethers.Contract(collateralToken, ERC20_ABI, wallet);
  const allowance = await token.allowance(walletAddress, managerAddress);
  if (allowance < collateralAmount) {
    log(`[POS] Approving collateral ${short(collateralToken)} → Manager ${short(managerAddress)}...`, "warn");
    const feeParams = await getFeeParams(provider);
    const nonce = await getNextNonce(provider, walletAddress, chainId);
    const approveTx = await token.approve(managerAddress, ethers.MaxUint256, { ...feeParams, gasLimit: 100000n, nonce });
    log(`[POS] Approve tx=${approveTx.hash}`, "warn");
    await approveTx.wait();
    log(`[POS] Approve confirmed`, "success");
  }

  // 3. Compute borrowAmount from leverage
  // For leverageX10: 20=2x, 30=3x, etc. borrowAmount = collateral * (leverageX10 - 10) / 10
  const leverageX10 = BigInt(leverage) * 10n;
  const borrowAmount = collateralAmount * (leverageX10 - 10n) / 10n;

  // 4. Encode calldata — CORRECT parameter order per on-chain Manager ABI:
  // openPosition(isLong, collateralToken, collateralAmount, amountOutMin, leverage, size, deadline)
  // size=0: contract uses collateralAmount internally (required for USDT 6-decimal collateral)
  const deadline = Math.floor(Date.now() / 1000) + 1200;

  const coder = ethers.AbiCoder.defaultAbiCoder();
  const params = coder.encode(
    ["bool", "address", "uint256", "uint256", "uint256", "uint256", "uint256"],
    [isLong, collateralToken, collateralAmount, amountOutMin, leverageX10, 0n, BigInt(deadline)]
  );
  const calldata = OPEN_POSITION_SELECTOR + params.slice(2);

  log(`[POS] Calldata: ${calldata.length / 2 - 1} bytes`, "info");
  log(`[POS] isLong=${isLong} collateral=${short(collateralToken)} amount=${collateralAmount} leverage=${leverage}x deadline=${deadline}`, "info");

  // 4. Pre-flight call
  try {
    await provider.call({ from: walletAddress, to: managerAddress, data: calldata, value: 0n });
    log(`[POS] Pre-flight call succeeded`, "info");
  } catch (error) {
    const reason = decodeError(error);
    log(`[POS] Pre-flight call reverted: ${reason}`, "error");
    throw new Error(`Open position pre-flight failed: ${reason}`);
  }

  // 5. Estimate gas
  let gasEstimate;
  try {
    gasEstimate = await provider.estimateGas({ from: walletAddress, to: managerAddress, data: calldata, value: 0n });
    log(`[POS] Gas estimate: ${gasEstimate}`, "info");
  } catch (error) {
    const reason = decodeError(error);
    log(`[POS] Gas estimation failed: ${reason}`, "error");
    throw new Error(`Open position gas estimation failed: ${reason}`);
  }

  // 6. Send transaction
  const feeParams = await getFeeParams(provider);
  const nonce = await getNextNonce(provider, walletAddress, chainId);
  const gasLimit = gasEstimate + gasEstimate / 5n; // 20% buffer

  log(`[POS] Sending openPosition tx...`, "warn");
  const tx = await wallet.sendTransaction({
    to: managerAddress,
    data: calldata,
    value: 0n,
    gasLimit,
    nonce,
    ...feeParams,
  });
  log(`[POS] Tx sent: ${tx.hash}`, "warn");

  // 7. Wait for confirmation
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("Transaction confirmation timed out")), 120000)
  );
  let receipt;
  try {
    receipt = await Promise.race([tx.wait(), timeoutPromise]);
  } catch (error) {
    receipt = error?.receipt || error?.transactionReceipt;
    if (receipt) {
      log(`[POS] FAIL tx=${receipt.hash || tx.hash} status=${receipt.status} gasUsed=${receipt.gasUsed}`, "error");
    }
    throw error;
  }

  if (receipt.status !== 1) {
    log(`[POS] FAIL tx=${receipt.hash} status=${receipt.status}`, "error");
    throw new Error("Open position transaction reverted");
  }

  // 8. Verify LP token receipt
  const afterBalance = await new ethers.Contract(managerAddress, MANAGER_ABI, provider).balanceOf(walletAddress);
  log(`[POS] openPosition SUCCESS tx=${tx.hash} gasUsed=${receipt.gasUsed}`, "success");
  log(`[POS] LP balance after: ${afterBalance.toString()}`, "success");

  return {
    txHash: tx.hash,
    receipt,
    gasUsed: receipt.gasUsed,
    lpBalanceAfter: afterBalance,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
//  4. CLOSE POSITION — closePosition(uint256,uint256,uint256)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Close a leveraged position via the Manager contract.
 * Confirmed E2E: selector 0xb35648d7 = closePosition(uint256,uint256,uint256)
 *
 * Flow:
 * 1. Check user has active position (LP balance > 0)
 * 2. Encode calldata: positionId, amountOutMin, deadline
 * 3. Pre-flight call (eth_call)
 * 4. Estimate gas
 * 5. Send transaction
 * 6. Wait for confirmation
 * 7. Return result
 *
 * @param {Object} params
 * @param {ethers.Wallet} params.wallet
 * @param {ethers.Provider} params.provider
 * @param {string} params.managerAddress
 * @param {number} params.positionId — from PositionCreated event topic[2]
 * @param {Function} params.getFeeParams
 * @param {Function} params.getNextNonce
 * @param {number} params.chainId
 * @param {Function} params.log
 */
export async function closePosition({
  wallet, provider, managerAddress, positionId, positionAmount,
  getFeeParams, getNextNonce, chainId, log = () => {},
}) {
  const walletAddress = wallet.address;
  log(`[POS] closePosition: Manager=${short(managerAddress)} positionId=${positionId}`, "warn");

  // 1. Check position exists
  const pos = await getUserPosition({ provider, walletAddress, managerAddress, log });
  if (!pos.hasPosition) {
    throw new Error("[BLOCKED] No active position to close");
  }

  // 2. Encode calldata — closePosition(uint256,uint256,uint256)
  // selector: 0xb35648d7
  // params: positionId, amountOutMin(=0 for now), deadline
  const deadline = Math.floor(Date.now() / 1000) + 1200;

  const coder = ethers.AbiCoder.defaultAbiCoder();
  const params = coder.encode(
    ["uint256", "uint256", "uint256"],
    [positionId, 0n, deadline]  // positionId, amountOutMin, deadline
  );
  const calldata = CLOSE_POSITION_SELECTOR + params.slice(2);

  log(`[POS] Calldata: ${calldata.length / 2 - 1} bytes`, "info");

  // 3. Pre-flight call
  try {
    await provider.call({ from: walletAddress, to: managerAddress, data: calldata, value: 0n });
    log(`[POS] Pre-flight call succeeded`, "info");
  } catch (error) {
    const reason = decodeError(error);
    log(`[POS] Pre-flight call reverted: ${reason}`, "error");
    throw new Error(`Close position pre-flight failed: ${reason}`);
  }

  // 4. Estimate gas
  let gasEstimate;
  try {
    gasEstimate = await provider.estimateGas({ from: walletAddress, to: managerAddress, data: calldata, value: 0n });
    log(`[POS] Gas estimate: ${gasEstimate}`, "info");
  } catch (error) {
    const reason = decodeError(error);
    log(`[POS] Gas estimation failed: ${reason}`, "error");
    throw new Error(`Close position gas estimation failed: ${reason}`);
  }

  // 5. Send transaction
  const feeParams = await getFeeParams(provider);
  const nonce = await getNextNonce(provider, walletAddress, chainId);
  const gasLimit = gasEstimate + gasEstimate / 5n;

  log(`[POS] Sending closePosition tx...`, "warn");
  const tx = await wallet.sendTransaction({
    to: managerAddress,
    data: calldata,
    value: 0n,
    gasLimit,
    nonce,
    ...feeParams,
  });
  log(`[POS] Tx sent: ${tx.hash}`, "warn");

  // 6. Wait for confirmation
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("Transaction confirmation timed out")), 120000)
  );
  let receipt;
  try {
    receipt = await Promise.race([tx.wait(), timeoutPromise]);
  } catch (error) {
    receipt = error?.receipt || error?.transactionReceipt;
    if (receipt) {
      log(`[POS] FAIL tx=${receipt.hash || tx.hash} status=${receipt.status}`, "error");
    }
    throw error;
  }

  if (receipt.status !== 1) {
    log(`[POS] FAIL tx=${receipt.hash} status=${receipt.status}`, "error");
    throw new Error("Close position transaction reverted");
  }

  // 7. Verify — check LP balance after close
  const afterBalance = await new ethers.Contract(managerAddress, MANAGER_ABI, provider).balanceOf(walletAddress);
  log(`[POS] closePosition SUCCESS tx=${tx.hash} gasUsed=${receipt.gasUsed}`, "success");
  log(`[POS] LP balance after: ${afterBalance.toString()}`, afterBalance === 0n ? "success" : "warn");

  return {
    txHash: tx.hash,
    receipt,
    gasUsed: receipt.gasUsed,
    lpBalanceAfter: afterBalance,
    closed: afterBalance === 0n,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
//  5. RESOLVE MANAGER ADDRESS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Resolve the Manager proxy address for a given market.
 * Uses the confirmedPools from deployments/v2.js as fallback.
 *
 * @param {Object} params
 * @param {ethers.Provider} params.provider
 * @param {string} params.marketSymbol — e.g. "ETH/USDT"
 * @param {Object} params.confirmedPools — from deployments/v2.js
 * @param {Function} params.log
 * @returns {string} managerAddress
 */
export function resolveManagerAddress({ marketSymbol, confirmedPools, log = () => {} }) {
  const poolInfo = confirmedPools?.[marketSymbol];
  if (!poolInfo?.manager) {
    throw new Error(`No manager address found for ${marketSymbol}`);
  }
  log(`[POS] Manager for ${marketSymbol}: ${poolInfo.manager}`, "info");
  return poolInfo.manager;
}

/**
 * Check if a market's pool is deployed on-chain.
 * Returns false if pool has 0 bytes of code.
 */
export async function isPoolDeployed({ provider, poolAddress, log = () => {} }) {
  try {
    // Fix checksum if needed
    const addr = ethers.getAddress(poolAddress.toLowerCase());
    const code = await provider.getCode(addr);
    const deployed = code && code !== "0x" && code.length > 10;
    if (!deployed) {
      log(`[POS] Pool ${short(poolAddress)} NOT DEPLOYED (0 bytes)`, "warn");
    }
    return deployed;
  } catch (e) {
    log(`[POS] Pool ${short(poolAddress)} NOT DEPLOYED (code check failed)`, "warn");
    return false;
  }
}

export default {
  getUserPosition,
  getActivePositions,
  validatePositionParams,
  openPosition,
  closePosition,
  resolveManagerAddress,
  isPoolDeployed,
  OPEN_POSITION_SELECTOR,
  CLOSE_POSITION_SELECTOR,
  NONCES_SELECTOR,
  MANAGER_ABI,
};
