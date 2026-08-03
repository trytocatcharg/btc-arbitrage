import assert from 'node:assert/strict';
import test from 'node:test';
import { invariant } from '../src/index.js';

test('invariant throws on false conditions', () => {
  assert.throws(() => invariant(false, 'boom'), /boom/);
});
