export function assertRisexTradingUnsupported(): never {
  throw new Error('RISEx trade execution is intentionally not implemented in this slice. Use dry-run monitoring only.');
}
