import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAddress,
  formatAddress,
  parseRange,
  compareAddresses,
} from './cell-address.js';

test('parseAddress parses a single-letter column and row', () => {
  assert.deepEqual(parseAddress('A1'), { column: 1, row: 1 });
});

test('parseAddress parses multi-letter columns', () => {
  assert.deepEqual(parseAddress('AA10'), { column: 27, row: 10 });
});

test('parseAddress rejects malformed addresses', () => {
  assert.throws(() => parseAddress('1A'), Error);
});

test('formatAddress formats numeric coordinates', () => {
  assert.equal(formatAddress(27, 10), 'AA10');
});

test('formatAddress rejects invalid coordinates', () => {
  assert.throws(() => formatAddress(0, 1), Error);
  assert.throws(() => formatAddress(1, 0), Error);
  assert.throws(() => formatAddress(-1, 1), Error);
  assert.throws(() => formatAddress(1.5, 1), Error);
});

test('parseRange parses a rectangular range', () => {
  assert.deepEqual(parseRange('B2:D4'), {
    start: { column: 2, row: 2 },
    end: { column: 4, row: 4 },
  });
});

test('parseRange rejects malformed ranges', () => {
  assert.throws(() => parseRange('B2:'), Error);
  assert.throws(() => parseRange(':D4'), Error);
});

test('compareAddresses compares in row-then-column order', () => {
  assert.ok(compareAddresses({ column: 1, row: 1 }, { column: 3, row: 2 }) < 0);
  assert.ok(compareAddresses({ column: 3, row: 2 }, { column: 1, row: 1 }) > 0);
  assert.equal(compareAddresses({ column: 2, row: 3 }, { column: 2, row: 3 }), 0);
  assert.ok(compareAddresses({ column: 1, row: 3 }, { column: 2, row: 3 }) < 0);
});
