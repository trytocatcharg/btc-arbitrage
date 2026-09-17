import assert from "node:assert/strict";
import test from "node:test";
import { RisexHttpClient } from "../src/exchanges/risex/risex-http-client.js";

test("RISEx HTTP client parses JSON responses", async () => {
  const client = new RisexHttpClient(
    "https://example.test",
    async () =>
      new Response(JSON.stringify({ data: { ok: true } }), { status: 200 }),
  );

  const payload = await client.get("/v1/markets");
  assert.deepEqual(payload, { data: { ok: true } });
});
