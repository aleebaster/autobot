// ═══════════════════════════════════════════════════════════════════════════════
//  V3 DEPLOYMENT — NOT YET CONFIGURED
//  No contract addresses known. Placeholder for future deployment.
// ═══════════════════════════════════════════════════════════════════════════════

export const V3_PROFILE = {
  id: "v3",
  name: "V3 — NOT CONFIGURED",
  version: "3.0.0",
  chainId: 11155111,
  status: "unknown",

  factory:    "0x0000000000000000000000000000000000000000",
  router:     "0x0000000000000000000000000000000000000000",

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

  defaultCollateral: "0x5f2E83cCDEa73D60aF400e03F1Cd8Fb9eaB07b20",

  positionTarget: "unknown",
  closeTarget: "unknown",
  borrowAmountMode: "unknown",

  collateralRules: { mode: "unknown" },

  errorSelectors: {},

  discovery: {
    method: "unknown",
    subgraphUrl: "https://api.goldsky.com/api/public/project_cmma0sxdrnwdx01ym126h3z8q/subgraphs/nemesis-eth-sepolia/prod/gn",
  },

  knownMarkets: [],
  confirmedPools: {},
};
