export enum Side {
  Long = 0,
  Short = 1
}

export enum OrderType {
  Market = 0,
  Limit = 1
}

export enum TimeInForce {
  GoodTillCancelled = 0,
  GoodTillTime = 1,
  FillOrKill = 2,
  ImmediateOrCancel = 3
}

export enum StpMode {
  ExpireMaker = 0,
  ExpireTaker = 1,
  ExpireBoth = 2,
  None = 3
}

export enum MarginMode {
  Cross = 0,
  Isolated = 1
}

export enum StopPriceOption {
  LastTradedPrice = 0,
  MarkPrice = 1
}

export enum TpSlStopType {
  TakeProfit = 0,
  StopLoss = 1
}
