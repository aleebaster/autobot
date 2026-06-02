# Changelog

## 2026-06-02

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
