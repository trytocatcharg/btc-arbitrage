import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JsonFileLogger } from '../src/logging/json-file-logger.js';
import { RisexHttpClient } from '../src/exchanges/risex/risex-http-client.js';

test('RISEx HTTP client writes JSONL response logs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'risex-http-log-'));
  const filePath = join(dir, 'risex-http.jsonl');
  const client = new RisexHttpClient('https://example.test', async () => new Response(JSON.stringify({ data: { ok: true } }), { status: 200 }), new JsonFileLogger(filePath));

  const payload = await client.get('/v1/markets');
  assert.deepEqual(payload, { data: { ok: true } });

  const lines = readFileSync(filePath, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]!);
  assert.equal(entry.event, 'risex_http_response');
  assert.equal(entry.method, 'GET');
  assert.equal(entry.path, '/v1/markets');
  assert.equal(entry.status, 200);
  assert.deepEqual(entry.body, { data: { ok: true } });
});
