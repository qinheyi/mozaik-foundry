import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFormula } from './formula-parser.js';

test('parses multiplication with precedence', () => {
  assert.deepEqual(parseFormula('=1+2*3'), {
    type: 'binary',
    op: '+',
    left: { type: 'number', value: 1 },
    right: {
      type: 'binary',
      op: '*',
      left: { type: 'number', value: 2 },
      right: { type: 'number', value: 3 },
    },
  });
});

test('parses a cell reference using zero-based indices', () => {
  assert.deepEqual(parseFormula('=A1'), {
    type: 'cell',
    row: 0,
    column: 0,
  });

  assert.deepEqual(parseFormula('=AA10'), {
    type: 'cell',
    row: 9,
    column: 26,
  });
});

test('parses a SUM call with a range argument', () => {
  assert.deepEqual(parseFormula('=SUM(A1:B3)'), {
    type: 'call',
    name: 'SUM',
    range: {
      type: 'range',
      start: { row: 0, column: 0 },
      end: { row: 2, column: 1 },
    },
  });
});

test('supports the documented aggregate functions', () => {
  for (const name of ['SUM', 'AVG', 'MIN', 'MAX']) {
    assert.deepEqual(parseFormula(`=${name}(A1:B2)`), {
      type: 'call',
      name,
      range: {
        type: 'range',
        start: { row: 0, column: 0 },
        end: { row: 1, column: 1 },
      },
    });
  }
});

test('parses unary and binary arithmetic nodes', () => {
  assert.deepEqual(parseFormula('=-2'), {
    type: 'unary',
    op: '-',
    operand: { type: 'number', value: 2 },
  });

  assert.deepEqual(parseFormula('=+2-3'), {
    type: 'binary',
    op: '-',
    left: {
      type: 'unary',
      op: '+',
      operand: { type: 'number', value: 2 },
    },
    right: { type: 'number', value: 3 },
  });
});

test('rejects source that is not a formula', () => {
  assert.throws(() => parseFormula('1+2'), Error);
  assert.throws(() => parseFormula(''), Error);
});

test('rejects unknown tokens and unsupported functions', () => {
  assert.throws(() => parseFormula('=1 $ 2'), Error);
  assert.throws(() => parseFormula('=PRODUCT(A1:B2)'), Error);
});

test('rejects malformed references, ranges, and invalid syntax', () => {
  assert.throws(() => parseFormula('=A'), Error);
  assert.throws(() => parseFormula('=A1:B'), Error);
  assert.throws(() => parseFormula('=A1+'), Error);
});
