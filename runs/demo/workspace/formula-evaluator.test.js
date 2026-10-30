import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, collectDependencies, normalizeRange } from './formula-evaluator.js';
import { parse } from './formula-parser.js';

test('evaluates arithmetic with standard operator precedence', () => {
  assert.equal(evaluate(parse('1+2*3'), () => 0), 7);
});

test('evaluates cell references using the cell-value provider', () => {
  const readCell = address => (address === 'A1' ? 2 : 3);

  assert.equal(evaluate(parse('A1+B1'), readCell), 5);
});

test('returns a division-by-zero error record', () => {
  const readCell = address => (address === 'A1' ? 1 : 0);

  assert.deepEqual(evaluate(parse('A1/A2'), readCell), {
    type: 'error',
    value: '#DIV/0',
  });
});

test('SUM evaluates every cell in a range', () => {
  const readCell = address => {
    if (address === 'A1') return 1;
    if (address === 'B2') return 4;
    return 0;
  };

  assert.equal(evaluate(parse('SUM(A1:B2)'), readCell), 5);
});

test('collectDependencies returns unique references in first-occurrence order', () => {
  assert.deepEqual(collectDependencies(parse('A1+B1+A1')), ['A1', 'B1']);
});

test('normalizeRange returns addresses in row-major order', () => {
  assert.deepEqual(normalizeRange('B2', 'D4'), [
    'B2', 'C2', 'D2',
    'B3', 'C3', 'D3',
    'B4', 'C4', 'D4',
  ]);
});

test('normalizeRange throws for malformed range endpoints', () => {
  assert.throws(() => normalizeRange('not-an-address', 'B2'));
  assert.throws(() => normalizeRange('A1', 'not-an-address'));
});
