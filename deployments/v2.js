// ═══════════════════════════════════════════════════════════════════════════════
//  V2 DEPLOYMENT — Nemesis X/USDT Pool Architecture (Verified 2026-08-15)
//  Pools: Token/USDT pairs (ETH/USDT, NEMESIS/USDT, DAI/USDT, UNI/USDT, etc.)
//  openPosition target: Pool contract (NOT manager — V2 change!)
//  closePosition target: NLP contract (needs on-chain verification)
//  Collateral rule: token0→LONG (isLong=true), token1→SHORT (isLong=false)
//  borrowAmount: computed locally (frontend pattern) or pass 0n
// ═══════════════════════════════════════════════════════════════════════════════

export const V2_PROFILE = {
  id: "v2",
  name: "V2 — Token/USDT Pools",
  version: "2.0.0",
  chainId: 11155111,
  status: "active",

  // Core contracts (confirmed on-chain + in frontend JS bundles)
  factory:    "0x28e90C39CF9f65fc24000B563EFDEBB81a730a11",
  router:     "0x4Db34a545988d19C9842a0C2E7e02eE56631a202",

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

  // Default collateral
  defaultCollateral: "0x5f2E83cCDEa73D60aF400e03F1Cd8Fb9eaB07b20", // USDT

  // V2 positions: openPosition targets Manager contract (forensic-verified 2026-08-15)
  // V2 frontend resolves vaultAddress = Factory.getManager(pool) and calls openPosition on it
  positionTarget: "manager", // "manager" | "pool"

  // V2 closePosition targets Manager (same as open)
  closeTarget: "manager", // "manager" | "nlp" | "pool"

  // V2 borrowAmount: computed off-chain (same formula as frontend aAv/f())
  // V2 Manager requires non-zero borrowAmount — passing 0n triggers MAM_ZeroBorrow()
  borrowAmountMode: "computed", // "zero" | "computed" | "frontend"

  // V2 collateral rules (same pool-aware logic: token0→LONG, token1→SHORT)
  collateralRules: {
    mode: "pool-aware",
  },

  // V2 error selectors (different mapping from V1 for 0x499ad952)
  errorSelectors: {
    "0x7939f424": "MAM_BROKEN_PROXY",
    "0x24811982": "MAM_WRONG_COLLATERAL_TOKEN",
    "0x499ad952": "Router_InsufficientOutputAmount (V2) vs POSITION_NOT_ALLOWED (V1)",
  },

  // V2 market discovery: hybrid (subgraph + on-chain Factory)
  discovery: {
    method: "hybrid", // V2 Factory doesn't respond to getPool(address,address) — subgraph-based
    subgraphUrl: "https://api.goldsky.com/api/public/project_cmma0sxdrnwdx01ym126h3z8q/subgraphs/nemesis-eth-sepolia/prod/gn",
  },

  // V2 pool info format
  poolInfo: {
    hasPoolToken0: true,
    hasOraclePrice: true,
    hasSwapFeeBps: true,
    hasLiquidity: true,
    codeSize: 23326, // V2 pools have 23326 chars code (V1 had 23132)
  },

  // V2 positions info
  positionInfo: {
    returnsHealthFactor: true,
  },

  // V2 known markets (from Factory on-chain audit 2026-08-27)
  // NOTE: poolToken0 is read on-chain from pool.token0() — do NOT hardcode.
  // The values below are for reference only; the bot reads them dynamically.
  knownMarkets: [
    { symbol: "NEMESIS/USDT", collateralToken: "0x18D18A40614b6d8C6154309F517acf9829308842", collateralSymbol: "NEMESIS", collateralDecimals: 6 },
    { symbol: "ETH/USDT",     collateralToken: "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9", collateralSymbol: "ETH",     collateralDecimals: 18 },
    { symbol: "DAI/USDT",     collateralToken: "0xa3215a5cA659e0Bd57c0B33d5EAD71901A24d3d6", collateralSymbol: "DAI",     collateralDecimals: 6 },
    { symbol: "USDC/USDT",    collateralToken: "0x5dcf1Db10F87CB7839640F9B85C4ECfA29b56e80", collateralSymbol: "USDC",    collateralDecimals: 6 },
    { symbol: "UNI/USDT",     collateralToken: "0xEaBEcd70AC3330d65e09e429824C49d0D8812952", collateralSymbol: "UNI",     collateralDecimals: 6 },
    { symbol: "LINK/USDT",    collateralToken: "0x1132087D2D97b55E5fe1B0FcA7b99348B5f07e28", collateralSymbol: "LINK",    collateralDecimals: 6 },
  ],

  // V2 confirmed pools (from Factory on-chain audit 2026-08-27)
  // These are FALLBACK addresses — the bot always prefers Factory.getPool() results.
  confirmedPools: {
    "ETH/USDT": {
      pool:    "0xb0ef1Fc1AB4365F1705c259227582355C03276dd",
      manager: "0x3a0856852516eF5E6f8994c44a7eC36c2af98dE7",
    },
    "NEMESIS/USDT": {
      pool:    "0xE3a38CD42c196cC8d0dfF9B17b23963451Ccd56c",
      manager: "0x8cB04f6156B0F1aBA1665A1F070F06d295789F87",
    },
    "USDC/USDT": {
      pool:    "0x81EBBaeb9e4A967Bdf93DD90849f0fB735a63Fc0",
      manager: "0x900aC0cE0834CeC50f2BC4189861Ec26E601A52D",
    },
    "UNI/USDT": {
      pool:    "0x8FcB1B1C4db8dfcF60c4A237B2ccb97c9F16b80B",
      manager: "0xcAf433B95CffE46934Df8a0ffA1BC507Cde85817",
    },
    "DAI/USDT": {
      pool:    "0x5334eBf8e139EB574DD781e5Ad390de9C3f3A91E",
      manager: "0x24A54B4129d2E70Bef948F2DAf8FbFc505706dc1",
    },
    "LINK/USDT": {
      pool:    "0xFf934309981CB59828D6048D5670Df5145028b2a",
      manager: "0x077036b3f02D31B94c82f50acbe2d50B6CCe81d8",
    },
  },

  // V2 router ABI — includes V2-specific function signatures
  routerAbi: [
    "function swapExactETHForTokens(uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) payable returns (uint256[] memory)",
    "function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) returns (uint256[] memory)",
    "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) returns (uint256[] memory)",
    "function getAmountsOut(uint256 amountIn, address[] calldata path) view returns (uint256[] memory amounts)",
  ],
};
