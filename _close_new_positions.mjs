import { ethers } from "ethers";
import fs from "fs";

const RPC = "https://ethereum-sepolia-rpc.publicnode.com/557d07a988c4164482ef0c56a10f98ee0e3073440fd72fbe89cd7f6fef809388";
const provider = new ethers.JsonRpcProvider(RPC, 11155111);
const pk = fs.readFileSync("pk.txt", "utf8").trim();
const wallet = new ethers.Wallet(pk, provider);

const MANAGER_NEW = "0x87dbB2A051A50a9fC82736bd98e570E81dE67A37";

// closePosition(uint256 positionId, uint256 amountOutMin, uint256 deadline)
const CLOSE_FN = "closePosition(uint256,uint256,uint256)";

async function closePosition(positionId) {
  console.log(`\n=== CLOSING positionId=${positionId} on NEW manager ===`);
  
  const deadline = Math.floor(Date.now() / 1000) + 1200;
  const amountOutMin = 0n;
  
  const iface = new ethers.Interface([`function ${CLOSE_FN}`]);
  const data = iface.encodeFunctionData("closePosition", [positionId, amountOutMin, deadline]);
  
  try {
    const tx = await wallet.sendTransaction({
      to: MANAGER_NEW,
      data,
      value: 0n,
      gasLimit: 500000n
    });
    console.log(`  TX hash: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`  Receipt status: ${receipt.status}`);
    console.log(`  Block: ${receipt.blockNumber}`);
    console.log(`  Gas used: ${receipt.gasUsed.toString()}`);
    if (receipt.status === 1) {
      console.log(`  SUCCESS!`);
    } else {
      console.log(`  FAILED - status=0`);
    }
    return receipt.status === 1;
  } catch (e) {
    console.log(`  ERROR: ${e.message?.slice(0, 300)}`);
    return false;
  }
}

async function main() {
  const r1 = await closePosition(14527n);
  const r2 = await closePosition(14528n);
  
  console.log(`\n=== RESULTS ===`);
  console.log(`LONG 14527: ${r1 ? "CLOSED" : "FAILED"}`);
  console.log(`SHORT 14528: ${r2 ? "CLOSED" : "FAILED"}`);
}

main();
