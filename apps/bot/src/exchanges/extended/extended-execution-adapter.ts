export function assertExtendedTradingUnsupported(): never {
  throw new Error('Extended trade execution is intentionally not implemented in this slice. Use dry-run monitoring only.');
}
