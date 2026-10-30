import { parseAddress, parseRange } from './cell-address.js';

const OPERATORS = new Set(['+', '-', '*', '/']);
const FUNCTIONS = new Set(['SUM', 'AVG', 'MIN', 'MAX']);
const ADDRESS_PATTERN = /^[A-Za-z]+[1-9][0-9]*$/;
const RANGE_PATTERN = /^[A-Za-z]+[1-9][0-9]*:[A-Za-z]+[1-9][0-9]*$/;

function isAsciiLetter(character) {
  return character >= 'A' && character <= 'Z';
}

function isAsciiDigit(character) {
  return character >= '0' && character <= '9';
}

function isIdentifierStart(character) {
  return isAsciiLetter(character);
}

function isIdentifierPart(character) {
  return isAsciiLetter(character) || isAsciiDigit(character) || character === '_';
}

function isValidAddress(value) {
  if (!ADDRESS_PATTERN.test(value)) {
    return false;
  }

  try {
    parseAddress(value);
    return true;
  } catch {
    return false;
  }
}

function isValidRange(value) {
  if (!RANGE_PATTERN.test(value)) {
    return false;
  }

  try {
    parseRange(value);
    return true;
  } catch {
    return false;
  }
}

export function tokenize(src) {
  if (typeof src !== 'string') {
    throw new Error('Formula source must be a string');
  }

  const tokens = [];
  let index = 0;

  while (index < src.length) {
    const character = src[index];

    if (/\s/.test(character)) {
      index += 1;
      continue;
    }

    if (isAsciiDigit(character) || (character === '.' && isAsciiDigit(src[index + 1]))) {
      const start = index;
      let hasDecimalPoint = false;

      while (index < src.length) {
        const current = src[index];

        if (isAsciiDigit(current)) {
          index += 1;
        } else if (current === '.' && !hasDecimalPoint) {
          hasDecimalPoint = true;
          index += 1;
        } else {
          break;
        }
      }

      const value = Number(src.slice(start, index));

      if (!Number.isFinite(value)) {
        throw new Error(`Invalid number at position ${start}`);
      }

      tokens.push({ type: 'number', value });
      continue;
    }

    if (isIdentifierStart(character)) {
      const start = index;

      while (index < src.length && isIdentifierPart(src[index])) {
        index += 1;
      }

      const value = src.slice(start, index);
      tokens.push({ type: 'identifier', value });
      continue;
    }

    if (OPERATORS.has(character)) {
      tokens.push({ type: 'operator', value: character });
      index += 1;
      continue;
    }

    if (character === '(') {
      tokens.push({ type: 'lparen', value: '(' });
      index += 1;
      continue;
    }

    if (character === ')') {
      tokens.push({ type: 'rparen', value: ')' });
      index += 1;
      continue;
    }

    if (character === ',') {
      tokens.push({ type: 'comma', value: ',' });
      index += 1;
      continue;
    }

    if (character === ':') {
      tokens.push({ type: 'colon', value: ':' });
      index += 1;
      continue;
    }

    throw new Error(`Unknown token at position ${index}`);
  }

  return tokens;
}

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.position = 0;
  }

  current() {
    return this.tokens[this.position];
  }

  consume(type, value) {
    const token = this.current();

    if (!token || token.type !== type || (value !== undefined && token.value !== value)) {
      throw new Error('Invalid formula syntax');
    }

    this.position += 1;
    return token;
  }

  parseExpression() {
    return this.parseAdditive();
  }

  parseAdditive() {
    let left = this.parseMultiplicative();

    while (
      this.current()?.type === 'operator' &&
      (this.current().value === '+' || this.current().value === '-')
    ) {
      const operator = this.consume('operator').value;
      const right = this.parseMultiplicative();
      left = { type: 'binary', operator, left, right };
    }

    return left;
  }

  parseMultiplicative() {
    let left = this.parsePrimary();

    while (
      this.current()?.type === 'operator' &&
      (this.current().value === '*' || this.current().value === '/')
    ) {
      const operator = this.consume('operator').value;
      const right = this.parsePrimary();
      left = { type: 'binary', operator, left, right };
    }

    return left;
  }

  parsePrimary() {
    const token = this.current();

    if (!token) {
      throw new Error('Invalid formula syntax');
    }

    if (token.type === 'number') {
      this.position += 1;
      return { type: 'number', value: token.value };
    }

    if (token.type === 'lparen') {
      this.position += 1;
      const expression = this.parseExpression();
      this.consume('rparen');
      return expression;
    }

    if (token.type === 'identifier') {
      this.position += 1;
      const value = token.value;

      if (this.current()?.type === 'lparen') {
        if (!FUNCTIONS.has(value)) {
          throw new Error(`Unknown function: ${value}`);
        }

        this.position += 1;
        const argument = this.parseExpression();
        this.consume('rparen');

        return {
          type: 'call',
          name: value,
          argument,
        };
      }

      if (this.current()?.type === 'colon') {
        if (!isValidAddress(value)) {
          throw new Error(`Invalid cell address: ${value}`);
        }

        this.position += 1;
        const endToken = this.current();

        if (!endToken || endToken.type !== 'identifier' || !isValidAddress(endToken.value)) {
          throw new Error('Invalid range');
        }

        this.position += 1;
        const range = `${value}:${endToken.value}`;

        try {
          parseRange(range);
        } catch {
          throw new Error('Invalid range');
        }

        return {
          type: 'range',
          start: value,
          end: endToken.value,
        };
      }

      if (!isValidAddress(value)) {
        throw new Error(`Invalid cell address: ${value}`);
      }

      return { type: 'ref', address: value };
    }

    throw new Error('Invalid formula syntax');
  }
}

export function parse(src) {
  if (typeof src !== 'string') {
    throw new Error('Formula source must be a string');
  }

  const tokens = tokenize(src);

  if (tokens.length === 0) {
    throw new Error('Invalid formula syntax');
  }

  const parser = new Parser(tokens);
  const expression = parser.parseExpression();

  if (parser.position !== tokens.length) {
    throw new Error('Invalid formula syntax');
  }

  return {
    type: 'expression',
    expression,
  };
}
