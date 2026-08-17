---
updatedAt: 2026-08-07T09:38:42.000Z
---

Fetch the complete documentation index at: https://developer.rise.trade/llms.txt. Use this file to discover all available pages before exploring further.

# Integration

This document describes how to integrate with the RISEx API integration. All signatures use [EIP-712](https://eips.ethereum.org/EIPS/eip-712) typed data signing.

This guide shows how to trade on RISEx directly over REST, without the `risex-client` SDK. Every struct, address rule and byte layout below is checked against the **mainnet** contracts, not against our own SDK — see [Verification](#verification) at the bottom.

## Bot support status

Implemented in `apps/bot/src/exchanges/risex/risex-execution-adapter.ts` and covered by `apps/bot/test/risex-execution-adapter.test.ts`:
- `GET /v1/markets`
- `GET /v1/auth/eip712-domain`
- `GET /v1/system/config`
- `GET /v1/nonce-state/{account}`
- `GET /v1/orders/open`
- `GET /v1/account/cross-margin-balance`
- `GET /v1/account/position`
- `POST /v1/account/leverage`
- `POST /v1/orders/place`
- `POST /v1/orders/cancel`

Known limitation: the official REST documentation mirrored here does **not** document native TP/SL trigger endpoints. The bot refuses to invent them and fails closed for RISEx `take-profit-market` / `stop-market` requests.

## TP/SL endpoints

Additional official documentation exists for off-chain trigger orders:
- Place TP/SL order: `POST /v1/orders/tpsl`
- Get TP/SL orders: `GET /v1/orders/tpsl`
- Cancel TP/SL order: `POST /v1/orders/tpsl/cancel`

Key documented behavior from the official API reference:
- TP/SL orders are stored off-chain and executed on-chain once the stop condition is met.
- `TAKE_PROFIT` triggers favorably; `STOP_LOSS` triggers unfavorably.
- `MARK_PRICE` and `LAST_TRADED_PRICE` are supported trigger price sources.
- Placement uses EIP-712 `PlaceTpslOrder`.
- Cancellation uses EIP-712 `CancelTpslOrder`.

Implementation status in this repo remains **blocked pending signature verification details**. The current public reference page mixes string enum request bodies (`BUY`, `SELL`, `TAKE_PROFIT`, `MARKET`, `IOC`, etc.) with a typed-signature field list documented as `uint8` values. Until those enum-to-integer encodings are verified from an official SDK/example or a successful testnet fixture, runtime code must not guess them.

If you would rather not sign anything yourself, use [`risex-client`](https://developer.rise.trade/reference/javascripttypescript) instead; it implements everything on this page.

## Overview

RISEx separates the wallet that holds your funds from the key that signs your orders:

* **Account** — your main wallet. Holds collateral and positions. Signs only during setup.
* **Signer** (session key) — a hot key registered on-chain against your account. Signs every order.

There are two ways to authorise a trading action, and they are independent:

| Path                              | What you send                                           | Setup needed                                                      |
| --------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------- |
| **Permit** (recommended for bots) | A per-action EIP-712 signature from the signer          | Register a signer                                                 |
| **JWT**                           | `Authorization: Bearer` header, no per-action signature | Register a signer **and** grant an on-chain OperatorHub allowance |

The permit path is fully self-contained and is what the rest of this page documents. See [Trading with a JWT](#trading-with-a-jwt) for the other one.

The server never holds your private key. It builds the on-chain payload from your signature and pays the gas.

## Before you start

Three endpoints supply everything you need. **Fetch them at runtime — do not hardcode addresses.** They differ per environment and change on redeploys.

```
GET /v1/auth/eip712-domain     -> EIP-712 domain for every signature on this page
GET /v1/system/config          -> contract addresses, incl. the permit `target`
GET /v1/nonce-state/{account}  -> your current nonce anchor and bitmap index
```

Base URLs:

| Environment | REST                             | WebSocket                        |
| ----------- | -------------------------------- | -------------------------------- |
| Mainnet     | `https://api.rise.trade`         | `wss://ws.rise.trade/ws`         |
| Testnet     | `https://api.testnet.rise.trade` | `wss://ws.testnet.rise.trade/ws` |

**Your account must be registered on-chain before it can trade.** Registration happens on your first collateral deposit. Until then every order fails with `FailedPrecondition: account <addr> is not registered (userId 0)`. The registry is fed by chain events, so for a few seconds after the deposit lands you may still see that error — retry, it is not a signing problem.

On mainnet you register by depositing collateral. On testnet there is a faucet that does both:

```json
POST /v1/account/deposit
{ "account": "0x...", "amount": "1000" }
```

Non-bot wallets get exactly 1000 USDC, once.

## EIP-712 domain

Every signature on this page — setup, permits, login, WebSocket auth — uses the same domain:

```json
GET /v1/auth/eip712-domain
{
  "data": {
    "name": "RISEx",
    "version": "1",
    "chain_id": "4153",
    "verifying_contract": "0x0D919DAA3f12AE715744Eb648c00066c5DBd66f0"
  }
}
```

`verifying_contract` is the **Authorization** contract (`addresses.auth` in `/v1/system/config`). It is *not* the router, and *not* the contract you put in the permit's `target` field. Those are different addresses with different jobs:

| Address            | Role                               |
| ------------------ | ---------------------------------- |
| `addresses.auth`   | EIP-712 domain `verifyingContract` |
| `addresses.router` | permit `target` field              |

## Nonces

Signatures are replay-protected by an **anchor + bitmap** scheme, not a counter.

* `nonceAnchor` — a `uint48` slot number.
* `nonceBitmap` — the bit index inside that anchor, **0 to 207 inclusive**.

Each `(anchor, bitIndex)` pair may be consumed once. Read your current state with:

```json
GET /v1/nonce-state/0xYourAccount
{ "data": { "nonce_anchor": "0", "current_bitmap_index": 0, "bitmap": "0" } }
```

Two rules that cause most nonce bugs:

1. **Sign with `nonce_anchor + 1` and start at bit 0.** The contract accepts the current anchor or the current anchor + 1; starting a fresh anchor guarantees you cannot collide with a permit already in flight. Bitmap gaps are harmless.
2. **`nonceBitmap` maxes out at 207, not 255.** The field is a `uint8`, but 208 and above revert:

```
FailedPrecondition: PlaceOrder reverted: InvalidNonceIndex(uint8) => (208)
```

When you reach 208, move to the next anchor and reset the index to 0.

A wrong anchor reverts with `InvalidNonceAnchor`. That error almost always means the value you *signed* and the value you *sent* differ — not that your nonce tracking is broken.

## Register a signer

Two signatures: the account authorises the signer, the signer proves consent. Both use the domain above and the **same** `nonceAnchor` / `nonceBitmap`.

**1. The account signs `RegisterSigner`:**

```
RegisterSigner(address account,address signer,string message,uint32 expiration,uint48 nonceAnchor,uint8 nonceBitmap)
```

**2. The signer signs `VerifySigner`:**

```
VerifySigner(address account,uint48 nonceAnchor,uint8 nonceBitmap)
```

Then submit both:

```json
POST /v1/auth/register-signer
{
  "account": "0x...",
  "signer": "0x...",
  "message": "RISEx session key",
  "expiration": "1788700000",
  "nonce_anchor": "1",
  "nonce_bitmap_index": 0,
  "account_signature": "0x...",
  "signer_signature": "0x..."
}
```

`account_signature` and `signer_signature` are **0x-prefixed hex** (65 bytes, r+s+v). This differs from `permit.signature` on the trading endpoints — see [Signature encoding](#signature-encoding).

The call is idempotent: if the signer is already active it returns `success: true` with an empty `transaction_hash`. Confirm with:

```
GET /v1/auth/session-key-status?account=0x...&signer=0x...
-> { "data": { "status": 1, "status_description": "Active" } }
```

Status `1` is Active, `3` is Revoked.

### Revoke a signer

Signed by the account only. Note there are **no spaces** in the type string — an EIP-712 type string is hashed literally, so a stray space produces a different typehash and the signature will not recover.

```
RevokeSigner(address account,address signer,uint48 nonceAnchor,uint8 nonceBitmap)
```

```json
POST /v1/auth/revoke-signer
{ "account": "0x...", "signer": "0x...", "nonce_anchor": "1",
  "nonce_bitmap_index": 5, "account_signature": "0x..." }
```

## Signing an action: the permit

Every trading action is signed the same way. You build an **action hash** for the specific action, then wrap it in one permit struct:

```
VerifyWitness(address account,address target,bytes32 hash,uint48 nonceAnchor,uint8 nonceBitmap,uint32 deadline)
```

| Field                         | Value                                                     |
| ----------------------------- | --------------------------------------------------------- |
| `account`                     | your main account (not the signer)                        |
| `target`                      | `addresses.router` from `GET /v1/system/config`           |
| `hash`                        | the action hash for this specific action                  |
| `nonceAnchor` / `nonceBitmap` | the pair you are consuming                                |
| `deadline`                    | `uint32` unix seconds; the server rejects expired permits |

It is ordinary EIP-712 typed data — `signTypedData` in ethers/viem, `eth_account.sign_typed_data` in Python. Sign it with the **signer** key.

> **`target` must be the router.** Not the OrdersManager, not your account, not the domain's `verifyingContract`. Signing against the wrong target still produces a valid signature, so it recovers *some* address — a different one every time — and fails with:
>
> ```
> FailedPrecondition: PlaceOrder reverted: SignerNotAuthorized(address) => (0xf1eeb62342c4c9C232DDBA6A0A600E7fD620beFe)
> ```
>
> The address in that error is meaningless garbage. If you see it, check `target` before you touch anything else.

### Signature encoding

`permit.signature` is a protobuf `bytes` field, so over REST/JSON it is **base64**, not hex. Two formats are accepted:

* 64-byte EIP-2098 compact: `r` (32 bytes) `|| yParityAndS` (32 bytes). Set the top bit of `s` when `v == 28`.
* 65-byte `r || s || v` — converted server-side.

```python
def compact(sig):                      # eth_account SignedMessage
    r = sig.r.to_bytes(32, "big")
    s = sig.s.to_bytes(32, "big")
    if sig.v == 28:
        s = bytes([s[0] | 0x80]) + s[1:]
    return base64.b64encode(r + s).decode()
```

To recap the two encodings on this page:

| Field                                                      | Encoding               |
| ---------------------------------------------------------- | ---------------------- |
| `account_signature`, `signer_signature`, login `signature` | `0x` hex, 65 bytes     |
| `permit.signature` / `permit_params.signature`             | base64, 64 or 65 bytes |

## Place an order

### Sizes and prices are integers, not decimals

Orders are quoted in **steps** and **ticks**, taken from the market config:

```
GET /v1/markets
-> config: { "step_size": "0.000001", "step_price": "0.1", "min_order_size": "0.00015" }

size_steps  = size  / step_size      # 0.0002 BTC  -> 200
price_ticks = price / step_price     # 55024.8     -> 550248
```

`size_steps` is a `uint32`; `price_ticks` is a **`uint24`** (max 16,777,215).

### Pack the order into a uint88

```
[87:70] marketId    (16 bits)
[69:38] sizeSteps   (32 bits)
[37:14] priceTicks  (24 bits)
[13:6]  orderFlags  (8 bits)
[5:1]   version     (5 bits, must be 1)
[0]     reserved    (1 bit)
```

`orderFlags`, bit by bit:

| Bit   | Meaning                               |
| ----- | ------------------------------------- |
| `0`   | side — 1 = Sell                       |
| `1`   | postOnly                              |
| `2`   | reduceOnly                            |
| `4:3` | stpMode                               |
| `5`   | orderType — **0 = Market, 1 = Limit** |
| `7:6` | timeInForce                           |

```python
def pack_order(market_id, size_steps, price_ticks, side, post_only,
               reduce_only, stp_mode, order_type, tif):
    flags = ((side & 1) | (post_only << 1) | (reduce_only << 2)
             | ((stp_mode & 3) << 3) | ((order_type & 1) << 5) | ((tif & 3) << 6))
    return ((market_id << 70) | (size_steps << 38) | (price_ticks << 14)
            | (flags << 6) | (1 << 1))
```

### Build the action hash

A separate **header flags** byte says which optional fields are present. Bit `0x01` (permit) is always set:

| Bit    | Set when                |
| ------ | ----------------------- |
| `0x01` | always (permit present) |
| `0x02` | `builder_id != 0`       |
| `0x04` | `client_order_id != 0`  |
| `0x10` | `ttl_units != 0`        |

```
actionHash = keccak256(abi.encode(
  keccak256("RISE_PERPS_PLACE_ORDER_V1"),  // bytes32 action selector
  uint8(headerFlags),
  uint88(orderData),
  uint16(builderId),
  uint16(builderFeeBps),   // ONLY when builder_fee_bps > 0 — omit this slot otherwise
  uint64(clientOrderId),
  uint16(ttlUnits)))
```

Every operand is left-padded to a full 32-byte word, exactly as `abi.encode` does.

### Submit

```json
POST /v1/orders/place
{
  "market_id": 1,
  "size_steps": 200,
  "price_ticks": 550248,
  "side": 0,
  "post_only": true,
  "reduce_only": false,
  "stp_mode": 0,
  "order_type": 1,
  "time_in_force": 0,
  "permit": {
    "account": "0x...",
    "signer": "0x...",
    "nonce_anchor": "1",
    "nonce_bitmap_index": 1,
    "deadline": 1786097000,
    "signature": "base64..."
  }
}
```

The values in `permit` must match the ones you signed, and the top-level order fields must match the ones you packed into `orderData`. Any mismatch changes the hash and the signature will not recover.

### Enums

| Field           | Values                                           |
| --------------- | ------------------------------------------------ |
| `side`          | 0 = Buy, 1 = Sell                                |
| `order_type`    | **0 = Market, 1 = Limit**                        |
| `time_in_force` | 0 = GTC, 1 = GTT, 2 = FOK, 3 = IOC               |
| `stp_mode`      | 0 = ExpireMaker, 1 = ExpireTaker, 2 = ExpireBoth |

**Market orders must use FOK or IOC.** A market order with GTC is rejected:

```
InvalidArgument: market orders require FOK or IOC time_in_force, got 0
```

For a market order, `price_ticks` still matters — it is the slippage bound the order will not cross.

## Cancel an order

The action hash commits to `resting_order_id`, **not** the `order_id` string you send in the body. Read it from `GET /v1/orders/open`; it equals `wide_order_id >> 1`.

```
actionHash = keccak256(abi.encode(
  keccak256("RISE_PERPS_CANCEL_ORDER_V1"),
  uint256(marketId),
  uint256(restingOrderId)))
```

```json
POST /v1/orders/cancel
{ "market_id": 1, "order_id": "0x0000...000f", "permit": { ... } }
```

To cancel everything in a market, use `POST /v1/orders/cancel-all` with the selector `RISE_PERPS_CANCEL_ALL_ORDERS_V1`.

## Leverage and margin

Same permit, different action hash — and note these three endpoints name the field **`permit_params`**, not `permit`.

| Endpoint                           | Action hash                                                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `POST /v1/account/leverage`        | `keccak256(abi.encode(keccak256("RISE_PERPS_UPDATE_LEVERAGE_V1"), uint16(marketId), uint8(leverage)))`       |
| `POST /v1/account/margin-mode`     | `keccak256(abi.encode(keccak256("RISE_PERPS_UPDATE_MARGIN_MODE_V1"), uint16(marketId), uint8(marginMode)))`  |
| `POST /v1/account/isolated-margin` | `keccak256(abi.encode(keccak256("RISE_PERPS_UPDATE_ISOLATED_MARGIN_V1"), uint16(marketId), int128(amount)))` |

```json
POST /v1/account/leverage
{ "market_id": "1", "leverage": "10", "permit_params": { ... } }
```

`margin_mode` is 0 = Cross, 1 = Isolated. Switching margin mode while a position is open reverts with `OpenPositionExists(int256)` — close the position first.

## Trading with a JWT

A JWT lets you skip per-order signing: send `Authorization: Bearer <token>` and omit `permit` entirely.

**Mint a token** — the nonce is a hex string from the server, signed as a `uint256`:

```
GET /v1/auth/nonce?account=0x...   ->  { "nonce": "a1b2c3..." }
```

```
Login(address account,uint256 nonce,uint32 deadline)
```

```json
POST /v1/auth/login
{ "account": "0x...", "nonce": "a1b2c3...", "deadline": 1786093897, "signature": "0x..." }
```

Sign it with the **account** key. The nonce is single-use and expires after 5 minutes.

**A JWT alone is not enough to trade.** JWT orders execute against your on-chain OperatorHub allowance, which the login flow does not create. Without it, orders fail:

```
FailedPrecondition: PlaceOrder reverted: AllowanceExpired(address,address)
  => (0xYourAccount, 0xf665aBa90b6Ac7515d50b12FCB4f350136726734)
```

Grant the allowance once via `POST /v1/auth/approve-single` (or from the web app), then JWT orders work until the budget or expiry runs out. The permit path has no such dependency, which is why it is the better default for bots.

## WebSocket

Public channels need no authentication:

```json
{"method": "subscribe", "params": {"channel": "orderbook", "market_ids": [1]}}
```

Account-scoped channels (`orders`, `positions`, `fills`, `account`) need an `auth_v2` frame first — it pins the subscription to your account. Use a nonce from `GET /v1/auth/nonce` and this typed data, signed by the **signer**:

```
RegisterV2(address signer,string message,uint256 nonce)
```

```json
{"method": "auth_v2", "params": {"account": "0x...", "signer": "0x...",
 "message": "...", "nonce": "a1b2c3...", "signature": "0x..."}}
```

Full channel payloads: [WebSocket API](https://developer.rise.trade/reference/endpoints).

## Common errors

| Error                                                | Cause                                                                                           |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `SignerNotAuthorized(address)` with a random address | permit `target` is not the router, or a field mismatch between signed and submitted values      |
| `InvalidNonceAnchor`                                 | the anchor you signed differs from the one you sent, or it is more than current + 1             |
| `InvalidNonceIndex(uint8) => (208)`                  | bitmap index above 207 — roll to the next anchor                                                |
| `account ... is not registered (userId 0)`           | no collateral deposit yet, or the deposit has not been indexed                                  |
| `AllowanceExpired(address,address)`                  | JWT order without an OperatorHub allowance                                                      |
| `OpenPositionExists(int256)`                         | margin-mode switch with an open position                                                        |
| `market orders require FOK or IOC time_in_force`     | `order_type: 0` with GTC/GTT                                                                    |
| signature recovers the wrong address                 | a space in an EIP-712 type string, or `uint256` where the struct says `uint48`/`uint32`/`uint8` |

## Working example

End to end in Python (`pip install eth-account requests`): faucet, register, place, cancel.
It targets **testnet** so it can run start to finish on a throwaway wallet; every rule it
follows is the mainnet one. To point it at mainnet, change `API` and fund the account with a
real deposit instead of the faucet call.

```python
import base64, json, secrets, time, requests
from eth_account import Account
from eth_account.messages import encode_typed_data
from eth_utils import keccak, to_checksum_address

API = "https://api.testnet.rise.trade"
g = lambda p: requests.get(API + p, timeout=45).json()
p_ = lambda p, b: requests.post(API + p, json=b, timeout=45).json()

acct = Account.from_key("0x" + secrets.token_hex(32))
sgnr = Account.from_key("0x" + secrets.token_hex(32))

d = g("/v1/auth/eip712-domain")["data"]
DOMAIN = {"name": d["name"], "version": d["version"], "chainId": int(d["chain_id"]),
          "verifyingContract": to_checksum_address(d["verifying_contract"])}
ROUTER = to_checksum_address(g("/v1/system/config")["data"]["addresses"]["router"])
ED = [{"name": "name", "type": "string"}, {"name": "version", "type": "string"},
      {"name": "chainId", "type": "uint256"}, {"name": "verifyingContract", "type": "address"}]

p_("/v1/account/deposit", {"account": acct.address, "amount": "1000"})   # testnet faucet
ANCHOR = int(g(f"/v1/nonce-state/{acct.address}")["data"]["nonce_anchor"]) + 1

# --- register the signer -----------------------------------------------------
EXP = int(time.time()) + 30 * 86400
reg = {"types": {"EIP712Domain": ED, "RegisterSigner": [
           {"name": "account", "type": "address"}, {"name": "signer", "type": "address"},
           {"name": "message", "type": "string"}, {"name": "expiration", "type": "uint32"},
           {"name": "nonceAnchor", "type": "uint48"}, {"name": "nonceBitmap", "type": "uint8"}]},
       "primaryType": "RegisterSigner", "domain": DOMAIN,
       "message": {"account": acct.address, "signer": sgnr.address, "message": "RISEx session key",
                   "expiration": EXP, "nonceAnchor": ANCHOR, "nonceBitmap": 0}}
ver = {"types": {"EIP712Domain": ED, "VerifySigner": [
           {"name": "account", "type": "address"}, {"name": "nonceAnchor", "type": "uint48"},
           {"name": "nonceBitmap", "type": "uint8"}]},
       "primaryType": "VerifySigner", "domain": DOMAIN,
       "message": {"account": acct.address, "nonceAnchor": ANCHOR, "nonceBitmap": 0}}
print(p_("/v1/auth/register-signer", {
    "account": acct.address, "signer": sgnr.address, "message": "RISEx session key",
    "nonce_anchor": str(ANCHOR), "nonce_bitmap_index": 0, "expiration": str(EXP),
    "account_signature": "0x" + acct.sign_message(encode_typed_data(full_message=reg)).signature.hex().removeprefix("0x"),
    "signer_signature": "0x" + sgnr.sign_message(encode_typed_data(full_message=ver)).signature.hex().removeprefix("0x")}))

# --- permit helpers ----------------------------------------------------------
w = lambda v: int(v).to_bytes(32, "big")

def permit(action_hash, bit):
    dl = int(time.time()) + 3600
    td = {"types": {"EIP712Domain": ED, "VerifyWitness": [
              {"name": "account", "type": "address"}, {"name": "target", "type": "address"},
              {"name": "hash", "type": "bytes32"}, {"name": "nonceAnchor", "type": "uint48"},
              {"name": "nonceBitmap", "type": "uint8"}, {"name": "deadline", "type": "uint32"}]},
          "primaryType": "VerifyWitness", "domain": DOMAIN,
          "message": {"account": acct.address, "target": ROUTER, "hash": action_hash,
                      "nonceAnchor": ANCHOR, "nonceBitmap": bit, "deadline": dl}}
    s = sgnr.sign_message(encode_typed_data(full_message=td))
    r, ss = s.r.to_bytes(32, "big"), s.s.to_bytes(32, "big")
    if s.v == 28:
        ss = bytes([ss[0] | 0x80]) + ss[1:]
    return {"account": acct.address, "signer": sgnr.address, "nonce_anchor": str(ANCHOR),
            "nonce_bitmap_index": bit, "deadline": dl,
            "signature": base64.b64encode(r + ss).decode()}

# --- place a resting limit buy 15% below mark --------------------------------
m = next(x for x in g("/v1/markets")["data"]["markets"] if x["market_id"] == "1")
size_steps = 200                                            # 0.0002 BTC (mainnet min 0.00015)
price_ticks = int(float(m["mark_price"]) * 0.85 / float(m["config"]["step_price"]))
flags = (0 | (1 << 1) | (1 << 5) | (0 << 6))                # postOnly + Limit + GTC, Buy
order_data = (1 << 70) | (size_steps << 38) | (price_ticks << 14) | (flags << 6) | (1 << 1)
ah = keccak(keccak(b"RISE_PERPS_PLACE_ORDER_V1") + w(0x01) + w(order_data) + w(0) + w(0) + w(0))
res = p_("/v1/orders/place", {
    "market_id": 1, "size_steps": size_steps, "price_ticks": price_ticks, "side": 0,
    "post_only": True, "reduce_only": False, "stp_mode": 0, "order_type": 1,
    "time_in_force": 0, "permit": permit(ah, 1)})
order_id = res["data"]["order_id"]
print("placed", order_id)

# --- cancel it: the hash commits to resting_order_id, not order_id -----------
time.sleep(2)
o = next(x for x in g(f"/v1/orders/open?account={acct.address}&market_id=1")["data"]["orders"]
         if x["order_id"] == order_id)
ch = keccak(keccak(b"RISE_PERPS_CANCEL_ORDER_V1") + w(1) + w(int(o["resting_order_id"])))
print(p_("/v1/orders/cancel", {"market_id": 1, "order_id": order_id, "permit": permit(ch, 2)}))
```

## Verification

Every struct, address rule and constant on this page was checked directly against the
**mainnet** contracts on **2026-08-07**, read-only, plus an end-to-end run on testnet.

Typehashes read straight off the mainnet Authorization contract
(`0x0D919DAA3f12AE715744Eb648c00066c5DBd66f0`) match the type strings above exactly:

```
REGISTER_SIGNER_TYPEHASH()  0xa526f63b3968e56ae1b177ce9b3dc29766e0891e6397a9c23cf8c53ee8fc8f62
VERIFY_SIGNER_TYPEHASH()    0x4d298dcceb691695f582cc337308236426a0c97201a31834625e8eadc44d4230
REVOKE_SIGNER_TYPEHASH()    0x36db7f392f548b56f37d89469115d138685addf06be45684f9e5b0e8b5d28000
VERIFY_WITNESS_TYPEHASH()   0x055e6bcbf2ba5ff1c2ba5dc95b6648a5de6aaab3185251a34e3b88c11e116821
PERMIT_SINGLE_TYPEHASH()    0x0776297f41046e119f28b9bd380b653a8c632d5700a51311bc8fed061b1c00f1
```

The rest was proved by having the mainnet contracts recover a throwaway key from a permit
built purely from the rules on this page:

* The Authorization contract recovered exactly that key when `target` was the router, and
  unrelated addresses for every other `target` — it derives `target` from `msg.sender`.
* The router recovered exactly that key from a payload packed with the `uint88` layout,
  header-flags byte and action hash documented above. Corrupting the action hash or the
  flags byte broke recovery, as it should.
* `nonceBitmap` 207 passed the index check; 208 and 255 reverted `InvalidNonceIndex`.
* A used `(anchor, bit)` pair reverted `NonceUsed`, and `anchor + 1` was accepted — which is
  why this page tells you to start on a fresh anchor.

If something here does not match what the chain does, that is a bug — please report it and
we will fix the page.
