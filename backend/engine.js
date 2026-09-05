/**
 * Core "what's meaningful" engine.
 *
 * Everything here is plain math, no ML library needed. The logic:
 *
 *   1. Compute the stock's move today, and its benchmark's move today.
 *   2. relativeMove = stock's move minus benchmark's move.
 *      This strips out "the whole market/sector did this" noise.
 *   3. Compare today's relativeMove against the stock's own history of
 *      relativeMove values (rolling std dev), producing a z-score.
 *      A z-score is "how many standard deviations from this stock's normal
 *      behavior is this move", which is what makes the threshold adapt
 *      per stock instead of using one flat percentage for everything.
 *   4. Tier the result: notable / significant / none, plus a staleness flag.
 */

const NOTABLE_Z = 1.5;
const SIGNIFICANT_Z = 2.5;
const MIN_HISTORY_DAYS = 20;          // below this, we don't trust the z-score
const STALE_AFTER_MINUTES = 15;       // matches expected poll interval

/**
 * @param {number[]} prices - chronological close prices, oldest first
 * @returns {number[]} daily returns as decimals, e.g. 0.012 for +1.2%
 */
function dailyReturns(prices) {
  const returns = [];
  for (let i = 1; i < prices.length; i++) {
    returns.push((prices[i] - prices[i - 1]) / prices[i - 1]);
  }
  return returns;
}

function mean(values) {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function stdDev(values) {
  const m = mean(values);
  const variance = mean(values.map((v) => (v - m) ** 2));
  return Math.sqrt(variance);
}

function hasPriceDiscontinuity(prices) {
  return prices.some((price, index) => {
    if (index === 0) return false;
    const previous = prices[index - 1];
    const ratio = price / previous;
    return !Number.isFinite(ratio) || ratio <= 0 || ratio > 3 || ratio < 1 / 3;
  });
}

/**
 * Computes the meaningful-change result for one ticker.
 *
 * @param {object} input
 * @param {number[]} input.tickerPrices - ticker close prices, oldest → newest, today last
 * @param {number[]} input.benchmarkPrices - matching benchmark close prices, same length/order
 * @param {number} input.latestVolume - today's volume
 * @param {number} input.avgVolume - trailing average volume for this ticker
 * @param {Date}   input.latestSourceTimestamp - when the data provider says this price is from
 * @param {Date}   [input.now] - injectable for testing, defaults to current time
 */
function evaluateTicker({
  tickerPrices,
  benchmarkPrices,
  latestVolume,
  avgVolume,
  latestSourceTimestamp,
  marketStatus = 'UNKNOWN',
  dataStatus = 'UNKNOWN',
  now = new Date(),
}) {
  const ageMinutes = (now - latestSourceTimestamp) / 60000;
  const isValidEndOfDay = marketStatus === 'CLOSED' && dataStatus === 'END_OF_DAY';
  const isStale = isValidEndOfDay ? false : ageMinutes > STALE_AFTER_MINUTES;

  const hasUsableHistory =
    tickerPrices.length >= MIN_HISTORY_DAYS + 1 &&
    benchmarkPrices.length === tickerPrices.length &&
    !hasPriceDiscontinuity(tickerPrices) &&
    !hasPriceDiscontinuity(benchmarkPrices);

  if (!hasUsableHistory) {
    // Not enough history for a trustworthy z-score (e.g. recently listed stock).
    // Fall back to raw move only, and say so explicitly rather than
    // silently producing a misleading z-score.
    const rawMove =
      (tickerPrices.at(-1) - tickerPrices.at(-2)) / tickerPrices.at(-2);
    return {
      rawMove,
      relativeMove: null,
      zScore: null,
      tier: 'insufficient-history',
      isStale,
      note: `Only ${tickerPrices.length} days of history, need ${MIN_HISTORY_DAYS}+ for relative scoring`,
    };
  }

  const tickerReturns = dailyReturns(tickerPrices);
  const benchmarkReturns = dailyReturns(benchmarkPrices);

  // Relative move series: ticker return minus benchmark return, each day.
  // Returns are unitless percentages: (new price - old price) / old price.
  // Never compare absolute price levels or mix histories from different scales.
  const relativeSeries = tickerReturns.map((r, i) => r - benchmarkReturns[i]);

  const todayRelative = relativeSeries.at(-1);
  const historyRelative = relativeSeries.slice(0, -1); // exclude today from baseline

  const baselineStdDev = stdDev(historyRelative);
  const zScore = baselineStdDev === 0 ? 0 : todayRelative / baselineStdDev;

  const rawMove = tickerReturns.at(-1);
  const benchmarkMove = benchmarkReturns.at(-1);
  const volumeRatio = avgVolume ? latestVolume / avgVolume : null;

  let tier = 'none';
  if (Math.abs(zScore) >= SIGNIFICANT_Z) tier = 'significant';
  else if (Math.abs(zScore) >= NOTABLE_Z) tier = 'notable';

  // Volume spike can bump a borderline move up a tier — cheap secondary signal.
  if (tier === 'none' && volumeRatio !== null && volumeRatio >= 2) {
    tier = 'notable';
  }

  return {
    rawMove,
    benchmarkMove,
    relativeMove: todayRelative,
    zScore,
    volumeRatio,
    tier,
    isStale,
  };
}

module.exports = { evaluateTicker, dailyReturns, mean, stdDev };
