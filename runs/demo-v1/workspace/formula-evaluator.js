export function evaluateRange(node, context) {
  if (!node || node.type !== "range") {
    throw new Error("Expected a range node");
  }

  const values = context.getRange(node.start, node.end);
  return Array.isArray(values) ? values : [];
}

export function evaluateFormula(node, context) {
  if (!node || typeof node !== "object") {
    return "#DIV/0";
  }

  switch (node.type) {
    case "number":
      return node.value;

    case "cell": {
      const value = context.getCell(node.row, node.column);
      return coerceValue(value);
    }

    case "range":
      return evaluateRange(node, context).map(coerceValue);

    case "unary": {
      const operand = evaluateFormula(node.operand, context);

      if (isError(operand)) {
        return operand;
      }

      const value = toNumber(operand);
      if (isError(value)) {
        return value;
      }

      return node.op === "-" ? -value : value;
    }

    case "binary": {
      const left = evaluateFormula(node.left, context);
      if (isError(left)) {
        return left;
      }

      const right = evaluateFormula(node.right, context);
      if (isError(right)) {
        return right;
      }

      const leftNumber = toNumber(left);
      if (isError(leftNumber)) {
        return leftNumber;
      }

      const rightNumber = toNumber(right);
      if (isError(rightNumber)) {
        return rightNumber;
      }

      switch (node.op) {
        case "+":
          return leftNumber + rightNumber;
        case "-":
          return leftNumber - rightNumber;
        case "*":
          return leftNumber * rightNumber;
        case "/":
          return rightNumber === 0 ? "#DIV/0" : leftNumber / rightNumber;
        default:
          return "#DIV/0";
      }
    }

    case "call": {
      const values = evaluateRange(node.range, context);
      const numbers = [];

      for (const value of values) {
        const coerced = coerceValue(value);
        if (isError(coerced)) {
          return coerced;
        }

        const number = toNumber(coerced);
        if (isError(number)) {
          return number;
        }

        numbers.push(number);
      }

      switch (node.name) {
        case "SUM":
          return numbers.reduce((sum, value) => sum + value, 0);
        case "AVG":
          return numbers.length === 0
            ? "#DIV/0"
            : numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
        case "MIN":
          return numbers.length === 0 ? 0 : Math.min(...numbers);
        case "MAX":
          return numbers.length === 0 ? 0 : Math.max(...numbers);
        default:
          return "#DIV/0";
      }
    }

    default:
      return "#DIV/0";
  }
}

function isError(value) {
  return value === "#CYCLE" || value === "#DIV/0";
}

function coerceValue(value) {
  if (value === undefined || value === null || value === "") {
    return 0;
  }

  return value;
}

function toNumber(value) {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "string") {
    if (isError(value)) {
      return value;
    }

    const number = Number(value);
    return Number.isNaN(number) ? "#DIV/0" : number;
  }

  return "#DIV/0";
}
