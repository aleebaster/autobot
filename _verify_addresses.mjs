import { ethers } from "ethers";

const RPC = "https://ethereum-sepolia-rpc.publicnode.com/557d07a988c4164482ef0c56a10f98ee0e3073440fd72fbe89cd7f6fef809388";
const provider = new ethers.JsonRpcProvider(RPC, 11155111);

const WETH = "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9";
const DAI_NEW = "0x8a871311feF28B3d684Fb4F06B964603196BD4E3";
const DAI_OLD = "0xf43ca549bb166cd3b165b5262226bba8cb4114dc";
const USDC_NEW = "0xc4D9dC931B43930e1AA1F90D8a032AF4Ac66560a";
const USDC_OLD = "0x5cb826e44f313c3294663d74c7e555f145aa7c19";
const UNI_NEW = "0xC32a7fCB1cC8E247D9b8ED74220f6F8A61341F4F";
const UNI_OLD = "0xbc77ba7b5a2bf4e71256f71fc5fb4fb5f498421a";
const NEMESIS = "0x534a29DfcA1ceFB6e933f6C0D00e8A43a52e60d2";

const FACTORY_NEW = "0x3A4A7D9ED3701bB331f6E6040362614ab1D787D3";
const FACTORY_OLD = "0x938B84B0F4E02B008dDf5FF3108C4DCd163e1318";
const ROUTER_NEW = "0x5b23F24b08fa3FAa0Fa555611ACF74c3bAb23550";
const ROUTER_OLD = "0xeDeC53F31C5f7BE26fcD1C5Edf405AE653BBd342";

const ERC20_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)"
];

const FACTORY_ABI = [
  "function getPool(address tokenA, address tokenB) view returns (address)",
  "function getManager(address pool) view returns (address)",
  "function allPoolsLength() view returns (uint256)"
];

const ROUTER_ABI = [
  "function getAmountsOut(uint256 amountIn, address[] calldata path) view returns (uint256[] memory)"
];

async function checkAddress(label, address) {
  const code = await provider.getCode(address);
  const hasCode = code !== "0x" && code.length > 2;
  let balance = null;
  try { balance = await provider.getBalance(address); } catch {}
  return { label, address, hasCode, codeLen: code.length, balance: balance ? ethers.formatEther(balance) : "N/A" };
}

async function checkERC20(label, address) {
  const code = await provider.getCode(address);
  const hasCode = code !== "0x" && code.length > 2;
  if (!hasCode) return { label, address, hasCode: false, name: "N/A", symbol: "N/A", decimals: "N/A", totalSupply: "N/A" };
  const contract = new ethers.Contract(address, ERC20_ABI, provider);
  const [name, symbol, decimals, totalSupply] = await Promise.all([
    contract.name().catch(() => "ERROR"),
    contract.symbol().catch(() => "ERROR"),
    contract.decimals().catch(() => "ERROR"),
    contract.totalSupply().catch(() => "ERROR")
  ]);
  return { label, address, hasCode, name, symbol, decimals: Number(decimals), totalSupply: totalSupply.toString() };
}

async function checkFactory(label, address) {
  const code = await provider.getCode(address);
  const hasCode = code !== "0x" && code.length > 2;
  if (!hasCode) return { label, address, hasCode: false, poolsLength: "N/A" };
  const contract = new ethers.Contract(address, FACTORY_ABI, provider);
  let poolsLength = "ERROR";
  try { poolsLength = (await contract.allPoolsLength()).toString(); } catch {}
  return { label, address, hasCode, poolsLength };
}

async function checkRouter(label, address) {
  const code = await provider.getCode(address);
  const hasCode = code !== "0x" && code.length > 2;
  return { label, address, hasCode, codeLen: code.length };
}

console.log("=== 1. КОД НА АДРЕСАХ ( getCode ) ===\n");

const addresses = [
  ["Factory OLD", FACTORY_OLD],
  ["Factory NEW", FACTORY_NEW],
  ["Router OLD", ROUTER_OLD],
  ["Router NEW", ROUTER_NEW],
];

for (const [label, addr] of addresses) {
  const r = await checkAddress(label, addr);
  console.log(`${r.label} (${r.address})`);
  console.log(`  Has code: ${r.hasCode} | Code length: ${r.codeLen} bytes`);
  console.log();
}

console.log("\n=== 2. ERC20 ТОКЕНИ ===\n");

const tokens = [
  ["DAI OLD", DAI_OLD],
  ["DAI NEW", DAI_NEW],
  ["USDC OLD", USDC_OLD],
  ["USDC NEW", USDC_NEW],
  ["UNI OLD", UNI_OLD],
  ["UNI NEW", UNI_NEW],
  ["NEMESIS", NEMESIS],
  ["WETH", WETH],
];

for (const [label, addr] of tokens) {
  const r = await checkERC20(label, addr);
  console.log(`${r.label} (${r.address})`);
  console.log(`  Has code: ${r.hasCode} | Name: ${r.name} | Symbol: ${r.symbol} | Decimals: ${r.decimals}`);
  console.log(`  TotalSupply: ${r.totalSupply}`);
  console.log();
}

console.log("\n=== 3. FACTORY: getPool(WETH, DAI) ===\n");

for (const [label, addr] of [["Factory OLD", FACTORY_OLD], ["Factory NEW", FACTORY_NEW]]) {
  const code = await provider.getCode(addr);
  if (code === "0x" || code.length <= 2) { console.log(`${label}: NO CODE\n`); continue; }
  const contract = new ethers.Contract(addr, FACTORY_ABI, provider);
  try {
    const poolOld = await contract.getPool(WETH, DAI_OLD);
    const poolNew = await contract.getPool(WETH, DAI_NEW);
    console.log(`${label} getPool(WETH, DAI_OLD): ${poolOld}`);
    console.log(`${label} getPool(WETH, DAI_NEW): ${poolNew}`);
    if (poolOld !== ethers.ZeroAddress) {
      const manager = await contract.getManager(poolOld);
      console.log(`  -> Manager for DAI_OLD pool: ${manager}`);
    }
    if (poolNew !== ethers.ZeroAddress) {
      const manager = await contract.getManager(poolNew);
      console.log(`  -> Manager for DAI_NEW pool: ${manager}`);
    }
  } catch (e) { console.log(`${label}: ERROR - ${e.message?.slice(0, 100)}`); }
  console.log();
}

console.log("\n=== 4. ROUTER: getAmountsOut(WETH->DAI) ===\n");

const AMOUNT = ethers.parseEther("0.001");
for (const [label, addr] of [["Router OLD", ROUTER_OLD], ["Router NEW", ROUTER_NEW]]) {
  const code = await provider.getCode(addr);
  if (code === "0x" || code.length <= 2) { console.log(`${label}: NO CODE\n`); continue; }
  const contract = new ethers.Contract(addr, ROUTER_ABI, provider);
  try {
    const outOld = await contract.getAmountsOut(AMOUNT, [WETH, DAI_OLD]);
    const outNew = await contract.getAmountsOut(AMOUNT, [WETH, DAI_NEW]);
    console.log(`${label} getAmountsOut(0.001 ETH -> DAI_OLD): ${outOld[1].toString()}`);
    console.log(`${label} getAmountsOut(0.001 ETH -> DAI_NEW): ${outNew[1].toString()}`);
  } catch (e) { console.log(`${label}: ERROR - ${e.message?.slice(0, 150)}`); }
  console.log();
}

console.log("DONE");
