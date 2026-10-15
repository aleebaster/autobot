// ═══════════════════════════════════════════════════════════════════════════════
//  RUNTIME MODE — the single source of truth for "what may this process do?"
//
//  Before this module the answer was scattered and self-contradictory:
//    • config.enableSwaps       = false   (top level)
//    • config.swap.enabled      = true    (nested)
//    • config.autoSwap.enabled  = true    (nested, legacy)
//    • config.simulateOnly      = false
//    • config.fullAutoEnabled   = false
//  ...and NONE of `enableSwaps` / `simulateOnly` / `fullAutoEnabled` was read by
//  any production code path. The effective behaviour was "swaps on, live on
//  unless --dry-run was passed", which is the opposite of what the file said.
//
//  There are now exactly TWO questions with exactly ONE answer each:
//
//    1. MAY WE SWAP?        → `swapsEnabled`  (AND of all three swap switches;
//                              any explicit `false` anywhere wins → swap off)
//    2. MAY WE SEND LIVE?   → `liveEnabled`   (fullAutoEnabled is the master;
//                              live is impossible unless it is explicitly true)
//
//  And one derived flag:
//
//    3. ARE WE DRY?         → `dryRun`        (`--dry-run` OR simulateOnly=true;
//                              dry-run NEVER signs or sends anything)
//
//  Live trading can never be switched on implicitly — not by a test run, not by
//  a restart, not by an unset key. It requires `fullAutoEnabled: true` AND no
//  dry-run request. Refusing live is a hard, explained exit — never a silent
//  downgrade to a mode the operator did not ask for.
// ═══════════════════════════════════════════════════════════════════════════════

/** The CLI flag that requests a read-only run. */
export const DRY_RUN_FLAG = "--dry-run";

/**
 * Resolve the runtime mode from config + CLI flags.
 *
 * Pure and side-effect free so it is unit-testable and so callers decide what
 * to do with the answer (auto.js exits; a library consumer may just plan).
 *
 * @param {object} [config]  parsed config.json
 * @param {string[]} [args]  process.argv.slice(2)
 * @returns {{
 *   dryRun: boolean,
 *   swapsEnabled: boolean,
 *   liveEnabled: boolean,
 *   canSendTransactions: boolean,
 *   fullAutoEnabled: boolean,
 *   simulateOnly: boolean,
 *   sources: object,
 *   reasons: string[],
 *   refusal: string|null,
 * }}
 */
export function resolveRuntimeMode(config = {}, args = []) {
  const cfg = config && typeof config === "object" ? config : {};
  const argv = Array.isArray(args) ? args : [];
  const reasons = [];

  const cliDryRun = argv.includes(DRY_RUN_FLAG);

  // ── 3. DRY RUN — the most conservative flag wins ──────────────────────────
  const simulateOnly = cfg.simulateOnly === true;
  const dryRun = cliDryRun || simulateOnly;
  if (cliDryRun) reasons.push(`dry-run requested by CLI (${DRY_RUN_FLAG})`);
  if (simulateOnly) reasons.push("dry-run forced by config.simulateOnly=true");

  // ── 1. SWAPS — every switch must be non-false; any explicit false wins ────
  const enableSwaps = cfg.enableSwaps;
  const swapEnabled = cfg.swap?.enabled;
  const autoSwapEnabled = cfg.autoSwap?.enabled;
  const swapOff = [enableSwaps, swapEnabled, autoSwapEnabled].some(v => v === false);
  const swapsEnabled = !swapOff;
  if (enableSwaps === false) reasons.push("swaps disabled: config.enableSwaps=false");
  if (swapEnabled === false) reasons.push("swaps disabled: config.swap.enabled=false");
  if (autoSwapEnabled === false) reasons.push("swaps disabled: config.autoSwap.enabled=false");
  if (swapsEnabled && enableSwaps === undefined) {
    reasons.push("swaps: config.enableSwaps unset — falling through to swap.enabled/autoSwap.enabled");
  }

  // ── 2. LIVE — fullAutoEnabled is the ONLY master switch ───────────────────
  const fullAutoEnabled = cfg.fullAutoEnabled === true;
  const liveEnabled = fullAutoEnabled && !dryRun;

  let refusal = null;
  if (!fullAutoEnabled) {
    refusal = "LIVE TRADING DISABLED: config.fullAutoEnabled is not true. " +
      "Set \"fullAutoEnabled\": true to allow real transactions, or pass --dry-run / " +
      "\"simulateOnly\": true for a read-only run. Nothing will be signed or sent.";
    reasons.push("live disabled: config.fullAutoEnabled is not true");
  } else if (dryRun) {
    refusal = `LIVE TRADING OVERRIDDEN BY DRY-RUN: ${reasons.filter(r => r.startsWith("dry-run")).join("; ")}. ` +
      "No transaction will be signed or sent even though fullAutoEnabled=true.";
  }

  return {
    dryRun,
    swapsEnabled,
    liveEnabled,
    canSendTransactions: liveEnabled,
    fullAutoEnabled,
    simulateOnly,
    sources: {
      enableSwaps: enableSwaps ?? null,
      swapEnabled: swapEnabled ?? null,
      autoSwapEnabled: autoSwapEnabled ?? null,
      simulateOnly: cfg.simulateOnly ?? null,
      fullAutoEnabled: cfg.fullAutoEnabled ?? null,
      cliDryRun,
    },
    reasons,
    refusal,
  };
}

/**
 * One-line human summary for the boot banner.
 */
export function describeRuntimeMode(mode) {
  if (!mode) return "mode: unknown";
  const swap = mode.swapsEnabled ? "swaps=ON" : "swaps=OFF";
  const live = mode.liveEnabled ? "LIVE" : (mode.dryRun ? "DRY-RUN" : "BLOCKED");
  return `mode: ${live} ${swap} (fullAutoEnabled=${mode.fullAutoEnabled} simulateOnly=${mode.simulateOnly})`;
}

export default { resolveRuntimeMode, describeRuntimeMode, DRY_RUN_FLAG };
