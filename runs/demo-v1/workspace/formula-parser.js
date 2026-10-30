import { parseAddress } from './cell-address.js';

const FUNCTIONS = new Set(['SUM', 'AVG', 'MIN', 'MAX']);

class Tokenizer {
  constructor(source) {
    this.source = source;
    this.position = 0;
  }

  next() {
    this.skipWhitespace();

    if (this.position >= this.source.length) {
      return { type: 'eof' };
    }

    const character = this.source[this.position];

    if ('+-*/()'.includes(character)) {
      this.position += 1;
      return { type: 'operator', value: character };
    }

    if (character === ':') {
      this.position += 1;
      return { type: 'colon' };
    }

    if (character === ',') {
      this.position += 1;
      return { type: 'comma' };
    }

    if (/\d/.test(character)) {
      return this.readNumber();
    }

    if (/[A-Za-z]/.test(character)) {
      return this.readIdentifier();
    }

    throw new Error(`Unknown token at position ${this.position}`);
  }

  skipWhitespace() {
    while (
      this.position < this.source.length &&
      /\s/.test(this.source[this.position])
    ) {
      this.position += 1;
    }
  }

  readNumber() {
    const start = this.position;

    while (
      this.position < this.source.length &&
      /\d/.test(this.source[this.position])
    ) {
      this.position += 1;
    }

    if (
      this.position < this.source.length &&
      this.source[this.position] === '.' &&
      /\d/.test(this.source[this.position + 1] ?? '')
    ) {
      this.position += 1;

      while (
        this.position < this.source.length &&
        /\d/.test(this.source[this.position])
      ) {
        this.position += 1;
      }
    }

    return {
      type: 'number',
      value: Number(this.source.slice(start, this.position)),
    };
  }

  readIdentifier() {
    const start = this.position;

    while (
      this.position < this.source.length &&
      /[A-Za-z0-9_]/.test(this.source[this.position])
    ) {
      this.position += 1;
    }

    const value = this.source.slice(start, this.position);
    const upperValue = value.toUpperCase();

    if (FUNCTIONS.has(upperValue)) {
      return { type: 'function', value: upperValue };
    }

    if (/^[A-Za-z]+[0-9]+$/.test(value)) {
      return { type: 'identifier', value };
    }

    throw new Error(`Malformed reference or unsupported function: ${value}`);
  }
}

class Parser {
  constructor(source) {
    this.tokenizer = new Tokenizer(source);
    this.currentToken = this.tokenizer.next();
  }

  parse() {
    const expression = this.parseExpression();

    if (this.currentToken.type !== 'eof') {
      throw new Error(`Unexpected token at position ${this.tokenizer.position}`);
    }

    return expression;
  }

  parseExpression() {
    let left = this.parseTerm();

    while (
      this.currentToken.type === 'operator' &&
      (this.currentToken.value === '+' || this.currentToken.value === '-')
    ) {
      const op = this.currentToken.value;
      this.currentToken = this.tokenizer.next();
      const right = this.parseTerm();
      left = { type: 'binary', op, left, right };
    }

    return left;
  }

  parseTerm() {
    let left = this.parseUnary();

    while (
      this.currentToken.type === 'operator' &&
      (this.currentToken.value === '*' || this.currentToken.value === '/')
    ) {
      const op = this.currentToken.value;
      this.currentToken = this.tokenizer.next();
      const right = this.parseUnary();
      left = { type: 'binary', op, left, right };
    }

    return left;
  }

  parseUnary() {
    if (
      this.currentToken.type === 'operator' &&
      (this.currentToken.value === '+' || this.currentToken.value === '-')
    ) {
      const op = this.currentToken.value;
      this.currentToken = this.tokenizer.next();
      const operand = this.parseUnary();
      return { type: 'unary', op, operand };
    }

    return this.parsePrimary();
  }

  parsePrimary() {
    const token = this.currentToken;

    if (token.type === 'number') {
      this.currentToken = this.tokenizer.next();
      return { type: 'number', value: token.value };
    }

    if (token.type === 'operator' && token.value === '(') {
      this.currentToken = this.tokenizer.next();
      const expression = this.parseExpression();

      if (
        this.currentToken.type !== 'operator' ||
        this.currentToken.value !== ')'
      ) {
        throw new Error('Expected closing parenthesis');
      }

      this.currentToken = this.tokenizer.next();
      return expression;
    }

    if (token.type === 'function') {
      return this.parseFunctionCall();
    }

    if (token.type === 'identifier') {
      return this.parseCellOrRange();
    }

    throw new Error('Expected an expression');
  }

  parseFunctionCall() {
    const name = this.currentToken.value;
    this.currentToken = this.tokenizer.next();

    if (
      this.currentToken.type !== 'operator' ||
      this.currentToken.value !== '('
    ) {
      throw new Error(`Expected opening parenthesis after ${name}`);
    }

    this.currentToken = this.tokenizer.next();

    if (this.currentToken.type !== 'identifier') {
      throw new Error(`${name} requires a cell range`);
    }

    const start = this.readAddress();
    let range;

    if (this.currentToken.type === 'colon') {
      this.currentToken = this.tokenizer.next();

      if (this.currentToken.type !== 'identifier') {
        throw new Error(`Expected the end of the range for ${name}`);
      }

      const end = this.readAddress();
      range = { type: 'range', start, end };
    } else {
      range = { type: 'range', start, end: start };
    }

    if (
      this.currentToken.type !== 'operator' ||
      this.currentToken.value !== ')'
    ) {
      throw new Error(`Expected closing parenthesis after ${name}`);
    }

    this.currentToken = this.tokenizer.next();
    return { type: 'call', name, range };
  }

  parseCellOrRange() {
    const start = this.readAddress();

    if (this.currentToken.type === 'colon') {
      this.currentToken = this.tokenizer.next();

      if (this.currentToken.type !== 'identifier') {
        throw new Error('Expected the end of the cell range');
      }

      const end = this.readAddress();
      return { type: 'range', start, end };
    }

    return { type: 'cell', row: start.row, column: start.column };
  }

  readAddress() {
    const token = this.currentToken;
    const address = token.value;

    let parsed;

    try {
      parsed = parseAddress(address);
    } catch {
      throw new Error(`Malformed cell address: ${address}`);
    }

    this.currentToken = this.tokenizer.next();
    return parsed;
  }
}

export function parseFormula(source) {
  if (typeof source !== 'string' || !source.startsWith('=')) {
    throw new Error('Formula source must start with "="');
  }

  const body = source.slice(1).trim();

  if (body.length === 0) {
    throw new Error('Formula source cannot be empty');
  }

  const parser = new Parser(body);
  return parser.parse();
}

export const Node = Object.freeze({
  number: (value) => ({ type: 'number', value }),
  cell: (row, column) => ({ type: 'cell', row, column }),
  range: (start, end) => ({ type: 'range', start, end }),
  unary: (op, operand) => ({ type: 'unary', op, operand }),
  binary: (op, left, right) => ({ type: 'binary', op, left, right }),
  call: (name, range) => ({ type: 'call', name, range }),
});
