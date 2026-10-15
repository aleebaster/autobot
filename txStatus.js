// ═══════════════════════════════════════════════════════════════════════════
//  TRANSACTION STATUS LIFECYCLE + DURABLE TRANSACTION JOURNAL
//
//  The bot used to derive "success" from a SINGLE receipt read against the
//  configured RPC. That node answers `null` for eth_getTransactionReceipt on
//  transactions that ARE mined, so a confirmed transaction could be reported as
//  pending (and a pending one as done). This module makes the state explicit,
//  cross-checks a second source before concluding anything, and appends every
//  transition to an append-only journal file so any reported success can be
//  audited against the chain after the fact.
//
//  States:
//    PREPARED                 — we are about to sign/send (recorded, not sent)
//    SUBMITTED                — hash exists, not yet seen in a block
//    PENDING                  — in the mempool / not mined yet
//    CONFIRMED                — receipt.status === 1 (mined and succeeded)
//    REVERTED                 — receipt.status === 0 (mined and failed)
//    DROPPED_OR_REPLACED      — no receipt anywhere and the nonce is consumed
//    UNKNOWN                  — mined (tx.blockNumber present) but no RPC
//                               returned a receipt: status cannot be asserted
//    CONFIRMED_STATE_MISMATCH — receipt is status 1 but the post-confirmation
//                               read contradicts what the bot assumed
//
//  READ-ONLY with respect to bot state: this module never touches
//  auto-trader-state.json.
// ═══════════════════════════════════════════════════════════════════════════

import fs from "fs";
import { ethers } from "ethers";

export const TX_STATE = Object.freeze({
  PREPARED: "PREPARED",
  SUBMITTED: "SUBMITTED",
  PENDING: "PENDING",
  CONFIRMED: "CONFIRMED",
  REVERTED: "REVERTED",
  DROPPED_OR_REPLACED: "DROPPED_OR_REPLACED",
  UNKNOWN: "UNKNOWN",
  CONFIRMED_STATE_MISMATCH: "CONFIRMED_STATE_MISMATCH",
});

export const TX_STATES = Object.freeze(Object.values(TX_STATE));

/** States that will never change again without a new transaction. */
const TERMINAL = new Set([TX_STATE.CONFIRMED, TX_STATE.REVERTED, TX_STATE.DROPPED_OR_REPLACED]);

/** States that are only valid while nothing is settled yet. */
const TRANSIENT = new Set([TX_STATE.PREPARED, TX_STATE.SUBMITTED, TX_STATE.PENDING, TX_STATE.UNKNOWN]);

export function isTerminalState(state) {
  return TERMINAL.has(state);
}

export function isTransientState(state) {
  return TRANSIENT.has(state);
}

export function isKnownState(state) {
  return TX_STATES.includes(state);
}

/** Confirmed-but-wrong is terminal too: the tx landed, the expectation did not. */
export function isSettledState(state) {
  return TERMINAL.has(state) || state === TX_STATE.CONFIRMED_STATE_MISMATCH;
}

/**
 * Receipt → state. `null` receipt means "not yet resolved", never "failed".
 * @param {object|null} receipt
 * @returns {string|null}
 */
export function stateFromReceipt(receipt) {
  if (!receipt) return null;
  return Number(receipt.status) === 1 ? TX_STATE.CONFIRMED : TX_STATE.REVERTED;
}

/**
 * Pure classification of one transaction observed through one or more sources.
 *
 * The distinction that matters: "no receipt" is NOT a failure. It splits into
 *   • PENDING               — the tx is simply not mined yet,
 *   • DROPPED_OR_REPLACED   — our nonce was consumed but this hash never mined,
 *   • UNKNOWN               — the tx IS mined (blockNumber set) yet no node
 *                             returned a receipt, so status is unprovable.
 *
 * @param {object}   input
 * @param {object}   [input.receipt]     receipt object, or null
 * @param {object}   [input.tx]          getTransaction() result; null = absent
 * @param {number}   [input.nonce]       the nonce WE signed with
 * @param {number}   [input.latestNonce] getTransactionCount(addr, "latest")
 * @returns {string} one of TX_STATE
 */
export function classifyTx({ receipt = null, tx = undefined, nonce = null, latestNonce = null } = {}) {
  const fromReceipt = stateFromReceipt(receipt);
  if (fromReceipt) return fromReceipt;

  const nonceSpent = Number.isFinite(Number(nonce))
    && Number.isFinite(Number(latestNonce))
    && Number(latestNonce) > Number(nonce);

  if (nonceSpent) return TX_STATE.DROPPED_OR_REPLACED;
  if (tx === null) return TX_STATE.DROPPED_OR_REPLACED;
  if (tx === undefined) return TX_STATE.UNKNOWN;
  return tx.blockNumber !== null && tx.blockNumber !== undefined
    ? TX_STATE.UNKNOWN
    : TX_STATE.PENDING;
}

/**
 * Next legal transition. Enforces the lifecycle instead of trusting the caller,
 * so a CONFIRMED tx can never be silently downgraded to PENDING.
 *
 * @returns {{ok:boolean, reason?:string}}
 */
export function canTransition(from, to) {
  if (!isKnownState(to)) return { ok: false, reason: `unknown target state ${to}` };
  if (!from) return { ok: true };
  if (from === to) return { ok: true };
  // The one downgrade that IS legal: the receipt said CONFIRMED and the
  // post-confirmation read contradicted it.
  if (from === TX_STATE.CONFIRMED && to === TX_STATE.CONFIRMED_STATE_MISMATCH) return { ok: true };
  if (isSettledState(from)) return { ok: false, reason: `${from} is settled` };
  if (from === TX_STATE.UNKNOWN && to === TX_STATE.CONFIRMED) return { ok: true };
  if (from === TX_STATE.UNKNOWN && to === TX_STATE.REVERTED) return { ok: true };
  if (from === TX_STATE.PENDING && to === TX_STATE.SUBMITTED) return { ok: false, reason: "PENDING → SUBMITTED goes backwards" };
  return { ok: true };
}

// ─── Multi-source receipt resolution ────────────────────────────────────────

/** Public fallback Sepolia endpoints — used ONLY to break a receipt deadlock. */
export function fallbackRpcUrls() {
  const raw = process.env.NEMESIS_FALLBACK_RPCS
    ?? process.env.FALLBACK_RPCS
    ?? "https://sepolia.drpc.org,https://sepolia.gateway.tenderly.co";
  return String(raw).split(",").map(s => s.trim()).filter(Boolean);
}

const _fallbackProviders = new Map();

function fallbackProvider(url) {
  if (!_fallbackProviders.has(url)) {
    try {
      _fallbackProviders.set(url, new ethers.JsonRpcProvider(url, 11155111));
    } catch {
      _fallbackProviders.set(url, null);
    }
  }
  return _fallbackProviders.get(url);
}

/** Test seam: forget cached providers between test cases. */
export function _resetFallbackProviders() {
  _fallbackProviders.clear();
}

/**
 * Resolve a receipt trying the primary provider first and then each fallback.
 *
 * A single flaky node must never be able to flip CONFIRMED → PENDING.
 *
 * @param {object}   input
 * @param {object}   input.provider  primary provider
 * @param {string}   input.hash
 * @param {string[]} [input.fallbacks]
 * @param {function} [input.log]
 * @returns {Promise<{receipt:object|null, source:string|null, attempts:Array}>}
 */
export async function resolveReceipt({ provider, hash, fallbacks = null, log = null } = {}) {
  const attempts = [];
  if (!hash) return { receipt: null, source: null, attempts };

  const chain = [];
  if (provider) chain.push({ name: "primary", p: provider });
  let i = 0;
  for (const url of (fallbacks === null ? fallbackRpcUrls() : fallbacks)) {
    const p = url && typeof url === "object" ? url : fallbackProvider(url);
    if (p) chain.push({ name: typeof url === "object" ? `fallback#${++i}` : url, p });
  }

  for (const { name, p } of chain) {
    try {
      const r = await p.getTransactionReceipt(hash);
      attempts.push({ source: name, found: !!r });
      if (r) return { receipt: r, source: name, attempts };
    } catch (e) {
      attempts.push({ source: name, found: false, error: String(e?.message || e).slice(0, 120) });
    }
  }
  if (log && attempts.length > 1) {
    log(`[TX] no receipt on ${attempts.length} endpoints for ${String(hash).slice(0, 18)}…`, "warn");
  }
  return { receipt: null, source: null, attempts };
}

// ─── Durable transaction journal ────────────────────────────────────────────

const DEFAULT_JOURNAL = "tx-journal.jsonl";

/**
 * Append-only JSONL journal. One line per state transition; `load()` replays
 * them last-write-wins so the final state of every hash survives a restart.
 *
 * Set `NEMESIS_TX_JOURNAL=off` to disable writing (tests that must not touch
 * the filesystem), or to a path to relocate it.
 */
export class TxJournal {
  constructor(file = process.env.NEMESIS_TX_JOURNAL ?? DEFAULT_JOURNAL) {
    this.file = file;
    this.enabled = !(file === "off" || file === "" || file === "0" || file === "false");
    this.entries = new Map();
  }

  _append(entry) {
    if (!this.enabled) return entry;
    try {
      fs.appendFileSync(this.file, JSON.stringify(entry) + "\n");
    } catch {
      // A journaling failure must never break a transaction.
    }
    return entry;
  }

  /** PREPARED — called before/at send time. */
  begin(fields = {}) {
    if (!fields.hash) return null;
    const entry = { ts: Date.now(), state: TX_STATE.PREPARED, ...fields };
    this.entries.set(entry.hash, entry);
    return this._append(entry);
  }

  /** Record a transition. Ignores illegal transitions (never throws). */
  transition(hash, state, extra = {}) {
    if (!hash || !isKnownState(state)) return null;
    const prev = this.entries.get(hash) || { hash };
    const verdict = canTransition(prev.state, state);
    if (!verdict.ok) {
      this._append({ ts: Date.now(), hash, state: prev.state, rejected: state, reason: verdict.reason, ...extra });
      return null;
    }
    const entry = { ...prev, ...extra, hash, state, updatedAt: Date.now() };
    this.entries.set(hash, entry);
    return this._append(entry);
  }

  get(hash) {
    return this.entries.get(hash) || null;
  }

  all() {
    return [...this.entries.values()];
  }

  /** Replay the file (last write wins per hash). Returns `this` for chaining. */
  load() {
    if (!this.enabled || !fs.existsSync(this.file)) return this;
    try {
      for (const line of fs.readFileSync(this.file, "utf8").split("\n")) {
        if (!line.trim()) continue;
        const e = JSON.parse(line);
        if (e && e.hash) this.entries.set(e.hash, e);
      }
    } catch { /* corrupted tail — keep what we already have */ }
    return this;
  }

  /** Everything still unsettled — used to re-check on startup. */
  unsettled() {
    return this.all().filter(e => isTransientState(e.state));
  }
}

export function createTxJournal(file) {
  return new TxJournal(file);
}
