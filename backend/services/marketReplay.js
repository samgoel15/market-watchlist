const MARKET_TIME_ZONE = 'Asia/Kolkata';
const MARKET_CLOSE_MINUTES = 930;
const DIVERGENCE_THRESHOLD = 0.01;
const MEANINGFUL_MOVE_THRESHOLD = 0.005;
const MAX_EVENTS = 8;
const MIN_INTRADAY_SNAPSHOTS = 4;
const BENCHMARK_ALIGNMENT_TOLERANCE_MS = 10 * 60 * 1000;

function localSessionDate(timestamp) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: MARKET_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(timestamp));
}

function sessionBounds(sessionDate) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(sessionDate);
  if (!match) return null;
  const utcStart = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) - (5.5 * 60 * 60 * 1000);
  return {
    start: new Date(utcStart),
    end: new Date(utcStart + 24 * 60 * 60 * 1000),
  };
}

function percentChange(start, end) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || start === 0) return null;
  return (end - start) / start;
}

function timeLabel(timestamp) {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: MARKET_TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(timestamp));
}

function minutesInSession(timestamp) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: MARKET_TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return Number(values.hour) * 60 + Number(values.minute);
}

function buildEvent({ id, timestamp, type, severity, title, description, price, rawMove, benchmarkMove, relativeMove }) {
  return {
    id,
    timestamp: new Date(timestamp).toISOString(),
    timeLabel: timeLabel(timestamp),
    type,
    severity,
    title,
    description,
    price: Number(price),
    rawMove: rawMove ?? null,
    benchmarkMove: benchmarkMove ?? null,
    relativeMove: relativeMove ?? null,
    zScore: null,
  };
}

function alignBenchmark(tickerRows, benchmarkRows) {
  return tickerRows.map((ticker) => {
    const tickerTime = new Date(ticker.timestamp).getTime();
    let nearest = null;
    let nearestDistance = Infinity;
    for (const benchmark of benchmarkRows) {
      const distance = Math.abs(new Date(benchmark.timestamp).getTime() - tickerTime);
      if (distance < nearestDistance) {
        nearest = benchmark;
        nearestDistance = distance;
      }
    }
    return nearest && nearestDistance <= BENCHMARK_ALIGNMENT_TOLERANCE_MS
      ? { ticker, benchmark: nearest }
      : null;
  }).filter(Boolean);
}

function detectEvents({ symbol, rows, benchmarkRows, sessionDate, benchmarkName }) {
  if (rows.length === 0) return [];

  const events = [];
  const first = rows[0];
  const last = rows.at(-1);
  const aligned = alignBenchmark(rows, benchmarkRows);
  const firstAligned = aligned[0];
  const lastAligned = aligned.at(-1);
  const alignedFirstTicker = firstAligned?.ticker ?? first;
  const sessionRawMove = percentChange(alignedFirstTicker.price, last.price);
  const sessionBenchmarkMove = firstAligned && lastAligned
    ? percentChange(firstAligned.benchmark.price, lastAligned.benchmark.price)
    : null;
  const sessionRelativeMove = sessionRawMove !== null && sessionBenchmarkMove !== null
    ? sessionRawMove - sessionBenchmarkMove
    : null;

  events.push(buildEvent({
    id: `${symbol}-${sessionDate}-open`,
    timestamp: first.timestamp,
    type: 'market_open',
    severity: 'info',
    title: 'Market Open',
    description: `${symbol} opened the available session at ${first.price}.`,
    price: first.price,
    rawMove: 0,
  }));

  let momentumCandidate = null;
  for (let index = 6; index < rows.length; index += 1) {
    const previousWindow = percentChange(rows[index - 6].price, rows[index - 3].price);
    const recentWindow = percentChange(rows[index - 3].price, rows[index].price);
    if (previousWindow === null || recentWindow === null) continue;
    const acceleration = Math.abs(recentWindow) - Math.abs(previousWindow);
    if (Math.abs(acceleration) < 0.003 || Math.abs(recentWindow) <= Math.abs(previousWindow)) continue;
    if (!momentumCandidate || Math.abs(acceleration) > Math.abs(momentumCandidate.acceleration)) {
      momentumCandidate = { row: rows[index], recentWindow, acceleration };
    }
  }
  if (momentumCandidate) {
    events.push(buildEvent({
      id: `${symbol}-${sessionDate}-momentum`,
      timestamp: momentumCandidate.row.timestamp,
      type: 'momentum',
      severity: 'medium',
      title: 'Momentum Detected',
      description: `${symbol}'s movement accelerated over the latest available snapshot window.`,
      price: momentumCandidate.row.price,
      rawMove: momentumCandidate.recentWindow,
    }));
  }

  let divergenceCandidate = null;
  let previousRelative = 0;
  for (const point of aligned) {
    const rawMove = percentChange(alignedFirstTicker.price, point.ticker.price);
    const benchmarkMove = percentChange(firstAligned?.benchmark.price, point.benchmark.price);
    if (rawMove === null || benchmarkMove === null) continue;
    const relativeMove = rawMove - benchmarkMove;
    const crossedPositive = previousRelative < DIVERGENCE_THRESHOLD && relativeMove >= DIVERGENCE_THRESHOLD;
    const crossedNegative = previousRelative > -DIVERGENCE_THRESHOLD && relativeMove <= -DIVERGENCE_THRESHOLD;
    if (crossedPositive || crossedNegative) {
      divergenceCandidate = { point, rawMove, benchmarkMove, relativeMove };
      break;
    }
    previousRelative = relativeMove;
  }
  if (divergenceCandidate) {
    const direction = divergenceCandidate.relativeMove >= 0 ? 'outperforming' : 'falling behind';
    events.push(buildEvent({
      id: `${symbol}-${sessionDate}-divergence`,
      timestamp: divergenceCandidate.point.ticker.timestamp,
      type: 'benchmark_divergence',
      severity: 'high',
      title: 'Benchmark Divergence',
      description: `${symbol} began ${direction} its ${benchmarkName || 'benchmark'} during the session.`,
      price: divergenceCandidate.point.ticker.price,
      rawMove: divergenceCandidate.rawMove,
      benchmarkMove: divergenceCandidate.benchmarkMove,
      relativeMove: divergenceCandidate.relativeMove,
    }));
  }

  let majorCandidate = null;
  for (let index = 1; index < rows.length; index += 1) {
    const move = percentChange(rows[index - 1].price, rows[index].price);
    if (move === null || Math.abs(move) < MEANINGFUL_MOVE_THRESHOLD) continue;
    if (!majorCandidate || Math.abs(move) > Math.abs(majorCandidate.move)) {
      majorCandidate = { row: rows[index], move };
    }
  }
  if (majorCandidate) {
    events.push(buildEvent({
      id: `${symbol}-${sessionDate}-major-move`,
      timestamp: majorCandidate.row.timestamp,
      type: 'major_move',
      severity: Math.abs(majorCandidate.move) >= 0.01 ? 'high' : 'medium',
      title: 'Major Move',
      description: `${symbol} recorded its largest meaningful snapshot-to-snapshot move in the available session data.`,
      price: majorCandidate.row.price,
      rawMove: majorCandidate.move,
    }));
  }

  const isCompleted = sessionDate < localSessionDate(new Date()) || minutesInSession(last.timestamp) >= MARKET_CLOSE_MINUTES - 5;
  events.push(buildEvent({
    id: `${symbol}-${sessionDate}-${isCompleted ? 'close' : 'latest'}`,
    timestamp: last.timestamp,
    type: isCompleted ? 'market_close' : 'latest_position',
    severity: 'info',
    title: isCompleted ? 'Market Close' : 'Latest Market Position',
    description: isCompleted
      ? `${symbol} closed at ${last.price}, finishing ${sessionRawMove === null ? 'with an unavailable movement' : `${sessionRawMove >= 0 ? '+' : ''}${(sessionRawMove * 100).toFixed(2)}%`}.`
      : `${symbol} was last recorded at ${last.price}; the session is not yet complete.`,
    price: last.price,
    rawMove: sessionRawMove,
    benchmarkMove: sessionBenchmarkMove,
    relativeMove: sessionRelativeMove,
  }));

  return events
    .sort((firstEvent, secondEvent) => new Date(firstEvent.timestamp) - new Date(secondEvent.timestamp))
    .slice(0, MAX_EVENTS);
}

function buildTimeline(rows, benchmarkRows) {
  return rows.map((row) => {
    const aligned = alignBenchmark([row], benchmarkRows)[0];
    return {
      timestamp: new Date(row.timestamp).toISOString(),
      price: row.price,
      benchmarkPrice: aligned?.benchmark.price ?? null,
    };
  });
}

async function buildMarketReplay({ symbol, sessionDate, db }) {
  const { rows: tickerRows } = await db.query(
    `SELECT t.id, t.symbol, t.name, t.benchmark_id, b.name AS benchmark_name
     FROM tickers t
     LEFT JOIN benchmarks b ON b.id = t.benchmark_id
     WHERE t.symbol = $1`,
    [symbol]
  );
  if (tickerRows.length === 0) {
    const error = new Error('ticker not found');
    error.statusCode = 404;
    throw error;
  }

  const ticker = tickerRows[0];
  let resolvedSessionDate = sessionDate;
  if (!resolvedSessionDate) {
    const { rows: latestRows } = await db.query(
      `SELECT source_ts AS timestamp, captured_at AS "capturedAt"
       FROM price_snapshots
       WHERE ticker_id = $1
       ORDER BY captured_at DESC
       LIMIT 1`,
      [ticker.id]
    );
    const latest = latestRows[0];
    if (!latest) return emptyReplay(ticker, null);
    resolvedSessionDate = localSessionDate(latest.timestamp || latest.capturedAt);
  }

  const bounds = sessionBounds(resolvedSessionDate);
  if (!bounds) {
    const error = new Error('date must use YYYY-MM-DD format');
    error.statusCode = 400;
    throw error;
  }

  const { rows } = await db.query(
    `SELECT CASE WHEN ps.ticker_id = $1 THEN 'ticker' ELSE 'benchmark' END AS kind,
            ps.id,
            COALESCE(ps.source_ts, ps.captured_at) AS timestamp,
            ps.captured_at AS "capturedAt",
            ps.price
     FROM price_snapshots ps
     WHERE ((ps.ticker_id = $1) OR (ps.benchmark_id = $2))
       AND ps.captured_at >= $3
       AND ps.captured_at < $4
       AND COALESCE(ps.source_ts, ps.captured_at) >= $3
       AND COALESCE(ps.source_ts, ps.captured_at) < $4
     ORDER BY timestamp ASC, ps.id ASC`,
    [ticker.id, ticker.benchmark_id, bounds.start, bounds.end]
  );

  const sessionTickerRows = rows.filter((row) => row.kind === 'ticker').map((row) => ({ ...row, price: Number(row.price) }));
  const sessionBenchmarkRows = rows.filter((row) => row.kind === 'benchmark').map((row) => ({ ...row, price: Number(row.price) }));
  if (sessionTickerRows.length === 0) return emptyReplay(ticker, resolvedSessionDate);

  const timeline = buildTimeline(sessionTickerRows, sessionBenchmarkRows);
  const hasSufficientIntradayData = sessionTickerRows.length >= MIN_INTRADAY_SNAPSHOTS;
  const events = hasSufficientIntradayData
    ? detectEvents({
        symbol: ticker.symbol,
        rows: sessionTickerRows,
        benchmarkRows: sessionBenchmarkRows,
        sessionDate: resolvedSessionDate,
        benchmarkName: ticker.benchmark_name,
      })
    : [];
  const last = sessionTickerRows.at(-1);
  const aligned = alignBenchmark(sessionTickerRows, sessionBenchmarkRows);
  const first = aligned[0]?.ticker ?? sessionTickerRows[0];
  const firstBenchmark = aligned[0]?.benchmark;
  const lastBenchmark = aligned.at(-1)?.benchmark;
  const rawMove = percentChange(first.price, last.price);
  const benchmarkMove = firstBenchmark && lastBenchmark ? percentChange(firstBenchmark.price, lastBenchmark.price) : null;

  return {
    symbol: ticker.symbol,
    name: ticker.name,
    sessionDate: resolvedSessionDate,
    summary: {
      startPrice: first.price,
      endPrice: last.price,
      rawMove,
      benchmarkMove,
      relativeMove: rawMove !== null && benchmarkMove !== null ? rawMove - benchmarkMove : null,
      benchmarkName: ticker.benchmark_name,
    },
    timeline,
    interactiveReplayAvailable: hasSufficientIntradayData,
    events,
    limitations: {
      historicalAttention: 'not_available',
      historicalZScore: 'not_available',
      note: hasSufficientIntradayData
        ? 'Attention scores and z-scores are current daily analysis values, not stored per intraday snapshot, so replay events do not fabricate historical values.'
        : `Limited intraday data is available for this session (${sessionTickerRows.length} snapshots). Detailed replay events are withheld until at least ${MIN_INTRADAY_SNAPSHOTS} snapshots are available.`,
    },
  };
}

function emptyReplay(ticker, sessionDate) {
  return {
    symbol: ticker.symbol,
    name: ticker.name,
    sessionDate,
    summary: { startPrice: null, endPrice: null, rawMove: null, benchmarkMove: null, relativeMove: null, benchmarkName: ticker.benchmark_name },
    timeline: [],
    interactiveReplayAvailable: false,
    events: [],
    limitations: {
      historicalAttention: 'not_available',
      historicalZScore: 'not_available',
      note: 'Not enough timestamped snapshots are available to reconstruct this session.',
    },
  };
}

module.exports = { buildMarketReplay, localSessionDate };
