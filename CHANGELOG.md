# Changelog

## 2026-06-05

- Added isolated Liquidity Pool mode with add, remove, status, config, and auto-cycle flows for ETH/DAI LP.
- Fixed LP add-liquidity minimum calculations to use pool-ratio optimal ETH/token amounts instead of configured desired DAI as the min amount.
- Wired LP mode to the Nemesis UI liquidity surface: leveraged router `0x5b23F24b08fa3FAa0Fa555611ACF74c3bAb23550`, leveraged DAI `0x8a871311feF28B3d684Fb4F06B964603196BD4E3`, and pool `0xA079592346cF2CCe68Fd7e1FFADE041a602D33e4`.
- Fixed runtime cooldown parsing so explicit `0` values are preserved instead of falling back to defaults; this keeps immediate auto-close test/runtime paths honest.
- Added `NEMESIS_SKIP_GIT_SYNC=1` startup guard for controlled proof runs without changing production startup behavior by default.
- Verified LONG UI agreement: open appeared in Nemesis UI subgraph with matching tx/position, close removed it from open UI state.
- Verified SHORT UI agreement: open appeared in Nemesis UI subgraph with matching tx/position, close removed it from open UI state.
- Verified full-auto runtime opens/closes using the actual app path: swaps executed, LONG opened/closed, SHORT opened/closed, receipts succeeded, local active-position cache cleared, chain active positions returned to zero, and UI open positions returned to zero.
- Verified LP add/remove chain and UI balance agreement: chain LP balance moved `0 -> positive -> 0`, UI `lpBalance` moved `0 -> positive -> 0`.
- Documented external Nemesis UI/indexer behavior: `userLiquidityPositions.status` may remain `OPEN` when `lpBalance` is `0`; this is treated as external UI/indexer state unless chain LP balance or UI `lpBalance` contradicts removal.

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
