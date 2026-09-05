/**
 * Market Intelligence Layer
 *
 * This file converts raw analytics from engine.js into:
 * 1. Attention priority scores
 * 2. Human-readable explanations
 * 3. Market pattern detection
 *
 * IMPORTANT:
 * This layer does not predict stock prices or give investment advice.
 * It only prioritizes and explains statistically detected market movements.
 */

/**
 * Calculate an attention score from 0 to 100.
 *
 * Higher score = deserves more user attention.
 *
 * Factors:
 * - Statistical unusualness (absolute z-score)
 * - Relative movement against benchmark
 * - Volume confirmation
 * - New signal since last visit
 * - Stale data penalty
 */
function calculateAttentionScore(change) {
  let score = 0;

  // 1. Statistical unusualness: maximum 40 points.
  // A |z-score| of 3 or above receives the maximum contribution.
  if (change.zScore !== null && Number.isFinite(change.zScore)) {
    score += Math.min(Math.abs(change.zScore) / 3, 1) * 40;
  }

  // 2. Benchmark-relative divergence: maximum 30 points.
  // A relative move of 5% or above receives the maximum contribution.
  if (
    change.relativeMove !== null &&
    Number.isFinite(change.relativeMove)
  ) {
    score += Math.min(Math.abs(change.relativeMove) / 0.05, 1) * 30;
  }

  // 3. Volume confirmation: maximum 15 points.
  // Normal volume (~1x) adds little; 3x or above receives full points.
  if (
    change.volumeRatio !== null &&
    Number.isFinite(change.volumeRatio) &&
    change.volumeRatio > 1
  ) {
    score += Math.min((change.volumeRatio - 1) / 2, 1) * 15;
  }

  // 4. New signal bonus.
  if (change.isNewSinceLastVisit) {
    score += 10;
  }

  // 5. Tier-based bonus.
  if (change.tier === 'significant') {
    score += 10;
  } else if (change.tier === 'notable') {
    score += 5;
  }

  // Stale data should reduce attention because freshness is lower.
  if (change.isStale) {
    score *= 0.75;
  }

  return Math.round(Math.min(Math.max(score, 0), 100));
}

/**
 * Convert a numeric attention score into a human-readable level.
 */
function getAttentionLevel(score) {
  if (score >= 70) return 'high';
  if (score >= 40) return 'medium';
  return 'low';
}

/**
 * Generate an explainable reason for why a stock deserves attention.
 *
 * This uses deterministic rules based on the analytics engine output.
 * No LLM is required, making the explanation transparent and reproducible.
 */
function generateExplanation(change) {
  const reasons = [];

  if (
    change.zScore !== null &&
    Number.isFinite(change.zScore)
  ) {
    const direction = change.zScore > 0 ? 'upward' : 'downward';

    if (Math.abs(change.zScore) >= 2.5) {
      reasons.push(
        `The ${direction} movement is statistically significant compared with its historical behaviour.`
      );
    } else if (Math.abs(change.zScore) >= 1.5) {
      reasons.push(
        `The ${direction} movement is unusual compared with its recent historical behaviour.`
      );
    }
  }

  if (
    change.relativeMove !== null &&
    Number.isFinite(change.relativeMove)
  ) {
    const percentage = Math.abs(change.relativeMove * 100).toFixed(2);

    if (change.relativeMove > 0.01) {
      reasons.push(
        `It is outperforming its benchmark by ${percentage}%.`
      );
    } else if (change.relativeMove < -0.01) {
      reasons.push(
        `It is underperforming its benchmark by ${percentage}%.`
      );
    }
  }

  if (
    change.volumeRatio !== null &&
    Number.isFinite(change.volumeRatio) &&
    change.volumeRatio >= 1.5
  ) {
    reasons.push(
      `Trading volume is ${change.volumeRatio.toFixed(1)}x above its recent average.`
    );
  }

  if (change.isNewSinceLastVisit) {
    reasons.push('This is a new signal since your last visit.');
  }

  if (change.isStale) {
    reasons.push('The latest available market data is currently stale.');
  }

  if (change.tier === 'insufficient-history') {
    return change.note ||
      'There is not enough historical data for reliable statistical scoring.';
  }

  if (reasons.length === 0) {
    return 'No unusually strong market signal was detected relative to recent historical behaviour.';
  }

  return reasons.join(' ');
}

function detectPatterns(changes) {
  const activeSignals = changes.filter(
    (change) =>
      change.tier === 'significant' ||
      change.tier === 'notable'
  );

  const patterns = [];

  if (activeSignals.length >= 3) {
    patterns.push({
      type: 'multiple-signals',
      severity: activeSignals.length >= 5 ? 'high' : 'medium',
      message: `${activeSignals.length} stocks are showing notable or significant movements.`,
      tickers: activeSignals.map((change) => change.ticker),
    });
  }

  const positiveSignals = activeSignals.filter(
    (change) => change.relativeMove !== null && change.relativeMove > 0
  );

  const negativeSignals = activeSignals.filter(
    (change) => change.relativeMove !== null && change.relativeMove < 0
  );

  if (positiveSignals.length >= 3) {
    patterns.push({
      type: 'broad-outperformance',
      severity: 'medium',
      message: `${positiveSignals.length} stocks are outperforming their benchmarks with unusual movement.`,
      tickers: positiveSignals.map((change) => change.ticker),
    });
  }

  if (negativeSignals.length >= 3) {
    patterns.push({
      type: 'broad-underperformance',
      severity: 'medium',
      message: `${negativeSignals.length} stocks are underperforming their benchmarks with unusual movement.`,
      tickers: negativeSignals.map((change) => change.ticker),
    });
  }

  const sectors = new Map();
  for (const change of changes) {
    if (!change.sector) continue;
    if (!sectors.has(change.sector)) sectors.set(change.sector, []);
    sectors.get(change.sector).push(change);
  }

  for (const [sector, sectorChanges] of sectors) {
    if (sectorChanges.length < 2) continue;

    const meaningfulSignals = sectorChanges.filter(
      (change) =>
        change.relativeMove !== null &&
        Number.isFinite(change.relativeMove) &&
        Math.abs(change.relativeMove) >= 0.01
    );
    const positiveSectorSignals = meaningfulSignals.filter(
      (change) => change.relativeMove >= 0.01
    );
    const negativeSectorSignals = meaningfulSignals.filter(
      (change) => change.relativeMove <= -0.01
    );

    if (positiveSectorSignals.length >= 2) {
      patterns.push({
        type: 'sector-outperformance',
        sector,
        severity: 'medium',
        message: `${positiveSectorSignals.length} ${sector} stocks are outperforming their benchmarks together.`,
        tickers: positiveSectorSignals.map((change) => change.ticker),
      });
    }

    if (negativeSectorSignals.length >= 2) {
      patterns.push({
        type: 'sector-underperformance',
        sector,
        severity: 'medium',
        message: `${negativeSectorSignals.length} ${sector} stocks are underperforming their benchmarks together.`,
        tickers: negativeSectorSignals.map((change) => change.ticker),
      });
    }

    if (positiveSectorSignals.length >= 1 && negativeSectorSignals.length >= 1) {
      patterns.push({
        type: 'sector-divergence',
        sector,
        severity: 'medium',
        message: `${sector} stocks are showing divergent performance relative to their benchmark.`,
        tickers: meaningfulSignals.map((change) => change.ticker),
      });
    }
  }

  return patterns;
}

module.exports = {
  calculateAttentionScore,
  getAttentionLevel,
  generateExplanation,
  detectPatterns,
};
