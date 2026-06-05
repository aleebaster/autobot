import { ethers } from "ethers";

const ROUTER_LP_ABI = [
  "function factory() view returns (address)",
  "function WETH() view returns (address)",
  "function addLiquidityETH(address token,uint256 amountTokenDesired,uint256 amountTokenMin,uint256 amountETHMin,address to,uint256 deadline) payable returns (uint256 amountToken,uint256 amountETH,uint256 liquidity)",
  "function removeLiquidityETH(address token,uint256 liquidity,uint256 amountTokenMin,uint256 amountETHMin,address to,uint256 deadline) returns (uint256 amountToken,uint256 amountETH)"
];

const FACTORY_ABI = [
  "function getPair(address tokenA,address tokenB) view returns (address)",
  "function getPool(address tokenA,address tokenB) view returns (address)"
];

const ERC20_ABI = [
  "function approve(address spender,uint256 amount) returns (bool)",
  "function allowance(address owner,address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)"
];

const PAIR_ABI = [
  ...ERC20_ABI,
  "function totalSupply() view returns (uint256)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112 reserve0,uint112 reserve1,uint32 blockTimestampLast)"
];

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function minAmount(amount, slippagePercent) {
  const bps = BigInt(Math.max(0, Math.min(10000, Math.floor(Number(slippagePercent) * 100))));
  return amount * (10000n - bps) / 10000n;
}

function getOptimalAddAmounts({ ethAmount, tokenAmount, status, wethAddress, tokenAddress }) {
  if (!status.reserves || status.totalSupply === 0n) return { optimalEth: ethAmount, optimalToken: tokenAmount };
  const token0 = status.token0.toLowerCase();
  const reserveEth = token0 === wethAddress.toLowerCase() ? status.reserves[0] : status.reserves[1];
  const reserveToken = token0 === tokenAddress.toLowerCase() ? status.reserves[0] : status.reserves[1];
  if (reserveEth === 0n || reserveToken === 0n) return { optimalEth: ethAmount, optimalToken: tokenAmount };

  const tokenForEth = ethAmount * reserveToken / reserveEth;
  if (tokenForEth <= tokenAmount) return { optimalEth: ethAmount, optimalToken: tokenForEth };

  const ethForToken = tokenAmount * reserveEth / reserveToken;
  return { optimalEth: ethForToken, optimalToken: tokenAmount };
}

function short(value) {
  return value ? `${value.slice(0, 6)}...${value.slice(-4)}` : "N/A";
}

async function ensureApproval({ wallet, provider, tokenAddress, spender, amount, getFeeParams, getNextNonce, chainId, log }) {
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);
  const allowance = await token.allowance(wallet.address, spender);
  if (allowance >= amount) {
    log(`[LP] Allowance sufficient for ${short(tokenAddress)}.`, "info");
    return;
  }

  const feeParams = await getFeeParams(provider);
  const nonce = await getNextNonce(provider, wallet.address, chainId);
  const tx = await token.approve(spender, ethers.MaxUint256, { ...feeParams, gasLimit: 100000n, nonce });
  log(`[LP] Approve sent tx=${tx.hash}`, "warn");
  const receipt = await tx.wait();
  if (receipt.status !== 1) throw new Error("LP approve reverted");
  log(`[LP] Approve confirmed tx=${tx.hash}`, "success");
}

export async function getLpPair({ provider, routerAddress, tokenAddress }) {
  const router = new ethers.Contract(routerAddress, ROUTER_LP_ABI, provider);
  const [factoryAddress, wethAddress] = await Promise.all([router.factory(), router.WETH()]);
  const factory = new ethers.Contract(factoryAddress, FACTORY_ABI, provider);
  let pairAddress;
  try {
    pairAddress = await factory.getPair(wethAddress, tokenAddress);
  } catch (error) {
    pairAddress = await factory.getPool(wethAddress, tokenAddress);
  }
  return { router, factoryAddress, wethAddress, pairAddress };
}

export async function getLpStatus({ provider, walletAddress, routerAddress, tokenAddress }) {
  const { factoryAddress, wethAddress, pairAddress } = await getLpPair({ provider, routerAddress, tokenAddress });
  if (!pairAddress || pairAddress === ZERO_ADDRESS) {
    return { factoryAddress, wethAddress, pairAddress: ZERO_ADDRESS, lpBalance: 0n, totalSupply: 0n, exists: false };
  }

  const pair = new ethers.Contract(pairAddress, PAIR_ABI, provider);
  const [lpBalance, totalSupply, token0, token1, reserves] = await Promise.all([
    pair.balanceOf(walletAddress),
    pair.totalSupply(),
    pair.token0(),
    pair.token1(),
    pair.getReserves()
  ]);

  return { factoryAddress, wethAddress, pairAddress, lpBalance, totalSupply, token0, token1, reserves, exists: lpBalance > 0n };
}

export async function addLiquidity({ wallet, provider, config, routerAddress, tokenAddress, tokenDecimals, chainId, getFeeParams, getNextNonce, log }) {
  const router = new ethers.Contract(routerAddress, ROUTER_LP_ABI, wallet);
  const tokenAmount = ethers.parseUnits(String(config.lpDaiAmount), tokenDecimals);
  const ethAmount = ethers.parseEther(String(config.lpEthAmount));
  if (tokenAmount <= 0n || ethAmount <= 0n) throw new Error("LP amounts must be greater than zero");

  await ensureApproval({ wallet, provider, tokenAddress, spender: routerAddress, amount: tokenAmount, getFeeParams, getNextNonce, chainId, log });

  const before = await getLpStatus({ provider, walletAddress: wallet.address, routerAddress, tokenAddress });
  const { optimalEth, optimalToken } = getOptimalAddAmounts({ ethAmount, tokenAmount, status: before, wethAddress: before.wethAddress, tokenAddress });
  const deadline = Math.floor(Date.now() / 1000) + 1200;
  const feeParams = await getFeeParams(provider);
  const nonce = await getNextNonce(provider, wallet.address, chainId);
  const tx = await router.addLiquidityETH(
    tokenAddress,
    tokenAmount,
    minAmount(optimalToken, config.lpSlippage),
    minAmount(optimalEth, config.lpSlippage),
    wallet.address,
    deadline,
    { ...feeParams, value: ethAmount, gasLimit: 600000n, nonce }
  );
  log(`[LP] Add liquidity sent tx=${tx.hash}`, "warn");
  const receipt = await tx.wait();
  if (receipt.status !== 1) throw new Error("LP add liquidity reverted");

  const after = await getLpStatus({ provider, walletAddress: wallet.address, routerAddress, tokenAddress });
  if (!after.exists || after.lpBalance <= before.lpBalance) throw new Error("LP add verification failed: LP balance did not increase");
  log(`[LP] Add verified pair=${after.pairAddress} lp=${after.lpBalance.toString()}`, "success");
  return { receipt, before, after };
}

export async function removeLiquidity({ wallet, provider, config, routerAddress, tokenAddress, chainId, getFeeParams, getNextNonce, log }) {
  const before = await getLpStatus({ provider, walletAddress: wallet.address, routerAddress, tokenAddress });
  if (!before.exists || before.lpBalance <= 0n) throw new Error("No LP position found to remove");

  await ensureApproval({ wallet, provider, tokenAddress: before.pairAddress, spender: routerAddress, amount: before.lpBalance, getFeeParams, getNextNonce, chainId, log });

  const router = new ethers.Contract(routerAddress, ROUTER_LP_ABI, wallet);
  const deadline = Math.floor(Date.now() / 1000) + 1200;
  const feeParams = await getFeeParams(provider);
  const nonce = await getNextNonce(provider, wallet.address, chainId);
  const tx = await router.removeLiquidityETH(
    tokenAddress,
    before.lpBalance,
    0n,
    0n,
    wallet.address,
    deadline,
    { ...feeParams, gasLimit: 600000n, nonce }
  );
  log(`[LP] Remove liquidity sent tx=${tx.hash}`, "warn");
  const receipt = await tx.wait();
  if (receipt.status !== 1) throw new Error("LP remove liquidity reverted");

  const after = await getLpStatus({ provider, walletAddress: wallet.address, routerAddress, tokenAddress });
  if (after.lpBalance >= before.lpBalance) throw new Error("LP remove verification failed: LP balance did not decrease");
  log(`[LP] Remove verified pair=${before.pairAddress} remainingLp=${after.lpBalance.toString()}`, "success");
  return { receipt, before, after };
}
