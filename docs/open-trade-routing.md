# Open trade routing rule

This project must always route the entry legs with this priority:

1. **Choose the cheaper maker venue first**
2. If maker fees tie, **choose the cheaper taker venue**

Definitions:

- `maker` = limit order
- `taker` = market order

Because an arbitrage entry has only two exchanges, there are only two valid layouts:

1. maker on `longExchange`, taker on `shortExchange`
2. maker on `shortExchange`, taker on `longExchange`

The bot must compare those two layouts lexicographically:

```text
first: maker fee bps
second: taker fee bps
```

## Verified fee references

### Extended

Source: `docs/exchanges/extended.md`

- Maker: `0.000%` = `0 bps`
- Taker: `0.025%` = `2.5 bps`

### RISEx

Source: `docs/exchanges/risex.md`

RISEx depends on the account's rolling 14-day volume.

Tier 1 defaults:

- Maker: `1.00 bps`
- Taker: `3.00 bps`

Higher tiers reduce those values, and Tier 5/Tier 6 can reach `0 bps` maker.

## Configuration rule

- `RISEX_MAKER_FEE_BPS` and `RISEX_TAKER_FEE_BPS` must reflect the account's current RISEx tier.
- `EXTENDED_MAKER_FEE_BPS` and `EXTENDED_TAKER_FEE_BPS` should default to the documented Extended schedule unless Extended changes its fees.

## Worked example

Assume:

- RISEx BTC price = `$75,000`
- Extended BTC price = `$74,940`

Direction:

- `shortExchange = risex` because it has the higher sell price
- `longExchange = extended` because it is cheaper to buy there

Using the currently documented defaults:

- RISEx maker = `1 bps`
- RISEx taker = `3 bps`
- Extended maker = `0 bps`
- Extended taker = `2.5 bps`

Candidate layouts:

1. **Maker on Extended / Taker on RISEx**
   - maker fee = `0 bps`
   - taker fee = `3 bps`
2. **Maker on RISEx / Taker on Extended**
   - maker fee = `1 bps`
   - taker fee = `2.5 bps`

Chosen layout:

- **Limit buy on Extended** to open the long leg
- **Market sell on RISEx** to open the short leg

Why:

- The first layout wins immediately because `0 bps maker < 1 bps maker`
- Taker fee is only used as a tie-breaker, not as the first criterion
