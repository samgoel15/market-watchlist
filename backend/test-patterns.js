const assert = require('assert');
const { detectPatterns } = require('./intelligence');

function printTest(name, changes, expectedType) {
  const patterns = detectPatterns(changes);
  const matchingPattern = expectedType
    ? patterns.find((pattern) => pattern.type === expectedType)
    : undefined;

  console.log(`\n${name}`);
  console.log(JSON.stringify(patterns, null, 2));

  if (expectedType) {
    assert(matchingPattern, `Expected ${expectedType} pattern`);
    console.log(`Verified: ${matchingPattern.type}`);
    console.log(`Severity: ${matchingPattern.severity}`);
    console.log(`Message: ${matchingPattern.message}`);
    console.log(`Tickers: ${matchingPattern.tickers.join(', ')}`);
  } else {
    assert(
      !patterns.some((pattern) => pattern.type.startsWith('sector-')),
      'Expected no sector pattern'
    );
    console.log('Verified: no sector pattern');
  }
}

printTest(
  'TEST 1 - Sector Outperformance',
  [
    { ticker: 'TCS', sector: 'Information Technology', relativeMove: 0.02, tier: 'none' },
    { ticker: 'INFY', sector: 'Information Technology', relativeMove: 0.015, tier: 'none' },
  ],
  'sector-outperformance'
);

printTest(
  'TEST 2 - Sector Underperformance',
  [
    { ticker: 'HDFCBANK', sector: 'Banking', relativeMove: -0.02, tier: 'none' },
    { ticker: 'ICICIBANK', sector: 'Banking', relativeMove: -0.015, tier: 'none' },
  ],
  'sector-underperformance'
);

printTest(
  'TEST 3 - Sector Divergence',
  [
    { ticker: 'HDFCBANK', sector: 'Banking', relativeMove: 0.02, tier: 'none' },
    { ticker: 'ICICIBANK', sector: 'Banking', relativeMove: -0.02, tier: 'none' },
  ],
  'sector-divergence'
);

printTest(
  'TEST 4 - No Pattern Below Threshold',
  [
    { ticker: 'TCS', sector: 'Information Technology', relativeMove: 0.009, tier: 'none' },
    { ticker: 'INFY', sector: 'Information Technology', relativeMove: -0.009, tier: 'none' },
  ]
);

console.log('\nAll sector pattern tests passed.');
