require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const assert = require('assert');
const { spawn } = require('child_process');
const http = require('http');
const { Client } = require('pg');

const API_PORT = 3102;
const API_URL = `http://localhost:${API_PORT}`;
const USER_ID = 1;
let testServer;

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
  if (testServer) {
    testServer.kill();
    testServer = null;
  }
}

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
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
        response.on('end', () => {
          clearTimeout(hardTimeout);
          resolve({
            status: response.statusCode,
            body: responseBody ? JSON.parse(responseBody) : null,
          });
        });
      }
    );

    const hardTimeout = setTimeout(() => {
      request.destroy(new Error('HTTP request timed out after 10 seconds'));
    }, 10000);

    request.on('timeout', () => {
      clearTimeout(hardTimeout);
      request.destroy(new Error('HTTP request timed out after 10 seconds'));
    });
    request.on('error', (error) => {
      clearTimeout(hardTimeout);
      reject(error);
    });
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

async function main() {
  const temporaryName = `Temporary CRUD test ${Date.now()}-${process.pid}`;
  let watchlistId;
  let client;

  try {
    const created = await apiRequest('POST', '/watchlist', { name: temporaryName });
    expectStatus(created, 201);
    assert(Number.isInteger(created.body.id), 'Expected a numeric watchlist id');
    assert.strictEqual(created.body.name, temporaryName);
    watchlistId = created.body.id;
    console.log('TEST 1 - Create Watchlist\nPASS');

    const added = await apiRequest(
      'POST',
      `/watchlist/${watchlistId}/items`,
      { symbol: 'TCS' }
    );
    expectStatus(added, 201);
    assert(Number.isInteger(added.body.tickerId), 'Expected a numeric tickerId');
    assert.strictEqual(added.body.symbol, 'TCS');
    assert(added.body.name, 'Expected a ticker name');
    assert(added.body.addedAt, 'Expected addedAt');
    console.log('\nTEST 2 - Add Ticker\nPASS');

    const listed = await apiRequest('GET', `/watchlist/${watchlistId}/items`);
    expectStatus(listed, 200);
    assert(listed.body.items.some((item) => item.symbol === 'TCS'));
    console.log('\nTEST 3 - Get Watchlist Items\nPASS');

    const duplicate = await apiRequest(
      'POST',
      `/watchlist/${watchlistId}/items`,
      { symbol: 'TCS' }
    );
    expectStatus(duplicate, 409);
    assert.strictEqual(duplicate.body.error, 'already in watchlist');
    console.log('\nTEST 4 - Prevent Duplicate Ticker\nPASS');

    const removed = await apiRequest(
      'DELETE',
      `/watchlist/${watchlistId}/items/TCS`
    );
    expectStatus(removed, 204);
    console.log('\nTEST 5 - Remove Ticker\nPASS');

    const remaining = await apiRequest('GET', `/watchlist/${watchlistId}/items`);
    expectStatus(remaining, 200);
    assert(!remaining.body.items.some((item) => item.symbol === 'TCS'));
    console.log('\nTEST 6 - Confirm Ticker Removed\nPASS');

    console.log('\nWatchlist API CRUD behavior passed all six tests.');
  } finally {
    stopTestServer();
    if (watchlistId) {
      client = new Client({
        connectionString: process.env.DATABASE_URL,
        connectionTimeoutMillis: 10000,
        statement_timeout: 10000,
      });
      await client.connect();
      try {
        await client.query('BEGIN');
        await client.query('DELETE FROM watchlist_members WHERE watchlist_id = $1', [watchlistId]);
        await client.query('DELETE FROM watchlist_items WHERE watchlist_id = $1', [watchlistId]);
        await client.query('DELETE FROM watchlists WHERE id = $1 AND owner_id = $2', [watchlistId, USER_ID]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        await client.end();
      }
    }
  }
}

main().catch((error) => {
  console.error(`Test failed: ${error.message}`);
  stopTestServer();
  process.exitCode = 1;
});
