import { ethers } from "ethers";
import fs from "fs";

const RPC = "https://ethereum-sepolia-rpc.publicnode.com/557d07a988c4164482ef0c56a10f98ee0e3073440fd72fbe89cd7f6fef809388";
const provider = new ethers.JsonRpcProvider(RPC, 11155111);
const pk = fs.readFileSync("pk.txt", "utf8").trim();
const wallet = new ethers.Wallet(pk, provider);

const WETH = "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9";
const DAI_NEW = "0x8a871311feF28B3d684Fb4F06B964603196BD4E3";
const FACTORY_NEW = "0x3A4A7D9ED3701bB331f6E6040362614ab1D787D3";

const FACTORY_ABI = [
  "function getPool(address tokenA, address tokenB) view returns (address)",
  "function getManager(address pool) view returns (address)"
];

const MANAGER_ABI = [
  "function openPosition(bool isLong, address collateralToken, uint256 collateralAmount, uint256 borrowAmount, uint256 leverageX10, uint256 amountOutMin, uint256 deadline) payable returns (uint256)",
  "function closePosition(uint256 positionId, uint256 amountOutMin, uint256 deadline) returns (uint256)",
  "function getAvailableLiquidity() view returns (uint256)",
  "function getOraclePrice() view returns (uint256)",
  "function getPosition(uint256 positionId) view returns (tuple(uint256 positionId, address owner, bool isLong, address collateralToken, uint256 collateralAmount, uint256 borrowAmount, uint256 leverageX10, uint256 entryPrice, uint256 lastUpdated))"
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)"
];

// Setup
const factory = new ethers.Contract(FACTORY_NEW, FACTORY_ABI, provider);
const poolAddr = await factory.getPool(WETH, DAI_NEW);
const managerAddr = await factory.getManager(poolAddr);
const manager = new ethers.Contract(managerAddr, MANAGER_ABI, provider);
const dai = new ethers.Contract(DAI_NEW, ERC20_ABI, provider);

console.log("=== NEW ECOSYSTEM TEST ===");
console.log(`Manager: ${managerAddr}`);
console.log(`Pool: ${poolAddr}`);

// Check liquidity
const liquidity = await manager.getAvailableLiquidity();
console.log(`Available liquidity: ${liquidity.toString()} (${Number(liquidity) / 1e6} DAI)`);

// Check DAI balance and allowance
const daiBal = await dai.balanceOf(wallet.address);
const daiAllow = await dai.allowance(wallet.address, managerAddr);
console.log(`DAI balance: ${daiBal.toString()} (${Number(daiBal) / 1e6} DAI)`);
console.log(`DAI allowance to manager: ${daiAllow.toString()}`);

// Build and simulate LONG position
const collateralAmount = 333216n; // 0.333216 DAI (6 decimals)
const leverageX10 = 20n;
const deadline = Math.floor(Date.now() / 1000) + 1200;

console.log(`\n--- SIMULATING LONG (provider.call) ---`);
console.log(`Collateral: ${collateralAmount} (${Number(collateralAmount) / 1e6} DAI)`);
console.log(`Leverage: ${leverageX10}x`);

// Get quote for amountOutMin
const ROUTER_NEW = "0x5b23F24b08fa3FAa0Fa555611ACF74c3bAb23550";
const router = new ethers.Contract(ROUTER_NEW, [
  "function getAmountsOut(uint256 amountIn, address[] calldata path) view returns (uint256[] memory)"
], provider);

// For LONG: user provides DAI, gets WETH exposure
// The amountOutMin is based on the expected output after the position is opened
// Let's try with amountOutMin = 0 to see if the call reverts
try {
  const txData = manager.interface.encodeFunctionData("openPosition", [
    true,           // isLong
    DAI_NEW,        // collateralToken
    collateralAmount, // collateralAmount
    0n,             // borrowAmount
    leverageX10,    // leverageX10
    162000n,        // amountOutMin (approx)
    deadline        // deadline
  ]);

  await provider.call({
    from: wallet.address,
    to: managerAddr,
    data: txData,
    value: 0n
  });
  console.log("provider.call: SUCCESS (no revert)");
} catch (e) {
  console.log(`provider.call: REVERTED`);
  console.log(`  Error: ${e.message?.slice(0, 300)}`);

  // Try to decode the revert reason
  const errData = e.data || e.transaction?.data;
  if (errData && typeof errData === "string" && errData.length > 10) {
    try {
      const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
        ["string"],
        "0x" + errData.slice(10)
      );
      console.log(`  Reason: ${decoded[0]}`);
    } catch {
      console.log(`  Raw data: ${errData.slice(0, 200)}`);
    }
  }
}

// Try SHORT too
console.log(`\n--- SIMULATING SHORT (provider.call) ---`);
try {
  const txData = manager.interface.encodeFunctionData("openPosition", [
    false,          // isLong (SHORT)
    DAI_NEW,        // collateralToken
    collateralAmount, // collateralAmount
    0n,             // borrowAmount
    leverageX10,    // leverageX10
    162000n,        // amountOutMin
    deadline        // deadline
  ]);

  await provider.call({
    from: wallet.address,
    to: managerAddr,
    data: txData,
    value: 0n
  });
  console.log("provider.call: SUCCESS (no revert)");
} catch (e) {
  console.log(`provider.call: REVERTED`);
  console.log(`  Error: ${e.message?.slice(0, 300)}`);
}

// Also check what positionId 591 looks like on OLD manager
console.log(`\n--- CHECK EXISTING POSITIONS ON OLD MANAGER ---`);
const FACTORY_OLD = "0x938B84B0F4E02B008dDf5FF3108C4DCd163e1318";
const DAI_OLD = "0xf43ca549bb166cd3b165b5262226bba8cb4114dc";
const factoryOld = new ethers.Contract(FACTORY_OLD, FACTORY_ABI, provider);
const poolOld = await factoryOld.getPool(WETH, DAI_OLD);
const managerOldAddr = await factoryOld.getManager(poolOld);
const managerOld = new ethers.Contract(managerOldAddr, MANAGER_ABI, provider);

try {
  const pos = await managerOld.getPosition(591n);
  console.log(`Position 591: owner=${pos.owner} isLong=${pos.isLong} collateral=${pos.collateralAmount.toString()} leverage=${pos.leverageX10.toString()}`);
} catch (e) {
  console.log(`getPosition(591): ${e.message?.slice(0, 150)}`);
}

try {
  const pos = await managerOld.getPosition(592n);
  console.log(`Position 592: owner=${pos.owner} isLong=${pos.isLong} collateral=${pos.collateralAmount.toString()} leverage=${pos.leverageX10.toString()}`);
} catch (e) {
  console.log(`getPosition(592): ${e.message?.slice(0, 150)}`);
}

console.log("\nDONE");
