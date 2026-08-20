# RISEx integration spec

This spec captures the RISEx API facts this bot relies on, so trading work is reviewed against documentation instead of memory.

## Source of truth

| Source | URL |
|---|---|
| RISE RISEx docs | https://docs.risechain.com/docs/risex |
| RISEx API reference | https://developer.rise.trade/reference/general-information |
| RISE LLM docs bundle | https://docs.risechain.com/llms-full.txt |

## Bot scope

| Capability | Current state | Endpoint |
|---|---:|---|
| Markets | wired | `GET /v1/markets` |
| Orderbook / executable BBO | wired | `GET /v1/orderbook?market_id={marketId}&limit=1` |
| Cross-margin balance | wired | `GET /v1/account/cross-margin-balance?account={address}` |
| Positions | wired | `GET /v1/positions?account={address}` |
| Single position | wired | `GET /v1/account/position?account={address}&market_id={marketId}` |
| Open orders | wired | `GET /v1/orders/open?account={address}` |
| Place order | gated | `POST /v1/orders/place` |
| Cancel order | gated | `POST /v1/orders/cancel` |

## Auth and signing decisions

- Read methods require `RISEX_ACCOUNT_ADDRESS` where the endpoint is account-scoped.
- `GET /v1/markets` must not be used as a source of executable BBO on RISEx production payloads because it exposes `last_price` / `mark_price` / `index_price` but not bid/ask.
- Executable BBO is read from `GET /v1/orderbook` using the resolved `market_id`.
- The backend balance endpoint mirrors `GET /v1/account/cross-margin-balance` from RISEx and uses the production API base `https://api.rise.trade` by default.
- The backend authenticates RISEx REST balance reads with the official JWT login flow: `GET /v1/auth/nonce?account=...`, `GET /v1/auth/eip712-domain`, sign `Login(address account,uint256 nonce,uint32 deadline)` with `RISEX_ACCOUNT_PRIVATE_KEY`, then call `POST /v1/auth/login` with `account`, `nonce`, `deadline`, and `signature`, and send `Authorization: Bearer <access_token>`.
- Trading remains disabled unless `RISEX_TRADING_ENABLED=true`.
- Placing and closing trades requires a prebuilt signed permit. The bot must not invent or partially build a permit in production code.
- `RISEX_PRIVATE_KEY` is a secret and must never be logged.

## Operational constraints

| Constraint | Impact |
|---|---|
| RISEx API docs are marked work-in-progress | Re-check endpoints before enabling live trading. |
| Timestamps are nanoseconds unless the endpoint says otherwise | Do not reuse millisecond timestamps blindly. |
| REST rate limit is 500 requests / 10 seconds per IP | Avoid aggressive polling and add backoff around retries. |

## Implementation map

| File | Responsibility |
|---|---|
| `src/exchanges/risex/risex-client.ts` | High-level RISEx operations and trading gate. |
| `src/exchanges/risex/risex-http-client.ts` | Native `fetch` HTTP client, query handling, request timeout. |
| `src/exchanges/risex/risex-execution-adapter.ts` | Adapter exposed to bot commands/execution ports. |
| `src/exchanges/risex/risex.types.ts` | Request/response and enum shapes used by the adapter. |

## Before live trading

- [ ] Verify current `POST /v1/orders/place` and `POST /v1/orders/cancel` schemas against the official API reference.
- [ ] Implement and test EIP-712 permit signing on testnet.
- [ ] Confirm market ID mapping from scanner symbol to RISEx `market_id`.
- [ ] Add a Telegram confirmation step before sending any order.
- [ ] Keep `RISEX_TRADING_ENABLED=false` until testnet order open/close is verified end-to-end.

## RISEx Trading Fees

RISEx uses a fee system based on each account's **rolling 14-day trading volume**.

The system must determine the user's current fee tier based on the total trading volume generated during the previous 14 days.

## Fee Tiers

| Tier   | 14-Day Trading Volume | Taker Fee | Maker Fee |
| ------ | --------------------: | --------: | --------: |
| Tier 1 |                    $0 |  3.00 bps |  1.00 bps |
| Tier 2 |            $5,000,000 |  2.50 bps |  0.75 bps |
| Tier 3 |           $25,000,000 |  2.10 bps |  0.50 bps |
| Tier 4 |          $100,000,000 |  1.70 bps |  0.25 bps |
| Tier 5 |          $500,000,000 |  1.55 bps |  0.00 bps |
| Tier 6 |        $1,000,000,000 |  1.50 bps |  0.00 bps |

## Tier Calculation

The fee tier must be selected using the highest threshold reached by the user's rolling 14-day trading volume.

```text
volume >= 1,000,000,000 -> Tier 6
volume >=   500,000,000 -> Tier 5
volume >=   100,000,000 -> Tier 4
volume >=    25,000,000 -> Tier 3
volume >=     5,000,000 -> Tier 2
otherwise                -> Tier 1
```

The volume used for tier calculation is:

```text
rollingVolume = trading volume generated during the previous 14 days
```

The user's tier may increase or decrease automatically as older trades leave the rolling 14-day window.

## Fee Calculation

Fees are expressed in **basis points (bps)**.

```text
1 bps = 0.01%
1 bps = 0.0001
```

The fee for an executed trade is calculated as:

```text
fee = tradeNotional * (feeBps / 10_000)
```

### Taker Example

For a `$100,000` taker trade at Tier 1:

```text
feeBps = 3.00

fee = 100000 * (3 / 10000)
fee = $30
```

### Maker Example

For a `$100,000` maker trade at Tier 1:

```text
feeBps = 1.00

fee = 100000 * (1 / 10000)
fee = $10
```

## Maker vs Taker

The applicable fee depends on how the order is executed:

```text
Maker execution -> makerFeeBps
Taker execution -> takerFeeBps
```

Fees should be calculated at the **fill level**.

If an order produces multiple fills, each fill should use the correct fee depending on whether that specific execution was maker or taker.

## Market Makers

RISEx currently does **not provide a general maker rebate program**.

Users who intend to operate as market makers may request a **fee tier trial**.

The request can be submitted through a support ticket in the RISEx Discord server.

## Implementation Requirements

The RISEx integration should:

1. Obtain or track the user's rolling 14-day trading volume.
2. Determine the corresponding fee tier.
3. Distinguish between `maker` and `taker` executions.
4. Apply the correct fee according to the current tier and execution type.
5. Calculate fees based on the executed trade notional.
6. Calculate fees independently for each fill.
7. Allow the user's fee tier to change as the rolling 14-day volume changes.
8. Do not assume any maker rebates.
9. Support `0 bps` maker fees for Tier 5 and Tier 6.

## Suggested Data Model

```ts
interface RiseXFeeTier {
  tier: number;
  min14DayVolume: number;
  takerFeeBps: number;
  makerFeeBps: number;
}
```

## Fee Tier Configuration

```ts
const RISEX_FEE_TIERS: RiseXFeeTier[] = [
  {
    tier: 1,
    min14DayVolume: 0,
    takerFeeBps: 3.0,
    makerFeeBps: 1.0,
  },
  {
    tier: 2,
    min14DayVolume: 5_000_000,
    takerFeeBps: 2.5,
    makerFeeBps: 0.75,
  },
  {
    tier: 3,
    min14DayVolume: 25_000_000,
    takerFeeBps: 2.1,
    makerFeeBps: 0.5,
  },
  {
    tier: 4,
    min14DayVolume: 100_000_000,
    takerFeeBps: 1.7,
    makerFeeBps: 0.25,
  },
  {
    tier: 5,
    min14DayVolume: 500_000_000,
    takerFeeBps: 1.55,
    makerFeeBps: 0,
  },
  {
    tier: 6,
    min14DayVolume: 1_000_000_000,
    takerFeeBps: 1.5,
    makerFeeBps: 0,
  },
];
```

## Fee Tier Resolution

```ts
function getRiseXFeeTier(volume14d: number): RiseXFeeTier {
  return [...RISEX_FEE_TIERS]
    .reverse()
    .find((tier) => volume14d >= tier.min14DayVolume)!;
}
```

## Trading Fee Calculation

```ts
function calculateTradingFee(
  notional: number,
  feeBps: number
): number {
  return notional * (feeBps / 10_000);
}
```

## Execution Fee Helper

```ts
type ExecutionType = 'maker' | 'taker';

function calculateRiseXExecutionFee(
  notional: number,
  executionType: ExecutionType,
  volume14d: number
): number {
  const tier = getRiseXFeeTier(volume14d);

  const feeBps =
    executionType === 'maker'
      ? tier.makerFeeBps
      : tier.takerFeeBps;

  return calculateTradingFee(notional, feeBps);
}
```

## Example

For a user with `$30,000,000` of rolling 14-day volume:

```text
Current Tier: Tier 3

Maker Fee: 0.50 bps
Taker Fee: 2.10 bps
```

For a `$50,000` taker fill:

```text
fee = 50000 * (2.10 / 10000)

fee = $10.50
```

For a `$50,000` maker fill:

```text
fee = 50000 * (0.50 / 10000)

fee = $2.50
```

## Important Notes

* Fee tiers are based on **rolling 14-day trading volume**.
* Tier thresholds should be treated as minimum volume requirements.
* The highest eligible tier must always be selected.
* Fees are applied to executed notional, not order size.
* Partially filled orders should only incur fees on the filled amount.
* Maker and taker fees may differ significantly.
* Tier 5 and Tier 6 have `0 bps` maker fees.
* No general maker rebate should be assumed.
* Fee configuration should remain centralized so future RISEx fee changes can be updated easily.
