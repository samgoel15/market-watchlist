const { evaluateTicker } = require('./engine');

// 25 days of prices: a calm stock that normally tracks its benchmark closely,
// then has one clearly unusual day at the end.
const calmPrices = [];
const calmBenchmark = [];
let p = 100, b = 100;
for (let i = 0; i < 24; i++) {
  p *= 1 + (Math.random() - 0.5) * 0.01; // tiny daily noise
  b *= 1 + (Math.random() - 0.5) * 0.01;
  calmPrices.push(p);
  calmBenchmark.push(b);
}
// Today: benchmark barely moves, stock jumps 4% — should score as significant.
calmBenchmark.push(b * 1.001);
calmPrices.push(p * 1.04);

const result = evaluateTicker({
  tickerPrices: calmPrices,
  benchmarkPrices: calmBenchmark,
  latestVolume: 500000,
  avgVolume: 200000,
  latestSourceTimestamp: new Date(),
});

console.log('Result for an unusual +4% day against a flat benchmark:');
console.log(result);
console.log(
  result.tier === 'significant' || result.tier === 'notable'
    ? '✓ correctly flagged as meaningful'
    : '✗ did not flag — check thresholds/math'
);

// Sanity check: a stock that moves with its benchmark should NOT be flagged.
const trackingPrices = calmBenchmark.map((v) => v); // moves identically to benchmark
const trackingResult = evaluateTicker({
  tickerPrices: trackingPrices,
  benchmarkPrices: calmBenchmark,
  latestVolume: 200000,
  avgVolume: 200000,
  latestSourceTimestamp: new Date(),
});
console.log('\nResult for a stock that just tracks its benchmark:');
console.log(trackingResult);
console.log(
  trackingResult.tier === 'none' ? '✓ correctly not flagged' : '✗ false positive — check math'
);
