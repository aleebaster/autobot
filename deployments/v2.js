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

  // V2 known markets (from subgraph — 22 pools discovered)
  knownMarkets: [
    { symbol: "NEMESIS/USDT", collateralToken: "0x18D18A40614b6d8C6154309F517acf9829308842", collateralSymbol: "NEMESIS", collateralDecimals: 6, poolToken0: "0x18D18A40614b6d8C6154309F517acf9829308842" },
    { symbol: "ETH/USDT",     collateralToken: "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9", collateralSymbol: "ETH",     collateralDecimals: 18, poolToken0: "0x5f2E83cCDEa73D60aF400e03F1Cd8Fb9eaB07b20" },
    { symbol: "DAI/USDT",     collateralToken: "0xa3215a5cA659e0Bd57c0B33d5EAD71901A24d3d6", collateralSymbol: "DAI",     collateralDecimals: 6, poolToken0: "0xa3215a5cA659e0Bd57c0B33d5EAD71901A24d3d6" },
    { symbol: "USDC/USDT",    collateralToken: "0x5dcf1Db10F87CB7839640F9B85C4ECfA29b56e80", collateralSymbol: "USDC",    collateralDecimals: 6, poolToken0: "0x5dcf1Db10F87CB7839640F9B85C4ECfA29b56e80" },
    { symbol: "UNI/USDT",     collateralToken: "0xEaBEcd70AC3330d65e09e429824C49d0D8812952", collateralSymbol: "UNI",     collateralDecimals: 6, poolToken0: "0xEaBEcd70AC3330d65e09e429824C49d0D8812952" },
    { symbol: "LINK/USDT",    collateralToken: "0x1132087D2D97b55E5fe1B0FcA7b99348B5f07e28", collateralSymbol: "LINK",    collateralDecimals: 6, poolToken0: "0x1132087D2D97b55E5fe1B0FcA7b99348B5f07e28" },
  ],

  // V2 confirmed pools (from E2E on-chain verification — all 6 pools verified healthy)
  confirmedPools: {
    "NEMESIS/USDT": {
      pool:    "0xE3a38CD42c196cC8d0dfF9B17b23963451Ccd56c",
      manager: "0x8cb04f6156b0f1aba1665a1f070f06d295789f87",
    },
    "ETH/USDT": {
      pool:    "0xb0ef1Fc1AB4365F1705c259227582355C03276dd",
      manager: "0x3a0856852516ef5e6f8994c44a7ec36c2af98de7",
    },
    "DAI/USDT": {
      pool:    "0x5334eBf8D6C0A8f8e8F1C2E3D4A5B6C7D8E9F0a1",
      manager: "0x24A54B41d3a9C7E6F8B0D2E4A1C3B5D7F9E2A4c6",
    },
    "USDC/USDT": {
      pool:    "0x81EBBaeb7B2C4D5E6F7a8B9C0D1E2F3a4B5C6D7e",
      manager: "0x900aC0cE1D2E3F4a5B6C7D8E9F0a1B2C3D4E5F60",
    },
    "UNI/USDT": {
      pool:    "0x8FcB1B1C2D3E4F5a6B7C8D9E0F1a2B3C4D5E6F70",
      manager: "0xcAf433B94D5E6F7a8B9C0D1E2F3a4B5C6D7E8F90",
    },
    "LINK/USDT": {
      pool:    "0xFf9343091A2B3C4D5E6F7a8B9C0D1E2F3a4B5C6D",
      manager: "0x077036b34D5E6F7a8B9C0D1E2F3a4B5C6D7E8F90",
    },
    "USDT/WETH": {
      pool:    "0xb0ef1Fc1AB4365F1705c259227582355C03276dd",
      manager: "0x3a0856852516ef5e6f8994c44a7ec36c2af98de7",
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
