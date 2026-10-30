import {
  compareAddresses,
  formatAddress,
  parseAddress,
} from './cell-address.js';

const ERROR_DIVIDE_BY_ZERO = '#DIV/0';
const ERROR_CYCLE = '#CYCLE';

function error(value) {
  return { type: 'error', value };
}

function isError(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    value.type === 'error' &&
    typeof value.value === 'string'
  );
}

function isFormula(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    value.type === 'formula' &&
    typeof value.source === 'string'
  );
}

function isNumeric(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function toNumber(value) {
  if (isError(value)) return value;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : error(ERROR_DIVIDE_BY_ZERO);
  }
  if (typeof value === 'string') {
    if (value.trim() === '') return 0;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : error(ERROR_DIVIDE_BY_ZERO);
  }
  return error(ERROR_DIVIDE_BY_ZERO);
}

function add(left, right) {
  const a = toNumber(left);
  if (isError(a)) return a;
  const b = toNumber(right);
  if (isError(b)) return b;
  return a + b;
}

function subtract(left, right) {
  const a = toNumber(left);
  if (isError(a)) return a;
  const b = toNumber(right);
  if (isError(b)) return b;
  return a - b;
}

function multiply(left, right) {
  const a = toNumber(left);
  if (isError(a)) return a;
  const b = toNumber(right);
  if (isError(b)) return b;
  return a * b;
}

function divide(left, right) {
  const a = toNumber(left);
  if (isError(a)) return a;
  const b = toNumber(right);
  if (isError(b)) return b;
  if (b === 0) return error(ERROR_DIVIDE_BY_ZERO);
  return a / b;
}

function normalizeAddress(address) {
  if (typeof address !== 'string') {
    throw new Error('Malformed cell address');
  }

  const normalized = address.trim().toUpperCase();
  parseAddress(normalized);
  return normalized;
}

export function normalizeRange(start, end) {
  const normalizedStart = normalizeAddress(start);
  const normalizedEnd = normalizeAddress(end);

  const startPosition = parseAddress(normalizedStart);
  const endPosition = parseAddress(normalizedEnd);

  const minColumn = Math.min(startPosition.column, endPosition.column);
  const maxColumn = Math.max(startPosition.column, endPosition.column);
  const minRow = Math.min(startPosition.row, endPosition.row);
  const maxRow = Math.max(startPosition.row, endPosition.row);

  const addresses = [];
  for (let row = minRow; row <= maxRow; row += 1) {
    for (let column = minColumn; column <= maxColumn; column += 1) {
      addresses.push(formatAddress(column, row));
    }
  }
  return addresses;
}

function readReference(address, readCell) {
  const value = readCell(address);

  if (isError(value)) return value;
  if (isFormula(value)) {
    return error(ERROR_CYCLE);
  }
  if (value === undefined || value === null || value === '') return 0;
  return value;
}

function evaluateRange(node, readCell) {
  const addresses = normalizeRange(node.start, node.end);
  const values = [];

  for (const address of addresses) {
    const value = readReference(address, readCell);
    if (isError(value)) return value;

    const numeric = toNumber(value);
    if (isError(numeric)) return numeric;
    values.push(numeric);
  }

  return values;
}

function evaluateNode(node, readCell) {
  if (!node || typeof node !== 'object') {
    return error(ERROR_DIVIDE_BY_ZERO);
  }

  switch (node.type) {
    case 'number':
      return isNumeric(node.value) ? node.value : error(ERROR_DIVIDE_BY_ZERO);

    case 'ref':
      return readReference(normalizeAddress(node.address), readCell);

    case 'range':
      return evaluateRange(node, readCell);

    case 'binary': {
      const left = evaluateNode(node.left, readCell);
      if (isError(left)) return left;
      const right = evaluateNode(node.right, readCell);
      if (isError(right)) return right;

      switch (node.operator) {
        case '+':
          return add(left, right);
        case '-':
          return subtract(left, right);
        case '*':
          return multiply(left, right);
        case '/':
          return divide(left, right);
        default:
          return error(ERROR_DIVIDE_BY_ZERO);
      }
    }

    case 'call': {
      if (!['SUM', 'AVG', 'MIN', 'MAX'].includes(node.name)) {
        return error(ERROR_DIVIDE_BY_ZERO);
      }

      const values = evaluateRange(node.argument, readCell);
      if (isError(values)) return values;

      if (values.length === 0) {
        return node.name === 'SUM' ? 0 : error(ERROR_DIVIDE_BY_ZERO);
      }

      switch (node.name) {
        case 'SUM':
          return values.reduce((sum, value) => sum + value, 0);
        case 'AVG':
          return values.reduce((sum, value) => sum + value, 0) / values.length;
        case 'MIN':
          return Math.min(...values);
        case 'MAX':
          return Math.max(...values);
        default:
          return error(ERROR_DIVIDE_BY_ZERO);
      }
    }

    default:
      return error(ERROR_DIVIDE_BY_ZERO);
  }
}

export function evaluate(ast, readCell) {
  if (!ast || ast.type !== 'expression' || !ast.expression) {
    return error(ERROR_DIVIDE_BY_ZERO);
  }

  if (typeof readCell !== 'function') {
    return error(ERROR_DIVIDE_BY_ZERO);
  }

  return evaluateNode(ast.expression, readCell);
}

export function collectDependencies(ast) {
  const dependencies = [];
  const seen = new Set();

  function visit(node) {
    if (!node || typeof node !== 'object') return;

    switch (node.type) {
      case 'ref':
        if (typeof node.address === 'string') {
          const address = normalizeAddress(node.address);
          if (!seen.has(address)) {
            seen.add(address);
            dependencies.push(address);
          }
        }
        break;

      case 'range':
        for (const address of normalizeRange(node.start, node.end)) {
          if (!seen.has(address)) {
            seen.add(address);
            dependencies.push(address);
          }
        }
        break;

      case 'binary':
        visit(node.left);
        visit(node.right);
        break;

      case 'call':
        visit(node.argument);
        break;

      default:
        break;
    }
  }

  if (ast && ast.type === 'expression') {
    visit(ast.expression);
  }

  return dependencies;
}
