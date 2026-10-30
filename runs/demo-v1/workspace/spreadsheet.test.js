import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Spreadsheet } from './spreadsheet.js';

test('calculates formula chains and updates dependents when precedents change', () => {
  const sheet = new Spreadsheet();

  sheet.setCell('A1', 1);
  sheet.setCell('B1', '=A1+1');
  sheet.setCell('C1', '=B1*2');

  assert.equal(sheet.getComputedValue('A1'), 1);
  assert.equal(sheet.getComputedValue('B1'), 2);
  assert.equal(sheet.getComputedValue('C1'), 4);

  sheet.setCell('A1', 5);

  assert.equal(sheet.getComputedValue('A1'), 5);
  assert.equal(sheet.getComputedValue('B1'), 6);
  assert.equal(sheet.getComputedValue('C1'), 12);
});

test('marks every cell in a circular dependency as #CYCLE', () => {
  const sheet = new Spreadsheet();

  sheet.setCell('A1', '=B1');
  sheet.setCell('B1', '=A1');
  sheet.recalculate();

  assert.equal(sheet.getComputedValue('A1'), '#CYCLE');
  assert.equal(sheet.getComputedValue('B1'), '#CYCLE');
});

test('coerces empty precedents to zero and reports division by zero', () => {
  const sheet = new Spreadsheet();

  sheet.setCell('A1', '=B1+2');
  sheet.setCell('C1', '=A1/0');

  assert.equal(sheet.getComputedValue('A1'), 2);
  assert.equal(sheet.getComputedValue('C1'), '#DIV/0');
});

test('exports computed values while preserving constants', () => {
  const sheet = new Spreadsheet();

  sheet.setCell('A1', 'hello');
  sheet.setCell('B1', 2);

  assert.equal(sheet.toCsv(), 'hello,2');
});

test('imports CSV as raw values, including formula strings', () => {
  const sheet = new Spreadsheet();

  sheet.fromCsv('=A1+1,hello\n2,3.5');

  assert.equal(sheet.getRawValue('A1'), '=A1+1');
  assert.equal(sheet.getRawValue('B1'), 'hello');
  assert.equal(sheet.getRawValue('A2'), 2);
  assert.equal(sheet.getRawValue('B2'), 3.5);
});

test('exposes raw values, computed values, and direct dependencies in source order', () => {
  const sheet = new Spreadsheet();

  sheet.setCell('A1', 1);
  sheet.setCell('B1', 2);
  sheet.setCell('C1', '=A1+B1');

  assert.equal(sheet.getRawValue('C1'), '=A1+B1');
  assert.equal(sheet.getCell('C1'), '=A1+B1');
  assert.equal(sheet.getComputedValue('C1'), 3);
  assert.deepEqual(sheet.getDependencies('C1'), ['A1', 'B1']);
});

test('recalculates formulas and treats an empty cell as zero', () => {
  const sheet = new Spreadsheet();

  sheet.setCell('A1', '=B1+1');
  assert.equal(sheet.getComputedValue('A1'), 1);

  sheet.recalculate();
  assert.equal(sheet.getComputedValue('A1'), 1);
  assert.equal(sheet.getComputedValue('Z99'), 0);
});
