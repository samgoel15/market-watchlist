require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const assert = require('assert');
const fs = require('fs');
const { spawn } = require('child_process');
const http = require('http');
const { Client } = require('pg');

const API_PORT = 3103;
const API_URL = `http://localhost:${API_PORT}`;
const USER_ID = 1;
const TEMP_SUFFIX = `${Date.now()}_${process.pid}`;
const TEMP_BENCHMARK_SYMBOL = `TESTBENCH${TEMP_SUFFIX}`;
const TEMP_NO_PRICE_SYMBOL = `TESTNOPRICE${TEMP_SUFFIX}`;
const TEMP_SHORT_HISTORY_SYMBOL = `TESTSHORT${TEMP_SUFFIX}`;

let testServer;
let temporaryWatchlistIds = [];
let temporaryTickerIds = [];
let temporaryBenchmarkId;

function probeServer() {
  return new Promise((resolve) => {
    const request = http.get(
      `${API_URL}/__test_ping__`,
      { agent: false, timeout: 1000 },
      (response) => {
        response.resume();
        response.on('end', () => resolve(true));
      }
    );
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(false));
  });
}

async function startTestServer() {
  testServer = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(API_PORT) },
    stdio: 'ignore',
  });

  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await probeServer()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Test backend did not become available within 10 seconds');
}

function stopTestServer() {
  if (!testServer) return;
  testServer.kill();
  testServer = null;
}

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    let settled = false;
    const finish = (callback) => (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimeout);
      callback(value);
    };
    const request = http.request(
      `${API_URL}${path}`,
      {
        method,
        agent: false,
        timeout: 10000,
        headers: payload
          ? {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(payload),
            }
          : undefined,
      },
      (response) => {
        let responseBody = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { responseBody += chunk; });
        response.on('end', finish(() => resolve({
          status: response.statusCode,
          body: responseBody ? JSON.parse(responseBody) : null,
        })));
        response.on('error', finish(reject));
      }
    );
    const hardTimeout = setTimeout(() => {
      request.destroy(new Error('HTTP request timed out after 10 seconds'));
    }, 10000);

    request.on('timeout', () => {
      request.destroy(new Error('HTTP request timed out after 10 seconds'));
    });
    request.on('error', finish(reject));
    if (payload) request.write(payload);
    request.end();
  });
}

async function apiRequest(method, path, body) {
  await startTestServer();
  try {
    return await request(method, path, body);
  } finally {
    stopTestServer();
  }
}

function expectStatus(response, status) {
  assert.strictEqual(response.status, status, `Expected HTTP ${status}, received ${response.status}`);
}

async function createWatchlist(name) {
  const response = await apiRequest('POST', '/watchlist', { name });
  expectStatus(response, 201);
  assert(Number.isInteger(response.body.id), 'Expected a numeric watchlist id');
  temporaryWatchlistIds.push(response.body.id);
  return response.body.id;
}

async function addTicker(watchlistId, symbol) {
  const response = await apiRequest(
    'POST',
    `/watchlist/${watchlistId}/items`,
    { symbol }
  );
  expectStatus(response, 201);
}

function readEngineHistoryRequirement() {
  const engineSource = fs.readFileSync(
    require('path').join(__dirname, 'engine.js'),
    'utf8'
  );
  const match = engineSource.match(/MIN_HISTORY_DAYS\s*=\s*(\d+)/);
  assert(match, 'Could not derive MIN_HISTORY_DAYS from engine.js');
  return Number(match[1]);
}

function readTierRank() {
  const routeSource = fs.readFileSync(
    require('path').join(__dirname, 'routes', 'watchlist.js'),
    'utf8'
  );
  const match = routeSource.match(/const tierRank = \{([^}]+)\}/s);
  assert(match, 'Could not derive tierRank from watchlist.js');
  const tierRank = {};
  const entryPattern = /(?:'([^']+)'|([A-Za-z-]+))\s*:\s*(\d+)/g;
  let entry;
  while ((entry = entryPattern.exec(match[1])) !== null) {
    tierRank[entry[1] || entry[2]] = Number(entry[3]);
  }
  assert(Object.keys(tierRank).length > 0, 'Could not parse tierRank');
  return tierRank;
}

async function createTemporaryMarketData(client) {
  await client.query('BEGIN');
  try {
    const { rows: benchmarkRows } = await client.query(
      `INSERT INTO benchmarks (symbol, name)
       VALUES ($1, $2)
       RETURNING id`,
      [TEMP_BENCHMARK_SYMBOL, `Temporary benchmark ${TEMP_SUFFIX}`]
    );
    temporaryBenchmarkId = benchmarkRows[0].id;

    const { rows: tickerRows } = await client.query(
      `INSERT INTO tickers (symbol, name, sector, benchmark_id, listed_at)
       VALUES
         ($1, $2, $3, $4, CURRENT_DATE),
         ($5, $6, $7, $4, CURRENT_DATE)
       RETURNING id, symbol`,
      [
        TEMP_NO_PRICE_SYMBOL,
        `Temporary no-price ticker ${TEMP_SUFFIX}`,
        'Temporary Test',
        temporaryBenchmarkId,
        TEMP_SHORT_HISTORY_SYMBOL,
        `Temporary short-history ticker ${TEMP_SUFFIX}`,
        'Temporary Test',
      ]
    );
    temporaryTickerIds = tickerRows.map((row) => row.id);

    const shortTicker = tickerRows.find((row) => row.symbol === TEMP_SHORT_HISTORY_SYMBOL);
    await client.query(
      `INSERT INTO price_snapshots
         (ticker_id, price, volume, captured_at, source_ts, is_stale)
       VALUES ($1, $2, $3, now(), now(), false)`,
      [shortTicker.id, 100, 1000]
    );
    await client.query(
      `INSERT INTO price_snapshots
         (benchmark_id, price, volume, captured_at, source_ts, is_stale)
       VALUES ($1, $2, $3, now(), now(), false)`,
      [temporaryBenchmarkId, 100, 1000]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function cleanup(client) {
  await client.query('BEGIN');
  try {
    if (temporaryTickerIds.length > 0) {
      await client.query(
        'DELETE FROM price_snapshots WHERE ticker_id = ANY($1::int[])',
        [temporaryTickerIds]
      );
    }
    if (temporaryBenchmarkId) {
      await client.query(
        'DELETE FROM price_snapshots WHERE benchmark_id = $1',
        [temporaryBenchmarkId]
      );
    }
    for (const watchlistId of temporaryWatchlistIds) {
      await client.query('DELETE FROM watchlist_members WHERE watchlist_id = $1', [watchlistId]);
      await client.query('DELETE FROM watchlist_items WHERE watchlist_id = $1', [watchlistId]);
      await client.query('DELETE FROM watchlists WHERE id = $1 AND owner_id = $2', [watchlistId, USER_ID]);
    }
    if (temporaryTickerIds.length > 0) {
      await client.query('DELETE FROM tickers WHERE id = ANY($1::int[])', [temporaryTickerIds]);
    }
    if (temporaryBenchmarkId) {
      await client.query('DELETE FROM benchmarks WHERE id = $1', [temporaryBenchmarkId]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

async function main() {
  let client;
  try {
    const missing = await apiRequest('GET', '/watchlist/999999999/changes');
    expectStatus(missing, 404);
    assert.deepStrictEqual(missing.body, { error: 'watchlist not found' });
    console.log('TEST 1 - Nonexistent Watchlist\nPASS');

    const emptyWatchlistId = await createWatchlist(`Temporary empty ${TEMP_SUFFIX}`);
    const empty = await apiRequest('GET', `/watchlist/${emptyWatchlistId}/changes`);
    expectStatus(empty, 200);
    assert(Array.isArray(empty.body.changes));
    assert.strictEqual(empty.body.changes.length, 0);
    assert(Array.isArray(empty.body.patterns));
    assert.strictEqual(empty.body.patterns.length, 0);
    console.log('\nTEST 2 - Empty Watchlist\nPASS');

    client = new Client({
      connectionString: process.env.DATABASE_URL,
      connectionTimeoutMillis: 10000,
      statement_timeout: 10000,
    });
    await client.connect();
    await createTemporaryMarketData(client);
    await client.end();
    client = null;

    const noPriceWatchlistId = await createWatchlist(`Temporary no-price ${TEMP_SUFFIX}`);
    await addTicker(noPriceWatchlistId, TEMP_NO_PRICE_SYMBOL);
    const noPrice = await apiRequest('GET', `/watchlist/${noPriceWatchlistId}/changes`);
    expectStatus(noPrice, 200);
    const noPriceResult = noPrice.body.changes.find((item) => item.ticker === TEMP_NO_PRICE_SYMBOL);
    assert(noPriceResult);
    assert.strictEqual(noPriceResult.error, 'no price data available');
    console.log('\nTEST 3 - Ticker With No Price Data\nPASS');

    const shortHistoryWatchlistId = await createWatchlist(`Temporary short-history ${TEMP_SUFFIX}`);
    await addTicker(shortHistoryWatchlistId, TEMP_SHORT_HISTORY_SYMBOL);
    const shortHistory = await apiRequest('GET', `/watchlist/${shortHistoryWatchlistId}/changes`);
    expectStatus(shortHistory, 200);
    const shortResult = shortHistory.body.changes.find((item) => item.ticker === TEMP_SHORT_HISTORY_SYMBOL);
    assert(shortResult);
    assert.strictEqual(shortResult.tier, 'insufficient-history');
    assert.strictEqual(typeof shortResult.isStale, 'boolean');
    const requiredHistoryDays = readEngineHistoryRequirement();
    assert(1 < requiredHistoryDays + 1, 'Temporary fixture unexpectedly meets the engine history requirement');
    console.log('\nTEST 4 - Insufficient History\nPASS');

    const normalWatchlistId = await createWatchlist(`Temporary normal ${TEMP_SUFFIX}`);
    await addTicker(normalWatchlistId, 'TCS');
    await addTicker(normalWatchlistId, 'INFY');
    const normal = await apiRequest('GET', `/watchlist/${normalWatchlistId}/changes`);
    expectStatus(normal, 200);
    const normalResults = normal.body.changes.filter((item) => !item.error && item.tier !== 'insufficient-history');
    assert(normalResults.length >= 2);
    for (const result of normalResults) {
      for (const field of ['ticker', 'name', 'sector', 'isNewSinceLastVisit', 'tier', 'isStale', 'attentionScore', 'attentionLevel', 'explanation']) {
        assert(Object.prototype.hasOwnProperty.call(result, field), `Missing ${field}`);
      }
      for (const field of ['rawMove', 'benchmarkMove', 'relativeMove', 'zScore']) {
        assert(Object.prototype.hasOwnProperty.call(result, field), `Missing ${field}`);
      }
    }
    console.log('\nTEST 5 - Response Structure\nPASS');

    const tierRank = readTierRank();
    for (let index = 1; index < normalResults.length; index += 1) {
      const previous = normalResults[index - 1];
      const current = normalResults[index];
      const previousRank = tierRank[previous.tier] ?? 4;
      const currentRank = tierRank[current.tier] ?? 4;
      assert(previousRank <= currentRank, 'Tier ranking order is incorrect');
      if (previousRank === currentRank) {
        assert(
          Math.abs(previous.zScore ?? 0) >= Math.abs(current.zScore ?? 0),
          'Same-tier z-score order is incorrect'
        );
      }
    }
    console.log('\nTEST 6 - Ranking Order\nPASS');

    const secondNormal = await apiRequest('GET', `/watchlist/${normalWatchlistId}/changes`);
    expectStatus(secondNormal, 200);
    for (const result of secondNormal.body.changes.filter((item) => !item.error)) {
      assert.strictEqual(result.isNewSinceLastVisit, false);
    }
    console.log('\nTEST 7 - Last Seen Integration\nPASS');

    console.log('\nWatchlist changes API behavior passed all seven tests.');
  } finally {
    stopTestServer();
    if (client) await client.end().catch(() => {});
    const cleanupClient = new Client({
      connectionString: process.env.DATABASE_URL,
      connectionTimeoutMillis: 10000,
      statement_timeout: 10000,
    });
    await cleanupClient.connect();
    try {
      await cleanup(cleanupClient);
    } finally {
      await cleanupClient.end();
    }
  }
}

main().catch((error) => {
  console.error(`Test failed: ${error.message}`);
  stopTestServer();
  process.exitCode = 1;
});
