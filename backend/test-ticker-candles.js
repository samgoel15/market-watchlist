require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const assert = require('assert');
const { spawn } = require('child_process');
const http = require('http');
const { Client } = require('pg');

const API_PORT = 3104;
const API_URL = `http://localhost:${API_PORT}`;
let testServer;

function probeServer() {
  return new Promise((resolve) => {
    const request = http.get(`${API_URL}/__test_ping__`, { agent: false, timeout: 1000 }, (response) => {
      response.resume();
      response.on('end', () => resolve(true));
    });
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
  if (testServer) {
    testServer.kill();
    testServer = null;
  }
}

function request(path) {
  return new Promise((resolve, reject) => {
    const request = http.get(`${API_URL}${path}`, { agent: false, timeout: 10000 }, (response) => {
      let responseBody = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { responseBody += chunk; });
      response.on('end', () => {
        clearTimeout(hardTimeout);
        try {
          resolve({ status: response.statusCode, body: responseBody ? JSON.parse(responseBody) : null });
        } catch (error) {
          reject(new Error(`Invalid JSON response: ${error.message}`));
        }
      });
    });
    const hardTimeout = setTimeout(() => request.destroy(new Error('HTTP request timed out after 10 seconds')), 10000);
    request.on('timeout', () => {
      clearTimeout(hardTimeout);
      request.destroy(new Error('HTTP request timed out after 10 seconds'));
    });
    request.on('error', (error) => {
      clearTimeout(hardTimeout);
      reject(error);
    });
  });
}

function expectStatus(response, status) {
  assert.strictEqual(response.status, status, `Expected HTTP ${status}, received ${response.status}`);
}

function assertCandlesAreValid(candles) {
  candles.forEach((candle) => {
    assert(candle.timestamp, 'Expected a candle timestamp');
    for (const field of ['open', 'high', 'low', 'close']) {
      assert(typeof candle[field] === 'number' && Number.isFinite(candle[field]), `Expected numeric ${field}`);
    }
    assert(candle.high >= candle.open && candle.high >= candle.close, 'High must contain open and close');
    assert(candle.low <= candle.open && candle.low <= candle.close, 'Low must contain open and close');
  });
}

function assertChronological(candles) {
  for (let index = 1; index < candles.length; index += 1) {
    assert(new Date(candles[index - 1].timestamp) <= new Date(candles[index].timestamp), 'Expected chronological candles');
  }
}

async function findTickerWithoutSnapshots() {
  const client = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10000 });
  await client.connect();
  try {
    const { rows } = await client.query(
      `SELECT t.symbol
       FROM tickers t
       LEFT JOIN price_snapshots ps ON ps.ticker_id = t.id
       GROUP BY t.id, t.symbol
       HAVING COUNT(ps.id) = 0
       LIMIT 1`
    );
    return rows[0]?.symbol;
  } finally {
    await client.end();
  }
}

async function main() {
  await startTestServer();
  try {
    const valid = await request('/tickers/RELIANCE/candles');
    expectStatus(valid, 200);
    assert.strictEqual(valid.body.ticker.symbol, 'RELIANCE');
    assert.strictEqual(valid.body.interval, '1d');
    assert(Array.isArray(valid.body.candles), 'Expected candles to be an array');
    console.log('TEST 1 - Valid Candle Response\nPASS');

    assertCandlesAreValid(valid.body.candles);
    console.log('\nTEST 2 - Candle Data Integrity\nPASS');

    assertChronological(valid.body.candles);
    console.log('\nTEST 3 - Chronological Ordering\nPASS');

    const limited = await request('/tickers/RELIANCE/candles?limit=5');
    expectStatus(limited, 200);
    assert(limited.body.candles.length <= 5, 'Expected limit to bound candles');
    assertChronological(limited.body.candles);
    console.log('\nTEST 4 - Limit Handling\nPASS');

    const invalid = await request('/tickers/RELIANCE/candles?limit=abc');
    expectStatus(invalid, 400);
    assert(invalid.body.error, 'Expected an invalid-limit error');
    console.log('\nTEST 5 - Invalid Limit\nPASS');

    const unknown = await request('/tickers/UNKNOWN_TICKER_FOR_TEST/candles');
    expectStatus(unknown, 404);
    assert(unknown.body.error, 'Expected an unknown-ticker error');
    console.log('\nTEST 6 - Unknown Ticker\nPASS');

    const noSnapshotTicker = await findTickerWithoutSnapshots();
    if (noSnapshotTicker) {
      const insufficient = await request(`/tickers/${noSnapshotTicker}/candles`);
      expectStatus(insufficient, 200);
      assert.deepStrictEqual(insufficient.body.candles, []);
      console.log('\nTEST 7 - Insufficient Real Data\nPASS');
    } else {
      console.log('\nTEST 7 - Insufficient Real Data\nSKIP (no valid ticker without snapshots exists in the database)');
    }

    console.log('\nTicker candle API behavior passed all available tests.');
  } finally {
    stopTestServer();
  }
}

main().catch((error) => {
  console.error(`Test failed: ${error.message}`);
  stopTestServer();
  process.exitCode = 1;
});
