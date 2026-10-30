# Mini spreadsheet engine

Build a tiny in-memory spreadsheet library in plain JavaScript.

- Cells are addressed like A1, B2, AA10. Each cell holds either a number, a string, or a formula starting with "=".
- Formulas support numbers, cell references, + - * / with normal precedence, parentheses, and the functions SUM(range), AVG(range), MIN(range), MAX(range) where a range looks like A1:B3.
- Setting a cell recalculates every cell that depends on it (directly or transitively), in dependency order.
- A circular reference (e.g. A1 = B1, B1 = A1) must not crash: every cell in the cycle evaluates to the error value "#CYCLE".
- Referencing an empty cell counts as 0. Dividing by zero yields "#DIV/0".
- The sheet can be exported to CSV (rows 1..maxRow, columns A..maxCol, computed values) and imported from CSV (raw values/formulas).
