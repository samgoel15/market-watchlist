const INDEX_SYMBOLS = Object.freeze({
  NIFTY: { providerSymbol: '^NSEI', name: 'Nifty 50', benchmarkSymbol: 'NIFTY50' },
  NIFTY50: { providerSymbol: '^NSEI', name: 'Nifty 50', benchmarkSymbol: 'NIFTY50' },
  NIFTYBANK: { providerSymbol: '^NSEBANK', name: 'Nifty Bank', benchmarkSymbol: 'NIFTYBANK' },
  NIFTYIT: { providerSymbol: '^CNXIT', name: 'Nifty IT', benchmarkSymbol: 'NIFTYIT' },
  NIFTYAUTO: { providerSymbol: '^CNXAUTO', name: 'Nifty Auto', benchmarkSymbol: 'NIFTYAUTO' },
  NIFTYFMCG: { providerSymbol: '^CNXFMCG', name: 'Nifty FMCG', benchmarkSymbol: 'NIFTYFMCG' },
  SENSEX: { providerSymbol: '^BSESN', name: 'BSE Sensex', benchmarkSymbol: 'NIFTY50' },
});

function normalizeSymbol(input) {
  if (typeof input !== 'string') return null;
  const normalized = input.trim().toUpperCase().replace(/\s+/g, '');
  const withoutNseSuffix = normalized.endsWith('.NS')
    ? normalized.slice(0, -3)
    : normalized;

  if (!/^[A-Z][A-Z0-9.-]{0,14}$/.test(withoutNseSuffix)) return null;
  return withoutNseSuffix;
}

function resolveSymbol(input) {
  const symbol = normalizeSymbol(input);
  if (!symbol) return null;

  const index = INDEX_SYMBOLS[symbol];
  return {
    symbol,
    providerSymbol: index?.providerSymbol ?? `${symbol}.NS`,
    suggestedName: index?.name ?? symbol,
    benchmarkSymbol: index?.benchmarkSymbol ?? 'NIFTY50',
    isIndex: Boolean(index),
  };
}

function providerSymbolFor(symbol) {
  return resolveSymbol(symbol)?.providerSymbol ?? `${symbol}.NS`;
}

module.exports = { INDEX_SYMBOLS, normalizeSymbol, resolveSymbol, providerSymbolFor };
