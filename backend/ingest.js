const cron = require('node-cron');
const db = require('./db');
const { providerSymbolFor } = require('./symbols');

const MARKET_TIME_ZONE = 'Asia/Kolkata';
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 500;
const BENCHMARK_SYMBOLS = {
  NIFTY50: '^NSEI',
  NIFTYBANK: '^NSEBANK',
  NIFTYIT: '^CNXIT',
  NIFTYAUTO: '^CNXAUTO',
  NIFTYFMCG: '^CNXFMCG',
};
let ingestionRunning = false;

function isMarketHours(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: MARKET_TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  const weekday = values.weekday;
  const minutes = Number(values.hour) * 60 + Number(values.minute);

  return !['Sat', 'Sun'].includes(weekday) && minutes >= 555 && minutes <= 930;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function fetchQuote(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1m`;
  const response = await fetch(url, {
    headers: { 'User-Agent': 'meaningful-change/1.0' },
  });
  if (!response.ok) {
    throw new Error(`Yahoo Finance returned ${response.status}`);
  }

  const payload = await response.json();
  const meta = payload.chart?.result?.[0]?.meta;
  if (!meta || meta.regularMarketPrice == null || meta.regularMarketTime == null) {
    throw new Error('quote not found');
  }

  return {
    price: Number(meta.regularMarketPrice),
    volume: meta.regularMarketVolume == null ? null : Number(meta.regularMarketVolume),
    sourceTs: new Date(meta.regularMarketTime * 1000),
    name: meta.shortName || meta.longName || null,
  };
}

async function fetchCandles(symbol, interval = '1d') {
  const { candles } = await fetchCandleData(symbol, interval);
  return candles;
}

function getMarketStatus({ providerMarketState, regularMarketTime, now = new Date() }) {
  if (providerMarketState === 'REGULAR') return 'OPEN';
  if (providerMarketState === 'CLOSED') return 'CLOSED';
  if (!isMarketHours(now)) return 'CLOSED';

  if (regularMarketTime && now.getTime() - regularMarketTime.getTime() > 15 * 60 * 1000) {
    return 'DELAYED';
  }

  return 'OPEN';
}

async function fetchCandleData(symbol, interval = '1d') {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1y&interval=${encodeURIComponent(interval)}`;
  const response = await fetch(url, {
    headers: { 'User-Agent': 'meaningful-change/1.0' },
  });
  if (!response.ok) {
    throw new Error(`Yahoo Finance returned ${response.status}`);
  }

  const result = (await response.json()).chart?.result?.[0];
  const meta = result?.meta ?? {};
  const timestamps = result?.timestamp ?? [];
  const quote = result?.indicators?.quote?.[0] ?? {};

  const candles = timestamps.map((timestamp, index) => ({
    timestamp: new Date(timestamp * 1000),
    open: quote.open?.[index] == null ? null : Number(quote.open[index]),
    high: quote.high?.[index] == null ? null : Number(quote.high[index]),
    low: quote.low?.[index] == null ? null : Number(quote.low[index]),
    close: quote.close?.[index] == null ? null : Number(quote.close[index]),
    volume: quote.volume?.[index] == null ? null : Number(quote.volume[index]),
  })).filter((candle) => (
    candle.open !== null && candle.high !== null && candle.low !== null && candle.close !== null
  ));

  const regularMarketTime = meta.regularMarketTime == null
    ? null
    : new Date(meta.regularMarketTime * 1000);

  return {
    candles,
    fetchedAt: new Date(),
    regularMarketPrice: meta.regularMarketPrice == null ? null : Number(meta.regularMarketPrice),
    regularMarketTime,
    providerMarketState: meta.marketState || null,
    marketStatus: getMarketStatus({
      providerMarketState: meta.marketState,
      regularMarketTime,
    }),
  };
}

async function fetchWithRetry(symbol) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await fetchQuote(symbol);
    } catch (error) {
      lastError = error;
      if (attempt < MAX_ATTEMPTS) {
        await sleep(RETRY_DELAY_MS * 2 ** (attempt - 1));
      }
    }
  }
  throw lastError;
}

async function saveSnapshot({ tickerId, benchmarkId, quote }) {
  const isStale = Date.now() - quote.sourceTs.getTime() > 15 * 60 * 1000;
  await db.query(
    `INSERT INTO price_snapshots
       (ticker_id, benchmark_id, price, volume, captured_at, source_ts, is_stale)
     SELECT $1, $2, $3, $4, now(), $5, $6
     WHERE NOT EXISTS (
       SELECT 1
       FROM price_snapshots
       WHERE ((ticker_id = $1 AND $1 IS NOT NULL) OR (benchmark_id = $2 AND $2 IS NOT NULL))
         AND source_ts = $5
         AND price = $3
     )`,
    [tickerId, benchmarkId, quote.price, quote.volume, quote.sourceTs, isStale]
  );
}

async function ingestOne(asset) {
  try {
    const quote = await fetchWithRetry(asset.yahooSymbol);
    await saveSnapshot({ ...asset, quote });
    console.log(`Ingested ${asset.symbol}`);
  } catch (error) {
    console.error(`Failed to ingest ${asset.symbol}: ${error.message}`);
  }
}

async function ingestTickerAndBenchmark({ tickerId, symbol, benchmarkId, benchmarkSymbol }) {
  const assets = [
    {
      tickerId,
      benchmarkId: null,
      symbol,
      yahooSymbol: providerSymbolFor(symbol),
    },
  ];
  if (benchmarkId && benchmarkSymbol) {
    assets.push({
      tickerId: null,
      benchmarkId,
      symbol: benchmarkSymbol,
      yahooSymbol: BENCHMARK_SYMBOLS[benchmarkSymbol] || benchmarkSymbol,
    });
  }

  const results = await Promise.allSettled(assets.map(async (asset) => {
    const quote = await fetchWithRetry(asset.yahooSymbol);
    const inserted = await saveSnapshot({ ...asset, quote });
    return { symbol: asset.symbol, inserted, sourceTs: quote.sourceTs };
  }));

  return results.map((result) => result.status === 'fulfilled'
    ? { status: 'ready', ...result.value }
    : { status: 'unavailable', error: 'market data temporarily unavailable' });
}

async function runIngestion(now = new Date()) {
  if (ingestionRunning) {
    console.log('Skipping ingestion because the previous run is still active');
    return;
  }
  if (!isMarketHours(now)) {
    console.log('Skipping ingestion outside NSE market hours');
    return;
  }

  ingestionRunning = true;
  try {
    const [{ rows: tickers }, { rows: benchmarks }] = await Promise.all([
      db.query(`SELECT id, symbol FROM tickers`),
      db.query(`SELECT id, symbol FROM benchmarks`),
    ]);
    const assets = [
      ...tickers.map((ticker) => ({
        tickerId: ticker.id,
        benchmarkId: null,
        symbol: ticker.symbol,
        yahooSymbol: providerSymbolFor(ticker.symbol),
      })),
      ...benchmarks.map((benchmark) => ({
        tickerId: null,
        benchmarkId: benchmark.id,
        symbol: benchmark.symbol,
        yahooSymbol: BENCHMARK_SYMBOLS[benchmark.symbol] || benchmark.symbol,
      })),
    ];

    await Promise.all(assets.map(ingestOne));
  } finally {
    ingestionRunning = false;
  }
}

function startIngestion() {
  console.log('Running initial price ingestion...');

  runIngestion().catch((error) => {
    console.error(`Initial ingestion failed: ${error.message}`);
  });

  cron.schedule('*/5 9-15 * * 1-5', () => {
    runIngestion().catch((error) => {
      console.error(`Ingestion job failed: ${error.message}`);
    });
  }, { timezone: MARKET_TIME_ZONE });
  console.log('Price ingestion scheduled every 5 minutes during NSE market hours');
}

module.exports = {
  fetchQuote,
  fetchCandles,
  fetchCandleData,
  ingestTickerAndBenchmark,
  getMarketStatus,
  isMarketHours,
  runIngestion,
  startIngestion,
};
