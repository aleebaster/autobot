import { ethers } from "ethers";
import fs from "fs";

const RPC = "https://ethereum-sepolia-rpc.publicnode.com/557d07a988c4164482ef0c56a10f98ee0e3073440fd72fbe89cd7f6fef809388";
const provider = new ethers.JsonRpcProvider(RPC, 11155111);
const pk = fs.readFileSync("pk.txt", "utf8").trim();
const wallet = new ethers.Wallet(pk, provider);

const WETH = "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9";
const DAI_NEW = "0x8a871311feF28B3d684Fb4F06B964603196BD4E3";
const DAI_OLD = "0xf43ca549bb166cd3b165b5262226bba8cb4114dc";
const FACTORY_NEW = "0x3A4A7D9ED3701bB331f6E6040362614ab1D787D3";
const FACTORY_OLD = "0x938B84B0F4E02B008dDf5FF3108C4DCd163e1318";
const ROUTER_NEW = "0x5b23F24b08fa3FAa0Fa555611ACF74c3bAb23550";

const FACTORY_ABI = [
  "function getPool(address tokenA, address tokenB) view returns (address)",
  "function getManager(address pool) view returns (address)",
  "function allPoolsLength() view returns (uint256)",
  "function allPools(uint256) view returns (address)"
];

const MANAGER_ABI = [
  "function openPosition(bool isLong, address collateralToken, uint256 collateralAmount, uint256 borrowAmount, uint256 leverageX10, uint256 amountOutMin, uint256 deadline) payable returns (uint256)",
  "function closePosition(uint256 positionId, uint256 amountOutMin, uint256 deadline) returns (uint256)",
  "function getAvailableLiquidity() view returns (uint256)",
  "function getOraclePrice() view returns (uint256)",
  "function getSideOpenInterest(address token, bool isLong) view returns (uint256)"
];

const ROUTER_ABI = [
  "function swapExactETHForTokens(uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) payable returns (uint256[] memory)",
  "function getAmountsOut(uint256 amountIn, address[] calldata path) view returns (uint256[] memory)"
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)"
];

async function safe(fn, label) {
  try { return await fn(); } catch (e) { return `ERROR: ${e.message?.slice(0, 120)}`; }
}

console.log("========================================");
console.log("  FULL ON-CHAIN VERIFICATION REPORT");
console.log("========================================\n");

// === NEW ECOSYSTEM ===
const factoryNew = new ethers.Contract(FACTORY_NEW, FACTORY_ABI, provider);
const poolNewAddr = await factoryNew.getPool(WETH, DAI_NEW);
const managerNewAddr = await factoryNew.getManager(poolNewAddr);

console.log("--- NEW ECOSYSTEM (frontend) ---");
console.log(`Factory:   ${FACTORY_NEW}`);
console.log(`Pool:      ${poolNewAddr}`);
console.log(`Manager:   ${managerNewAddr}`);
console.log(`DAI:       ${DAI_NEW}`);

const managerNew = new ethers.Contract(managerNewAddr, MANAGER_ABI, provider);
const poolNewCode = await provider.getCode(poolNewAddr);
const managerNewCode = await provider.getCode(managerNewAddr);
console.log(`Pool code:       ${poolNewCode.length} bytes`);
console.log(`Manager code:    ${managerNewCode.length} bytes`);
console.log(`Liquidity:       ${await safe(() => managerNew.getAvailableLiquidity(), 'liq')}`);
console.log(`Oracle price:    ${await safe(() => managerNew.getOraclePrice(), 'oracle')}`);
console.log(`Long interest:   ${await safe(() => managerNew.getSideOpenInterest(DAI_NEW, true), 'longOI')}`);
console.log(`Short interest:  ${await safe(() => managerNew.getSideOpenInterest(DAI_NEW, false), 'shortOI')}`);

// === OLD ECOSYSTEM ===
const factoryOld = new ethers.Contract(FACTORY_OLD, FACTORY_ABI, provider);
const poolOldAddr = await factoryOld.getPool(WETH, DAI_OLD);
const managerOldAddr = await factoryOld.getManager(poolOldAddr);

console.log("\n--- OLD ECOSYSTEM (bot) ---");
console.log(`Factory:   ${FACTORY_OLD}`);
console.log(`Pool:      ${poolOldAddr}`);
console.log(`Manager:   ${managerOldAddr}`);
console.log(`DAI:       ${DAI_OLD}`);

const managerOld = new ethers.Contract(managerOldAddr, MANAGER_ABI, provider);
const poolOldCode = await provider.getCode(poolOldAddr);
const managerOldCode = await provider.getCode(managerOldAddr);
console.log(`Pool code:       ${poolOldCode.length} bytes`);
console.log(`Manager code:    ${managerOldCode.length} bytes`);
console.log(`Liquidity:       ${await safe(() => managerOld.getAvailableLiquidity(), 'liq')}`);
console.log(`Oracle price:    ${await safe(() => managerOld.getOraclePrice(), 'oracle')}`);
console.log(`Long interest:   ${await safe(() => managerOld.getSideOpenInterest(DAI_OLD, true), 'longOI')}`);
console.log(`Short interest:  ${await safe(() => managerOld.getSideOpenInterest(DAI_OLD, false), 'shortOI')}`);

// === WALLET STATE ===
console.log("\n--- WALLET STATE ---");
console.log(`Address: ${wallet.address}`);
console.log(`ETH:     ${ethers.formatEther(await provider.getBalance(wallet.address))}`);

const daiNew = new ethers.Contract(DAI_NEW, ERC20_ABI, provider);
const daiOld = new ethers.Contract(DAI_OLD, ERC20_ABI, provider);
console.log(`DAI_NEW balance:    ${await safe(() => daiNew.balanceOf(wallet.address), 'bal')}`);
console.log(`DAI_OLD balance:    ${await safe(() => daiOld.balanceOf(wallet.address), 'bal')}`);
console.log(`DAI_NEW allowance→ManagerNEW: ${await safe(() => daiNew.allowance(wallet.address, managerNewAddr), 'allow')}`);
console.log(`DAI_OLD allowance→ManagerOLD: ${await safe(() => daiOld.allowance(wallet.address, managerOldAddr), 'allow')}`);

// === ROUTER NEW TEST ===
console.log("\n--- ROUTER NEW ---");
console.log(`Router: ${ROUTER_NEW}`);
const routerNew = new ethers.Contract(ROUTER_NEW, ROUTER_ABI, provider);
const routerNewCode = await provider.getCode(ROUTER_NEW);
console.log(`Router code: ${routerNewCode.length} bytes`);

const WETH_DAI_NEW = [WETH, DAI_NEW];
try {
  const amounts = await routerNew.getAmountsOut(ethers.parseEther("0.001"), WETH_DAI_NEW);
  console.log(`getAmountsOut(0.001 ETH → DAI_NEW): ${amounts[1].toString()}`);
} catch (e) {
  console.log(`getAmountsOut(ETH→DAI_NEW): ${e.message?.slice(0, 150)}`);
}

// === LIST ALL POOLS ON NEW FACTORY ===
console.log("\n--- ALL POOLS ON NEW FACTORY ---");
const newPoolsLen = await factoryNew.allPoolsLength();
console.log(`Total pools: ${newPoolsLen.toString()}`);

for (let i = 0; i < Math.min(Number(newPoolsLen), 20); i++) {
  const p = await factoryNew.allPools(i);
  const pc = new ethers.Contract(p, [
    "function token0() view returns (address)",
    "function token1() view returns (address)"
  ], provider);
  try {
    const [t0, t1] = await Promise.all([pc.token0(), pc.token1()]);
    console.log(`  Pool[${i}]: ${p}  tokens: ${t0.slice(0,10)}... / ${t1.slice(0,10)}...`);
  } catch {
    console.log(`  Pool[${i}]: ${p}  (error reading tokens)`);
  }
}

// === LIST ALL POOLS ON OLD FACTORY ===
console.log("\n--- ALL POOLS ON OLD FACTORY ---");
const oldPoolsLen = await factoryOld.allPoolsLength();
console.log(`Total pools: ${oldPoolsLen.toString()}`);

for (let i = 0; i < Math.min(Number(oldPoolsLen), 20); i++) {
  const p = await factoryOld.allPools(i);
  const pc = new ethers.Contract(p, [
    "function token0() view returns (address)",
    "function token1() view returns (address)"
  ], provider);
  try {
    const [t0, t1] = await Promise.all([pc.token0(), pc.token1()]);
    console.log(`  Pool[${i}]: ${p}  tokens: ${t0.slice(0,10)}... / ${t1.slice(0,10)}...`);
  } catch {
    console.log(`  Pool[${i}]: ${p}  (error reading tokens)`);
  }
}

console.log("\nDONE");
