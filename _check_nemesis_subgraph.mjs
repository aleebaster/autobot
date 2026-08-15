#!/usr/bin/env node
import axios from "axios";

const WALLET = "0x315E5193633A962B3F369F9C3833D973D0588cCD";

// Known transaction hashes from our tests
const KNOWN_TXS = [
  "0x1b0ada1549b9c945d579605b77a622beae5aaeee2ae3dbf7edb19efe7df2f719",
  "0x42e834832451ba39c378ba0e7791d14da927d81081e275d947904581531f004d",
  "0x3fb1476e4583ad1e05755627969fa0ed09e1b8afb6e7485da5ff268370b2a71a"
];

async function querySubgraph(endpoint, query) {
  try {
    const res = await axios.post(endpoint, { query }, {
      headers: { "Content-Type": "application/json" },
      timeout: 10000
    });
    return res.data;
  } catch (e) {
    return { error: e.message };
  }
}

async function main() {
  console.log("═══ CHECKING NEMESIS SUBGRAPH ═══\n");

  // Try different subgraph endpoints
  const endpoints = [
    "https://api.studio.thegraph.com/query/nemesis-trade/nemesis-sepolia/version/latest",
    "https://nemesis.trade/api/subgraph",
    "https://api.thegraph.com/subgraphs/name/nemesis-trade/nemesis-sepolia"
  ];

  // Query 1: Get swaps for our wallet
  const swapQuery = `{
    swaps(where: {user: "${WALLET.toLowerCase()}"}, orderBy: timestamp, orderDirection: desc, first: 20) {
      id
      txHash
      timestamp
      amountIn
      amountOut
      tokenIn { symbol address }
      tokenOut { symbol address }
      pool { id }
    }
  }`;

  // Query 2: Get all pools
  const poolQuery = `{
    pools(first: 20) {
      id
      token0 { symbol address }
      token1 { symbol address }
      reserve0
      reserve1
    }
  }`;

  for (const endpoint of endpoints) {
    console.log(`\nTrying endpoint: ${endpoint}`);

    // Query swaps
    const swapResult = await querySubgraph(endpoint, swapQuery);
    if (swapResult.data?.swaps) {
      console.log(`  ✅ Swaps found: ${swapResult.data.swaps.length}`);
      for (const swap of swapResult.data.swaps.slice(0, 5)) {
        console.log(`    TX: ${swap.txHash}`);
        console.log(`    ${swap.tokenIn.symbol} → ${swap.tokenOut.symbol}`);
        console.log(`    Amount: ${swap.amountIn} → ${swap.amountOut}`);
        console.log(`    Pool: ${swap.pool.id}`);
        console.log();
      }
    } else if (swapResult.error) {
      console.log(`  ❌ Error: ${swapResult.error}`);
    } else {
      console.log(`  ⚠️ No swaps found or unexpected response`);
      console.log(`  Response: ${JSON.stringify(swapResult).slice(0, 200)}`);
    }

    // Query pools
    const poolResult = await querySubgraph(endpoint, poolQuery);
    if (poolResult.data?.pools) {
      console.log(`  ✅ Pools found: ${poolResult.data.pools.length}`);
      for (const pool of poolResult.data.pools.slice(0, 5)) {
        console.log(`    Pool: ${pool.id}`);
        console.log(`    ${pool.token0.symbol} / ${pool.token1.symbol}`);
        console.log(`    Reserves: ${pool.reserve0} / ${pool.reserve1}`);
        console.log();
      }
    } else if (poolResult.error) {
      console.log(`  ❌ Pool query error: ${poolResult.error}`);
    }
  }

  console.log("\n═══ CHECKING ETHERSCAN FOR SWAPS ═══\n");

  // Check each known TX on Etherscan
  for (const txHash of KNOWN_TXS) {
    console.log(`TX: ${txHash}`);
    console.log(`  Etherscan: https://sepolia.etherscan.io/tx/${txHash}`);
    console.log(`  Nemesis: https://nemesis.trade/trade`);
    console.log();
  }

  console.log("═══ VERIFICATION COMPLETE ═══");
  console.log("\nTo see transactions on Nemesis:");
  console.log("1. Go to https://nemesis.trade/trade");
  console.log("2. Connect wallet: " + WALLET);
  console.log("3. Check the swap history / activity tab");
  console.log("4. Transactions should appear after indexer processes them");
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
