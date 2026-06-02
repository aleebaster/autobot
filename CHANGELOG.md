# Changelog

## 2026-06-03

- Fixed leveraged open routing to send `openPosition` to the manager contract; Sepolia preflight proved the pool target reverts while the same calldata succeeds on the manager.
- Fixed LONG quote calculation so `amountOutMin` uses the contract's leverage scale consistently with SHORT; the previous LONG quote exceeded the contract's real output threshold and reverted with selector `0x499ad952`.
- Verified live LONG and SHORT open/close receipts on Sepolia with manager target, runtime-scaled quotes, and zeroed `getPosition` state after close.

## 2026-06-02

- Removed false open/close success by requiring receipt status plus refreshed on-chain position verification before state updates.
- Added in-memory side-specific bad-market blacklist and health scoring so reverting markets do not stop full-auto.
- Added hard swap quote guards so zero-output quotes are skipped before approval or transaction send.
- Fixed leveraged open target selection to use the Nemesis pool address and added LONG revert diagnostics.
- Fixed auto-close confirmation so positions are only removed after a confirmed close receipt and chain refresh.
- Hardened LONG/SHORT opens with strict manager, calldata, and non-zero quote validation plus RSI market debug logs.
- Fixed full-auto open blocking by syncing positions from chain before duplicate checks and pruning stale cached positions.
- Refactored `[1]` into `Start Full Auto Trading` for master swaps, RSI trading, ratio-based opens, auto-close monitoring, and persisted resume state.
- Added ENTER submit and ESC cancel keybindings for config popup forms.
- Added a dedicated `[9] Stop Auto RSI Trading` menu action with persisted stop state.
- Added `rsiRunning` duplicate-session protection, RUNNING/STOPPED logs, and dynamic Auto RSI status text.
- Added multi-market trading configuration for single, selected, and all-market RSI modes.
- Added market discovery from Nemesis leveraged factory pools with inactive/broken market skips.
- Added per-market duplicate prevention, cooldowns, daily trade limits, and concurrent trade limits.
- Added fixed/equal trade distribution and wallet-percent trade sizing.
- Added close selector bulk actions for all LONG, all SHORT, or all positions.
- Fixed close transactions so they no longer run open-position collateral validation.
- Added startup git sync for `origin nemesis-autobot` with config, wallet, private-key, and env protection.
- Added `.gitignore` protections for secrets, wallets, and dependencies.
