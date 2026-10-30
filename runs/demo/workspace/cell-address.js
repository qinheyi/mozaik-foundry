export function parseAddress(src) {
  if (typeof src !== 'string') {
    throw new Error('Invalid cell address');
  }

  const match = /^([A-Z]+)([1-9][0-9]*)$/.exec(src);
  if (!match) {
    throw new Error(`Invalid cell address: ${src}`);
  }

  let column = 0;
  for (const character of match[1]) {
    column = column * 26 + character.charCodeAt(0) - 64;
  }

  const row = Number(match[2]);
  if (!Number.isSafeInteger(column) || !Number.isSafeInteger(row)) {
    throw new Error(`Invalid cell address: ${src}`);
  }

  return { column, row };
}

export function formatAddress(column, row) {
  if (
    !Number.isInteger(column) ||
    !Number.isInteger(row) ||
    column <= 0 ||
    row <= 0
  ) {
    throw new Error('Invalid cell coordinates');
  }

  let letters = '';
  let remaining = column;

  while (remaining > 0) {
    const remainder = (remaining - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    remaining = Math.floor((remaining - 1) / 26);
  }

  return `${letters}${row}`;
}

export function parseRange(src) {
  if (typeof src !== 'string') {
    throw new Error('Invalid cell range');
  }

  const parts = src.split(':');
  if (parts.length !== 2) {
    throw new Error(`Invalid cell range: ${src}`);
  }

  const start = parseAddress(parts[0]);
  const end = parseAddress(parts[1]);

  return { start, end };
}

export function compareAddresses(a, b) {
  if (a.row !== b.row) {
    return a.row < b.row ? -1 : 1;
  }

  if (a.column !== b.column) {
    return a.column < b.column ? -1 : 1;
  }

  return 0;
}
