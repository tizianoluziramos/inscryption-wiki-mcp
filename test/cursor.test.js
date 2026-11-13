import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeCursor, encodeCursor } from '../src/utils/cursor.js';

test('continuation tokens survive URLs and Unicode', () => {
  const cursor = { continue: '-||', apcontinue: '鳳凰/Act 2' };
  assert.deepEqual(decodeCursor(encodeCursor(cursor)), cursor);
});

test('rejects unknown continuation keys', () => {
  const malicious = Buffer.from(JSON.stringify({ action: 'delete' })).toString('base64url');
  assert.throws(() => decodeCursor(malicious), /Invalid continuation token field/);
});

test('accepts empty tokens', () => {
  assert.deepEqual(decodeCursor(null), {});
  assert.equal(encodeCursor(null), null);
});
