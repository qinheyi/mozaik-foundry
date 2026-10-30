const SUPPORTED_TYPES = new Set(["string", "number"]);

function assertSupportedValue(value) {
  if (
    value === null ||
    !SUPPORTED_TYPES.has(typeof value) ||
    (typeof value === "number" && !Number.isFinite(value))
  ) {
    throw new Error(`Unsupported CSV value: ${String(value)}`);
  }
}

function quoteField(value) {
  assertSupportedValue(value);
  const text = String(value);

  return /[",\r\n]/.test(text)
    ? `"${text.replaceAll('"', '""')}"`
    : text;
}

export function toCsv(rows) {
  if (!Array.isArray(rows)) {
    throw new Error("CSV rows must be an array");
  }

  const width = rows.length === 0 ? 0 : rows[0].length;

  if (!Number.isInteger(width) || width < 0) {
    throw new Error("Invalid CSV row width");
  }

  return rows
    .map((row) => {
      if (!Array.isArray(row)) {
        throw new Error("Each CSV row must be an array");
      }

      if (row.length !== width) {
        throw new Error("CSV rows must not be ragged");
      }

      return row.map(quoteField).join(",");
    })
    .join("\n");
}

export function fromCsv(src) {
  if (typeof src !== "string") {
    throw new Error("CSV source must be a string");
  }

  if (src === "") {
    return [];
  }

  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let fieldWasQuoted = false;
  let atFieldStart = true;
  let i = 0;

  const finishField = () => {
    row.push(field);
    field = "";
    fieldWasQuoted = false;
    atFieldStart = true;
  };

  const finishRow = () => {
    finishField();
    rows.push(row);
    row = [];
  };

  while (i < src.length) {
    const char = src[i];

    if (inQuotes) {
      if (char === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }

        inQuotes = false;
        i += 1;

        if (
          i < src.length &&
          src[i] !== "," &&
          src[i] !== "\r" &&
          src[i] !== "\n"
        ) {
          throw new Error("Malformed CSV quoting");
        }

        continue;
      }

      field += char;
      i += 1;
      continue;
    }

    if (char === '"') {
      if (!atFieldStart) {
        throw new Error("Malformed CSV quoting");
      }

      inQuotes = true;
      fieldWasQuoted = true;
      atFieldStart = false;
      i += 1;
      continue;
    }

    if (char === ",") {
      finishField();
      i += 1;
      continue;
    }

    if (char === "\r" || char === "\n") {
      if (char === "\r" && src[i + 1] === "\n") {
        i += 1;
      }

      finishRow();
      i += 1;
      continue;
    }

    if (fieldWasQuoted) {
      throw new Error("Malformed CSV quoting");
    }

    field += char;
    atFieldStart = false;
    i += 1;
  }

  if (inQuotes) {
    throw new Error("Malformed CSV quoting");
  }

  if (field.length > 0 || row.length > 0 || atFieldStart === false) {
    finishRow();
  }

  return rows;
}
