require('dotenv').config();
const { Client } = require('pg');

const benchmarks = [
  ['NIFTY50', 'Nifty 50'],
  ['NIFTYBANK', 'Nifty Bank'],
  ['NIFTYIT', 'Nifty IT'],
  ['NIFTYAUTO', 'Nifty Auto'],
  ['NIFTYFMCG', 'Nifty FMCG'],
];

const tickers = [
  ['RELIANCE', 'Reliance Industries', 'Energy', 'NIFTY50'],
  ['TCS', 'Tata Consultancy Services', 'Information Technology', 'NIFTYIT'],
  ['HDFCBANK', 'HDFC Bank', 'Banking', 'NIFTYBANK'],
  ['INFY', 'Infosys', 'Information Technology', 'NIFTYIT'],
  ['ICICIBANK', 'ICICI Bank', 'Banking', 'NIFTYBANK'],
  ['ITC', 'ITC', 'FMCG', 'NIFTYFMCG'],
  ['LT', 'Larsen & Toubro', 'Industrials', 'NIFTY50'],
  ['MARUTI', 'Maruti Suzuki India', 'Automotive', 'NIFTYAUTO'],
  ['BHARTIARTL', 'Bharti Airtel', 'Telecommunications', 'NIFTY50'],
  ['SUNPHARMA', 'Sun Pharmaceutical Industries', 'Healthcare', 'NIFTY50'],
];

async function seed() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    await client.query('BEGIN');
    for (const [symbol, name] of benchmarks) {
      await client.query(
        `INSERT INTO benchmarks (symbol, name)
         VALUES ($1, $2)
         ON CONFLICT (symbol) DO NOTHING`,
        [symbol, name]
      );
    }

    for (const [symbol, name, sector, benchmarkSymbol] of tickers) {
      await client.query(
        `INSERT INTO tickers (symbol, name, sector, benchmark_id, listed_at)
         SELECT $1, $2, $3, id, CURRENT_DATE
         FROM benchmarks
         WHERE symbol = $4
         ON CONFLICT (symbol) DO NOTHING`,
        [symbol, name, sector, benchmarkSymbol]
      );
    }
    await client.query('COMMIT');
    console.log(`Seeded ${benchmarks.length} benchmarks and ${tickers.length} tickers`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

seed().catch((error) => {
  console.error(`Seed failed: ${error.message}`);
  process.exitCode = 1;
});
