import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, parse } from './formula-parser.js';

test('tokenize classifies numbers, identifiers, operators, and punctuation', () => {
  assert.deepEqual(tokenize('12+A1*(2,3):4'), [
    { type: 'number', value: 12 },
    { type: 'operator', value: '+' },
    { type: 'identifier', value: 'A1' },
    { type: 'operator', value: '*' },
    { type: 'lparen', value: '(' },
    { type: 'number', value: 2 },
    { type: 'comma', value: ',' },
    { type: 'number', value: 3 },
    { type: 'rparen', value: ')' },
    { type: 'colon', value: ':' },
    { type: 'number', value: 4 }
  ]);
});

test('tokenize throws on an unknown token', () => {
  assert.throws(() => tokenize('@'), Error);
});

test('parse gives multiplication higher precedence than addition', () => {
  const parsed = parse('1+2*3');

  assert.deepEqual(parsed, {
    type: 'expression',
    expression: {
      type: 'binary',
      operator: '+',
      left: { type: 'number', value: 1 },
      right: {
        type: 'binary',
        operator: '*',
        left: { type: 'number', value: 2 },
        right: { type: 'number', value: 3 }
      }
    }
  });
});

test('parse respects parentheses', () => {
  assert.deepEqual(parse('(1+2)*3'), {
    type: 'expression',
    expression: {
      type: 'binary',
      operator: '*',
      left: {
        type: 'binary',
        operator: '+',
        left: { type: 'number', value: 1 },
        right: { type: 'number', value: 2 }
      },
      right: { type: 'number', value: 3 }
    }
  });
});

test('parse produces a reference node for a cell address', () => {
  assert.deepEqual(parse('A1'), {
    type: 'expression',
    expression: { type: 'ref', address: 'A1' }
  });
});

test('parse produces a range argument inside a function call', () => {
  assert.deepEqual(parse('SUM(A1:B3)'), {
    type: 'expression',
    expression: {
      type: 'call',
      name: 'SUM',
      argument: { type: 'range', start: 'A1', end: 'B3' }
    }
  });
});

test('parse throws for an incomplete binary expression', () => {
  assert.throws(() => parse('A1 +'), Error);
});
