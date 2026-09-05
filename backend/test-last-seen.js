require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const assert = require('assert');
const { spawn } = require('child_process');
const http = require('http');
const { Client } = require('pg');

const API_PORT = 3101;
const API_URL = `http://localhost:${API_PORT}`;
const USER_ID = 1;
const SYMBOLS = ['TCS', 'INFY'];

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

async function ensureServer() {
  testServer = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(API_PORT) },
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await probeServer()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Backend server did not become available within 10 seconds\n${serverOutput}`);
}

function stopTestServer() {
  if (testServer) {
    testServer.kill();
    testServer = null;
  }
}

function byTicker(response, symbol) {
  const change = response.changes.find((item) => item.ticker === symbol);
  assert(change, `Expected ${symbol} in changes response`);
  return change;
}

function printResults(label, response) {
  console.log(`\n${label}`);
  for (const change of response.changes) {
    console.log(
      `${change.ticker}: isNewSinceLastVisit=${change.isNewSinceLastVisit}`
    );
  }
}

async function requestChanges(watchlistId) {
  await ensureServer();
  const startedAt = Date.now();
  const response = await new Promise((resolve, reject) => {
    const hardTimeout = setTimeout(() => {
      reject(new Error(`HTTP request hard timeout after ${Date.now() - startedAt}ms`));
    }, 10000);
    const request = http.get(
      `${API_URL}/watchlist/${watchlistId}/changes`,
      { agent: false, timeout: 10000 },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          clearTimeout(hardTimeout);
          resolve({ status: res.statusCode, body });
        });
      }
    );
    request.on('timeout', () => {
      clearTimeout(hardTimeout);
      reject(new Error(`HTTP request timed out after ${Date.now() - startedAt}ms`));
      request.destroy();
    });
    request.on('error', (error) => {
      clearTimeout(hardTimeout);
      reject(error);
    });
  });
  assert(response.status >= 200 && response.status < 300, `Changes request failed with HTTP ${response.status}`);
  const payload = JSON.parse(response.body);
  stopTestServer();
  return payload;
}

async function main() {
  let client = new Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 10000,
    statement_timeout: 10000,
  });
  let watchlistId;
  let temporarySnapshotId;

  try {
    await client.connect();
    await client.query('BEGIN');

    const { rows: tickerRows } = await client.query(
      `SELECT id, symbol
       FROM tickers
       WHERE symbol = ANY($1::text[])
       ORDER BY symbol`,
      [SYMBOLS]
    );
    assert.strictEqual(tickerRows.length, SYMBOLS.length, 'Test tickers are missing');

    const { rows: watchlistRows } = await client.query(
      `INSERT INTO watchlists (owner_id, name)
       VALUES ($1, $2)
       RETURNING id`,
      [USER_ID, 'Temporary isNewSinceLastVisit test']
    );
    watchlistId = watchlistRows[0].id;

    for (const ticker of tickerRows) {
      await client.query(
        `INSERT INTO watchlist_items (watchlist_id, ticker_id)
         VALUES ($1, $2)`,
        [watchlistId, ticker.id]
      );
    }
    await client.query('COMMIT');

    const { rows: initialRows } = await client.query(
      `SELECT t.symbol, max(ps.captured_at) AS latest_captured_at
       FROM watchlist_items wi
       JOIN tickers t ON t.id = wi.ticker_id
       LEFT JOIN price_snapshots ps ON ps.ticker_id = t.id
       WHERE wi.watchlist_id = $1
       GROUP BY t.symbol
       ORDER BY t.symbol`,
      [watchlistId]
    );
    const { rows: anchorRows } = await client.query(
      `SELECT price, volume
       FROM price_snapshots
       WHERE ticker_id = $1
       ORDER BY captured_at DESC
       LIMIT 1`,
      [tickerRows.find((ticker) => ticker.symbol === 'TCS').id]
    );
    assert(anchorRows[0], 'Expected an existing snapshot for test ticker');

    const firstVisit = await requestChanges(watchlistId);
    printResults('TEST 1 - First Visit', firstVisit);
    for (const symbol of SYMBOLS) {
      assert.strictEqual(byTicker(firstVisit, symbol).isNewSinceLastVisit, true);
    }

    const secondVisit = await requestChanges(watchlistId);
    printResults('TEST 2 - Immediate Second Visit', secondVisit);
    for (const symbol of SYMBOLS) {
      assert.strictEqual(byTicker(secondVisit, symbol).isNewSinceLastVisit, false);
    }

    client = new Client({
      connectionString: process.env.DATABASE_URL,
      connectionTimeoutMillis: 10000,
      statement_timeout: 10000,
    });
    await client.connect();

    const testTicker = tickerRows.find((ticker) => ticker.symbol === 'TCS');
    const newCapturedAt = new Date();
    const { rows: insertedRows } = await client.query(
      `INSERT INTO price_snapshots
         (ticker_id, price, volume, captured_at, source_ts, is_stale)
       VALUES ($1, $2, $3, $4, $4, false)
       RETURNING id, captured_at`,
      [
        testTicker.id,
        anchorRows[0].price,
        anchorRows[0].volume,
        newCapturedAt,
      ]
    );
    temporarySnapshotId = insertedRows[0].id;

    await client.end();
    client = null;

    const newSnapshotVisit = await requestChanges(watchlistId);
    printResults('TEST 3 - New Snapshot', newSnapshotVisit);
    assert.strictEqual(byTicker(newSnapshotVisit, 'TCS').isNewSinceLastVisit, true);
    assert.strictEqual(byTicker(newSnapshotVisit, 'INFY').isNewSinceLastVisit, false);

    const afterSeenVisit = await requestChanges(watchlistId);
    printResults('TEST 4 - No New Snapshot', afterSeenVisit);
    for (const symbol of SYMBOLS) {
      assert.strictEqual(byTicker(afterSeenVisit, symbol).isNewSinceLastVisit, false);
    }

    console.log('\nisNewSinceLastVisit behavior passed all four tests.');
  } finally {
    if (client) {
      await client.query('ROLLBACK').catch(() => {});
      await client.end();
    }

    const cleanupClient = new Client({
      connectionString: process.env.DATABASE_URL,
      connectionTimeoutMillis: 10000,
      statement_timeout: 10000,
    });
    await cleanupClient.connect();
    await cleanupClient.query('BEGIN');
    try {
      if (temporarySnapshotId) {
        await cleanupClient.query('DELETE FROM price_snapshots WHERE id = $1', [temporarySnapshotId]);
      }
      if (watchlistId) {
        await cleanupClient.query('DELETE FROM watchlist_members WHERE watchlist_id = $1', [watchlistId]);
        await cleanupClient.query('DELETE FROM watchlist_items WHERE watchlist_id = $1', [watchlistId]);
        await cleanupClient.query('DELETE FROM watchlists WHERE id = $1', [watchlistId]);
      }
      await cleanupClient.query('COMMIT');
    } catch (cleanupError) {
      await cleanupClient.query('ROLLBACK').catch(() => {});
      await cleanupClient.end();
      throw cleanupError;
    }
    await cleanupClient.end();
    stopTestServer();
  }
}

main().catch((error) => {
  console.error(`Test failed: ${error.message}`);
  stopTestServer();
  process.exitCode = 1;
});
