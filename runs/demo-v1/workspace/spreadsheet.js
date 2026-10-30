import { parseAddress, formatAddress } from './cell-address.js';
import { parseFormula } from './formula-parser.js';
import { evaluateFormula } from './formula-evaluator.js';
import { toCsv as encodeCsv, fromCsv as decodeCsv } from './csv-codec.js';

const ERROR_CYCLE = '#CYCLE';

function isFormula(value) {
  return typeof value === 'string' && value.startsWith('=');
}

function collectReferences(node, references = []) {
  if (!node || typeof node !== 'object') {
    return references;
  }

  switch (node.type) {
    case 'cell':
      references.push({
        row: node.row,
        column: node.column,
        range: false,
      });
      break;
    case 'range':
      references.push(node);
      break;
    case 'unary':
      collectReferences(node.operand, references);
      break;
    case 'binary':
      collectReferences(node.left, references);
      collectReferences(node.right, references);
      break;
    case 'call':
      if (node.range) {
        collectReferences(node.range, references);
      }
      break;
    default:
      break;
  }

  return references;
}

function collectDependencies(node) {
  const dependencies = [];

  for (const reference of collectReferences(node)) {
    if (reference.type === 'range') {
      const { start, end } = reference;
      const minRow = Math.min(start.row, end.row);
      const maxRow = Math.max(start.row, end.row);
      const minColumn = Math.min(start.column, end.column);
      const maxColumn = Math.max(start.column, end.column);

      for (let row = minRow; row <= maxRow; row += 1) {
        for (let column = minColumn; column <= maxColumn; column += 1) {
          dependencies.push(formatAddress(row, column));
        }
      }
    } else {
      dependencies.push(formatAddress(reference.row, reference.column));
    }
  }

  return [...new Set(dependencies)];
}

export class Spreadsheet {
  constructor() {
    this.cells = new Map();
    this.parsed = new Map();
    this.dependencies = new Map();
    this.dependents = new Map();
    this.computed = new Map();
    this.recalculate();
  }

  setCell(address, rawValue) {
    const normalizedAddress = this.#normalizeAddress(address);

    this.cells.set(normalizedAddress, rawValue);
    this.recalculate();
  }

  getCell(address) {
    const normalizedAddress = this.#normalizeAddress(address);
    const rawValue = this.cells.get(normalizedAddress);

    if (rawValue === undefined) {
      return 0;
    }

    return rawValue;
  }

  getComputedValue(address) {
    const normalizedAddress = this.#normalizeAddress(address);
    const rawValue = this.cells.get(normalizedAddress);

    if (rawValue === undefined) {
      return 0;
    }

    if (isFormula(rawValue)) {
      return this.computed.get(normalizedAddress) ?? ERROR_CYCLE;
    }

    return rawValue;
  }

  getRawValue(address) {
    const normalizedAddress = this.#normalizeAddress(address);
    return this.cells.get(normalizedAddress);
  }

  getDependencies(address) {
    const normalizedAddress = this.#normalizeAddress(address);
    return [...(this.dependencies.get(normalizedAddress) ?? [])];
  }

  toCsv() {
    let maxRow = -1;
    let maxColumn = -1;

    for (const address of this.cells.keys()) {
      const { row, column } = parseAddress(address);
      maxRow = Math.max(maxRow, row);
      maxColumn = Math.max(maxColumn, column);
    }

    if (maxRow < 0 || maxColumn < 0) {
      return '';
    }

    const rows = [];

    for (let row = 0; row <= maxRow; row += 1) {
      const values = [];

      for (let column = 0; column <= maxColumn; column += 1) {
        values.push(this.getComputedValue(formatAddress(row, column)));
      }

      rows.push(values);
    }

    return encodeCsv(rows);
  }

  fromCsv(src) {
    const rows = decodeCsv(src);

    this.cells.clear();
    this.parsed.clear();
    this.dependencies.clear();
    this.dependents.clear();
    this.computed.clear();

    rows.forEach((row, rowIndex) => {
      row.forEach((field, columnIndex) => {
        const address = formatAddress(rowIndex, columnIndex);
        const numericValue = typeof field === 'string' && field.trim() !== ''
          ? Number(field)
          : NaN;

        this.cells.set(
          address,
          Number.isFinite(numericValue) ? numericValue : field,
        );
      });
    });

    this.recalculate();
  }

  recalculate() {
    this.parsed.clear();
    this.dependencies.clear();
    this.dependents.clear();

    const formulaAddresses = [];
    const graph = new Map();

    for (const [address, rawValue] of this.cells) {
      if (!isFormula(rawValue)) {
        continue;
      }

      let ast = null;

      try {
        ast = parseFormula(rawValue);
      } catch {
        ast = null;
      }

      this.parsed.set(address, ast);
      formulaAddresses.push(address);

      const dependencies = ast ? collectDependencies(ast) : [];
      this.dependencies.set(address, dependencies);
      graph.set(address, dependencies);

      for (const dependency of dependencies) {
        if (!this.dependents.has(dependency)) {
          this.dependents.set(dependency, new Set());
        }

        this.dependents.get(dependency).add(address);
      }
    }

    const values = new Map();

    for (const [address, rawValue] of this.cells) {
      if (!isFormula(rawValue)) {
        values.set(address, rawValue);
      }
    }

    const state = new Map();
    const cycleCells = new Set();

    const visit = (address) => {
      const currentState = state.get(address);

      if (currentState === 'visited') {
        return;
      }

      if (currentState === 'visiting') {
        cycleCells.add(address);
        return;
      }

      state.set(address, 'visiting');

      for (const dependency of graph.get(address) ?? []) {
        if (graph.has(dependency)) {
          visit(dependency);
        }
      }

      state.set(address, 'visited');
    };

    for (const address of formulaAddresses) {
      visit(address);
    }

    for (const address of formulaAddresses) {
      if (!cycleCells.has(address)) {
        continue;
      }

      const path = [];
      const pathIndex = new Map();
      let current = address;

      while (graph.has(current) && !pathIndex.has(current)) {
        pathIndex.set(current, path.length);
        path.push(current);

        const dependency = (graph.get(current) ?? []).find(
          (candidate) => graph.has(candidate) && cycleCells.has(candidate),
        );

        if (dependency === undefined) {
          break;
        }

        current = dependency;
      }

      if (pathIndex.has(current)) {
        for (const cycleAddress of path.slice(pathIndex.get(current))) {
          cycleCells.add(cycleAddress);
        }
      }
    }

    const evaluateAddress = (address) => {
      if (cycleCells.has(address)) {
        return ERROR_CYCLE;
      }

      const ast = this.parsed.get(address);

      if (!ast) {
        return ERROR_CYCLE;
      }

      const context = {
        getCell: (row, column) => {
          const reference = formatAddress(row, column);
          const value = values.get(reference);
          return value === undefined ? 0 : value;
        },
        getRange: (start, end) => {
          const minRow = Math.min(start.row, end.row);
          const maxRow = Math.max(start.row, end.row);
          const minColumn = Math.min(start.column, end.column);
          const maxColumn = Math.max(start.column, end.column);
          const rangeValues = [];

          for (let row = minRow; row <= maxRow; row += 1) {
            for (let column = minColumn; column <= maxColumn; column += 1) {
              const reference = formatAddress(row, column);
              const value = values.get(reference);
              rangeValues.push(value === undefined ? 0 : value);
            }
          }

          return rangeValues;
        },
      };

      try {
        const result = evaluateFormula(ast, context);
        return result === undefined ? 0 : result;
      } catch {
        return ERROR_CYCLE;
      }
    };

    const evaluationState = new Map();

    const evaluateInOrder = (address) => {
      const currentState = evaluationState.get(address);

      if (currentState === 'evaluated') {
        return;
      }

      if (currentState === 'evaluating') {
        return;
      }

      evaluationState.set(address, 'evaluating');

      for (const dependency of graph.get(address) ?? []) {
        if (graph.has(dependency)) {
          evaluateInOrder(dependency);
        }
      }

      evaluationState.set(address, 'evaluated');

      if (cycleCells.has(address)) {
        values.set(address, ERROR_CYCLE);
      } else {
        values.set(address, evaluateAddress(address));
      }
    };

    for (const address of formulaAddresses) {
      evaluateInOrder(address);
    }

    this.computed = new Map();

    for (const address of formulaAddresses) {
      this.computed.set(address, values.get(address) ?? ERROR_CYCLE);
    }
  }

  #normalizeAddress(address) {
    if (typeof address !== 'string') {
      throw new Error('Invalid cell address');
    }

    const parsed = parseAddress(address.trim().toUpperCase());
    return formatAddress(parsed.row, parsed.column);
  }
}
