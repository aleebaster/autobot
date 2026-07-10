import { ethers } from "ethers";

const RPC = "https://ethereum-sepolia-rpc.publicnode.com/557d07a988c4164482ef0c56a10f98ee0e3073440fd72fbe89cd7f6fef809388";
const provider = new ethers.JsonRpcProvider(RPC, 11155111);

const ERC20_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)"
];

async function checkToken(addr) {
  try {
    const c = new ethers.Contract(addr, ERC20_ABI, provider);
    const [name, symbol, decimals] = await Promise.all([c.name(), c.symbol(), c.decimals()]);
    console.log(`${addr}: ${name} (${symbol}) decimals=${decimals}`);
  } catch(e) {
    console.log(`${addr}: ERROR - ${e.message?.slice(0, 80)}`);
  }
}

// Tokens found in NEW factory pools
console.log("=== Tokens in NEW factory pools ===");
await checkToken("0xF763Ae0e44B4f9f29af22d3e4e1a8c12bB629986");
await checkToken("0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9");
await checkToken("0x8a871311feF28B3d684Fb4F06B964603196BD4E3");

// Tokens found in OLD factory pools
console.log("\n=== Tokens in OLD factory pools ===");
await checkToken("0x7F37A0B83d5E67b2C1A7F3c4E8B9D2F5A1C3E6B7");
await checkToken("0xf43ca549bb166cd3b165b5262226bba8cb4114dc");
await checkToken("0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9");

// Check what the router sees for WETH→DAI_NEW
const ROUTER_NEW = "0x5b23F24b08fa3FAa0Fa555611ACF74c3bAb23550";
const WETH = "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9";
const DAI_NEW = "0x8a871311feF28B3d684Fb4F06B964603196BD4E3";

const router = new ethers.Contract(ROUTER_NEW, [
  "function getAmountsOut(uint256 amountIn, address[] calldata path) view returns (uint256[] memory)"
], provider);

console.log("\n=== Router NEW quotes ===");
const out1 = await router.getAmountsOut(ethers.parseEther("1"), [WETH, DAI_NEW]);
console.log(`1 ETH → DAI_NEW: ${out1[1].toString()} (${Number(out1[1]) / 1e6} DAI)`);

const out2 = await router.getAmountsOut(ethers.parseEther("0.1"), [WETH, DAI_NEW]);
console.log(`0.1 ETH → DAI_NEW: ${out2[1].toString()} (${Number(out2[1]) / 1e6} DAI)`);

// Also check with the old DAI on new router
const out3 = await router.getAmountsOut(ethers.parseEther("1"), [WETH, "0xf43ca549bb166cd3b165b5262226bba8cb4114dc"]);
console.log(`1 ETH → DAI_OLD via NEW router: ${out3[1].toString()} (${Number(out3[1]) / 1e6} DAI)`);

console.log("\nDONE");
