/**
 * Query the Nemesis subgraph with correct schema
 */
import { ethers } from "ethers";

const GOLDSKY_URL = "https://api.goldsky.com/api/public/project_cmma0sxdrnwdx01ym126h3z8q/subgraphs/nemesis-eth-sepolia/prod/gn";
const SUBGRAPH_URL = "https://nemesis.trade/api/subgraph";
const RPC = "https://ethereum-sepolia-rpc.publicnode.com/557d07a988c4164482ef0c56a10f98ee0e3073440fd72fbe89cd7f6fef809388";

async function querySubgraph(endpoint, query) {
  const resp = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query })
  });
  return resp.json();
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC, 11155111);
  const pk = (await import("fs")).readFileSync("pk.txt", "utf8").split("\n")[0].trim();
  const wallet = new ethers.Wallet(pk);
  console.log("Wallet:", wallet.address);

  for (const endpoint of [GOLDSKY_URL, SUBGRAPH_URL]) {
    console.log(`\n═══ Endpoint: ${endpoint} ═══`);

    // 1. Introspect Position type
    try {
      const r1 = await querySubgraph(endpoint, `{ __type(name: "Position") { fields { name type { name kind ofType { name } } } } }`);
      const fields = r1.data?.__type?.fields?.map(f => f.name) || [];
      console.log(`Position fields (${fields.length}): ${fields.join(", ")}`);
    } catch (e) {
      console.log(`Introspection failed: ${e.message}`);
    }

    // 2. Query all positions (latest 10)
    try {
      const r = await querySubgraph(endpoint, `{
        positions(first: 10, orderBy: openedAtTimestamp, orderDirection: desc) {
          id
          user { id }
          isLong
          collateralToken
          collateralAmount
          debtAmount
          healthFactor
          status
          leverageX10
          pool { id }
          market { id }
          openedAtTimestamp
        }
      }`);
      const positions = r.data?.positions || [];
      console.log(`\nLatest ${positions.length} positions:`);
      for (const p of positions) {
        const isWallet = p.user?.id?.toLowerCase() === wallet.address.toLowerCase();
        console.log(`  ${isWallet ? ">>> " : "    "}id=${p.id} user=${p.user?.id?.slice(0,10)}... isLong=${p.isLong} status=${p.status} leverageX10=${p.leverageX10} collateral=${p.collateralToken?.slice(0,10)}... pool=${p.pool?.id?.slice(0,10)}... market=${p.market?.id?.slice(0,10)}...`);
      }
    } catch (e) {
      console.log(`Position query error: ${e.message}`);
    }

    // 3. Query positions for this wallet
    try {
      const r = await querySubgraph(endpoint, `{
        positions(where: { user: "${wallet.address.toLowerCase()}" }, first: 20, orderBy: openedAtTimestamp, orderDirection: desc) {
          id
          isLong
          collateralToken
          collateralAmount
          debtAmount
          status
          leverageX10
          pool { id }
          market { id }
          openedAtTimestamp
        }
      }`);
      const positions = r.data?.positions || [];
      console.log(`\nPositions for wallet ${wallet.address}: ${positions.length}`);
      for (const p of positions) {
        console.log(`  id=${p.id} isLong=${p.isLong} status=${p.status} collateralAmt=${p.collateralAmount} leverageX10=${p.leverageX10} pool=${p.pool?.id} market=${p.market?.id} openedAt=${p.openedAtTimestamp}`);
      }
    } catch (e) {
      console.log(`Wallet position query error: ${e.message}`);
    }

    // 4. Query pools
    try {
      const r = await querySubgraph(endpoint, `{
        pools(first: 20) {
          id
          token0 { id symbol }
          token1 { id symbol }
          market { id }
        }
      }`);
      const pools = r.data?.pools || [];
      console.log(`\nPools: ${pools.length}`);
      for (const p of pools) {
        console.log(`  pool=${p.id} ${p.token0?.symbol}/${p.token1?.symbol} market=${p.market?.id}`);
      }
    } catch (e) {
      console.log(`Pool query error: ${e.message}`);
    }

    // 5. Query markets
    try {
      const r = await querySubgraph(endpoint, `{
        markets(first: 20) {
          id
          name
        }
      }`);
      const markets = r.data?.markets || [];
      console.log(`\nMarkets: ${markets.length}`);
      for (const m of markets) {
        console.log(`  id=${m.id} name=${m.name}`);
      }
    } catch (e) {
      console.log(`Market query error: ${e.message}`);
    }
  }
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
