import { test } from 'node:test';
import assert from 'node:assert/strict';
import Spreadsheet from './spreadsheet.js';

test('evaluates formulas and recalculates dependents after an input changes', () => {
  const sheet = new Spreadsheet();

  sheet.setCell('A1', 2);
  sheet.setCell('B1', '=A1*3');
  sheet.recalculate();

  assert.equal(sheet.getCell('B1'), 6);
  assert.deepEqual(sheet.getCellSource('B1'), {
    type: 'formula',
    source: '=A1*3',
  });

  sheet.setCell('A1', 5);
  sheet.recalculate();
  assert.equal(sheet.getCell('B1'), 15);
});

test('treats references to empty cells as zero', () => {
  const sheet = new Spreadsheet();

  sheet.setCell('A1', '=B2+4');
  sheet.recalculate();

  assert.equal(sheet.getCell('A1'), 4);
});

test('marks every cell in a circular reference as a cycle error', () => {
  const sheet = new Spreadsheet();

  sheet.setCell('A1', '=B1');
  sheet.setCell('B1', '=A1');
  sheet.recalculate();

  assert.deepEqual(sheet.getCell('A1'), { type: 'error', value: '#CYCLE' });
  assert.deepEqual(sheet.getCell('B1'), { type: 'error', value: '#CYCLE' });
});

test('tracks direct dependents without including transitive dependents', () => {
  const sheet = new Spreadsheet();

  sheet.setCell('A1', 1);
  sheet.setCell('B1', '=A1+1');
  sheet.setCell('C1', '=B1+1');

  assert.deepEqual(sheet.getDependencies('A1'), ['B1']);
  assert.deepEqual(sheet.getDependencies('B1'), ['C1']);
});

test('exports computed values as CSV', () => {
  const sheet = new Spreadsheet();

  sheet.setCell('A1', 1);
  sheet.setCell('B1', '=A1+1');
  sheet.recalculate();

  assert.match(sheet.toCSV(), /(^|\n)1,2(\n|$)/);
});

test('imports raw CSV values and formulas, then computes dependent cells', () => {
  const sheet = new Spreadsheet();

  sheet.fromCSV('1,=A1+1\n2,=B1*2');

  assert.deepEqual(sheet.getCellSource('A1'), 1);
  assert.deepEqual(sheet.getCellSource('B1'), {
    type: 'formula',
    source: '=A1+1',
  });
  assert.deepEqual(sheet.getCellSource('A2'), 2);
  assert.deepEqual(sheet.getCellSource('B2'), {
    type: 'formula',
    source: '=B1*2',
  });
  assert.equal(sheet.getCell('B1'), 2);
  assert.equal(sheet.getCell('B2'), 4);
});

test('validates cell addresses and cell values', () => {
  const sheet = new Spreadsheet();

  assert.throws(() => sheet.setCell('1A', 1), Error);
  assert.throws(() => sheet.setCell('A1', {}), Error);
  assert.throws(() => sheet.setCell('A1', true), Error);
  assert.throws(() => sheet.getCell('not-an-address'), Error);
  assert.throws(() => sheet.getCellSource('not-an-address'), Error);
  assert.throws(() => sheet.getDependencies('not-an-address'), Error);
});

test('clears all cells and reports empty sheet dimensions', () => {
  const sheet = new Spreadsheet({ initialCells: { A1: 1, B2: 2 } });

  assert.equal(sheet.getMaxRow(), 2);
  assert.equal(sheet.getMaxColumn(), 2);

  sheet.clear();

  assert.equal(sheet.getCell('A1'), 0);
  assert.equal(sheet.getCellSource('A1'), undefined);
  assert.equal(sheet.getMaxRow(), 0);
  assert.equal(sheet.getMaxColumn(), 0);
});
