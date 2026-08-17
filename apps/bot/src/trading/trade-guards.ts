export function shouldSuppressSignalForActiveTrades(activeTradeIds: readonly number[]): boolean { return activeTradeIds.length > 0; }
export function shouldNotifyLegClosure(input: { positionClosed: boolean; alreadyNotified: boolean }): boolean { return input.positionClosed && !input.alreadyNotified; }
