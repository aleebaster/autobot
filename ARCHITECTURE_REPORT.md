# Nemesis V2 Deployment — Complete Architecture Report
## Date: 2026-09-04 | On-chain verified

---

## A. CURRENT ON-CHAIN DEPLOYMENT

### Core Contracts

| Contract | Address | Code Size | Role |
|----------|---------|-----------|------|
| **Factory** | `0xdED3D3CA2F7eFDE734790ce51bD03D5145E4830B` | 15,926 bytes | Pool registry, router lookup |
| **Router** | `0x8f6eB7870334b1FD8006Fd52413f01689f4E57e9` | 12,683 bytes | Uniswap V2 swap router |
| **Implementation** | `0xeE68790cDb86BDCB7B9681E6fa7DC53744Ba4f4C` | 24,402 bytes | Shared by ALL manager proxies |
| **Pool (ETH/USDT)** | `0xf32E24b7F739c7C17544cb972833aB551121A72B` | 11,839 bytes | Enhanced Uniswap V2 + OMM |
| **Manager (ETH/USDT)** | `0x2069b502DD917DC089171F96BeE390FcB5bad29d` | 44 bytes | EIP-1167 proxy → Impl |

### Active Pools (3 of 6 — only these have code on-chain)

| Pool | Address | Token0 | Token1 | Code Size |
|------|---------|--------|--------|-----------|
| **ETH/USDT** | `0xf32E24b7F739c7C17544cb972833aB551121A72B` | USDT | WETH | 11,839 ✅ |
| **NEMESIS/USDT** | `0x792bCdbe39E6aF13EeEbab251Cb59D6824EBe28e` | NEMESIS | USDT | 11,839 ✅ |
| **USDC/USDT** | `0x7E0F5abE7ac2d7F609C70d5eEae4c3aeB6c8606e` | USDC | USDT | 11,839 ✅ |
| UNI/USDT | `0x07a44c21688c0dB4486B6325EDf0a0C2C9c00571` | — | — | **0 ❌ NOT DEPLOYED** |
| DAI/USDT | `0x5e7821F6B0Aa6716e9E2046B2aB91C0E94b74716` | — | — | **0 ❌ NOT DEPLOYED** |
| LINK/USDT | `0xd9Ab0698D658AFc6221DcA6BF7b70B4005aE44c5` | — | — | **0 ❌ NOT DEPLOYED** |

### Per-Market Manager Addresses

| Market | Manager Proxy | Code Size |
|--------|--------------|-----------|
| ETH/USDT | `0x2069b502DD917DC089171F96BeE390FcB5bad29d` | 44 bytes ✅ |
| NEMESIS/USDT | `0xD45dde32C66769ED835A0F0f45EC0bF6973857FD` | 44 bytes ✅ |
| USDC/USDT | `0xAbC78D0650f47426DeF16286FF0cE9CFD501e80e` | 44 bytes ✅ |
| UNI/USDT | `0x6238f87Dd84DA1DA2b0e93b22b380c710EE674a7` | 44 bytes ✅ |
| LINK/USDT | `0xF603d60B713e557dc199DDceaCF370eA90ECC00E` | 44 bytes ✅ |

All manager proxies point to the same implementation: `0xeE68790cDb86BDCB7B9681E6fa7DC53744Ba4f4C`

---

## B. ARCHITECTURE FLOW

```
USER
  │
  ├──[SWAP]────► ROUTER (0x8f6eB7...) ──► POOL (0xf32E24...) ──► WETH/USDT
  │                │ Uniswap V2
  │                └── factory() → 0xdED3D3...
  │
  ├──[OPEN LONG]──► MANAGER PROXY (0x2069b5...) ──► IMPL (0xeE6879...)
  │   selector: 0xfa2b1dfd    │
  │   params: (amount, collateral, collateralAmt, minOut, isLong,
  │            leverage, deadline, r, v, paymentToken)
  │                           ├──► POOL (0xf32E24...) ──► Liquidity swap
  │                           ├──► WETH (ERC20)
  │                           └──► USDT (ERC20)
  │
  ├──[CLOSE POSITION]──► MANAGER PROXY (0x2069b5...) ──► IMPL
  │   selector: 0x3f3cd555
  │   params: (positionId, collateralToken, marketToken, amount,
  │            amount2, recipient, refundTo, deadline)
  │
  └──[LP]──► MANAGER PROXY (0x2069b5...) ──► IMPL
              ERC4626 vault (deposit/withdraw)
```

---

## C. CONFIRMED FUNCTION SIGNATURES (from real transaction decode)

### Position Manager Functions

| Selector | Function | Source |
|----------|----------|--------|
| `0xfa2b1dfd` | `openLeveragedPosition(uint256,address,uint256,uint256,bool,uint256,uint256,bytes32,uint256,address)` | 27 successful TXs |
| `0x3f3cd555` | `closeLeveragedPosition(uint256,address,address,uint256,uint256,address,address,uint256)` | 1 successful TX |
| `0x7ecebe00` | `getUserPosition(address) → uint256` | Live call verified |
| `0xc45a0155` | `factory() → address` | Live call verified |
| `0x18160ddd` | `totalSupply() → uint256` | Live call verified |
| `0x70a08231` | `balanceOf(address) → uint256` | Live call verified |

### OPEN Position Calldata (decoded from TX `0x3b5a38...`)

```
Function: 0xfa2b1dfd (openLeveragedPosition)
[0]  uint256  positionId      = 0           (new position)
[1]  address  collateralToken = WETH
[2]  uint256  collateralAmt   = 1200000000000000 (~0.0012 ETH)
[3]  uint256  minOut          = 0           (slippage)
[4]  bool     isLong          = true
[5]  uint256  sizeOrLeverage  = (amount)
[6]  uint256  deadline        = timestamp
[7]  bytes32  r               = EIP-712 signature component
[8]  uint256  vOrFlag         = 1
[9]  address  paymentToken    = WETH
```

### CLOSE Position Calldata (decoded from TX `0x966664...`)

```
Function: 0x3f3cd555 (closeLeveragedPosition)
[0]  uint256  positionId      = (unique ID)
[1]  address  collateralToken = USDT
[2]  address  marketToken     = WETH
[3]  uint256  amount          = (token amount)
[4]  uint256  amount2         = (ETH amount)
[5]  address  recipient       = user address
[6]  address  refundTo        = user address
[7]  uint256  deadline        = timestamp
```

---

## D. POOL PARAMETERS (ETH/USDT — from on-chain probes)

| Parameter | Selector | Value | Meaning |
|-----------|----------|-------|---------|
| feeRate | `0x0878dc72` | 300 | 3% fee (300 basis points) |
| maxLeverage | `0x35659fb8` | 5 | 5x maximum leverage |
| precision | `0x4dfec49e` | 64 | Precision factor |
| precisionBase | `0x2ffdaf89` | 100 | Base precision |
| timeWindow | `0x1a65893b` | 60 | 60 seconds |
| enabled | `0x3b24e658` | 1 | Pool active |
| treasury | `0x5909c0d5` | `0x0087E7F16b2EB6b655aF42DD96B3DcC897384aF8` | Fee collector |
| feeCollector | `0x5c20df68` | `0x000001bf7BacB6aE6876c94Cc1685215620605c2` | Fee recipient |
| poolConfig | `0x217ac237` | 352-byte struct | Full config data |

---

## E. PLAIN ENGLISH

This deployment has the **same architecture as V1** but with new addresses:

```
SWAP:  USER → Router → Pool → Token swap
LONG:  USER → Manager(proxy) → Pool → collateral swap + position tracked
SHORT: USER → Manager(proxy) → Pool → collateral swap + position tracked (isLong=false)
LP:    USER → Manager(proxy) → ERC4626 vault deposit
```

The Position Manager is:
- An **ERC4626 LP vault** (for liquidity providers)  
- A **Position Manager** (for traders)  
- **Both in one contract** — different function selectors

---

## F. BOT CODE ANALYSIS

### Current Bot State

The bot's `lpExecutor.js` handles:
- ✅ `addLiquidity` via Manager proxy  
- ✅ `removeLiquidity` via Manager proxy  
- ✅ Token swaps via Router  

**NOT IMPLEMENTED in bot:**
- ❌ `openLeveragedPosition` (`0xfa2b1dfd`) — not in codebase
- ❌ `closeLeveragedPosition` (`0x3f3cd555`) — not in codebase  
- ❌ Position query functions — not in codebase

The bot currently treats the Manager proxy as an LP vault only. Leveraged position functions exist on-chain but are NOT implemented in the bot's code.

### Key Files

| File | Current Role |
|------|-------------|
| `deployments/v2.js` | ✅ Correct addresses (Factory, Router, Manager proxies) |
| `config.json` | ✅ Correct pool addresses, manager addresses, token addresses |
| `tokenInventory.js` | ETH spending guards (unchanged, correct) |
| `lpExecutor.js` | LP add/remove liquidity only (correct for LP) |
| `lpManager.js` | LP management (correct for LP) |

---

## G. CONCLUSIONS

### What's Working
1. **Swap routing** — Router → Pool → token swap ✅
2. **LP operations** — Manager proxy → ERC4626 vault ✅  
3. **Pool discovery** — Factory → getPool(tokenA, tokenB) ✅
4. **Manager proxy lookup** — All proxies functional ✅

### What's Missing (for leveraged trading)
1. **Open position function** — `0xfa2b1dfd` exists on-chain but not in bot
2. **Close position function** — `0x3f3cd555` exists on-chain but not in bot
3. **Position queries** — `getUserPosition(address)` exists on-chain but not in bot
4. **EIP-712 signing** — The open position function requires a signature component (bytes32 r, uint256 v)
5. **Position state tracking** — No on-chain position reader in bot

### Root Cause of "Stale Addresses" (Previous Investigation)
The bot was pointing to the OLD factory (`0x28e90C...`) instead of the NEW factory (`0xdED3D3...`). This has been fixed. The NEW factory returns the correct Router (`0x8f6eB7...`) via `Factory.router()`.

### Manager Implementation Analysis
- All manager proxies use the SAME implementation: `0xeE68790cDb86BDCB7B9681E6fa7DC53744Ba4f4C`
- The implementation is 24,402 bytes
- It contains BOTH ERC4626 vault logic AND position management logic
- The proxy at `0x2069b502...` routes all calls through delegatecall to this implementation

### ⚠️ CRITICAL FINDING
**UNI/USDT, DAI/USDT, and LINK/USDT pools have ZERO bytes of code on-chain.** They do NOT exist in the current deployment. The config lists 6 markets but only 3 are actually deployed. Any attempt to interact with UNI, DAI, or LINK pools will fail.

### Key Addresses Summary

```
FACTORY:    0xdED3D3CA2F7eFDE734790ce51bD03D5145E4830B
ROUTER:     0x8f6eB7870334b1FD8006Fd52413f01689f4E57e9
IMPL:       0xeE68790cDb86BDCB7B9681E6fa7DC53744Ba4f4C

ETH/USDT:   Pool: 0xf32E24b7F739c7C17544cb972833aB551121A72B
            Manager: 0x2069b502DD917DC089171F96BeE390FcB5bad29d

NEMESIS:    Pool: 0x792bCdbe39E6aF13EeEbab251Cb59D6824EBe28e
            Manager: 0xD45dde32C66769ED835A0F0f45EC0bF6973857FD

USDC:       Pool: 0x7E0F5abE7ac2d7F609C70d5eEae4c3aeB6c8606e
            Manager: 0xAbC78D0650f47426DeF16286FF0cE9CFD501e80e

WETH:       0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9
USDT:       0x5f2E83cCDEa73D60aF400e03F1Cd8Fb9eaB07b20
```

### CONFIRMED FUNCTION SELECTORS

```
OPEN:   0xfa2b1dfd  →  openLeveragedPosition(...) on Manager proxy
CLOSE:  0x3f3cd555  →  closeLeveragedPosition(...) on Manager proxy
POS_Q:  0x7ecebe00  →  getUserPosition(address) on Manager proxy
FACTORY: 0xc45a0155  →  factory() on Manager proxy
SUPPLY:  0x18160ddd  →  totalSupply() on Manager proxy
BAL:     0x70a08231  →  balanceOf(address) on Manager proxy
```
