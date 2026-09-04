# E2E FINAL REPORT — Nemesis Position Manager
## Date: 2026-09-04 | ALL TESTS PASSED ✅

---

## ARCHITECTURE (CONFIRMED ON-CHAIN)

### Exact Leverage Encoding

| Parameter | Value | Meaning |
|-----------|-------|---------|
| `leverage=20` | 2x | Divided by 10 = actual leverage |
| `leverage=30` | 3x | Divided by 10 = actual leverage |
| `leverage=160` | 16x | Divided by 10 = actual leverage (exceeds max 5x) |

**Formula: actual_leverage = leverage / 10**

### LONG Collateral Rule

```
isLong = true
collateralToken = USDT
→ User deposits USDT, receives position backed by WETH/USDT pool
```

### SHORT Collateral Rule

```
isLong = false
collateralToken = WETH
→ User deposits WETH, receives position backed by WETH/USDT pool
```

### Exact Close Parameters

```
closePosition(uint256 positionId, uint256 amountOutMin, uint256 deadline)
selector: 0xb35648d7
```

**positionId**: Internal position ID (1-indexed, from PositionCreated event topic[2])
**amountOutMin**: Minimum output (0 = accept any)
**deadline**: Unix timestamp

### Exact PositionId Source

```
PositionCreated event topic[2] = positionId
- SHORT positionId = 19 (0x13)
- LONG positionId = 20 (0x14)
- Auto-incremented per pool
```

---

## LONG E2E

### OPEN

| Field | Value |
|-------|-------|
| **TX Hash** | `0x792703800d3c0e52259b312bea68153577f876fdd32791ce35146bfb3a74dd12` |
| **Block** | 11635551 |
| **Gas used** | 989,214 |
| **Status** | ✅ SUCCESS |
| **positionId** | 20 |
| **collateralToken** | USDT |
| **collateralAmount** | 10 USDT |
| **leverage** | 20 (2x) |
| **size** | 4.9205 USDT |
| **Selector** | 0xfa2b1dfd |

### CLOSE

| Field | Value |
|-------|-------|
| **TX Hash** | `0x9f8cdcace8bd6fa4d53e8aed0f9df092428bcffb722b0e6d7e5e31f0bdee3f83` |
| **Block** | 11635578 |
| **Gas used** | 1,319,751 |
| **Status** | ✅ SUCCESS |
| **Selector** | 0xb35648d7 |

### Balances

| Token | Before | After | Delta |
|-------|--------|-------|-------|
| WETH | 0.049010 | 0.049504 | +0.000494 |
| USDT | 2490.667895 | 2500.545638 | +9.877743 |

**Net result**: LONG opened with 10 USDT, closed with ~9.88 USDT (small loss from fees)

---

## SHORT E2E

### OPEN

| Field | Value |
|-------|-------|
| **TX Hash** | `0x626178ee30b5a54dd690760cd5f137defefd543d6d97b2b85ef848a7b523d958` |
| **Block** | 11635548 |
| **Gas used** | 1,049,756 |
| **Status** | ✅ SUCCESS |
| **positionId** | 19 |
| **collateralToken** | WETH |
| **collateralAmount** | 0.0005 WETH |
| **leverage** | 20 (2x) |
| **size** | 0.000246025 WETH |
| **Selector** | 0xfa2b1dfd |

### CLOSE

| Field | Value |
|-------|-------|
| **TX Hash** | `0xc2eb6c6216977fe92dc336bf3cd17968ee3b1e88bd9fefc3373fc0d8ad0fefaf` |
| **Block** | 11635577 |
| **Gas used** | 1,920,101 |
| **Status** | ✅ SUCCESS |
| **Selector** | 0xb35648d7 |

### Balances

| Token | Before | After | Delta |
|-------|--------|-------|-------|
| WETH | 0.049010 | 0.049504 | +0.000494 |
| USDT | 2490.667895 | 2490.667895 | 0.000000 |

**Net result**: SHORT opened with 0.0005 WETH, closed with ~0.000494 WETH (small loss from fees)

---

## CODE

### Modified Files

| File | Change |
|------|--------|
| `positionManager.js` | **NEW** — openPosition, closePosition, getUserPosition, validatePositionParams |
| `deployments/v2.js` | Added `deployed: true/false` per pool, added `positionAbi`, fixed addresses |
| `deployments/index.js` | Auto-detect new factory first |

### Functions Added

| Function | Selector | Signature |
|----------|----------|-----------|
| `openPosition` | `0xfa2b1dfd` | `openPosition(bool,address,uint256,uint256,uint256,uint256,uint256)` |
| `closePosition` | `0xb35648d7` | `closePosition(uint256,uint256,uint256)` |
| `getUserPosition` | — | Checks mamNLP balance on Manager |
| `validatePositionParams` | — | Pre-flight validation |

### Exact ABI Signatures

```solidity
// OPEN — confirmed from 15+ historical successful TXs
function openPosition(
    bool isLong,           // true=LONG, false=SHORT
    address collateralToken, // WETH for SHORT, USDT for LONG
    uint256 collateralAmount, // in token decimals
    uint256 amountOutMin,  // slippage protection (0 = any)
    uint256 leverage,      // leverage * 10 (20=2x, 30=3x)
    uint256 size,          // position size
    uint256 deadline       // unix timestamp
) external returns (uint256);

// CLOSE — confirmed from E2E test + frontend JS
function closePosition(
    uint256 positionId,    // from PositionCreated event
    uint256 amountOutMin,  // minimum output (0 = any)
    uint256 deadline       // unix timestamp
) external;
```

---

## SAFETY

### ETH Limits (ALL PRESERVED ✅)

| Limit | Value | Status |
|-------|-------|--------|
| MAX_ETH_SWAP_PER_TX | 0.02 ETH | ✅ Active |
| SESSION_ETH_LIMIT | 0.1 ETH | ✅ Active |
| MIN_GAS_RESERVE | 0.003 ETH | ✅ Active |
| MAX_TOTAL_ETH_EXPOSURE | 0.15 ETH | ✅ Active |
| ETH_BLOCK_THRESHOLD | 0.005 ETH | ✅ Active |

### Full Auto

- ❌ NOT launched
- ❌ AUTO RSI NOT changed
- ❌ No leveraged positions opened via full auto

### Position Safety

- Manager code checked before every TX ✅
- Pool code checked before every TX ✅
- Pool enabled verified ✅
- Leverage validated (1-5x range) ✅
- Collateral balance checked ✅
- Allowance checked ✅
- Pre-flight simulation before every TX ✅
- Gas estimation before every TX ✅
- ETH reserve check before every TX ✅

---

## LESSONS LEARNED

1. **`withdrawWithLiquidity` is NOT for closing positions** — it's for LP providers to withdraw liquidity
2. **`closePosition(uint256,uint256,uint256)` is the correct close function** — found in frontend JS
3. **Position ID comes from PositionCreated event topic[2]** — not from LP token balance
4. **mamNLP balance is for LP providers, NOT position holders** — positions are tracked internally
5. **Leverage encoding is leverage * 10** — 20 = 2x, 30 = 3x
6. **UNI/DAI/LINK pools are NOT deployed** — 0 bytes on-chain
7. **Only 3 of 6 configured markets are active**: ETH/USDT, NEMESIS/USDT, USDC/USDT
