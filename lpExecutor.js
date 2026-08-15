import { ethers } from "ethers";

// ─── Nemesis Manager "addLiquidity" selector (unverified contract, raw selector) ───
// Function: addLiquidity(address tokenA, address tokenB, uint256 amountADesired, uint256 amountAMin, uint256 amountBDesired, uint256 amountBMin, address to, uint256 deadline)
// Selector: 0x3608c693 (confirmed from reference tx 0x547504d5fc2f1fa08eb3d3f55bff8ce7de67bf2f1897d4a828455bc3770ea59b)
const ADD_LIQUIDITY_SELECTOR = "0x3608c693";

const ERC20_ABI = [
  "function approve(address spender,uint256 amount) returns (bool)",
  "function allowance(address owner,address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)"
];

const ERC20_WITH_LOGS_ABI = [
  ...ERC20_ABI,
  "event Transfer(address indexed from, address indexed to, uint256 value)"
];

const PAIR_ABI = [
  ...ERC20_ABI,
  "function totalSupply() view returns (uint256)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)"
];

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const WETH_ABI = [
  ...ERC20_ABI,
  "function deposit() payable",
  "function withdraw(uint256 wad)"
];

// ─── Helper Functions ───

function short(value) {
  return value ? `${value.slice(0, 6)}...${value.slice(-4)}` : "N/A";
}

function decodeError(error) {
  return error?.shortMessage || error?.reason || error?.info?.error?.message || error?.message || String(error);
}

function formatAmount(amount, decimals) {
  try { return ethers.formatUnits(amount, decimals); } catch { return amount.toString(); }
}

function applySlippage(amount, slippagePercent) {
  const bps = BigInt(Math.max(0, Math.min(10000, Math.floor(Number(slippagePercent) * 100))));
  if (amount <= 0n || bps >= 10000n) return 0n;
  return amount * (10000n - bps) / 10000n;
}

// ─── Core Functions ───

export async function getLpStatus({ provider, walletAddress, poolAddress }) {
  if (!poolAddress || poolAddress === ZERO_ADDRESS) {
    return { poolAddress: ZERO_ADDRESS, lpBalance: 0n, totalSupply: 0n, exists: false };
  }
  const pair = new ethers.Contract(poolAddress, PAIR_ABI, provider);
  const [lpBalance, totalSupply, token0, token1, reserves] = await Promise.all([
    pair.balanceOf(walletAddress),
    pair.totalSupply(),
    pair.token0(),
    pair.token1(),
    pair.getReserves()
  ]);
  return { poolAddress, lpBalance, totalSupply, token0, token1, reserves, exists: lpBalance > 0n };
}

/**
 * Ensure ERC20 token approval for the Manager contract.
 * Checks current allowance, sends approve tx if insufficient.
 */
async function ensureApproval({ wallet, provider, tokenAddress, spender, amount, getFeeParams, getNextNonce, chainId, log }) {
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);
  const allowance = await token.allowance(wallet.address, spender);
  if (allowance >= amount) {
    log(`[LP] Allowance sufficient for ${short(tokenAddress)} → ${short(spender)}.`, "info");
    return null;
  }
  log(`[LP] Approving ${short(tokenAddress)} for Manager ${short(spender)}...`, "warn");
  const feeParams = await getFeeParams(provider);
  const nonce = await getNextNonce(provider, wallet.address, chainId);
  const tx = await token.approve(spender, ethers.MaxUint256, { ...feeParams, gasLimit: 100000n, nonce });
  log(`[LP] Approve tx sent tx=${tx.hash}`, "warn");
  const receipt = await tx.wait();
  if (receipt.status !== 1) throw new Error(`LP approve reverted for ${short(tokenAddress)}`);
  log(`[LP] Approve confirmed tx=${tx.hash}`, "success");
  return receipt;
}

/**
 * Encode addLiquidity calldata for the Nemesis Manager contract.
 * Uses raw selector 0x3608c693 with 8 parameters:
 *   tokenA, tokenB, amountADesired, amountAMin, amountBDesired, amountBMin, to, deadline
 */
function encodeAddLiquidityCalldata({ tokenA, tokenB, amountADesired, amountAMin, amountBDesired, amountBMin, to, deadline }) {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const params = coder.encode(
    ["address", "address", "uint256", "uint256", "uint256", "uint256", "address", "uint256"],
    [tokenA, tokenB, amountADesired, amountAMin, amountBDesired, amountBMin, to, deadline]
  );
  return ADD_LIQUIDITY_SELECTOR + params.slice(2);
}

/**
 * Calculate optimal amounts for adding liquidity based on current pool reserves.
 * Ensures both tokens are added in the correct ratio.
 */
function calculateOptimalAmounts({ tokenA, tokenB, amountA, amountB, token0, reserves }) {
  const reserveA = tokenA.toLowerCase() === token0.toLowerCase() ? BigInt(reserves[0]) : BigInt(reserves[1]);
  const reserveB = tokenB.toLowerCase() === token0.toLowerCase() ? BigInt(reserves[0]) : BigInt(reserves[1]);

  if (reserveA === 0n || reserveB === 0n) {
    return { amountA, amountB };
  }

  // Calculate optimal amountB based on amountA
  const optimalB = amountA * reserveB / reserveA;
  if (optimalB <= amountB) {
    return { amountA, amountB: optimalB };
  }

  // Calculate optimal amountA based on amountB
  const optimalA = amountB * reserveA / reserveB;
  return { amountA: optimalA, amountB };
}

/**
 * Main addLiquidity function for Nemesis Manager.
 * 
 * Flow:
 * 1. Validate inputs and check balances
 * 2. Calculate optimal amounts based on pool reserves
 * 3. Approve both tokens to the Manager contract
 * 4. Encode and send the addLiquidity transaction
 * 5. Verify LP token receipt
 */
export async function addLiquidity({ wallet, provider, config, managerAddress, poolAddress, tokenAAddress, tokenBAddress, chainId, getFeeParams, getNextNonce, log }) {
  const walletAddress = wallet.address;
  log(`[LP] Add Liquidity starting → Manager=${short(managerAddress)} Pool=${short(poolAddress)}`, "info");

  // 1. Validate contracts
  const managerCode = await provider.getCode(managerAddress);
  if (!managerCode || managerCode === "0x") throw new Error(`Manager contract not found at ${managerAddress}`);

  // 2. Get token info
  const tokenAContract = new ethers.Contract(tokenAAddress, ERC20_ABI, provider);
  const tokenBContract = new ethers.Contract(tokenBAddress, ERC20_ABI, provider);
  const [decimalsA, decimalsB, symbolA, symbolB] = await Promise.all([
    tokenAContract.decimals(),
    tokenBContract.decimals(),
    tokenAContract.symbol(),
    tokenBContract.symbol()
  ]);

  // 3. Parse amounts from config
  const amountA = ethers.parseUnits(String(config.lpTokenAAmount || config.lpEthAmount || "0.001"), Number(decimalsA));
  let amountB = String(config.lpTokenBAmount || config.lpDaiAmount || "0.5").toLowerCase() === "auto"
    ? null  // Will calculate from reserves
    : ethers.parseUnits(String(config.lpTokenBAmount || config.lpDaiAmount || "0.5"), Number(decimalsB));

  log(`[LP] Desired amounts: ${formatAmount(amountA, decimalsA)} ${symbolA} + ${amountB != null ? formatAmount(amountB, decimalsB) : "AUTO"} ${symbolB}`, "info");

  // 4. Check balances and handle native ETH → WETH wrapping if needed
  let [balA, balB] = await Promise.all([
    tokenAContract.balanceOf(walletAddress),
    tokenBContract.balanceOf(walletAddress)
  ]);

  // If tokenA is WETH and balance is insufficient, try wrapping native ETH
  const WETH_ADDRESSES = ["0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9", "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"];
  const isWethA = WETH_ADDRESSES.includes(tokenAAddress.toLowerCase());
  if (isWethA && balA < amountA) {
    const ethBalance = await provider.getBalance(walletAddress);
    const missing = amountA - balA;
    if (ethBalance >= missing) {
      log(`[LP] Wrapping ${formatAmount(missing, 18)} ETH → WETH...`, "warn");
      const weth = new ethers.Contract(tokenAAddress, WETH_ABI, wallet);
      const feeParams = await getFeeParams(provider);
      const nonce = await getNextNonce(provider, walletAddress, chainId);
      const wrapTx = await weth.deposit({ value: missing, ...feeParams, gasLimit: 100000n, nonce });
      log(`[LP] WETH wrap tx=${wrapTx.hash}`, "warn");
      await wrapTx.wait();
      log(`[LP] WETH wrap confirmed`, "success");
      balA = await tokenAContract.balanceOf(walletAddress);
    } else {
      throw new Error(`Insufficient ${symbolA} and insufficient ETH to wrap: have ${formatAmount(balA, decimalsA)} ${symbolA} + ${formatAmount(ethBalance, 18)} ETH, need ${formatAmount(amountA, decimalsA)} ${symbolA}`);
    }
  }

  if (balA < amountA) throw new Error(`Insufficient ${symbolA}: have ${formatAmount(balA, decimalsA)}, need ${formatAmount(amountA, decimalsA)}`);
  if (amountB != null && balB < amountB) throw new Error(`Insufficient ${symbolB}: have ${formatAmount(balB, decimalsB)}, need ${formatAmount(amountB, decimalsB)}`);

  // 5. Calculate optimal amounts from pool reserves (if pool exists and has liquidity)
  let finalAmountA = amountA;
  let finalAmountB = amountB;
  let token0Address = null;

  if (poolAddress && poolAddress !== ZERO_ADDRESS) {
    const poolStatus = await getLpStatus({ provider, walletAddress: "0x0000000000000000000000000000000000000000", poolAddress });
    if (poolStatus.totalSupply > 0n) {
      token0Address = poolStatus.token0;
      const { amountA: optA, amountB: optB } = calculateOptimalAmounts({
        tokenA: tokenAAddress,
        tokenB: tokenBAddress,
        amountA,
        amountB: amountB ?? amountA * BigInt(poolStatus.reserves[1].toString()) / BigInt(poolStatus.reserves[0].toString()),
        token0: poolStatus.token0,
        reserves: poolStatus.reserves
      });
      finalAmountA = optA;
      finalAmountB = optB;
      log(`[LP] Optimal amounts: ${formatAmount(finalAmountA, decimalsA)} ${symbolA} + ${formatAmount(finalAmountB, decimalsB)} ${symbolB}`, "info");
    } else {
      // Empty pool - use provided amounts
      if (finalAmountB == null) throw new Error("Empty pool requires explicit tokenB amount (cannot use AUTO)");
      log(`[LP] Empty pool, using initial amounts`, "info");
    }
  } else {
    if (finalAmountB == null) throw new Error("No pool found and tokenB amount is AUTO - set explicit tokenB amount in config");
    log(`[LP] No pool address provided, using configured amounts`, "info");
  }

  if (finalAmountA <= 0n || finalAmountB <= 0n) throw new Error("Amounts must be greater than zero");

  // 6. Approve both tokens to the Manager
  const approveReceiptA = await ensureApproval({
    wallet, provider, tokenAddress: tokenAAddress, spender: managerAddress,
    amount: finalAmountA, getFeeParams, getNextNonce, chainId, log
  });
  const approveReceiptB = await ensureApproval({
    wallet, provider, tokenAddress: tokenBAddress, spender: managerAddress,
    amount: finalAmountB, getFeeParams, getNextNonce, chainId, log
  });

  // 7. Calculate slippage-protected minimums
  const slippagePercent = Number(config.lpSlippage) || 1;
  const amountAMin = applySlippage(finalAmountA, slippagePercent);
  const amountBMin = applySlippage(finalAmountB, slippagePercent);

  // 8. Set deadline (default 20 minutes)
  const deadline = Math.floor(Date.now() / 1000) + 1200;

  // 9. Encode the calldata
  const calldata = encodeAddLiquidityCalldata({
    tokenA: tokenAAddress,
    tokenB: tokenBAddress,
    amountADesired: finalAmountA,
    amountAMin,
    amountBDesired: finalAmountB,
    amountBMin,
    to: walletAddress,
    deadline
  });

  log(`[LP] Calldata selector: ${ADD_LIQUIDITY_SELECTOR}`, "info");
  log(`[LP] tokenA=${short(tokenAAddress)} amountA=${formatAmount(finalAmountA, decimalsA)} minA=${formatAmount(amountAMin, decimalsA)}`, "info");
  log(`[LP] tokenB=${short(tokenBAddress)} amountB=${formatAmount(finalAmountB, decimalsB)} minB=${formatAmount(amountBMin, decimalsB)}`, "info");
  log(`[LP] deadline=${deadline} (${new Date(deadline * 1000).toISOString()})`, "info");

  // 10. Record LP balance before
  const before = poolAddress && poolAddress !== ZERO_ADDRESS
    ? await getLpStatus({ provider, walletAddress, poolAddress })
    : { lpBalance: 0n, totalSupply: 0n };

  // 11. Pre-flight call
  try {
    await provider.call({ from: walletAddress, to: managerAddress, data: calldata, value: 0n });
    log(`[LP] Pre-flight call succeeded`, "info");
  } catch (error) {
    const reason = decodeError(error);
    log(`[LP] Pre-flight call reverted: ${reason}`, "error");
    throw new Error(`Add liquidity pre-flight failed: ${reason}`);
  }

  // 12. Estimate gas
  let gasEstimate;
  try {
    gasEstimate = await provider.estimateGas({ from: walletAddress, to: managerAddress, data: calldata, value: 0n });
    log(`[LP] Gas estimate: ${gasEstimate}`, "info");
  } catch (error) {
    const reason = decodeError(error);
    log(`[LP] Gas estimation failed: ${reason}`, "error");
    throw new Error(`Add liquidity gas estimation failed: ${reason}`);
  }

  // 13. Send transaction
  const feeParams = await getFeeParams(provider);
  const nonce = await getNextNonce(provider, walletAddress, chainId);
  const gasLimit = gasEstimate + gasEstimate / 5n;

  log(`[LP] Sending addLiquidity tx to Manager...`, "warn");
  const tx = await wallet.sendTransaction({
    to: managerAddress,
    data: calldata,
    value: 0n,
    gasLimit,
    nonce,
    ...feeParams
  });
  log(`[LP] Tx sent tx=${tx.hash}`, "warn");

  // 14. Wait for confirmation
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("Transaction confirmation timed out")), 120000)
  );
  let receipt;
  try {
    receipt = await Promise.race([tx.wait(), timeoutPromise]);
  } catch (error) {
    receipt = error?.receipt || error?.transactionReceipt;
    if (receipt) {
      log(`[LP] FAIL tx=${receipt.hash || tx.hash} status=${receipt.status} gasUsed=${receipt.gasUsed}`, "error");
    }
    throw error;
  }

  if (receipt.status !== 1) {
    log(`[LP] FAIL tx=${receipt.hash} status=${receipt.status}`, "error");
    throw new Error("Add liquidity transaction reverted");
  }

  // 15. Parse events for LP token transfers
  let lpTokensReceived = 0n;
  for (const logEntry of receipt.logs) {
    try {
      const parsed = new ethers.Interface(ERC20_WITH_LOGS_ABI).parseLog(logEntry);
      if (parsed?.name === "Transfer" && parsed.args.to.toLowerCase() === walletAddress.toLowerCase()) {
        lpTokensReceived += BigInt(parsed.args.value.toString());
      }
    } catch {}
  }

  // 16. Verify LP balance increase
  const after = poolAddress && poolAddress !== ZERO_ADDRESS
    ? await getLpStatus({ provider, walletAddress, poolAddress })
    : { lpBalance: 0n };

  const lpDelta = after.lpBalance - before.lpBalance;
  log(`[LP] Before LP: ${before.lpBalance} → After LP: ${after.lpBalance} (delta: ${lpDelta})`, "success");
  log(`[LP] LP tokens received (from events): ${lpTokensReceived}`, "info");

  // 17. Fetch UI position
  let ui = null;
  try {
    const query = "query($user:String!){ _meta { block { number timestamp } } userLiquidityPositions(where:{user:$user}, first:20, orderBy:updatedAtTimestamp, orderDirection:desc){ id lpBalance amount0 amount1 status updatedAtTimestamp pool { address } } }";
    const response = await fetch("https://nemesis.trade/api/subgraph", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables: { user: walletAddress.toLowerCase() } })
    });
    const json = await response.json();
    const position = json.data?.userLiquidityPositions?.find(
      item => item.pool.address.toLowerCase() === (poolAddress || "").toLowerCase()
    ) || null;
    ui = { block: json.data?._meta?.block, position };
  } catch (error) {
    ui = { error: error.message };
  }

  const proof = {
    txHash: tx.hash,
    receiptStatus: receipt.status,
    managerAddress,
    poolAddress,
    tokenA: tokenAAddress,
    tokenB: tokenBAddress,
    amountADesired: finalAmountA.toString(),
    amountBDesired: finalAmountB.toString(),
    amountAMin: amountAMin.toString(),
    amountBMin: amountBMin.toString(),
    amountADesiredDisplay: formatAmount(finalAmountA, decimalsA),
    amountBDesiredDisplay: formatAmount(finalAmountB, decimalsB),
    symbolA,
    symbolB,
    lpBalanceBefore: before.lpBalance.toString(),
    lpBalanceAfter: after.lpBalance.toString(),
    lpDelta: lpDelta.toString(),
    lpTokensReceived: lpTokensReceived.toString(),
    ui
  };

  log(`[LP] Add Liquidity SUCCESS tx=${tx.hash} status=${receipt.status}`, "success");
  log(`[LP] Added ${formatAmount(finalAmountA, decimalsA)} ${symbolA} + ${formatAmount(finalAmountB, decimalsB)} ${symbolB}`, "success");
  log(`[LP] LP balance: ${before.lpBalance} → ${after.lpBalance}`, "success");
  if (lpTokensReceived > 0n) {
    log(`[LP] mamNLP received: ${lpTokensReceived}`, "success");
  }

  return proof;
}

/**
 * Remove liquidity from Nemesis pool.
 * Approves LP tokens to Manager, then calls removeLiquidity (selector TBD).
 */
export async function removeLiquidity({ wallet, provider, config, managerAddress, poolAddress, chainId, getFeeParams, getNextNonce, log }) {
  const walletAddress = wallet.address;
  log(`[LP] Remove Liquidity starting → Manager=${short(managerAddress)} Pool=${short(poolAddress)}`, "info");

  const before = await getLpStatus({ provider, walletAddress, poolAddress });
  if (!before.exists || before.lpBalance <= 0n) throw new Error("No LP position found to remove");

  log(`[LP] Current LP balance: ${before.lpBalance}`, "info");

  // Approve LP tokens to Manager
  await ensureApproval({
    wallet, provider, tokenAddress: poolAddress, spender: managerAddress,
    amount: before.lpBalance, getFeeParams, getNextNonce, chainId, log
  });

  // Note: removeLiquidity selector is not yet identified from a reference transaction.
  log(`[LP] Remove Liquidity: selector not yet identified. Use the Nemesis UI at https://nemesis.trade/liquidity to remove liquidity.`, "warn");
  log(`[LP] To identify the selector, submit a manual removeLiquidity transaction on the Nemesis UI and provide the transaction hash.`, "warn");
  throw new Error("Remove Liquidity not yet supported: the function selector on the Nemesis Manager contract has not been identified. Please remove liquidity via the Nemesis UI.");
}
