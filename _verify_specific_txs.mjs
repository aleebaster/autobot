#!/usr/bin/env node
import axios from "axios";

const WALLET = "0x315e5193633a962b3f369f9c3833d973d0588ccd";
const ENDPOINT = "https://nemesis.trade/api/subgraph";

// Our known transaction hashes
const KNOWN_TXS = [
  "0x1b0ada1549b9c945d579605b77a622beae5aaeee2ae3dbf7edb19efe7df2f719",
  "0x42e834832451ba39c378ba0e7791d14da927d81081e275d947904581531f004d",
  "0x3fb1476e4583ad1e05755627969fa0ed09e1b8afb6e7485da5ff268370b2a71a",
  "0xa12774cdcd1eec8a2bb88b1187817ab2667b3f803c45f3318053721563cb4fe5",
  "0x757b034cff6cfe436a20268673d83b17cd50ac960a72cd09a342b6262e32b698",
  "0xa4cdecbf745b2aa81ac4d3c11f3ce357800e01236ec5be0f3981afc71e56293e",
  "0x17a32f20ba5120f61a3f119e23e5341f8ca41064d7d89b9c2cffa1b80b6629cc",
  "0x50b7e5521174d06766d112ed57d52b1f13c2425f7da673ed274dd030e156987e",
  "0x6ffd932c008a618b2c0142ff03dcca63d9ed87d47f701c46067e41c0bf0a1491",
  "0xfa43884745912487edcceec48f6ffb0681767d684eff873802e96734e30cc811"
];

async function query(queryStr) {
  const res = await axios.post(ENDPOINT, { query: queryStr }, {
    headers: { "Content-Type": "application/json" },
    timeout: 10000
  });
  return res.data;
}

async function main() {
  console.log("═══ VERIFYING SPECIFIC TRANSACTIONS IN NEMESIS SUBGRAPH ═══\n");

  // Query all swaps for our wallet with full details
  const swapQuery = `{
    swaps(first: 50, where: {user: "${WALLET}"}, orderBy: timestamp, orderDirection: desc) {
      id
      txHash
      timestamp
      blockNumber
      amount0In
      amount1In
      amount0Out
      amount1Out
      pool {
        id
        token0 { symbol address }
        token1 { symbol address }
      }
      user { id }
    }
  }`;

  const result = await query(swapQuery);

  if (result.data?.swaps) {
    const swaps = result.data.swaps;
    console.log(`Found ${swaps.length} swaps for wallet ${WALLET}\n`);

    // Check each known TX
    for (const txHash of KNOWN_TXS) {
      const found = swaps.find(s => s.txHash.toLowerCase() === txHash.toLowerCase());
      if (found) {
        console.log(`✅ FOUND: ${txHash}`);
        console.log(`   Block: ${found.blockNumber}`);
        console.log(`   Pool: ${found.pool.id} (${found.pool.token0.symbol}/${found.pool.token1.symbol})`);
        console.log(`   Amount0In: ${found.amount0In}`);
        console.log(`   Amount1In: ${found.amount1In}`);
        console.log(`   Amount0Out: ${found.amount0Out}`);
        console.log(`   Amount1Out: ${found.amount1Out}`);
        console.log(`   Etherscan: https://sepolia.etherscan.io/tx/${txHash}`);
        console.log();
      } else {
        console.log(`❌ NOT FOUND: ${txHash}`);
      }
    }

    // Show all swaps found
    console.log("\n═══ ALL SWAPS FOR THIS WALLET ═══\n");
    for (const swap of swaps) {
      const isOurs = KNOWN_TXS.some(tx => tx.toLowerCase() === swap.txHash.toLowerCase());
      const marker = isOurs ? "🆕 OUR TX" : "existing";
      console.log(`[${marker}] TX: ${swap.txHash}`);
      console.log(`  Block: ${swap.blockNumber}`);
      console.log(`  Pool: ${swap.pool.token0.symbol}/${swap.pool.token1.symbol}`);
      console.log(`  Amount0In: ${swap.amount0In} | Amount1In: ${swap.amount1In}`);
      console.log(`  Amount0Out: ${swap.amount0Out} | Amount1Out: ${swap.amount1Out}`);
      console.log();
    }
  } else {
    console.log("Query failed:", JSON.stringify(result).slice(0, 500));
  }
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
