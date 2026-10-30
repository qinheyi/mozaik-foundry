export function columnToIndex(column) {
  if (typeof column !== "string" || column.length === 0) {
    throw new Error("Invalid column label");
  }

  let index = 0;
  for (let i = 0; i < column.length; i += 1) {
    const code = column.charCodeAt(i);
    if (code < 65 || code > 90) {
      throw new Error("Invalid column label");
    }
    index = index * 26 + (code - 64);
  }

  return index - 1;
}

export function indexToColumn(index) {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error("Invalid column index");
  }

  let column = "";
  let current = index + 1;

  while (current > 0) {
    const remainder = (current - 1) % 26;
    column = String.fromCharCode(65 + remainder) + column;
    current = Math.floor((current - 1) / 26);
  }

  return column;
}

export function parseAddress(address) {
  if (typeof address !== "string") {
    throw new Error("Invalid cell address");
  }

  const match = /^([A-Z]+)([1-9][0-9]*)$/.exec(address);
  if (!match) {
    throw new Error("Invalid cell address");
  }

  return {
    row: Number(match[2]) - 1,
    column: columnToIndex(match[1]),
  };
}

export function formatAddress(row, column) {
  if (!Number.isInteger(row) || row < 0) {
    throw new Error("Invalid row index");
  }
  if (!Number.isInteger(column) || column < 0) {
    throw new Error("Invalid column index");
  }

  return `${indexToColumn(column)}${row + 1}`;
}
