// ═══════════════════════════════════════════════════════════════════════════════
//  ROTATION MEMORY — even coverage of MARKET × SIDE and SWAP pairs
//
//  Guarantees (given ≥2 candidates):
//    • the same MARKET×SIDE never repeats back-to-back more than `avoidRepeat` times
//    • the same SWAP pair never repeats more than `avoidRepeat` times
//    • least-used candidate is always preferred → no "NEMESIS 90× / others 0×" bias
//
//  State is serialisable so it survives restarts (persisted in auto-trader-state.json).
// ═══════════════════════════════════════════════════════════════════════════════

export class RotationMemory {
  constructor({ avoidRepeat = 2, historyLimit = 200, state = null } = {}) {
    this.avoidRepeat = avoidRepeat;
    this.historyLimit = historyLimit;
    this.recentMarkets = state?.recentMarkets || [];
    this.recentSides = state?.recentSides || [];
    this.recentSwapPairs = state?.recentSwapPairs || [];
    this.marketSideCounts = state?.marketSideCounts || {};
    this.swapPairCounts = state?.swapPairCounts || {};
    this.marketCounts = state?.marketCounts || {};
  }

  // ─── generic least-recent + least-used picker ───

  _pick(candidates, keyOf, recentList, counts) {
    if (!candidates || candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];

    const recentTail = recentList.slice(-Math.max(1, this.avoidRepeat));
    const recentSet = new Set(recentTail);
    const lastKey = recentList.length ? recentList[recentList.length - 1] : null;

    // 1) avoid the recent window
    let pool = candidates.filter(c => !recentSet.has(keyOf(c)));
    // 2) if the window covers every candidate (≥2), still never re-pick the immediate last
    if (pool.length === 0 && lastKey) pool = candidates.filter(c => keyOf(c) !== lastKey);
    // 3) only a single unique key remains — nothing else to pick
    if (pool.length === 0) pool = [...candidates];

    let min = Infinity;
    for (const c of pool) min = Math.min(min, counts[keyOf(c)] || 0);
    const leastUsed = pool.filter(c => (counts[keyOf(c)] || 0) === min);

    // Prefer least-recently-used among least-used for stable rotation
    if (leastUsed.length > 1 && recentList.length) {
      const recentIdx = new Map(recentList.map((k, i) => [k, i]));
      let best = Infinity;
      let bestItems = [];
      for (const c of leastUsed) {
        const idx = recentIdx.has(keyOf(c)) ? recentIdx.get(keyOf(c)) : -1;
        if (idx < best) { best = idx; bestItems = [c]; }
        else if (idx === best) bestItems.push(c);
      }
      return bestItems[Math.floor(Math.random() * bestItems.length)];
    }

    return leastUsed[Math.floor(Math.random() * leastUsed.length)];
  }

  // ─── MARKET × SIDE ───

  /**
   * @param {Array<{symbol:string, side:string}>} combos
   * @returns {{symbol, side, key}|null}
   */
  pickMarketSide(combos) {
    const items = (combos || []).map(c => ({ ...c, key: `${c.symbol}|${c.side}` }));
    const picked = this._pick(items, x => x.key, this.recentMarkets, this.marketSideCounts);
    return picked ? { symbol: picked.symbol, side: picked.side, key: picked.key } : null;
  }

  recordMarketSide(symbol, side) {
    const key = `${symbol}|${side}`;
    this.recentMarkets.push(key);
    this.recentSides.push(side);
    if (this.recentMarkets.length > this.historyLimit) this.recentMarkets = this.recentMarkets.slice(-this.historyLimit);
    if (this.recentSides.length > this.historyLimit) this.recentSides = this.recentSides.slice(-this.historyLimit);
    this.marketSideCounts[key] = (this.marketSideCounts[key] || 0) + 1;
    const mKey = String(symbol);
    this.marketCounts[mKey] = (this.marketCounts[mKey] || 0) + 1;
  }

  /**
   * Pick a side for a specific market, avoiding immediate repetition when possible.
   */
  pickSideForMarket(symbol, allowedSides) {
    const combos = (allowedSides || ["LONG", "SHORT"]).map(side => ({ symbol, side }));
    return this.pickMarketSide(combos);
  }

  /**
   * Ordered rotation over all MARKET×SIDE combos — used for fallback selection.
   * Least-recently-used first so a failed market never starves the others.
   */
  orderMarketSides(combos) {
    const items = (combos || []).map(c => ({ ...c, key: `${c.symbol}|${c.side}` }));
    const recentIdx = new Map(this.recentMarkets.map((k, i) => [k, i]));
    return [...items].sort((a, b) => {
      const ra = recentIdx.has(a.key) ? recentIdx.get(a.key) : -1;
      const rb = recentIdx.has(b.key) ? recentIdx.get(b.key) : -1;
      if (ra !== rb) return ra - rb;                      // least recent first
      const ca = this.marketSideCounts[a.key] || 0;
      const cb = this.marketSideCounts[b.key] || 0;
      if (ca !== cb) return ca - cb;                       // then least used
      return a.key.localeCompare(b.key);
    });
  }

  // ─── SWAP PAIRS ───

  pickSwapPair(candidates) {
    const items = (candidates || []).map(c => ({ ...c, key: c.key || `${c.from}>${c.to}` }));
    const picked = this._pick(items, x => x.key, this.recentSwapPairs, this.swapPairCounts);
    return picked || null;
  }

  recordSwapPair(from, to, key = null) {
    const k = key || `${from}>${to}`;
    this.recentSwapPairs.push(k);
    if (this.recentSwapPairs.length > this.historyLimit) this.recentSwapPairs = this.recentSwapPairs.slice(-this.historyLimit);
    this.swapPairCounts[k] = (this.swapPairCounts[k] || 0) + 1;
  }

  // ─── stats / persistence ───

  coverage() {
    return {
      markets: { ...this.marketCounts },
      marketSides: { ...this.marketSideCounts },
      swapPairs: { ...this.swapPairCounts },
      recentMarkets: [...this.recentMarkets],
      recentSides: [...this.recentSides],
      recentSwapPairs: [...this.recentSwapPairs],
    };
  }

  toJSON() {
    return {
      recentMarkets: this.recentMarkets,
      recentSides: this.recentSides,
      recentSwapPairs: this.recentSwapPairs,
      marketSideCounts: this.marketSideCounts,
      swapPairCounts: this.swapPairCounts,
      marketCounts: this.marketCounts,
    };
  }

  static fromJSON(state, opts = {}) {
    return new RotationMemory({ ...opts, state });
  }
}

export default RotationMemory;
