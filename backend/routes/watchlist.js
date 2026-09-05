const express = require('express');
const router = express.Router();
const { fetchCandleData, fetchQuote, ingestTickerAndBenchmark } = require('../ingest');
const { providerSymbolFor, resolveSymbol } = require('../symbols');
const { buildWatchlistAnalysis } = require('../services/watchlistAnalysis');
const { buildMarketReplay } = require('../services/marketReplay');
const { answerMarketQuestion } = require('../services/marketAiChat');
// Assumes a pg Pool instance exported from a db module — swap for your setup.
const db = require('../db');

const DEFAULT_PRICE_HISTORY_LIMIT = 90;
const MAX_PRICE_HISTORY_LIMIT = 365;
const DEFAULT_CANDLE_LIMIT = 90;
const MAX_CANDLE_LIMIT = 365;

router.get('/tickers/:symbol/replay', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const requestedDate = req.query.date;
  if (requestedDate !== undefined && (typeof requestedDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(requestedDate))) {
    return res.status(400).json({ error: 'date must use YYYY-MM-DD format' });
  }

  try {
    const replay = await buildMarketReplay({ symbol, sessionDate: requestedDate, db });
    res.set('Cache-Control', 'no-store');
    return res.json(replay);
  } catch (error) {
    console.error(error);
    const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 500;
    return res.status(statusCode).json({ error: error.message || 'failed to build market replay' });
  }
});

/**
 * GET /tickers/:symbol/ohlc
 * Returns complete daily OHLC candles directly from the market-data provider.
 */
router.get(['/tickers/:symbol/ohlc', '/tickers/:symbol/candles'], async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const interval = req.query.interval ?? '1d';
  const requestedLimit = req.query.limit;

  if (interval !== '1d') {
    return res.status(400).json({ error: 'interval must be 1d' });
  }
  if (requestedLimit !== undefined && (typeof requestedLimit !== 'string' || !/^[1-9]\d*$/.test(requestedLimit))) {
    return res.status(400).json({ error: 'limit must be a positive integer' });
  }

  const limit = requestedLimit === undefined ? DEFAULT_CANDLE_LIMIT : Number(requestedLimit);
  if (limit > MAX_CANDLE_LIMIT) {
    return res.status(400).json({ error: `limit must not exceed ${MAX_CANDLE_LIMIT}` });
  }

  try {
    const { rows: tickerRows } = await db.query(
      `SELECT id, symbol, name, benchmark_id FROM tickers WHERE symbol = $1`,
      [symbol]
    );
    if (tickerRows.length === 0) {
      return res.status(404).json({ error: 'ticker not found' });
    }

    const ticker = tickerRows[0];
    const candleData = await fetchCandleData(providerSymbolFor(ticker.symbol), interval);
    const candles = candleData.candles.slice(-limit);
    const dataStatus = candleData.marketStatus === 'CLOSED'
      ? 'END_OF_DAY'
      : candleData.marketStatus === 'DELAYED'
        ? 'DELAYED'
        : 'LIVE';

    res.set('Cache-Control', 'no-store');
    res.json({
      ticker: { symbol: ticker.symbol, name: ticker.name },
      interval,
      candles: candles.map((candle) => ({
        timestamp: candle.timestamp,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
      })),
      lastUpdated: candleData.regularMarketTime ?? candles.at(-1)?.timestamp ?? null,
      fetchedAt: candleData.fetchedAt,
      marketStatus: candleData.marketStatus,
      dataStatus,
      source: 'Yahoo Finance',
      cacheStatus: 'NONE',
    });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'failed to fetch ticker candles' });
  }
});

/**
 * GET /tickers/:symbol/prices
 * Returns the most recent ticker snapshots in chronological order.
 */
router.get('/tickers/:symbol/prices', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const requestedLimit = req.query.limit;

  if (requestedLimit !== undefined) {
    if (typeof requestedLimit !== 'string' || !/^[1-9]\d*$/.test(requestedLimit)) {
      return res.status(400).json({ error: 'limit must be a positive integer' });
    }
  }

  const limit = requestedLimit === undefined
    ? DEFAULT_PRICE_HISTORY_LIMIT
    : Number(requestedLimit);

  if (limit > MAX_PRICE_HISTORY_LIMIT) {
    return res.status(400).json({ error: `limit must not exceed ${MAX_PRICE_HISTORY_LIMIT}` });
  }

  try {
    const { rows: tickerRows } = await db.query(
      `SELECT id, symbol, name, benchmark_id FROM tickers WHERE symbol = $1`,
      [symbol]
    );

    if (tickerRows.length === 0) {
      return res.status(404).json({ error: 'ticker not found' });
    }

    const ticker = tickerRows[0];
    const { rows } = await db.query(
      `SELECT captured_at AS "capturedAt",
              source_ts AS "sourceTs",
              price,
              volume,
              is_stale AS "isStale"
       FROM price_snapshots
       WHERE ticker_id = $1
       ORDER BY captured_at DESC
       LIMIT $2`,
      [ticker.id, limit]
    );

    res.set('Cache-Control', 'no-store');
    res.json({
      ticker: { symbol: ticker.symbol, name: ticker.name },
      prices: rows.reverse().map((row) => ({
        capturedAt: row.capturedAt,
        sourceTs: row.sourceTs,
        price: Number(row.price),
        volume: row.volume === null ? null : Number(row.volume),
        isStale: row.isStale,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to fetch ticker price history' });
  }
});

/**
 * GET /watchlist/:id/changes
 *
 * Returns a ranked list of what's changed for this watchlist, tiered by
 * relative-move significance, with staleness flags per ticker.
 * Also updates the caller's last_seen_at so the *next* call only needs to
 * highlight what's new since this one — the diff-since-last-visit piece.
 */
router.get('/watchlist/:id/changes', async (req, res) => {
  const watchlistId = req.params.id;
  const userId = req.user.id; // assumes auth middleware set this

  try {
    const analysis = await buildWatchlistAnalysis(watchlistId, userId);
    res.set('Cache-Control', 'no-store');
    return res.json(analysis);

     /* Legacy inline analysis path retained below only as a reference during
       migration. The shared service above is the sole executed path.
    const { rows: watchlistRows } = await db.query(
      `SELECT id FROM watchlists WHERE id = $1`,
      [watchlistId]
    );
    if (watchlistRows.length === 0) {
      return res.status(404).json({ error: 'watchlist not found' });
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

    const results = await Promise.all(
      items.map(async (ticker) => {
        const tickerResolution = resolveSymbol(ticker.symbol);
        const benchmarkSymbol = ticker.benchmark_symbol || 'NIFTY50';
        const benchmarkResolution = resolveSymbol(benchmarkSymbol);

        if (
          !tickerResolution ||
          !benchmarkResolution ||
          tickerResolution.providerSymbol === benchmarkResolution.providerSymbol
        ) {
          return {
            ticker: ticker.symbol,
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

        const [tickerHistory, benchmarkHistory] = await Promise.all([
          getProviderAnalysisHistory(tickerResolution.providerSymbol),
          getProviderAnalysisHistory(benchmarkResolution.providerSymbol),
        ]);

        if (tickerHistory.status !== 'OK' || benchmarkHistory.status !== 'OK') {
          return {
            ticker: ticker.symbol,
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
        const tickerPrices = aligned.tickerPrices;
        const benchmarkPrices = aligned.benchmarkPrices;

        if (tickerPrices.length === 0) {
          return {
            ticker: ticker.symbol,
            analysisStatus: 'NO_DATA',
            marketStatus: tickerHistory.marketStatus,
            error: tickerHistory.status === 'PROVIDER_ERROR'
              ? 'market data provider unavailable'
              : 'no price data available',
          };
        }

        if (benchmarkPrices.length === 0) {
          return {
            ticker: ticker.symbol,
            analysisStatus: 'NO_DATA',
            marketStatus: benchmarkHistory.marketStatus,
            error: benchmarkHistory.status === 'PROVIDER_ERROR'
              ? 'benchmark data provider unavailable'
              : 'no benchmark data available',
          };
        }

        const latest = aligned.tickerCandles.at(-1);
        const latestCapturedAt = latest.timestamp;
        const latestSourceTimestamp = tickerHistory.latestDataTimestamp;

        const evaluation = evaluateTicker({
          tickerPrices,
          benchmarkPrices,
          latestVolume: getLatestVolume(aligned.tickerCandles),
          avgVolume: getAverageVolume(aligned.tickerCandles),
          latestSourceTimestamp,
          marketStatus: tickerHistory.marketStatus,
          dataStatus: tickerHistory.dataStatus,

        });

        const change = {
          ticker: ticker.symbol,
          name: ticker.name,
          sector: ticker.sector,
          isNewSinceLastVisit: lastSeenAt ? latestCapturedAt > new Date(lastSeenAt) : true,
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
      })
    );

    // Rank: significant tier first, then notable, then by |zScore| descending.
    const tierRank = { significant: 0, notable: 1, 'insufficient-history': 2, none: 3 };
    results.sort((a, b) => {
      const rankDiff = (tierRank[a.tier] ?? 4) - (tierRank[b.tier] ?? 4);
      if (rankDiff !== 0) return rankDiff;
      return Math.abs(b.zScore ?? 0) - Math.abs(a.zScore ?? 0);
    });

    // Update last_seen_at for next time — upsert.
    await db.query(
      `INSERT INTO watchlist_members (watchlist_id, user_id, last_seen_at)
       VALUES ($1, $2, now())
       ON CONFLICT (watchlist_id, user_id)
       DO UPDATE SET last_seen_at = now()`,
      [watchlistId, userId]
    );

    const patterns = detectPatterns(results);

    res.json({
      lastSeenAt,
      patterns,
      changes: results,
    });
    */
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to compute changes' });
  }
});

router.post('/watchlist/:id/ask-ai', async (req, res) => {
  const question = typeof req.body?.question === 'string' ? req.body.question.trim() : '';
  if (!question) {
    return res.status(400).json({ error: 'question is required' });
  }
  if (question.length > 1000) {
    return res.status(400).json({ error: 'question must be 1000 characters or fewer' });
  }

  const history = normalizeChatHistory(req.body?.history);
  if (history === null) {
    return res.status(400).json({
      error: 'history must contain up to 10 user or assistant messages',
    });
  }

  const selectedText = typeof req.body?.selectedText === 'string'
    ? req.body.selectedText.trim()
    : '';
  const contextType = normalizeContextType({
    requestedType: req.body?.contextType,
    question,
    selectedText,
  });
  const candleData = req.body?.candleData && typeof req.body.candleData === 'object'
    ? req.body.candleData
    : null;

  try {
    const analysis = await buildWatchlistAnalysis(req.params.id, req.user.id);
    const context = buildQuestionContext({
      analysis,
      question,
      contextType,
      selectedText,
      candleData,
    });
    const sources = findQuestionSources(question, analysis.changes);
    const answer = await answerMarketQuestion({ question, context, contextType, history });
    const timestamps = analysis.changes
      .map((change) => change.latestDataTimestamp)
      .filter(Boolean)
      .map((timestamp) => new Date(timestamp).getTime())
      .filter(Number.isFinite);

    res.set('Cache-Control', 'no-store');
    return res.json({
      answer,
      dataTimestamp: timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : null,
      sources,
      contextType,
    });
  } catch (error) {
    console.error(error);
    const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 500;
    return res.status(statusCode).json({ error: error.message || 'Market AI request failed' });
  }
});

function normalizeContextType({ requestedType, question, selectedText }) {
  if (requestedType === 'candle') return 'candle';
  if (requestedType === 'selected_text' && selectedText) return 'selected_text';
  if (requestedType === 'watchlist_summary' || isWatchlistSummaryQuestion(question)) {
    return 'watchlist_summary';
  }
  return 'general_question';
}

function isWatchlistSummaryQuestion(question) {
  return /\b(summarize|summary|what happened)\b.*\b(watchlist|market)\b/i.test(question) ||
    /\b(market summary|watchlist summary)\b/i.test(question);
}

function buildQuestionContext({ analysis, question, contextType, selectedText, candleData }) {
  const stocks = analysis.changes.map((change) => ({
        ticker: change.ticker,
        name: change.name,
        sector: change.sector,
        rawMove: change.rawMove,
        benchmarkMove: change.benchmarkMove,
        relativeMove: change.relativeMove,
        zScore: change.zScore,
        tier: change.tier,
        attentionScore: change.attentionScore,
        attentionLevel: change.attentionLevel,
        explanation: change.explanation,
        analysisStatus: change.analysisStatus,
        marketStatus: change.marketStatus,
        dataStatus: change.dataStatus,
        dataSource: change.dataSource,
        isStale: change.isStale,
      }));

  if (contextType === 'watchlist_summary') {
    return { marketPatterns: analysis.patterns, stocks };
  }

  if (contextType === 'general_question' && /^(hi|hello|hey|good morning|good afternoon|good evening)[!. ]*$/i.test(question)) {
    return {};
  }

  const relevantStocks = stocks.filter((stock) => {
    const searchable = `${stock.ticker} ${stock.name ?? ''}`.toLowerCase();
    return question.toLowerCase().includes(stock.ticker.toLowerCase()) ||
      (selectedText && selectedText.toLowerCase().includes(stock.ticker.toLowerCase())) ||
      (stock.name && question.toLowerCase().includes(stock.name.toLowerCase())) ||
      (stock.name && selectedText.toLowerCase().includes(stock.name.toLowerCase())) ||
      searchable.includes(question.toLowerCase());
  });
  const context = {};
  if (relevantStocks.length) context.stocks = relevantStocks;
  if (contextType === 'selected_text' && selectedText) context.selectedText = selectedText;
  if (contextType === 'candle' && candleData) context.candleData = candleData;
  if (relevantStocks.length && contextType !== 'selected_text') {
    context.marketPatterns = analysis.patterns.filter((pattern) =>
      pattern.tickers?.some((ticker) => relevantStocks.some((stock) => stock.ticker === ticker))
    );
  }
  return context;
}

/**
 * POST /watchlist
 * Creates a watchlist for the authenticated user.
 */
router.post('/watchlist', async (req, res) => {
  const userId = req.user.id;
  const name = typeof req.body.name === 'string' && req.body.name.trim()
    ? req.body.name.trim()
    : 'My Watchlist';

  try {
    const { rows } = await db.query(
      `INSERT INTO watchlists (owner_id, name)
       VALUES ($1, $2)
       RETURNING id, name, created_at AS "createdAt"`,
      [userId, name]
    );
    const watchlist = rows[0];

    await db.query(
      `INSERT INTO watchlist_members (watchlist_id, user_id, last_seen_at)
       VALUES ($1, $2, now())`,
      [watchlist.id, userId]
    );

    res.status(201).json(watchlist);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to create watchlist' });
  }
});

/**
 * GET /watchlist/:id/items
 * Lists tickers currently on the watchlist — separate from /changes since
 * the manage UI shouldn't have to run the full engine just to show the list.
 */
router.get('/watchlist/:id/items', async (req, res) => {
  const watchlistId = req.params.id;
  try {
    const { rows } = await db.query(
      `SELECT t.id AS "tickerId", t.symbol, t.name, wi.added_at AS "addedAt"
       FROM watchlist_items wi
       JOIN tickers t ON t.id = wi.ticker_id
       WHERE wi.watchlist_id = $1
       ORDER BY wi.added_at ASC`,
      [watchlistId]
    );
    res.json({ items: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to fetch items' });
  }
});

/**
 * POST /watchlist/:id/items
 * Body: { symbol: string }
 * Adds a ticker to the watchlist by symbol, not by internal id, since
 * that's what the frontend naturally has from user input.
 */
router.post('/watchlist/:id/items', async (req, res) => {
  const watchlistId = req.params.id;
  const { symbol } = req.body;

  if (!symbol || typeof symbol !== 'string') {
    return res.status(400).json({ error: 'symbol is required' });
  }

  const resolved = resolveSymbol(symbol);
  if (!resolved) {
    return res.status(400).json({
      error: 'symbol must be 1-15 letters or numbers, for example RELIANCE or NIFTY',
    });
  }

  try {
    const { rows: tickerRows } = await db.query(
      `SELECT id, symbol, name FROM tickers WHERE symbol = $1`,
      [resolved.symbol]
    );

    let ticker = tickerRows[0];
    if (!ticker) {
      let quote;
      try {
        quote = await fetchQuote(resolved.providerSymbol);
      } catch (error) {
        return res.status(404).json({
          error: `unknown symbol: ${resolved.symbol} is not available from Yahoo Finance`,
        });
      }

      const { rows: benchmarkRows } = await db.query(
        `SELECT id FROM benchmarks WHERE symbol = $1`,
        [resolved.benchmarkSymbol]
      );
      const benchmarkId = benchmarkRows[0]?.id ?? null;
      const { rows: insertedTickers } = await db.query(
        `INSERT INTO tickers (symbol, name, sector, benchmark_id, listed_at)
         VALUES ($1, $2, $3, $4, CURRENT_DATE)
         RETURNING id, symbol, name, benchmark_id`,
        [resolved.symbol, quote.name || resolved.suggestedName, resolved.isIndex ? 'Index' : null, benchmarkId]
      );
      ticker = insertedTickers[0];
    }

    const { rows: existing } = await db.query(
      `SELECT 1 FROM watchlist_items WHERE watchlist_id = $1 AND ticker_id = $2`,
      [watchlistId, ticker.id]
    );
    if (existing.length > 0) {
      return res.status(409).json({ error: 'already in watchlist' });
    }

    const { rows: inserted } = await db.query(
      `INSERT INTO watchlist_items (watchlist_id, ticker_id)
       VALUES ($1, $2)
       RETURNING added_at AS "addedAt"`,
      [watchlistId, ticker.id]
    );

    const initialData = await ingestTickerAndBenchmark({
      tickerId: ticker.id,
      symbol: ticker.symbol,
      benchmarkId: ticker.benchmark_id && providerSymbolFor(ticker.symbol) !== providerSymbolFor(resolved.benchmarkSymbol)
        ? ticker.benchmark_id
        : null,
      benchmarkSymbol: providerSymbolFor(ticker.symbol) !== providerSymbolFor(resolved.benchmarkSymbol)
        ? resolved.benchmarkSymbol
        : null,
    });
    const tickerData = initialData.find((result) => result.symbol === ticker.symbol);

    res.status(201).json({
      tickerId: ticker.id,
      symbol: ticker.symbol,
      name: ticker.name,
      addedAt: inserted[0].addedAt,
      initialDataStatus: tickerData?.status ?? 'unavailable',
      benchmarkDataStatus: initialData.find((result) => result.symbol === resolved.benchmarkSymbol)?.status ?? 'unavailable',
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to add ticker' });
  }
});

/**
 * DELETE /watchlist/:id/items/:symbol
 * Removes a ticker from the watchlist by symbol.
 */
router.delete('/watchlist/:id/items/:symbol', async (req, res) => {
  const watchlistId = req.params.id;
  const { symbol } = req.params;

  try {
    const { rows: tickerRows } = await db.query(
      `SELECT id FROM tickers WHERE symbol = $1`,
      [symbol.toUpperCase()]
    );
    if (tickerRows.length === 0) {
      return res.status(404).json({ error: 'not found in watchlist' });
    }

    const { rowCount } = await db.query(
      `DELETE FROM watchlist_items WHERE watchlist_id = $1 AND ticker_id = $2`,
      [watchlistId, tickerRows[0].id]
    );

    if (rowCount === 0) {
      return res.status(404).json({ error: 'not found in watchlist' });
    }

    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to remove ticker' });
  }
});

async function getProviderAnalysisHistory(providerSymbol) {
  try {
    const candleData = await fetchCandleData(providerSymbol, '1d');
    return {
      candles: candleData.candles,
      source: 'PROVIDER',
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
      source: 'PROVIDER',
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
  const alignedCandles = tickerCandles.filter((candle) =>
    benchmarkByDate.has(normalizeTradingDate(candle.timestamp))
  );
  const matchingBenchmarkCandles = alignedCandles.map((candle) =>
    benchmarkByDate.get(normalizeTradingDate(candle.timestamp))
  );

  return {
    tickerCandles: alignedCandles,
    benchmarkCandles: matchingBenchmarkCandles,
    tickerPrices: alignedCandles.map((candle) => candle.close),
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

function normalizeChatHistory(history) {
  if (history === undefined) return [];
  if (!Array.isArray(history) || history.length > 10) return null;

  const normalized = [];
  for (const message of history) {
    if (
      !message ||
      !['user', 'assistant'].includes(message.role) ||
      typeof message.content !== 'string' ||
      !message.content.trim() ||
      message.content.length > 2000
    ) {
      return null;
    }
    normalized.push({ role: message.role, content: message.content.trim() });
  }
  return normalized;
}

function findQuestionSources(question, changes) {
  const normalizedQuestion = question.toUpperCase();
  const mentioned = changes
    .filter((change) => normalizedQuestion.includes(change.ticker.toUpperCase()))
    .map((change) => change.ticker);
  return mentioned.length ? Array.from(new Set(mentioned)) : changes.map((change) => change.ticker);
}

module.exports = router;
