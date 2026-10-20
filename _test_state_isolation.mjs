// ═══════════════════════════════════════════════════════════════════════════
//  SHARED TEST STATE ISOLATION
//
//  A previous test run (test_close_recovery.mjs, before it was guarded)
//  overwrote the REPO's real auto-trader-state.json and destroyed position
//  #75's record. autoTrader.js reads STATE_FILE from
//  process.env.NEMESIS_STATE_FILE at MODULE LOAD, so the env var must be set
//  BEFORE autoTrader.js is evaluated.
//
//  ESM evaluates imported modules depth-first in import order, so importing
//  THIS FILE as the FIRST import of a test guarantees the env var is set before
//  any later import of autoTrader.js — for both static and dynamic imports.
//
//  Each test gets its own scratch directory, seeded from a pristine copy of the
//  real state so behaviour is realistic while the real file stays untouched.
// ═══════════════════════════════════════════════════════════════════════════

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const REPO = path.dirname(fileURLToPath(import.meta.url));
const REAL_STATE = path.join(REPO, "auto-trader-state.json");

// Seed source: the real state, unless the caller points us at a fixture.
// NEMESIS_TEST_STATE_SEED lets a suite start from a controlled snapshot
// instead of live data.
const SEED = process.env.NEMESIS_TEST_STATE_SEED || REAL_STATE;

// Unique scratch dir per test file, so parallel suites never collide.
const SUITE = process.env.NEMESIS_TEST_SUITE
  || path.basename(fileURLToPath(import.meta.url)).replace(/\.[cm]?js$/, "");
const SCRATCH_DIR = path.join(REPO, ".test-state", SUITE);
const SCRATCH_STATE = path.join(SCRATCH_DIR, "state.json");

fs.mkdirSync(SCRATCH_DIR, { recursive: true });
if (fs.existsSync(SEED)) fs.copyFileSync(SEED, SCRATCH_STATE);
else fs.writeFileSync(SCRATCH_STATE, JSON.stringify({
  activePosition: null, sessionStats: { opens: 0, closes: 0 }, lastCycleTime: 0, lastSide: null,
}, null, 2));

// MUST precede autoTrader.js evaluation.
process.env.NEMESIS_STATE_FILE = SCRATCH_STATE;

// ═══════════════════════════════════════════════════════════════════════════
//  LIVE-TRANSACTION GUARD — default-deny for every suite that imports this
//  module (2026-10 incident: test_final_validation.mjs signed real Sepolia
//  transactions because state isolation alone never gated the signer).
//
//  A test may only sign/broadcast when BOTH hold:
//    1. NEMESIS_ALLOW_LIVE_TX === "SEND LIVE TRANSACTIONS"   (explicit opt-in
//       phrase — a stray "1"/"true" is not enough), and
//    2. the network chainId equals NEMESIS_LIVE_CHAIN_ID (default 11155111,
//       Sepolia) — so an opt-in can never reach another network.
//
//  Production `auto.js` does NOT import this module and is unaffected.
// ═══════════════════════════════════════════════════════════════════════════
process.env.NEMESIS_TEST_MODE = "1";

const LIVE_TX_OPTIN = process.env.NEMESIS_ALLOW_LIVE_TX === "SEND LIVE TRANSACTIONS";
const LIVE_CHAIN_ID = BigInt(process.env.NEMESIS_LIVE_CHAIN_ID || "11155111");
const TX_BLOCK_MSG =
  '[TX GUARD] blocked: tests are read-only by default. Live sends require ' +
  'NEMESIS_ALLOW_LIVE_TX="SEND LIVE TRANSACTIONS" (chainId ' +
  `${LIVE_CHAIN_ID} via NEMESIS_LIVE_CHAIN_ID).`;

export async function assertLiveTxAllowed(provider) {
  if (!LIVE_TX_OPTIN) throw new Error(TX_BLOCK_MSG);
  if (provider && typeof provider.getNetwork === "function") {
    let net;
    try { net = await provider.getNetwork(); }
    catch { return; } // offline provider: the signer path itself will fail safely
    if (BigInt(net.chainId) !== LIVE_CHAIN_ID) {
      throw new Error(`[TX GUARD] blocked: network chainId ${net.chainId} !== expected ${LIVE_CHAIN_ID} (NEMESIS_LIVE_CHAIN_ID).`);
    }
  }
}

const _ethers = await import("ethers");
{
  // Wrap sendTransaction/signTransaction on EVERY prototype in a real
  // Wallet's chain that OWNS them (ethers v6 splits them across Wallet /
  // BaseWallet / AbstractSigner). Per-method OWN flags avoid the inheritance
  // trap where a flag set on the base prototype looks "already patched" to
  // subclasses.
  const wrap = (owner, name) => {
    if (!owner || typeof owner[name] !== "function") return;
    const flag = "__nemesisGuard_" + name;
    if (Object.prototype.hasOwnProperty.call(owner, flag)) return;
    const orig = owner[name];
    owner[flag] = true;
    owner[name] = async function (...args) {
      await assertLiveTxAllowed(this.provider);
      return orig.apply(this, args);
    };
  };
  let cur = _ethers.Wallet?.prototype;
  while (cur && cur !== Object.prototype) {
    wrap(cur, "sendTransaction");
    wrap(cur, "signTransaction");
    cur = Object.getPrototypeOf(cur);
  }
  const prov = _ethers.JsonRpcApiProvider?.prototype;
  if (prov && !Object.prototype.hasOwnProperty.call(prov, "__nemesisGuard_send")) {
    const origSend = prov.send;
    prov.__nemesisGuard_send = true;
    prov.send = async function (method, params) {
      if (method === "eth_sendRawTransaction") await assertLiveTxAllowed(this);
      return origSend.call(this, method, params);
    };
  }
}

export const TEST_STATE_FILE = SCRATCH_STATE;
export const REAL_STATE_FILE = REAL_STATE;

/** SHA-256 of the REAL state file. Suites assert this is unchanged. */
export function realStateHash() {
  return fs.existsSync(REAL_STATE)
    ? crypto.createHash("sha256").update(fs.readFileSync(REAL_STATE)).digest("hex")
    : "(missing)";
}

/** SHA-256 of this suite's scratch state file. */
export function scratchStateHash() {
  return fs.existsSync(SCRATCH_STATE)
    ? crypto.createHash("sha256").update(fs.readFileSync(SCRATCH_STATE)).digest("hex")
    : "(missing)";
}
