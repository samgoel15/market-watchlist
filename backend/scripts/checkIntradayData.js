const db = require('../db');

const symbol = process.argv[2]?.toUpperCase() || null;
const DAYS_TO_CHECK = 5;

async function main() {
  const { rows } = await db.query(
    `WITH snapshot_rows AS (
       SELECT t.id AS ticker_id,
              t.symbol,
              t.benchmark_id,
              ps.id,
              ps.price,
              COALESCE(ps.source_ts, ps.captured_at) AS snapshot_timestamp,
              ((COALESCE(ps.source_ts, ps.captured_at) AT TIME ZONE 'Asia/Kolkata')::date) AS session_date,
              LAG(COALESCE(ps.source_ts, ps.captured_at)) OVER (
                PARTITION BY t.id, ((COALESCE(ps.source_ts, ps.captured_at) AT TIME ZONE 'Asia/Kolkata')::date)
                ORDER BY COALESCE(ps.source_ts, ps.captured_at), ps.id
              ) AS previous_timestamp
       FROM price_snapshots ps
       JOIN tickers t ON t.id = ps.ticker_id
       WHERE COALESCE(ps.source_ts, ps.captured_at) IS NOT NULL
         ${symbol ? 'AND t.symbol = $1' : ''}
     ), recent_days AS (
       SELECT DISTINCT session_date
       FROM snapshot_rows
       ORDER BY session_date DESC
       LIMIT ${DAYS_TO_CHECK}
     )
     SELECT sr.symbol,
            sr.session_date AS "sessionDate",
            COUNT(sr.id)::int AS snapshots,
            MIN(sr.snapshot_timestamp) AS first_timestamp,
            MAX(sr.snapshot_timestamp) AS last_timestamp,
            COUNT(DISTINCT sr.snapshot_timestamp)::int AS distinct_timestamps,
            (COUNT(sr.id) - COUNT(DISTINCT (sr.snapshot_timestamp, sr.price)))::int AS exact_duplicate_rows,
            COUNT(DISTINCT bps.id)::int AS benchmark_snapshots,
            AVG(EXTRACT(EPOCH FROM (sr.snapshot_timestamp - sr.previous_timestamp)) / 60) AS average_interval_minutes
     FROM snapshot_rows sr
     JOIN recent_days rd ON rd.session_date = sr.session_date
     LEFT JOIN price_snapshots bps
       ON bps.benchmark_id = sr.benchmark_id
      AND COALESCE(bps.source_ts, bps.captured_at) BETWEEN sr.snapshot_timestamp - INTERVAL '10 minutes'
                                                        AND sr.snapshot_timestamp + INTERVAL '10 minutes'
     GROUP BY sr.ticker_id, sr.symbol, sr.session_date
     ORDER BY sr.session_date DESC, sr.symbol ASC`,
    symbol ? [symbol] : [],
  );

  if (rows.length === 0) {
    console.log(symbol ? `No intraday snapshots found for ${symbol}.` : 'No intraday snapshots found.');
    return;
  }

  for (const row of rows) {
    const interval = row.average_interval_minutes == null ? 'n/a' : `~${Number(row.average_interval_minutes).toFixed(1)} minutes`;
    console.log([
      row.symbol,
      `Date: ${String(row.sessionDate).slice(0, 10)}`,
      `Snapshots: ${row.snapshots}`,
      `Distinct provider timestamps: ${row.distinct_timestamps}`,
      `Exact duplicate rows: ${row.exact_duplicate_rows}`,
      `First: ${new Date(row.first_timestamp).toISOString()}`,
      `Last: ${new Date(row.last_timestamp).toISOString()}`,
      `Average interval: ${interval}`,
      `Benchmark snapshots within 10m: ${row.benchmark_snapshots}`,
    ].join(' | '));
  }
}

main()
  .catch((error) => {
    console.error(`Intraday diagnostic failed: ${error.message}`);
    process.exitCode = 1;
  });
