import { parseAddress, formatAddress } from './cell-address.js';
import { parse } from './formula-parser.js';
import {
  evaluate,
  collectDependencies,
} from './formula-evaluator.js';

const ERROR_CYCLE = '#CYCLE';

function isErrorValue(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    value.type === 'error' &&
    typeof value.value === 'string'
  );
}

export class Spreadsheet {
  constructor(options = {}) {
    this.cells = new Map();
    this.dependencies = new Map();
    this.dependents = new Map();
    this.asts = new Map();
    this.computedValues = new Map();
    this.options = options ?? {};

    if (this.options.initialCells) {
      for (const [address, value] of Object.entries(this.options.initialCells)) {
        this.#setCellWithoutRecalculation(
          this.#normalizeAddress(address),
          value,
        );
      }
      this.recalculate();
    }
  }

  setCell(address, value) {
    const normalized = this.#normalizeAddress(address);
    this.#setCellWithoutRecalculation(normalized, value);
    this.recalculate();
  }

  getCell(address) {
    const normalized = this.#normalizeAddress(address);
    const value = this.cells.get(normalized);

    if (value === undefined) {
      return 0;
    }

    if (this.asts.has(normalized)) {
      return this.computedValues.get(normalized);
    }

    return value;
  }

  getCellSource(address) {
    const normalized = this.#normalizeAddress(address);
    const value = this.cells.get(normalized);

    if (value === undefined) {
      return undefined;
    }

    if (this.asts.has(normalized)) {
      return { type: 'formula', source: value };
    }

    return value;
  }

  getDependencies(address) {
    const normalized = this.#normalizeAddress(address);
    return [...(this.dependents.get(normalized) ?? [])];
  }

  recalculate() {
    this.computedValues = new Map();

    const formulaAddresses = [...this.asts.keys()];
    const state = new Map();
    const cycleAddresses = new Set();

    const visit = (address) => {
      const currentState = state.get(address);

      if (currentState === 'done') {
        return;
      }

      if (currentState === 'visiting') {
        cycleAddresses.add(address);
        return;
      }

      state.set(address, 'visiting');

      for (const dependency of this.dependencies.get(address) ?? []) {
        if (this.asts.has(dependency)) {
          visit(dependency);
        }
      }

      state.set(address, 'done');
    };

    for (const address of formulaAddresses) {
      visit(address);
    }

    const findCycleMembers = () => {
      const found = new Set();
      const visited = new Set();

      const findFrom = (start, path) => {
        if (visited.has(start)) {
          return;
        }

        visited.add(start);
        path.add(start);

        for (const dependency of this.dependencies.get(start) ?? []) {
          if (!this.asts.has(dependency)) {
            continue;
          }

          if (path.has(dependency)) {
            const cycle = [...path];
            const cycleStart = cycle.indexOf(dependency);
            for (const member of cycle.slice(cycleStart)) {
              found.add(member);
            }
          } else {
            findFrom(dependency, path);
          }
        }

        path.delete(start);
      };

      for (const address of formulaAddresses) {
        findFrom(address, new Set());
      }

      return found;
    };

    for (const address of findCycleMembers()) {
      cycleAddresses.add(address);
    }

    const evaluateAddress = (address) => {
      const ast = this.asts.get(address);
      const readCell = (referencedAddress) => {
        const normalized = this.#normalizeAddress(referencedAddress);

        if (cycleAddresses.has(normalized)) {
          return { type: 'error', value: ERROR_CYCLE };
        }

        const referencedSource = this.cells.get(normalized);

        if (referencedSource === undefined) {
          return 0;
        }

        if (this.asts.has(normalized)) {
          const computed = this.computedValues.get(normalized);
          return computed === undefined
            ? { type: 'formula', source: referencedSource }
            : computed;
        }

        return referencedSource;
      };

      let result;

      try {
        result = evaluate(ast, readCell);
      } catch {
        result = { type: 'error', value: '#ERROR' };
      }

      this.computedValues.set(address, result);
    };

    const evaluateInOrder = (address) => {
      const currentState = state.get(address);

      if (currentState === 'done') {
        return;
      }

      state.set(address, 'visiting');

      for (const dependency of this.dependencies.get(address) ?? []) {
        if (this.asts.has(dependency)) {
          evaluateInOrder(dependency);
        }
      }

      if (cycleAddresses.has(address)) {
        this.computedValues.set(address, {
          type: 'error',
          value: ERROR_CYCLE,
        });
      } else {
        evaluateAddress(address);
      }

      state.set(address, 'done');
    };

    for (const address of formulaAddresses) {
      evaluateInOrder(address);
    }
  }

  toCSV(options = {}) {
    const delimiter = options.delimiter ?? ',';
    const maxRow = this.getMaxRow();
    const maxColumn = this.getMaxColumn();
    const rows = [];

    for (let row = 1; row <= maxRow; row += 1) {
      const fields = [];

      for (let column = 1; column <= maxColumn; column += 1) {
        const address = formatAddress(column, row);
        const value = this.getCell(address);

        if (value === undefined || value === null) {
          fields.push('');
        } else if (isErrorValue(value)) {
          fields.push(value.value);
        } else {
          fields.push(String(value));
        }
      }

      rows.push(fields.join(delimiter));
    }

    return rows.join('\n');
  }

  fromCSV(src, options = {}) {
    if (typeof src !== 'string') {
      throw new Error('CSV source must be a string');
    }

    const delimiter = options.delimiter ?? ',';
    this.clear();

    const lines = src.split(/\r\n|\n|\r/);

    for (let rowIndex = 0; rowIndex < lines.length; rowIndex += 1) {
      const line = lines[rowIndex];

      if (line === '') {
        continue;
      }

      const fields = this.#splitCsvLine(line, delimiter);

      for (let columnIndex = 0; columnIndex < fields.length; columnIndex += 1) {
        const field = fields[columnIndex];

        if (field === '') {
          continue;
        }

        const address = formatAddress(columnIndex + 1, rowIndex + 1);
        const value = field.startsWith('=') ? field : this.#parseCsvValue(field);

        this.#setCellWithoutRecalculation(address, value);
      }
    }

    this.recalculate();
  }

  clear() {
    this.cells.clear();
    this.dependencies.clear();
    this.dependents.clear();
    this.asts.clear();
    this.computedValues.clear();
  }

  getMaxRow() {
    let maxRow = 0;

    for (const address of this.cells.keys()) {
      const { row } = parseAddress(address);
      if (row > maxRow) {
        maxRow = row;
      }
    }

    return maxRow;
  }

  getMaxColumn() {
    let maxColumn = 0;

    for (const address of this.cells.keys()) {
      const { column } = parseAddress(address);
      if (column > maxColumn) {
        maxColumn = column;
      }
    }

    return maxColumn;
  }

  #normalizeAddress(address) {
    if (typeof address !== 'string') {
      throw new Error('Malformed cell address');
    }

    const parsed = parseAddress(address);
    return formatAddress(parsed.column, parsed.row);
  }

  #removeDependencies(address) {
    const oldDependencies = this.dependencies.get(address);

    if (!oldDependencies) {
      return;
    }

    for (const dependency of oldDependencies) {
      this.dependents.get(dependency)?.delete(address);
    }

    this.dependencies.delete(address);
  }

  #setCellWithoutRecalculation(address, value) {
    if (
      typeof value !== 'number' &&
      typeof value !== 'string'
    ) {
      throw new Error(`Invalid value for cell ${address}`);
    }

    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new Error(`Invalid value for cell ${address}`);
    }

    if (typeof value === 'string' && value.startsWith('=')) {
      let ast;

      try {
        ast = parse(value.slice(1));
      } catch {
        throw new Error(`Invalid formula for cell ${address}`);
      }

      this.#removeDependencies(address);
      this.cells.set(address, value);
      this.asts.set(address, ast);

      const dependencies = new Set();

      for (const dependency of collectDependencies(ast)) {
        const normalized = this.#normalizeAddress(dependency);
        dependencies.add(normalized);

        if (!this.dependents.has(normalized)) {
          this.dependents.set(normalized, new Set());
        }

        this.dependents.get(normalized).add(address);
      }

      this.dependencies.set(address, dependencies);
    } else {
      this.#removeDependencies(address);
      this.asts.delete(address);

      if (value !== '') {
        this.cells.set(address, value);
      } else {
        this.cells.delete(address);
      }
    }
  }

  #parseCsvValue(value) {
    if (value === '') {
      return '';
    }

    if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) {
      const number = Number(value);

      if (Number.isFinite(number)) {
        return number;
      }
    }

    return value;
  }

  #splitCsvLine(line, delimiter) {
    const fields = [];
    let field = '';
    let quoted = false;

    for (let index = 0; index < line.length; index += 1) {
      const character = line[index];

      if (character === '"') {
        if (quoted && line[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = !quoted;
        }
      } else if (character === delimiter && !quoted) {
        fields.push(field);
        field = '';
      } else {
        field += character;
      }
    }

    fields.push(field);
    return fields;
  }
}

export default Spreadsheet;
