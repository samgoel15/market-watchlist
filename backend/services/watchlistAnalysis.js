const { evaluateTicker } = require('../engine');
const { fetchCandleData } = require('../ingest');
const { providerSymbolFor, resolveSymbol } = require('../symbols');
const {
  calculateAttentionScore,
  getAttentionLevel,
  generateExplanation,
  detectPatterns,
} = require('../intelligence');
const db = require('../db');

const HISTORY_DAYS = 21;

async function buildWatchlistAnalysis(watchlistId, userId) {
  const { rows: watchlistRows } = await db.query(
    `SELECT id FROM watchlists WHERE id = $1`,
    [watchlistId]
  );
  if (watchlistRows.length === 0) {
    const error = new Error('watchlist not found');
    error.statusCode = 404;
    throw error;
  }

  const { rows: items } = await db.query(
    `SELECT t.id, t.symbol, t.name, t.sector, t.benchmark_id, t.listed_at,
        b.symbol AS benchmark_symbol
     FROM watchlist_items wi
     JOIN tickers t ON t.id = wi.ticker_id
     LEFT JOIN benchmarks b ON b.id = t.benchmark_id
     WHERE wi.watchlist_id = $1`,
    [watchlistId]
  );

  const { rows: memberRows } = await db.query(
    `SELECT last_seen_at FROM watchlist_members
     WHERE watchlist_id = $1 AND user_id = $2`,
    [watchlistId, userId]
  );
  const lastSeenAt = memberRows[0]?.last_seen_at ?? null;

  const changes = await Promise.all(items.map((ticker) => analyzeTicker(ticker, lastSeenAt)));
  const tierRank = { significant: 0, notable: 1, 'insufficient-history': 2, none: 3 };
  changes.sort((a, b) => {
    const rankDiff = (tierRank[a.tier] ?? 4) - (tierRank[b.tier] ?? 4);
    if (rankDiff !== 0) return rankDiff;
    return Math.abs(b.zScore ?? 0) - Math.abs(a.zScore ?? 0);
  });

  await db.query(
    `INSERT INTO watchlist_members (watchlist_id, user_id, last_seen_at)
     VALUES ($1, $2, now())
     ON CONFLICT (watchlist_id, user_id)
     DO UPDATE SET last_seen_at = now()`,
    [watchlistId, userId]
  );

  return { lastSeenAt, patterns: detectPatterns(changes), changes };
}

async function analyzeTicker(ticker, lastSeenAt) {
  const tickerResolution = resolveSymbol(ticker.symbol);
  const benchmarkSymbol = ticker.benchmark_symbol || 'NIFTY50';
  const benchmarkResolution = resolveSymbol(benchmarkSymbol);

  if (!tickerResolution) {
    return {
      ticker: ticker.symbol,
      name: ticker.name,
      sector: ticker.sector,
      analysisStatus: 'NO_COMPARISON_BENCHMARK',
      marketStatus: 'UNKNOWN',
      dataStatus: 'UNKNOWN',
      dataSource: 'YAHOO_FINANCE',
      relativeMove: null,
      zScore: null,
      attentionScore: 0,
      attentionLevel: 'low',
      explanation: 'No distinct comparison benchmark is configured for this instrument.',
    };
  }

  if (!benchmarkResolution || tickerResolution.providerSymbol === benchmarkResolution.providerSymbol) {
    const tickerHistory = await getProviderAnalysisHistory(tickerResolution.providerSymbol);
    const latest = tickerHistory.candles.at(-1);
    const previous = tickerHistory.candles.at(-2);
    const rawMove = latest && previous && previous.close !== 0
      ? (latest.close - previous.close) / previous.close
      : null;
    return {
      ticker: ticker.symbol,
      name: ticker.name,
      sector: ticker.sector,
      analysisStatus: tickerHistory.status === 'OK' ? 'NO_COMPARISON_BENCHMARK' : 'NO_DATA',
      marketStatus: tickerHistory.marketStatus,
      dataStatus: tickerHistory.dataStatus,
      dataSource: 'YAHOO_FINANCE',
      latestDataTimestamp: tickerHistory.latestDataTimestamp,
      rawMove,
      relativeMove: null,
      benchmarkMove: null,
      zScore: null,
      tier: 'insufficient-history',
      attentionScore: 0,
      attentionLevel: 'low',
      explanation: tickerHistory.status === 'OK'
        ? 'This instrument has its own market data, but no distinct comparison benchmark is available.'
        : 'Market data is temporarily unavailable for this instrument.',
    };
  }

  const [tickerHistory, benchmarkHistory] = await Promise.all([
    getProviderAnalysisHistory(tickerResolution.providerSymbol),
    getProviderAnalysisHistory(benchmarkResolution.providerSymbol),
  ]);

  if (tickerHistory.status !== 'OK' || benchmarkHistory.status !== 'OK') {
    return {
      ticker: ticker.symbol,
      name: ticker.name,
      sector: ticker.sector,
      analysisStatus: tickerHistory.status === 'PROVIDER_ERROR' || benchmarkHistory.status === 'PROVIDER_ERROR'
        ? 'PROVIDER_ERROR'
        : 'NO_DATA',
      marketStatus: tickerHistory.marketStatus,
      dataStatus: tickerHistory.dataStatus,
      dataSource: 'YAHOO_FINANCE',
      latestDataTimestamp: tickerHistory.latestDataTimestamp,
      relativeMove: null,
      zScore: null,
      attentionScore: 0,
      attentionLevel: 'low',
      error: 'market data unavailable for analysis',
    };
  }

  const aligned = alignProviderHistories(tickerHistory.candles, benchmarkHistory.candles);
  if (aligned.tickerPrices.length === 0 || aligned.benchmarkPrices.length === 0) {
    return {
      ticker: ticker.symbol,
      name: ticker.name,
      sector: ticker.sector,
      analysisStatus: 'NO_DATA',
      marketStatus: tickerHistory.marketStatus,
      dataStatus: tickerHistory.dataStatus,
      dataSource: 'YAHOO_FINANCE',
      latestDataTimestamp: tickerHistory.latestDataTimestamp,
      relativeMove: null,
      zScore: null,
      attentionScore: 0,
      attentionLevel: 'low',
      error: 'no aligned market data available for analysis',
    };
  }

  const latest = aligned.tickerCandles.at(-1);
  const evaluation = evaluateTicker({
    tickerPrices: aligned.tickerPrices,
    benchmarkPrices: aligned.benchmarkPrices,
    latestVolume: getLatestVolume(aligned.tickerCandles),
    avgVolume: getAverageVolume(aligned.tickerCandles),
    latestSourceTimestamp: tickerHistory.latestDataTimestamp,
    marketStatus: tickerHistory.marketStatus,
    dataStatus: tickerHistory.dataStatus,
  });
  const change = {
    ticker: ticker.symbol,
    name: ticker.name,
    sector: ticker.sector,
    isNewSinceLastVisit: lastSeenAt ? latest.timestamp > new Date(lastSeenAt) : true,
    ...evaluation,
  };
  const attentionScore = calculateAttentionScore(change);

  return {
    ...change,
    analysisStatus: evaluation.tier === 'insufficient-history' ? 'INSUFFICIENT_HISTORY' : 'OK',
    marketStatus: tickerHistory.marketStatus,
    dataStatus: tickerHistory.dataStatus,
    dataSource: 'YAHOO_FINANCE',
    latestDataTimestamp: tickerHistory.latestDataTimestamp,
    attentionScore,
    attentionLevel: getAttentionLevel(attentionScore),
    explanation: generateExplanation(change),
  };
}

async function getProviderAnalysisHistory(providerSymbol) {
  try {
    const candleData = await fetchCandleData(providerSymbol, '1d');
    return {
      candles: candleData.candles,
      status: candleData.candles.length ? 'OK' : 'NO_DATA',
      marketStatus: candleData.marketStatus,
      dataStatus: candleData.marketStatus === 'CLOSED'
        ? 'END_OF_DAY'
        : candleData.marketStatus === 'DELAYED'
          ? 'DELAYED'
          : 'LIVE',
      latestDataTimestamp: candleData.regularMarketTime ?? candleData.candles.at(-1)?.timestamp ?? null,
    };
  } catch (error) {
    return {
      candles: [],
      status: 'PROVIDER_ERROR',
      marketStatus: 'UNKNOWN',
      dataStatus: 'UNKNOWN',
      latestDataTimestamp: null,
    };
  }
}

function normalizeTradingDate(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function alignProviderHistories(tickerCandles, benchmarkCandles) {
  const benchmarkByDate = new Map(
    benchmarkCandles.map((candle) => [normalizeTradingDate(candle.timestamp), candle])
  );
  const tickerCandlesByDate = tickerCandles.filter((candle) =>
    benchmarkByDate.has(normalizeTradingDate(candle.timestamp))
  );
  const matchingBenchmarkCandles = tickerCandlesByDate.map((candle) =>
    benchmarkByDate.get(normalizeTradingDate(candle.timestamp))
  );

  return {
    tickerCandles: tickerCandlesByDate,
    benchmarkCandles: matchingBenchmarkCandles,
    tickerPrices: tickerCandlesByDate.map((candle) => candle.close),
    benchmarkPrices: matchingBenchmarkCandles.map((candle) => candle.close),
  };
}

function getLatestVolume(candles) {
  const volume = candles.at(-1)?.volume;
  return volume == null || Number(volume) <= 0 ? null : Number(volume);
}

function getAverageVolume(candles) {
  const volumes = candles
    .slice(0, -1)
    .map((candle) => Number(candle.volume))
    .filter((volume) => Number.isFinite(volume) && volume > 0);
  return volumes.length
    ? volumes.reduce((sum, volume) => sum + volume, 0) / volumes.length
    : null;
}

module.exports = { buildWatchlistAnalysis };
