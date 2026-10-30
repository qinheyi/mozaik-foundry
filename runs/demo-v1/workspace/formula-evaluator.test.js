import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateFormula, evaluateRange } from './formula-evaluator.js';
import { parseFormula } from './formula-parser.js';

function contextWithCells(cells = {}, rangeValues = []) {
  return {
    getCell(row, column) {
      return cells[`${row}:${column}`];
    },
    getRange(start, end) {
      return rangeValues;
    },
  };
}

test('evaluates arithmetic according to operator precedence', () => {
  assert.equal(
    evaluateFormula(parseFormula('=1+2*3'), contextWithCells()),
    7,
  );
});

test('returns #DIV/0 when dividing by zero', () => {
  assert.equal(
    evaluateFormula(parseFormula('=A1/0'), contextWithCells()),
    '#DIV/0',
  );
});

test('evaluates SUM over an expanded range', () => {
  const context = contextWithCells({}, [1, 2, 3, 4]);

  assert.equal(
    evaluateFormula(parseFormula('=SUM(A1:B2)'), context),
    10,
  );
});

test('evaluates AVG over an expanded range', () => {
  const context = contextWithCells({}, [1, 2, 3, 4]);

  assert.equal(
    evaluateFormula(parseFormula('=AVG(A1:B2)'), context),
    2.5,
  );
});

test('treats empty cells as zero in arithmetic', () => {
  const context = contextWithCells({ '0:0': undefined });

  assert.equal(
    evaluateFormula(parseFormula('=A1+2'), context),
    2,
  );
});

test('propagates existing #DIV/0 and #CYCLE cell values', () => {
  const divContext = contextWithCells({ '0:0': '#DIV/0' });
  const cycleContext = contextWithCells({ '0:0': '#CYCLE' });

  assert.equal(
    evaluateFormula(parseFormula('=A1+1'), divContext),
    '#DIV/0',
  );
  assert.equal(
    evaluateFormula(parseFormula('=A1+1'), cycleContext),
    '#CYCLE',
  );
});

test('expands range nodes through evaluateRange', () => {
  const context = contextWithCells({}, [1, 2, 3, 4]);

  assert.deepEqual(
    evaluateRange(parseFormula('=SUM(A1:B2)').range, context),
    [1, 2, 3, 4],
  );
});
