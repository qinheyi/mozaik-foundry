import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  columnToIndex,
  indexToColumn,
  parseAddress,
  formatAddress,
} from './cell-address.js';

test('columnToIndex converts the first and last single-letter columns', () => {
  assert.equal(columnToIndex('A'), 0);
  assert.equal(columnToIndex('Z'), 25);
});

test('columnToIndex converts a multi-letter column label', () => {
  assert.equal(columnToIndex('AA'), 26);
});

test('columnToIndex throws for empty or invalid column labels', () => {
  assert.throws(() => columnToIndex(''), Error);
  assert.throws(() => columnToIndex('A1'), Error);
  assert.throws(() => columnToIndex('!'), Error);
});

test('indexToColumn converts zero-based indices to canonical column labels', () => {
  assert.equal(indexToColumn(0), 'A');
  assert.equal(indexToColumn(25), 'Z');
  assert.equal(indexToColumn(26), 'AA');
});

test('indexToColumn throws for negative or non-integer indices', () => {
  assert.throws(() => indexToColumn(-1), Error);
  assert.throws(() => indexToColumn(1.5), Error);
});

test('parseAddress converts spreadsheet addresses to zero-based indices', () => {
  assert.deepEqual(parseAddress('A1'), { row: 0, column: 0 });
  assert.deepEqual(parseAddress('AA10'), { row: 9, column: 26 });
});

test('parseAddress throws for malformed addresses', () => {
  assert.throws(() => parseAddress(''), Error);
  assert.throws(() => parseAddress('1'), Error);
  assert.throws(() => parseAddress('A'), Error);
  assert.throws(() => parseAddress('1A'), Error);
  assert.throws(() => parseAddress('A0'), Error);
  assert.throws(() => parseAddress('!1'), Error);
});

test('formatAddress formats zero-based indices as canonical addresses', () => {
  assert.equal(formatAddress(0, 0), 'A1');
  assert.equal(formatAddress(9, 26), 'AA10');
});

test('formatAddress throws for negative or non-integer indices', () => {
  assert.throws(() => formatAddress(-1, 0), Error);
  assert.throws(() => formatAddress(0, -1), Error);
  assert.throws(() => formatAddress(1.5, 0), Error);
  assert.throws(() => formatAddress(0, 1.5), Error);
});
