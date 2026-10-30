import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCsv, fromCsv } from './csv-codec.js';

test('toCsv encodes rows while preserving formula strings', () => {
  assert.equal(
    toCsv([['=A1+1', 'hello'], [2, 'x']]),
    '=A1+1,hello\n2,x',
  );
});

test('toCsv rejects ragged rows', () => {
  assert.throws(
    () => toCsv([['a', 'b'], ['c']]),
    Error,
  );
});

test('toCsv rejects unsupported cell values', () => {
  assert.throws(
    () => toCsv([['ok', true]]),
    Error,
  );
  assert.throws(
    () => toCsv([['ok', null]]),
    Error,
  );
});

test('fromCsv parses unquoted fields', () => {
  assert.deepEqual(
    fromCsv('a,b\n1,2'),
    [['a', 'b'], ['1', '2']],
  );
});

test('fromCsv parses quoted fields containing commas and escaped quotes', () => {
  assert.deepEqual(
    fromCsv('"a,b",c'),
    [['a,b', 'c']],
  );
  assert.deepEqual(
    fromCsv('"a""b",c'),
    [['a"b', 'c']],
  );
});

test('fromCsv parses embedded newlines and CRLF or LF line endings', () => {
  assert.deepEqual(
    fromCsv('"a\nb",c\r\nd,e'),
    [['a\nb', 'c'], ['d', 'e']],
  );
  assert.deepEqual(
    fromCsv('"a\nb",c\nd,e'),
    [['a\nb', 'c'], ['d', 'e']],
  );
});

test('fromCsv rejects malformed quoting', () => {
  assert.throws(
    () => fromCsv('"unterminated,a'),
    Error,
  );
  assert.throws(
    () => fromCsv('a,"b"c'),
    Error,
  );
});
