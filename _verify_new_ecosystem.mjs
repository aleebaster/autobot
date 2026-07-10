import { ethers } from "ethers";

const RPC = "https://ethereum-sepolia-rpc.publicnode.com/557d07a988c4164482ef0c56a10f98ee0e3073440fd72fbe89cd7f6fef809388";
const provider = new ethers.JsonRpcProvider(RPC, 11155111);
const pk = (await import("fs")).readFileSync("pk.txt", "utf8").trim();
const wallet = new ethers.Wallet(pk, provider);

const WETH = "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9";
const DAI_NEW = "0x8a871311feF28B3d684Fb4F06B964603196BD4E3";
const FACTORY_NEW = "0x3A4A7D9ED3701bB331f6E6040362614ab1D787D3";
const ROUTER_NEW = "0x5b23F24b08fa3FAa0Fa555611ACF74c3bAb23550";

const FACTORY_ABI = [
  "function getPool(address tokenA, address tokenB) view returns (address)",
  "function getManager(address pool) view returns (address)",
  "function allPoolsLength() view returns (uint256)"
];

const POOL_ABI = [
  "function getReserves() view returns (uint112, uint112, uint32)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function totalSupply() view returns (uint256)"
];

const MANAGER_ABI = [
  "function openPosition(bool isLong, address collateralToken, uint256 collateralAmount, uint256 borrowAmount, uint256 leverageX10, uint256 amountOutMin, uint256 deadline) payable returns (uint256)",
  "function closePosition(uint256 positionId, uint256 amountOutMin, uint256 deadline) returns (uint256)",
  "function getAvailableLiquidity() view returns (uint256)",
  "function getPosition(uint256 positionId) view returns (tuple(uint256 positionId, address owner, bool isLong, address collateralToken, uint256 collateralAmount, uint256 borrowAmount, uint256 leverageX10, uint256 entryPrice, uint256 lastUpdated))",
  "function getOraclePrice() view returns (uint256)"
];

const ROUTER_ABI = [
  "function swapExactETHForTokens(uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) payable returns (uint256[] memory)",
  "function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) returns (uint256[] memory)",
  "function getAmountsOut(uint256 amountIn, address[] calldata path) view returns (uint256[] memory)"
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)"
];

console.log("=== NEW ECOSYSTEM DEEP VERIFICATION ===\n");

// 1. Pool details
const factory = new ethers.Contract(FACTORY_NEW, FACTORY_ABI, provider);
const poolAddr = await factory.getPool(WETH, DAI_NEW);
const managerAddr = await factory.getManager(poolAddr);
console.log(`Pool (WETH/DAI_NEW): ${poolAddr}`);
console.log(`Manager: ${managerAddr}`);

const pool = new ethers.Contract(poolAddr, POOL_ABI, provider);
const [t0, t1] = await Promise.all([pool.token0(), pool.token1()]);
const reserves = await pool.getReserves();
const totalSupply = await pool.totalSupply();
console.log(`token0: ${t0}`);
console.log(`token1: ${t1}`);
console.log(`Reserves: ${reserves[0].toString()} / ${reserves[1].toString()}`);
console.log(`Pool totalSupply: ${totalSupply.toString()}`);

// 2. Manager details
const manager = new ethers.Contract(managerAddr, MANAGER_ABI, provider);
const liquidity = await manager.getAvailableLiquidity();
const oraclePrice = await manager.getOraclePrice();
console.log(`\nManager available liquidity: ${liquidity.toString()}`);
console.log(`Manager oracle price: ${oraclePrice.toString()}`);

// 3. Wallet DAI balance
const dai = new ethers.Contract(DAI_NEW, ERC20_ABI, provider);
const daiBalance = await dai.balanceOf(wallet.address);
const daiAllowance = await dai.allowance(wallet.address, managerAddr);
console.log(`\nWallet DAI balance: ${daiBalance.toString()}`);
console.log(`DAI allowance to Manager: ${daiAllowance.toString()}`);

// 4. Try Router getAmountsOut with NEW factory's pool
const router = new ethers.Contract(ROUTER_NEW, ROUTER_ABI, provider);
try {
  const amounts = await router.getAmountsOut(ethers.parseEther("0.001"), [WETH, DAI_NEW]);
  console.log(`\nRouter NEW getAmountsOut(0.001 ETH -> DAI): ${amounts[1].toString()}`);
} catch (e) {
  console.log(`\nRouter NEW getAmountsOut ERROR: ${e.message?.slice(0, 200)}`);
}

// 5. Check if OLD manager still works for close
const FACTORY_OLD = "0x938B84B0F4E02B008dDf5FF3108C4DCd163e1318";
const factoryOld = new ethers.Contract(FACTORY_OLD, FACTORY_ABI, provider);
const poolOldAddr = await factoryOld.getPool(WETH, "0xf43ca549bb166cd3b165b5262226bba8cb4114dc");
const managerOldAddr = await factoryOld.getManager(poolOldAddr);
console.log(`\n=== OLD ECOSYSTEM (for comparison) ===`);
console.log(`Old Pool: ${poolOldAddr}`);
console.log(`Old Manager: ${managerOldAddr}`);

const managerOld = new ethers.Contract(managerOldAddr, MANAGER_ABI, provider);
const oldLiquidity = await managerOld.getAvailableLiquidity();
const oldOraclePrice = await managerOld.getOraclePrice();
console.log(`Old Manager liquidity: ${oldLiquidity.toString()}`);
console.log(`Old Manager oracle price: ${oldOraclePrice.toString()}`);

// 6. List all pools on NEW factory
const newPoolsLen = await factory.allPoolsLength();
console.log(`\nNEW Factory total pools: ${newPoolsLen.toString()}`);

const oldPoolsLen = await factoryOld.allPoolsLength();
console.log(`OLD Factory total pools: ${oldPoolsLen.toString()}`);

console.log("\nDONE");
