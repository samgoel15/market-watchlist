require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const assert = require('assert');
const { spawn } = require('child_process');
const http = require('http');

const API_PORT = 3103;
const API_URL = `http://localhost:${API_PORT}`;
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

function request(path) {
  return new Promise((resolve, reject) => {
    const request = http.get(
      `${API_URL}${path}`,
      { agent: false, timeout: 10000 },
      (response) => {
        let responseBody = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { responseBody += chunk; });
        response.on('end', () => {
          clearTimeout(hardTimeout);
          try {
            resolve({
              status: response.statusCode,
              body: responseBody ? JSON.parse(responseBody) : null,
            });
          } catch (error) {
            reject(new Error(`Invalid JSON response: ${error.message}`));
          }
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
  });
}

function expectStatus(response, status) {
  assert.strictEqual(response.status, status, `Expected HTTP ${status}, received ${response.status}`);
}

function assertChronological(prices) {
  for (let index = 1; index < prices.length; index += 1) {
    assert(
      new Date(prices[index - 1].capturedAt) <= new Date(prices[index].capturedAt),
      'Expected prices to be ordered oldest to newest'
    );
  }
}

async function main() {
  await startTestServer();
  try {
    const valid = await request('/tickers/TCS/prices');
    expectStatus(valid, 200);
    assert.strictEqual(valid.body.ticker.symbol, 'TCS');
    assert(Array.isArray(valid.body.prices), 'Expected prices to be an array');
    console.log('TEST 1 - Valid Ticker Price History\nPASS');

    assertChronological(valid.body.prices);
    console.log('\nTEST 2 - Chronological Ordering\nPASS');

    assert(
      valid.body.prices.every((price) => typeof price.price === 'number' && Number.isFinite(price.price)),
      'Expected every price value to be numeric'
    );
    console.log('\nTEST 3 - Numeric Price Values\nPASS');

    const limited = await request('/tickers/TCS/prices?limit=5');
    expectStatus(limited, 200);
    assert(limited.body.prices.length <= 5, 'Expected the limit to bound the result');
    assertChronological(limited.body.prices);
    console.log('\nTEST 4 - Limit Parameter\nPASS');

    const unknown = await request('/tickers/UNKNOWN_TICKER_FOR_TEST/prices');
    expectStatus(unknown, 404);
    assert(unknown.body.error, 'Expected an error for an unknown ticker');
    console.log('\nTEST 5 - Unknown Ticker\nPASS');

    for (const invalidLimit of ['abc', '-5']) {
      const invalid = await request(`/tickers/TCS/prices?limit=${invalidLimit}`);
      expectStatus(invalid, 400);
      assert(invalid.body.error, 'Expected an error for an invalid limit');
    }
    console.log('\nTEST 6 - Invalid Limit\nPASS');

    console.log('\nTicker price history API passed all six tests.');
  } finally {
    stopTestServer();
  }
}

main().catch((error) => {
  console.error(`Test failed: ${error.message}`);
  stopTestServer();
  process.exitCode = 1;
});
