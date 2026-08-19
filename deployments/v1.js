// ═══════════════════════════════════════════════════════════════════════════════
//  V1 DEPLOYMENT — Nemesis ETH/X Pool Architecture (Verified 2026-08-15)
//  Pools: ETH paired with collateral tokens (DAI, LINK, UNI, USDC, USDT, NEMESIS, TT1-3)
//  openPosition target: Manager contract
//  closePosition target: Manager contract
//  Collateral rule: token0 → LONG, token1 → SHORT
// ═══════════════════════════════════════════════════════════════════════════════

export const V1_PROFILE = {
  id: "v1",
  name: "V1 — ETH/X Pools",
  version: "1.0.0",
  chainId: 11155111,
  status: "deprecated",

  // Core contracts
  factory:    "0x0e733d055dbE7020f42D4f692Bc4fff15E5f2E7d",
  router:     "0xE787c35F6A875567409C4970BA7B41A0CB9d1B4D",

  // Token addresses (unchanged between V1/V2)
  tokens: {
    WETH:    "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9",
    ETH:     "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9",
    USDT:    "0x5f2E83cCDEa73D60aF400e03F1Cd8Fb9eaB07b20",
    USDC:    "0x5dcf1Db10F87CB7839640F9B85C4ECfA29b56e80",
    DAI:     "0xa3215a5cA659e0Bd57c0B33d5EAD71901A24d3d6",
    UNI:     "0xEaBEcd70AC3330d65e09e429824C49d0D8812952",
    LINK:    "0x1132087D2D97b55E5fe1B0FcA7b99348B5f07e28",
    NEMESIS: "0x18D18A40614b6d8C6154309F517acf9829308842",
  },

  // Default collateral (used when no market specified)
  defaultCollateral: "0x5f2E83cCDEa73D60aF400e03F1Cd8Fb9eaB07b20", // USDT

  // V1 positions: marketToken = any token (used in openPosition path)
  // V1 openPosition targets the Manager contract
  positionTarget: "manager", // "manager" | "pool"

  // V1 closePosition targets the Manager contract
  closeTarget: "manager", // "manager" | "nlp"

  // V1 borrowAmount: always 0n (computed on-chain)
  borrowAmountMode: "zero", // "zero" | "computed" | "frontend"

  // V1 collateral rules (pool-aware via poolToken0)
  collateralRules: {
    mode: "pool-aware", // "pool-aware" (token0→LONG, token1→SHORT)
  },

  // V1 error selectors
  errorSelectors: {
    "0x7939f424": "MAM_BROKEN_PROXY (Manager implementation has empty bytecode)",
    "0x24811982": "MAM_WRONG_COLLATERAL_TOKEN",
    "0x499ad952": "POSITION_NOT_ALLOWED",
  },

  // V1 market discovery
  discovery: {
    method: "factory", // "factory" | "subgraph" | "hybrid"
    subgraphUrl: "https://api.goldsky.com/api/public/project_cmma0sxdrnwdx01ym126h3z8q/subgraphs/nemesis-eth-sepolia/prod/gn",
  },

  // V1 pool info format: pool has token0/token1, reserves, oraclePrice
  poolInfo: {
    hasPoolToken0: true,
    hasOraclePrice: true,
    hasSwapFeeBps: true,
    hasLiquidity: true,
  },

  // V1 positions info: getPosition returns (isLong, user, collateralToken, collateralAmount, debtAmount, currentDebt, healthFactor)
  positionInfo: {
    returnsHealthFactor: true,
  },

  // V1 known markets (from config.json — 9 V1 pools)
  knownMarkets: [
    { symbol: "ETH/USDT",  collateralToken: "0x5f2E83cCDEa73D60aF400e03F1Cd8Fb9eaB07b20", collateralSymbol: "USDT",  collateralDecimals: 6, poolToken0: "0x5f2E83cCDEa73D60aF400e03F1Cd8Fb9eaB07b20" },
    { symbol: "ETH/USDC",  collateralToken: "0x5dcf1Db10F87CB7839640F9B85C4ECfA29b56e80", collateralSymbol: "USDC",  collateralDecimals: 6, poolToken0: "0x5dcf1Db10F87CB7839640F9B85C4ECfA29b56e80" },
    { symbol: "ETH/DAI",   collateralToken: "0xa3215a5cA659e0Bd57c0B33d5EAD71901A24d3d6", collateralSymbol: "DAI",   collateralDecimals: 6, poolToken0: "0xa3215a5cA659e0Bd57c0B33d5EAD71901A24d3d6" },
    { symbol: "ETH/UNI",   collateralToken: "0xEaBEcd70AC3330d65e09e429824C49d0D8812952", collateralSymbol: "UNI",   collateralDecimals: 6, poolToken0: "0xEaBEcd70AC3330d65e09e429824C49d0D8812952" },
    { symbol: "ETH/LINK",  collateralToken: "0x1132087D2D97b55E5fe1B0FcA7b99348B5f07e28", collateralSymbol: "LINK",  collateralDecimals: 6, poolToken0: "0x1132087D2D97b55E5fe1B0FcA7b99348B5f07e28" },
    { symbol: "ETH/NEMESIS", collateralToken: "0x18D18A40614b6d8C6154309F517acf9829308842", collateralSymbol: "NEMESIS", collateralDecimals: 6, poolToken0: "0x18D18A40614b6d8C6154309F517acf9829308842" },
    { symbol: "ETH/TT1",   collateralToken: "0x15C42b8181584e63d1111669c5e5C98b94C106E7", collateralSymbol: "TT1",   collateralDecimals: 6, poolToken0: "0x15C42b8181584e63d1111669c5e5C98b94C106E7" },
    { symbol: "ETH/TT2",   collateralToken: "0x4E49C6a26D5B14E7Ae9DB7be2f7470C98CE797c2", collateralSymbol: "TT2",   collateralDecimals: 6, poolToken0: "0x4E49C6a26D5B14E7Ae9DB7be2f7470C98CE797c2" },
    { symbol: "ETH/TT3",   collateralToken: "0xbbe3a2c8E8e745A84Bad510c79c6E6899a35843c", collateralSymbol: "TT3",   collateralDecimals: 6, poolToken0: "0xbbe3a2c8E8e745A84Bad510c79c6E6899a35843c" },
  ],
};
