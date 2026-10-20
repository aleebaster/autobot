// ═══════════════════════════════════════════════════════════════════════════
//  TX GUARD REGRESSION TEST — read-only, never broadcasts anything.
//
//  Verifies the 2026-10 incident fixes:
//    1. every suite imports the isolation/guard module (before autoTrader),
//    2. live-capable suites carry the default-SKIP opt-in gate,
//    3. the signer guard blocks by default and enforces the opt-in phrase,
//    4. the opt-in additionally enforces the expected chainId,
//    5. no suite writes the REAL auto-trader-state.json,
//    6. no suite sets NEMESIS_ALLOW_LIVE_TX itself.
// ═══════════════════════════════════════════════════════════════════════════
import { TEST_STATE_FILE, realStateHash, assertLiveTxAllowed } from "./_test_state_isolation.mjs";
import { ethers } from "ethers";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const results = [];
let failures = 0;
function check(id, name, ok, detail = "") {
  results.push({ id, name, ok, detail });
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  [${id}] ${name}${detail ? ` — ${detail}` : ""}`);
}

const beforeHash = realStateHash();
const testFiles = fs.readdirSync(ROOT).filter(f => /^test_.*\.mjs$/.test(f)).sort();

// ─── 1. every suite imports the guard module ────────────────────────────────
{
  const missing = testFiles.filter(f => {
    const src = fs.readFileSync(path.join(ROOT, f), "utf8");
    return !src.includes('_test_state_isolation.mjs');
  });
  check("01", `all ${testFiles.length} suites import _test_state_isolation`, missing.length === 0,
    missing.join(", "));
}

// ─── 2. guard import precedes autoTrader import ─────────────────────────────
{
  const bad = [];
  for (const f of testFiles) {
    const lines = fs.readFileSync(path.join(ROOT, f), "utf8").split(/\r?\n/);
    const iso = lines.findIndex(l => l.includes('_test_state_isolation.mjs'));
    const at = lines.findIndex(l => l.includes('from "./autoTrader.js"'));
    if (iso >= 0 && at >= 0 && iso > at) bad.push(f);
  }
  check("02", "guard import precedes autoTrader import everywhere", bad.length === 0, bad.join(", "));
}

// ─── 3. live-capable suites carry the default-SKIP gate ─────────────────────
const LIVE_TESTS = [
  "test_final_validation.mjs", "test_final_verify.mjs", "test_cycle.mjs",
  "test_5x_e2e.mjs", "test_e2e_multimarket.mjs", "test_inventory_e2e.mjs",
  "test_inventory_fullauto_e2e.mjs", "test_swap_e2e.mjs", "test_swap_fullauto_e2e.mjs",
  "test_swap_engine.mjs", "test_diagnose_phase2.mjs", "test_diagnose_phase3.mjs",
  "test_diagnose_revert.mjs",
];
{
  const bad = LIVE_TESTS.filter(f => {
    if (!fs.existsSync(path.join(ROOT, f))) return false;
    const src = fs.readFileSync(path.join(ROOT, f), "utf8");
    return !src.includes('NEMESIS_ALLOW_LIVE_TX !== "SEND LIVE TRANSACTIONS"');
  });
  check("03", `all ${LIVE_TESTS.length} live-capable suites have the opt-in gate`, bad.length === 0,
    bad.join(", "));
}

// ─── 4. no suite writes the REAL state file ─────────────────────────────────
{
  const offenders = [];
  for (const f of testFiles) {
    const src = fs.readFileSync(path.join(ROOT, f), "utf8");
    if (/writeFileSync\(\s*[^)]*auto-trader-state\.json/.test(src)) offenders.push(f + " (literal)");
    if (/writeFileSync\(\s*REAL_STATE\b/.test(src)) offenders.push(f + " (REAL_STATE)");
    if (/const stateFile = "auto-trader-state\.json"/.test(src)) offenders.push(f + " (stateFile=real)");
  }
  check("04", "no suite writes the real auto-trader-state.json", offenders.length === 0,
    offenders.join(", "));
}

// ─── 5. no suite self-enables the live opt-in ───────────────────────────────
{
  const offenders = [];
  for (const f of testFiles) {
    const src = fs.readFileSync(path.join(ROOT, f), "utf8");
    if (/process\.env\.NEMESIS_ALLOW_LIVE_TX\s*=(?!=)/.test(src)) offenders.push(f);
  }
  check("05", "no suite sets NEMESIS_ALLOW_LIVE_TX itself", offenders.length === 0,
    offenders.join(", "));
}

// ─── 6. guard blocks by default (no opt-in in this process) ─────────────────
{
  let msg = "";
  try { await assertLiveTxAllowed(undefined); msg = "NO THROW"; }
  catch (e) { msg = String(e.message || e); }
  check("06", "assertLiveTxAllowed blocks without the opt-in phrase",
    msg.includes("[TX GUARD] blocked"), msg.slice(0, 110));
}

// ─── 7. a real Wallet send is blocked before any network/broadcast ──────────
{
  const provider = new ethers.JsonRpcProvider("https://ethereum-sepolia-rpc.publicnode.com", 11155111);
  const wallet = ethers.Wallet.createRandom().connect(provider);
  let msg = "";
  try {
    await wallet.sendTransaction({ to: wallet.address, value: 0n });
    msg = "NO THROW — send went through!";
  } catch (e) { msg = String(e.message || e); }
  check("07", "Wallet.sendTransaction blocked by guard (throwaway key, no broadcast)",
    msg.includes("[TX GUARD] blocked"), msg.slice(0, 110));
}

// ─── 8. signTransaction blocked too ─────────────────────────────────────────
{
  const wallet = ethers.Wallet.createRandom();
  let msg = "";
  try {
    await wallet.signTransaction({ to: wallet.address, value: 0n, nonce: 0, gasLimit: 21000n, gasPrice: 1n, chainId: 11155111n });
    msg = "NO THROW — signed!";
  } catch (e) { msg = String(e.message || e); }
  check("08", "Wallet.signTransaction blocked by guard", msg.includes("[TX GUARD] blocked"),
    msg.slice(0, 110));
}

// ─── 9. spawned policy children (opt-in phrase / chainId enforcement) ───────
{
  const scratchDir = path.dirname(TEST_STATE_FILE);
  fs.mkdirSync(scratchDir, { recursive: true });
  const childPath = path.join(scratchDir, "guard_child.mjs");
  fs.writeFileSync(childPath, `
import { assertLiveTxAllowed } from ${JSON.stringify(pathToFileURL(path.join(ROOT, "_test_state_isolation.mjs")).href)};
const fake = (chainId) => ({ getNetwork: async () => ({ chainId: BigInt(chainId) }) });
const run = async (label, fn) => {
  try { await fn(); console.log(label + ":ALLOWED"); }
  catch (e) { console.log(label + ":BLOCKED:" + String(e.message).slice(0, 90)); }
};
await run("phraseOk-chainOk", () => assertLiveTxAllowed(fake(11155111)));
await run("phraseOk-chainBad", () => assertLiveTxAllowed(fake(999)));
await run("phraseOk-noProvider", () => assertLiveTxAllowed(undefined));
`);
  const runChild = (env) => new Promise((resolve) => {
    const out = [];
    const child = spawn(process.execPath, [childPath], {
      cwd: ROOT,
      env: { ...process.env, ...env, NEMESIS_TEST_SUITE: "guard_child" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", d => out.push(String(d)));
    child.stderr.on("data", d => out.push(String(d)));
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 60_000);
    child.on("exit", code => { clearTimeout(timer); resolve({ code, out: out.join("") }); });
  });

  const optIn = await runChild({ NEMESIS_ALLOW_LIVE_TX: "SEND LIVE TRANSACTIONS", NEMESIS_LIVE_CHAIN_ID: "11155111" });
  check("09", "opt-in phrase + matching chainId → policy allows (no tx sent)",
    optIn.out.includes("phraseOk-chainOk:ALLOWED") && optIn.out.includes("phraseOk-noProvider:ALLOWED"),
    optIn.out.replace(/\n/g, " | ").slice(0, 220));
  check("10", "opt-in phrase + WRONG chainId → blocked by chainId check",
    optIn.out.includes("phraseOk-chainBad:BLOCKED") && optIn.out.includes("network chainId 999 !== expected 11155111"),
    optIn.out.replace(/\n/g, " | ").slice(0, 220));

  const noOptIn = await runChild({ NEMESIS_ALLOW_LIVE_TX: "1" });
  check("11", "weak opt-in value ('1') is NOT enough → blocked",
    noOptIn.out.includes("phraseOk-chainOk:BLOCKED") && noOptIn.out.includes("[TX GUARD]"),
    noOptIn.out.replace(/\n/g, " | ").slice(0, 220));
}

// ─── 10. gated live suites SKIP by default (spawned, immediately exits) ─────
{
  const bad = [];
  for (const f of LIVE_TESTS) {
    if (!fs.existsSync(path.join(ROOT, f))) continue;
    const r = await new Promise((resolve) => {
      const out = [];
      const child = spawn(process.execPath, [f], {
        cwd: ROOT,
        env: { ...process.env, NEMESIS_TEST_SUITE: "guard_skip" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", d => out.push(String(d)));
      child.stderr.on("data", d => out.push(String(d)));
      const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} resolve({ code: -1, out: out.join("") }); }, 60_000);
      child.on("exit", code => { clearTimeout(timer); resolve({ code, out: out.join("") }); });
    });
    const ok = r.code === 0 && r.out.includes("SKIP — live-test opt-in missing");
    if (!ok) bad.push(`${f} (exit=${r.code}: ${r.out.split("\n")[0].slice(0, 60)})`);
  }
  check("12", `all ${LIVE_TESTS.length} live suites SKIP with exit 0 when no opt-in`, bad.length === 0,
    bad.join(" ; "));
}

// ─── 11. this test itself never touched the real state ──────────────────────
{
  const afterHash = realStateHash();
  check("13", "real auto-trader-state.json untouched by this suite", beforeHash === afterHash,
    beforeHash.slice(0, 16));
}

const total = results.length;
console.log("═".repeat(70));
console.log(`  TX GUARD TESTS: ${total - failures}/${total} PASS`);
console.log("═".repeat(70));
process.exit(failures ? 1 : 0);
