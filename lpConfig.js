export const DEFAULT_LP_CONFIG = {
  lpEnabled: false,
  lpPair: "ETH/DAI",
  lpTokenA: "ETH",
  lpTokenB: "DAI",
  lpCustomTokenAddress: "",
  lpAmountMode: "fixed",
  lpEthAmount: "0.001",
  lpDaiAmount: "0.5",
  lpTokenAAmount: "0.001",
  lpTokenBAmount: "0.5",
  lpWalletPercent: 1,
  lpWaitMinutes: 5,
  lpCooldownMinutes: 5,
  lpSlippage: 1,
  lpAutoRebalance: false,
  lpAutoRemoveMinutes: 0,
  lpMinLiquidity: "0",
  lpRetryAttempts: 1,
  lpRetryDelaySeconds: 10,
  lpCycles: 1
};

function getPairParts(pair) {
  const [tokenA = "ETH", tokenB = "DAI"] = String(pair || DEFAULT_LP_CONFIG.lpPair).split("/").map(part => part.trim().toUpperCase());
  return { tokenA, tokenB };
}

function clampNumber(value, fallback, min = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= min ? number : fallback;
}

export function loadLpConfig(rawConfig = {}) {
  const pair = rawConfig.lpPair || DEFAULT_LP_CONFIG.lpPair;
  const parts = getPairParts(pair);
  const tokenAAmount = String(rawConfig.lpTokenAAmount ?? rawConfig.lpEthAmount ?? DEFAULT_LP_CONFIG.lpTokenAAmount);
  const tokenBAmount = String(rawConfig.lpTokenBAmount ?? rawConfig.lpDaiAmount ?? DEFAULT_LP_CONFIG.lpTokenBAmount);
  return {
    lpEnabled: rawConfig.lpEnabled === true,
    lpPair: pair,
    lpTokenA: rawConfig.lpTokenA || parts.tokenA,
    lpTokenB: rawConfig.lpTokenB || parts.tokenB,
    lpCustomTokenAddress: String(rawConfig.lpCustomTokenAddress || DEFAULT_LP_CONFIG.lpCustomTokenAddress),
    lpAmountMode: ["fixed", "walletPercent"].includes(rawConfig.lpAmountMode) ? rawConfig.lpAmountMode : DEFAULT_LP_CONFIG.lpAmountMode,
    lpEthAmount: tokenAAmount,
    lpDaiAmount: tokenBAmount,
    lpTokenAAmount: tokenAAmount,
    lpTokenBAmount: tokenBAmount,
    lpWalletPercent: clampNumber(rawConfig.lpWalletPercent, DEFAULT_LP_CONFIG.lpWalletPercent),
    lpWaitMinutes: clampNumber(rawConfig.lpWaitMinutes, DEFAULT_LP_CONFIG.lpWaitMinutes),
    lpCooldownMinutes: clampNumber(rawConfig.lpCooldownMinutes, DEFAULT_LP_CONFIG.lpCooldownMinutes),
    lpSlippage: clampNumber(rawConfig.lpSlippage, DEFAULT_LP_CONFIG.lpSlippage),
    lpAutoRebalance: rawConfig.lpAutoRebalance === true,
    lpAutoRemoveMinutes: clampNumber(rawConfig.lpAutoRemoveMinutes, DEFAULT_LP_CONFIG.lpAutoRemoveMinutes),
    lpMinLiquidity: String(rawConfig.lpMinLiquidity ?? DEFAULT_LP_CONFIG.lpMinLiquidity),
    lpRetryAttempts: Math.max(1, Math.floor(clampNumber(rawConfig.lpRetryAttempts, DEFAULT_LP_CONFIG.lpRetryAttempts, 1))),
    lpRetryDelaySeconds: clampNumber(rawConfig.lpRetryDelaySeconds, DEFAULT_LP_CONFIG.lpRetryDelaySeconds),
    lpCycles: Math.max(1, Math.floor(clampNumber(rawConfig.lpCycles, DEFAULT_LP_CONFIG.lpCycles, 1)))
  };
}

export function serializeLpConfig(lpConfig) {
  return loadLpConfig(lpConfig);
}
