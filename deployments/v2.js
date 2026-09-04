// ═══════════════════════════════════════════════════════════════════════════════
//  V2 DEPLOYMENT — Nemesis X/USDT Pool Architecture
//  UPDATED 2026-09-04 — NEW Factory discovered via reference manual tx
//  Pools: Token/USDT pairs (ETH/USDT, NEMESIS/USDT, DAI/USDT, UNI/USDT, etc.)
//  openPosition target: Manager contract (V2 pattern)
//  closePosition target: Manager contract
//  Collateral rule: token0→LONG (isLong=true), token1→SHORT (isLong=false)
//  borrowAmount: computed locally (frontend pattern) or pass 0n
// ═══════════════════════════════════════════════════════════════════════════════

export const V2_PROFILE = {
  id: "v2",
  name: "V2 — Token/USDT Pools",
  version: "2.1.0",
  chainId: 11155111,
  status: "active",

  // Core contracts (verified on-chain via reference manual tx 2026-09-04)
  // Manual tx 0x47b31... used router 0x8f6eB7... → confirmed via Factory.router()
  factory:    "0xdED3D3CA2F7eFDE734790ce51bD03D5145E4830B",
  router:     "0x8f6eB7870334b1FD8006Fd52413f01689f4E57e9",

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

  // V2 market discovery: on-chain Factory.getPool() (verified working on new factory)
  discovery: {
    method: "on-chain", // New factory supports getPool(tokenA, tokenB)
    subgraphUrl: "https://api.goldsky.com/api/public/project_cmma0sxdrnwdx01ym126h3z8q/subgraphs/nemesis-eth-sepolia/prod/gn",
  },

  // V2 pool info format
  poolInfo: {
    hasPoolToken0: true,
    hasOraclePrice: true,
    hasSwapFeeBps: true,
    hasLiquidity: true,
    codeSize: 23680, // New V2 pools have 23680 chars code (old V2 had 23326, V1 had 23132)
  },

  // V2 positions info
  positionInfo: {
    returnsHealthFactor: true,
  },

  // V2 known markets (verified on-chain via new factory 2026-09-04)
  // Reference manual tx: 0x47b3102165c64dfab92463ec59f985c879bcbfaa724cf465a4084c8d8a46ddd4
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

  // V2 confirmed pools (verified on-chain 2026-09-04)
  // ⚠️ UNI/USDT, DAI/USDT, LINK/USDT pools have 0 bytes on-chain — NOT DEPLOYED
  // These are FALLBACK addresses — the bot always prefers Factory.getPool() results.
  confirmedPools: {
    "ETH/USDT": {
      pool:    "0xf32E24b7F739c7C17544cb972833aB551121A72B",
      manager: "0x2069b502DD917DC089171F96BeE390FcB5bad29d",
      deployed: true,
    },
    "NEMESIS/USDT": {
      pool:    "0x792bCdbe39E6aF13EeEbab251Cb59D6824EBe28e",
      manager: "0xD45dde32C66769ED835A0F0f45EC0bF6973857FD",
      deployed: true,
    },
    "USDC/USDT": {
      pool:    "0x7E0F5abE7ac2d7F609C70d5eEae4c3aeB6c8606e",
      manager: "0xAbC78D0650f47426DeF16286FF0cE9CFD501e80e",
      deployed: true,
    },
    "UNI/USDT": {
      pool:    "0x07a44c21688c0dB4486B6325EDf0a0C2C9c00571",
      manager: "0x6238f87Dd84DA1DA2b0e93b22b380c710EE674a7",
      deployed: false, // Pool has 0 bytes on-chain
    },
    "DAI/USDT": {
      pool:    "0x5e7821F6B0Aa6716e9E2046B2aB91C0E94b74716",
      manager: "0x46c9835f3412f25Fd2706fDc8aDf04B14f943289",
      deployed: false, // Pool has 0 bytes on-chain
    },
    "LINK/USDT": {
      pool:    "0xd9Ab0698D658AFc6221DcA6BF7b70B4005aE44c5",
      manager: "0xF603d60B713e557dc199DDceaCF370eA90ECC00E",
      deployed: false, // Pool has 0 bytes on-chain
    },
  },

  // V2 router ABI — includes V2-specific function signatures
  routerAbi: [
    "function swapExactETHForTokens(uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) payable returns (uint256[] memory)",
    "function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) returns (uint256[] memory)",
    "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) returns (uint256[] memory)",
    "function getAmountsOut(uint256 amountIn, address[] calldata path) view returns (uint256[] memory amounts)",
  ],

  // V2 position ABI — confirmed on-chain 2026-09-04
  // Selector 0xfa2b1dfd = openPosition(bool,address,uint256,uint256,uint256,uint256,uint256)
  // Selector 0xb35648d7 = closePosition(uint256,uint256,uint256) — confirmed via Nemesis frontend + E2E
  // Selector 0x3f3cd555 = withdrawWithLiquidity(...) — LP withdrawal, NOT position close
  // Selector 0x7ecebe00 = nonces(address) — EIP-712 nonces
  // Leverage encoding: 20=2x, 30=3x, 40=4x, 50=5x (leverage / 10)
  // LONG collateral = USDT, SHORT collateral = WETH
  // positionId = PositionCreated event topic[2]
  positionAbi: [
    "function openPosition(bool isLong, address collateralToken, uint256 collateralAmount, uint256 amountOutMin, uint256 leverage, uint256 size, uint256 deadline) returns (uint256)",
    "function closePosition(uint256 positionId, uint256 amountOutMin, uint256 deadline)",
    "function withdrawWithLiquidity(uint256 positionId, address collateralToken, address marketToken, uint256 amount, uint256 amount2, address recipient, address refundTo, uint256 deadline)",
    "function nonces(address user) view returns (uint256)",
    "function balanceOf(address account) view returns (uint256)",
    "function totalSupply() view returns (uint256)",
    "function asset() view returns (address)",
    "function totalAssets() view returns (uint256)",
    "function factory() view returns (address)",
  ],
};
