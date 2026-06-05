export const DEFAULT_LP_CONFIG = {
  lpEnabled: false,
  lpPair: "ETH/DAI",
  lpEthAmount: "0.001",
  lpDaiAmount: "0.5",
  lpWaitMinutes: 5,
  lpCooldownMinutes: 5,
  lpSlippage: 1,
  lpCycles: 1
};

export function loadLpConfig(rawConfig = {}) {
  return {
    lpEnabled: rawConfig.lpEnabled === true,
    lpPair: rawConfig.lpPair || DEFAULT_LP_CONFIG.lpPair,
    lpEthAmount: String(rawConfig.lpEthAmount ?? DEFAULT_LP_CONFIG.lpEthAmount),
    lpDaiAmount: String(rawConfig.lpDaiAmount ?? DEFAULT_LP_CONFIG.lpDaiAmount),
    lpWaitMinutes: Math.max(0, Number(rawConfig.lpWaitMinutes) || DEFAULT_LP_CONFIG.lpWaitMinutes),
    lpCooldownMinutes: Math.max(0, Number(rawConfig.lpCooldownMinutes) || DEFAULT_LP_CONFIG.lpCooldownMinutes),
    lpSlippage: Math.max(0, Number(rawConfig.lpSlippage) || DEFAULT_LP_CONFIG.lpSlippage),
    lpCycles: Math.max(1, Number(rawConfig.lpCycles) || DEFAULT_LP_CONFIG.lpCycles)
  };
}

export function serializeLpConfig(lpConfig) {
  return loadLpConfig(lpConfig);
}
