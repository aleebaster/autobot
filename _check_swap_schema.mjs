#!/usr/bin/env node
import axios from "axios";

const WALLET = "0x315e5193633a962b3f369f9c3833d973d0588ccd";

async function query(endpoint, query) {
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
  const endpoint = "https://nemesis.trade/api/subgraph";

  // First, get the schema for Swap entity
  console.log("═══ INTROSPECTION: Swap entity fields ═══\n");
  const introspectQuery = `{
    __type(name: "Swap") {
      fields {
        name
        type { name kind ofType { name } }
      }
    }
  }`;
  const introResult = await query(endpoint, introspectQuery);
  if (introResult.data?.__type?.fields) {
    console.log("Swap entity fields:");
    for (const field of introResult.data.__type.fields) {
      console.log(`  ${field.name}: ${field.type.name || field.type.ofType?.name}`);
    }
  } else {
    console.log("Introspection failed:", JSON.stringify(introResult).slice(0, 300));
  }

  // Try different field names for swaps
  console.log("\n═══ QUERY: Recent swaps ═══\n");

  // Try with just id and txHash
  const query1 = `{
    swaps(first: 5, orderBy: id, orderDirection: desc) {
      id
      txHash
    }
  }`;
  const r1 = await query(endpoint, query1);
  if (r1.data?.swaps) {
    console.log(`Found ${r1.data.swaps.length} swaps:`);
    for (const s of r1.data.swaps) {
      console.log(`  id=${s.id} tx=${s.txHash}`);
    }
  } else {
    console.log("Query 1 failed:", JSON.stringify(r1).slice(0, 300));
  }

  // Try with user filter
  console.log("\n═══ QUERY: Swaps for our wallet ═══\n");
  const query2 = `{
    swaps(first: 10, where: {user: "${WALLET}"}, orderBy: id, orderDirection: desc) {
      id
      txHash
    }
  }`;
  const r2 = await query(endpoint, query2);
  if (r2.data?.swaps) {
    console.log(`Found ${r2.data.swaps.length} swaps for wallet:`);
    for (const s of r2.data.swaps) {
      console.log(`  id=${s.id} tx=${s.txHash}`);
    }
  } else {
    console.log("Query 2 failed:", JSON.stringify(r2).slice(0, 300));
  }

  // Also check Transaction entity
  console.log("\n═══ QUERY: Recent transactions ═══\n");
  const query3 = `{
    transactions(first: 10, orderBy: id, orderDirection: desc) {
      id
      blockNumber
      timestamp
    }
  }`;
  const r3 = await query(endpoint, query3);
  if (r3.data?.transactions) {
    console.log(`Found ${r3.data.transactions.length} transactions:`);
    for (const t of r3.data.transactions) {
      console.log(`  id=${t.id} block=${t.blockNumber} time=${t.timestamp}`);
    }
  } else {
    console.log("Query 3 failed:", JSON.stringify(r3).slice(0, 300));
  }

  // Check what entities exist
  console.log("\n═══ INTROSPECTION: Available entities ═══\n");
  const schemaQuery = `{ __schema { queryType { fields { name } } } }`;
  const schemaResult = await query(endpoint, schemaQuery);
  if (schemaResult.data?.__schema?.queryType?.fields) {
    console.log("Available query entities:");
    for (const f of schemaResult.data.__schema.queryType.fields) {
      console.log(`  ${f.name}`);
    }
  }
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
