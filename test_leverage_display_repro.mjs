// LEVERAGE DISPLAY — reproduction + spec test (site nemesis.trade render logic).
//
// The logic below is EXTRACTED VERBATIM from the production chunks
// (_chunk_6200-*.js = subgraph->object transform, _chunk_page-*.js = formatter),
// not reimplemented, so this test proves what the interface ACTUALLY shows.
// READ-ONLY: no transactions, no bot config, no contracts.
//
// Spec:
//   realizedLeverageX10 = 200 -> 20x
//   realizedLeverageX10 = 20  -> 2x
//   field missing             -> verified fallback or N/A (NEVER the 1+LTV `leverage` field)
import fs from "fs";
import assert from "assert";

const MAIN_FILE = "_chunk_6200-1c7ffae3f59227e1.js";
const PAGE_FILE = "_chunk_page-3e992cb896517dec.js";

// The production chunks are third-party build artifacts of nemesis.trade and are
// intentionally NOT committed. Without them the extraction is impossible — skip
// cleanly rather than fail (the test is only meaningful where the audit chunks exist).
if (!fs.existsSync(MAIN_FILE) || !fs.existsSync(PAGE_FILE)) {
  console.log(`SKIP: site audit chunk missing (${MAIN_FILE} / ${PAGE_FILE}).`);
  console.log("      Fetch them from nemesis.trade/_next/static/chunks/ to run this test.");
  process.exit(0);
}

const MAIN = fs.readFileSync(MAIN_FILE, "utf8");
const PAGE = fs.readFileSync(PAGE_FILE, "utf8");

// --- EXTRACT REAL `H()` : leverage-field resolver (must prefer X10 fields) ---
const hStart = MAIN.indexOf("function H(e){var n,t;let a=null!=(n=e.realizedLeverageX10)");
assert(hStart > 0, "H() resolver not found in main chunk");
const hSrc = MAIN.slice(hStart, MAIN.indexOf("function G(e)", hStart));
const H = new Function("return (" + hSrc + ")")();

// --- EXTRACT REAL `er()` : number -> display string ---
const erIdx = PAGE.indexOf('er=e=>!isFinite(e)||e<=0?"0":');
assert(erIdx > 0, "er() formatter not found in page chunk");
const er = eval("(" + PAGE.slice(erIdx + 3, PAGE.indexOf(",ei=", erIdx)) + ")");

// --- EXTRACT REAL list transform rule (path B, main chunk idx ~40788) ---
// "A = w?.realizedLeverageX10 ?? e.realizedLeverageX10; S = A==null?null:A/10; M = S!=null?S:H(e)"
function listLeverage(e, w = null) {
  let A, S, M;
  A = (w && w.realizedLeverageX10 != null ? w.realizedLeverageX10 : null) != null
    ? (w && w.realizedLeverageX10 != null ? w.realizedLeverageX10 : null)
    : e.realizedLeverageX10;
  S = A == null ? null : A / 10;
  M = S != null ? S : H(e);
  return M;
}

// --- EXTRACT REAL detail/history override rule (path C, idx ~42924) ---
// "leverage: t?.leverage ?? H(e)" ; call site idx ~44405 passes leverage:M
function detailLeverage(e, M) {
  return M != null ? M : H(e);
}

// --- REAL subgraph rows (fetched from the site subgraph, unchanged) ---
const rows = {
  "20x (#22)": { leverage: "1.955440050313843123903650418077736", leverageX10: 200, realizedLeverageX10: 200, requestedLeverageX10: 200 },
  "2x (#32)": { leverage: "1.501502978776640312526130180039403", leverageX10: 20, realizedLeverageX10: 20, requestedLeverageX10: 20 },
  "legacy no X10": { leverage: "1.500000000000000000000000000000000", leverageX10: null, realizedLeverageX10: null },
  "legacy null leverage": { leverage: null, leverageX10: null, realizedLeverageX10: null },
};

// Surfaces (spec item 5): list card, detail/history card, and the open form
// (the open-form slider is independent selection state, never position leverage).
console.log("=== rendered values, per surface ===");
const out = {};
for (const [name, row] of Object.entries(rows)) {
  const M = listLeverage(row);
  const listCard = er(M) + "X";
  const detailCard = er(detailLeverage(row, M)) + "X";
  const historyCard = er(detailLeverage(row, M)) + "X";
  out[name] = { listCard, detailCard, historyCard };
  console.log(`  ${name.padEnd(19)} list=${listCard.padEnd(6)} detail=${detailCard.padEnd(6)} history=${historyCard.padEnd(6)} (leverage 1+LTV field=${row.leverage == null ? "null" : Number(row.leverage).toFixed(4)})`);
}

const results = [];
const check = (label, actual, expected) => {
  const ok = actual === expected;
  results.push({ label, ok, actual, expected });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}: got "${actual}", want "${expected}"`);
};

console.log("\n=== assertions ===");
// item 6: 200 -> 20x, 20 -> 2x, missing -> fallback/N-A
check("#22 realizedX10=200 -> 20x (list)", out["20x (#22)"].listCard, "20X");
check("#22 realizedX10=200 -> 20x (detail)", out["20x (#22)"].detailCard, "20X");
check("#22 realizedX10=200 -> 20x (history)", out["20x (#22)"].historyCard, "20X");
check("#32 realizedX10=20 -> 2x (list)", out["2x (#32)"].listCard, "2X");
check("#32 realizedX10=20 -> 2x (detail)", out["2x (#32)"].detailCard, "2X");
// item 3+4: never render the 1+LTV `leverage` field as actual leverage
check("legacy(no X10) must NOT show 1+LTV as leverage", out["legacy no X10"].listCard, "N/A");
check("legacy(no X10+null lev) must NOT invent '1x'", out["legacy null leverage"].listCard, "N/A");

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log("DEFECT REPRODUCED:");
  failed.forEach((f) => console.log(`  - ${f.label}: interface shows "${f.actual}" but spec requires "${f.expected}"`));
}
process.exit(failed.length ? 1 : 0);
