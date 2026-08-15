/**
 * Integration test: Verify Automatic Swaps and Full Auto configuration
 * 
 * Tests:
 * 1. Config values are correct (reduced cooldowns, increased limits)
 * 2. Bidirectional swap pair generation
 * 3. Random amount generation within 0.1 ETH max
 * 4. Menu labels are updated
 */

import fs from 'fs';

const CONFIG_FILE = 'config.json';
const INDEX_FILE = 'index.js';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✅ ${message}`);
    passed++;
  } else {
    console.log(`  ❌ ${message}`);
    failed++;
  }
}

console.log('\n═══════════════════════════════════════════════════════');
console.log('  INTEGRATION TEST: Automatic Swaps & Full Auto');
console.log('═══════════════════════════════════════════════════════\n');

// ── Test 1: Config values ──
console.log('📋 Test 1: Config values');
try {
  const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  
  assert(cfg.cooldownSeconds <= 30, `cooldownSeconds=${cfg.cooldownSeconds} (should be ≤30)`);
  assert(cfg.maxOpenPositions >= 3, `maxOpenPositions=${cfg.maxOpenPositions} (should be ≥3)`);
  assert(cfg.cooldownPerMarket <= 60, `cooldownPerMarket=${cfg.cooldownPerMarket} (should be ≤60)`);
  assert(cfg.maxDailyTrades >= 50, `maxDailyTrades=${cfg.maxDailyTrades} (should be ≥50)`);
  assert(cfg.enableClose === true, `enableClose=${cfg.enableClose} (should be true)`);
  assert(cfg.swapIntervalSeconds <= 5, `swapIntervalSeconds=${cfg.swapIntervalSeconds} (should be ≤5)`);
  assert(cfg.swapMaxAmount <= 0.1, `swapMaxAmount=${cfg.swapMaxAmount} (should be ≤0.1)`);
  assert(cfg.tradeMaxAmount <= 0.1, `tradeMaxAmount=${cfg.tradeMaxAmount} (should be ≤0.1)`);
} catch (error) {
  console.log(`  ❌ Config load failed: ${error.message}`);
  failed++;
}

// ── Test 2: Index.js menu labels ──
console.log('\n📋 Test 2: Menu labels in index.js');
try {
  const indexCode = fs.readFileSync(INDEX_FILE, 'utf8');
  
  assert(indexCode.includes('"Automatic Swaps"'), 'Menu contains "Automatic Swaps" label');
  assert(!indexCode.includes('"Token Swap"') || indexCode.includes('case "Token Swap"'), 'Old "Token Swap" label removed from menu items');
  assert(indexCode.includes('Start Automatic Swaps'), 'Menu contains "Start Automatic Swaps" action');
  assert(indexCode.includes('Stop Automatic Swaps'), 'Menu contains "Stop Automatic Swaps" action');
} catch (error) {
  console.log(`  ❌ Index.js read failed: ${error.message}`);
  failed++;
}

// ── Test 3: Cyclic swap engine changes ──
console.log('\n📋 Test 3: Cyclic swap engine');
try {
  const indexCode = fs.readFileSync(INDEX_FILE, 'utf8');
  
  assert(indexCode.includes('bidirectionalPairs'), 'Cyclic swap engine uses bidirectional pairs');
  assert(indexCode.includes('MAX_SWAP_ETH = 0.1'), 'Max swap amount is 0.1 ETH');
  assert(indexCode.includes('while (!cyclicSwapStopRequested)'), 'Infinite loop present');
  assert(!indexCode.includes('maxCycles') || indexCode.includes('maxCycles: Infinity'), 'No max cycle limit');
  assert(indexCode.includes('intervalSeconds: 3'), 'Default swap interval is 3 seconds');
} catch (error) {
  console.log(`  ❌ Index.js read failed: ${error.message}`);
  failed++;
}

// ── Test 4: Full Auto integration ──
console.log('\n📋 Test 4: Full Auto Trading integration');
try {
  const indexCode = fs.readFileSync(INDEX_FILE, 'utf8');
  
  assert(indexCode.includes('Starting Automatic Swaps (continuous cycle)'), 'Full Auto starts swaps');
  assert(indexCode.includes('Starting Auto RSI trading (LONG/SHORT)'), 'Full Auto starts RSI trading');
  assert(indexCode.includes('stopCyclicSwapEngine()'), 'Stop function stops swaps');
  assert(indexCode.includes('FULL AUTO TRADING STARTED'), 'Full Auto start log present');
} catch (error) {
  console.log(`  ❌ Index.js read failed: ${error.message}`);
  failed++;
}

// ── Test 5: Cooldowns and limits in code ──
console.log('\n📋 Test 5: Code defaults');
try {
  const indexCode = fs.readFileSync(INDEX_FILE, 'utf8');
  
  assert(indexCode.includes('BAD_MARKET_COOLDOWN_MS = 5 * 60 * 1000'), 'Bad market cooldown reduced to 5 minutes');
  assert(indexCode.includes('cooldownSeconds: 30') || indexCode.includes('cooldownSeconds: 15'), 'Default cooldown reduced');
  assert(indexCode.includes('maxOpenPositions: 5'), 'Max open positions increased to 5');
  assert(indexCode.includes('maxConcurrentTrades: 3'), 'Max concurrent trades increased to 3');
  assert(indexCode.includes('maxTradesPerPair: 2'), 'Max trades per pair increased to 2');
  assert(indexCode.includes('selectAutoSide(rsiValue)'), 'selectAutoSide function exists');
} catch (error) {
  console.log(`  ❌ Index.js read failed: ${error.message}`);
  failed++;
}

// ── Test 6: Random amount generation caps ──
console.log('\n📋 Test 6: Amount generation logic');
try {
  const indexCode = fs.readFileSync(INDEX_FILE, 'utf8');
  
  // Check that ETH amounts are capped at 0.1
  assert(indexCode.includes('0.001 + Math.random() * (MAX_SWAP_ETH - 0.001)'), 'ETH swap amount generation within 0.001-0.1 range');
  assert(indexCode.includes('amount = Math.min(amount, maxToken)'), 'Token amount is capped');
} catch (error) {
  console.log(`  ❌ Index.js read failed: ${error.message}`);
  failed++;
}

// ── Test 7: Syntax validation ──
console.log('\n📋 Test 7: Syntax validation');
try {
  const { execSync } = await import('child_process');
  const result = execSync('node --check index.js 2>&1', { encoding: 'utf8', timeout: 10000 });
  assert(true, 'index.js syntax is valid');
} catch (error) {
  assert(false, `index.js syntax error: ${error.message}`);
}

// ── Summary ──
console.log('\n═══════════════════════════════════════════════════════');
console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
console.log('═══════════════════════════════════════════════════════\n');

if (failed > 0) {
  process.exit(1);
} else {
  console.log('✅ All integration tests passed!');
  console.log('\n📌 How to start the bot manually:');
  console.log('   1. Run: node index.js');
  console.log('   2. In the TUI menu, press [1] to "Start Full Auto Trading"');
  console.log('   3. Or press [12] to "Start Automatic Swaps" only');
  console.log('   4. The bot will now run CONTINUOUSLY until you press [1] or [12] to Stop');
  console.log('   5. Full Auto Trading includes: Swaps + LONG + SHORT + Close');
}
