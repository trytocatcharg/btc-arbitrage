# Exchange specs

These specs are the local operating contract for each exchange integration. They do not replace official docs; they pin the decisions this bot currently relies on.

| Exchange | Spec | Official docs |
|---|---|---|
| RISEx | [risex.md](./risex.md) | https://docs.risechain.com/docs/risex |
| Extended | [extended.md](./extended.md) | https://api.docs.extended.exchange/#extended-api-documentation |
| Arcus | [arcus.md](./arcus.md) | https://docs.arcus.xyz/ |

Before enabling live trading, update the relevant spec first, then update the adapter.

Testing policy: by explicit user instruction on August 16, 2026, unit-test work is paused. Do not add or expand unit tests in this repo until the user says otherwise.
