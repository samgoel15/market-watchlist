// SYNTHETIC DEMO DATA: this script repairs missing or mixed-scale histories
// for a demo. It must not be used as a substitute for real market data.
require('dotenv').config();
const { Client } = require('pg');

const HISTORY_ROWS = 21;
const MIN_DAILY_MOVE = 0.005;
const MAX_DAILY_MOVE = 0.02;

function hasPriceDiscontinuity(rows) {
  return rows.some((row, index) => {
    if (index === 0) return false;
    const ratio = Number(row.price) / Number(rows[index - 1].price);
    return !Number.isFinite(ratio) || ratio <= 0 || ratio > 3 || ratio < 1 / 3;
  });
}

function randomMove() {
  const magnitude = MIN_DAILY_MOVE + Math.random() * (MAX_DAILY_MOVE - MIN_DAILY_MOVE);
  return (Math.random() < 0.5 ? -1 : 1) * magnitude;
}

function buildPrices(currentPrice) {
  const prices = [currentPrice];
  for (let index = 1; index < HISTORY_ROWS; index += 1) {
    prices.unshift(prices[0] / (1 + randomMove()));
  }
  return prices;
}

async function getAssets(client) {
  const { rows } = await client.query(`
    SELECT 'ticker' AS kind, id, symbol FROM tickers
    UNION ALL
    SELECT 'benchmark' AS kind, id, symbol FROM benchmarks
    ORDER BY kind, id
  `);
  return rows;
}

async function backfillAsset(client, asset) {
  const column = asset.kind === 'ticker' ? 'ticker_id' : 'benchmark_id';
  const { rows } = await client.query(
    `SELECT price, volume, source_ts
     FROM price_snapshots
     WHERE ${column} = $1
     ORDER BY captured_at DESC
     LIMIT $2`,
    [asset.id, HISTORY_ROWS]
  );

  if (rows.length >= HISTORY_ROWS && !hasPriceDiscontinuity(rows)) {
    return false;
  }
  if (rows.length === 0) {
    console.warn(`Skipping ${asset.kind} ${asset.symbol}: no current price to anchor demo history`);
    return false;
  }

  const currentPrice = Number(rows[0].price);
  const currentVolume = rows[0].volume == null ? null : Number(rows[0].volume);
  const currentSourceTs = rows[0].source_ts || new Date();
  const prices = buildPrices(currentPrice);

  await client.query(`DELETE FROM price_snapshots WHERE ${column} = $1`, [asset.id]);
  for (let index = 0; index < HISTORY_ROWS; index += 1) {
    const capturedAt = new Date(Date.now() - (HISTORY_ROWS - 1 - index) * 24 * 60 * 60 * 1000);
    const sourceTs = index === HISTORY_ROWS - 1 ? currentSourceTs : capturedAt;
    await client.query(
      `INSERT INTO price_snapshots
         (ticker_id, benchmark_id, price, volume, captured_at, source_ts, is_stale)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        asset.kind === 'ticker' ? asset.id : null,
        asset.kind === 'benchmark' ? asset.id : null,
        prices[index],
        currentVolume,
        capturedAt,
        sourceTs,
        index < HISTORY_ROWS - 1,
      ]
    );
  }
  console.log(`Backfilled ${asset.kind} ${asset.symbol} with ${HISTORY_ROWS} synthetic snapshots`);
  return true;
}

async function backfill() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query('BEGIN');
    const assets = await getAssets(client);
    for (const asset of assets) {
      await backfillAsset(client, asset);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

backfill().catch((error) => {
  console.error(`Backfill failed: ${error.message}`);
  process.exitCode = 1;
});