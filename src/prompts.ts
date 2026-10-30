import { FoundryState, ModuleSpec } from "./board"

const contract = (m: ModuleSpec) =>
	`### ${m.id} (${m.file})\nPurpose: ${m.purpose}\nExports:\n${m.exports.map((e) => `- ${e}`).join("\n")}\nDepends on: ${m.deps.join(", ") || "nothing"}\nAcceptance:\n${m.acceptance.map((a) => `- ${a}`).join("\n")}`

const depContracts = (b: FoundryState, m: ModuleSpec) =>
	m.deps.map((d) => b.modules.get(d)).filter(Boolean).map((d) => contract(d!.spec)).join("\n\n") || "(none)"

/** Real code of dependencies that already passed CI — lets an integrating module match their actual data shapes. */
const depSources = (b: FoundryState, m: ModuleSpec) => {
	const parts = m.deps
		.map((d) => b.modules.get(d))
		.filter((d) => d && d.status === "done" && b.files.has(d.spec.file))
		.map((d) => `Actual ${d!.spec.file} (already green; match its exported data shapes exactly):\n\`\`\`js\n${b.files.get(d!.spec.file)!.content.slice(0, 5000)}\n\`\`\``)
	return parts.length ? `\n${parts.join("\n\n")}\n` : ""
}

export const ARCHITECT = `You are the Architect of a small software factory. You turn a product spec into a set of independent JavaScript modules with precise contracts, so several coders and test writers can work IN PARALLEL without seeing each other's code. Be concise and exact.`
export const CODER = `You are a senior JavaScript engineer in a software factory. You implement exactly one module against its contract. Plain ESM JavaScript for Node 20, no npm packages. Output only code in a single \`\`\`js block.`
export const TESTER = `You are a test engineer in a software factory. You write tests from the CONTRACT only (you never see the implementation). Use node:test and node:assert/strict. Output only code in a single \`\`\`js block.`
export const REVIEWER = `You are a strict but pragmatic code reviewer. You approve code that satisfies its contract; you request changes only for real defects, never for style. Reply with JSON only.`

export function planPrompt(spec: string): string {
	return `Product spec:
"""
${spec.trim()}
"""

Split this into 3 to 5 modules. Rules:
- Each module is ONE file of plain ESM JavaScript (Node 20, no npm deps), file name "<id>.js", id is lowercase-kebab.
- "exports" lists every exported function/class with exact signature, types of inputs/outputs, and error behaviour (e.g. "parse(src: string): Node — throws Error on unknown token").
- When modules exchange data structures (AST nodes, tokens, records), the producing module's exports must spell out the EXACT shape, including every "type" string and field name (e.g. "{type:'ref', address:string}"), and consumers must use the same shape.
- "deps" lists module ids this module imports. The graph must be acyclic. Prefer few deps so work can run in parallel.
- "acceptance" lists 3-6 concrete, testable behaviours with example inputs/outputs.
Reply with JSON only, no prose:
{"project":"kebab-name","modules":[{"id":"...","file":"....js","purpose":"...","exports":["..."],"deps":["..."],"acceptance":["..."]}]}`
}

export function implPrompt(b: FoundryState, m: ModuleSpec, notes?: string): string {
	return `Project spec (for context):
"""
${b.spec.trim()}
"""

Implement this module:
${contract(m)}

Contracts of modules you may import (import them as './<file>'; they are written by other engineers in parallel, rely only on the contract):
${depContracts(b, m)}

Write the complete file ${m.file}. Use named ESM exports exactly as in the contract.${retryNote(notes)}`
}

const retryNote = (notes?: string) => (notes ? `\n\nIMPORTANT — your previous attempt was rejected: ${notes}` : "")

export function testPrompt(b: FoundryState, m: ModuleSpec, notes?: string): string {
	return `Write the test file ${m.id}.test.js for this module contract:
${contract(m)}

Contracts of its dependencies (the real implementations will be present next to it):
${depContracts(b, m)}

Rules: import { test } from 'node:test'; import assert from 'node:assert/strict'; import the module from './${m.file}'.
Write 5-8 focused tests that cover the acceptance criteria and the documented error behaviour. Only test behaviour the contract states. No snapshot tests, no timing, no filesystem, no network. Keep the file under 150 lines.${retryNote(notes)}`
}

export function fixPrompt(b: FoundryState, m: ModuleSpec, code: string, tests: string, feedback: string): string {
	return `Your module ${m.file} needs a fix.
${contract(m)}

Contracts of dependencies:
${depContracts(b, m)}
${depSources(b, m)}
Current ${m.file}:
\`\`\`js
${code}
\`\`\`

Tests (${m.id}.test.js, written from the contract by another engineer):
\`\`\`js
${tests}
\`\`\`

Feedback:
"""
${feedback.slice(0, 3500)}
"""

If and only if you are certain a failing TEST contradicts the contract, reply with a first line "TEST_BUG: <one-sentence reason>" and nothing else.
Otherwise reply with the full corrected ${m.file} in one \`\`\`js block.`
}

export function fixTestPrompt(m: ModuleSpec, tests: string, feedback: string): string {
	return `Your test file for ${m.file} needs attention (CI reports a problem, or the implementer disputes a test).
${contract(m)}

Current ${m.id}.test.js:
\`\`\`js
${tests}
\`\`\`

Report and CI output:
"""
${feedback.slice(0, 3500)}
"""

Fix the file: repair syntax errors, and fix tests that contradict the contract or assume details the contract does not state (adapt those to the implementation's reasonable choice). Keep tests that are correct. Reply with the full corrected ${m.id}.test.js in one \`\`\`js block.`
}

export function reviewPrompt(m: ModuleSpec, code: string, tests: string, ciOutput: string): string {
	return `Review ${m.file}. CI is green.
${contract(m)}

Code:
\`\`\`js
${code}
\`\`\`

Tests:
\`\`\`js
${tests}
\`\`\`

CI summary:
${ciOutput.slice(-800)}

Reply JSON only: {"verdict":"approve"|"changes","notes":"<max 3 short bullet points; for changes, name the exact defect vs the contract>"}`
}

export function extractCode(text: string): string | undefined {
	// An opened but never closed fence means the answer was cut off — reject it rather than ship half a file.
	const fences = (text.match(/```/g) ?? []).length
	if (fences % 2 === 1) return undefined
	const blocks = [...text.matchAll(/```(?:js|javascript|mjs)?\s*\n([\s\S]*?)```/g)].map((m) => m[1])
	if (blocks.length) return blocks.sort((a, b) => b.length - a.length)[0].trim() + "\n"
	if (/\b(export|import)\b/.test(text) && !text.startsWith("ERROR")) return text.trim() + "\n"
	return undefined
}

export function extractJson<T>(text: string): T | undefined {
	const start = text.indexOf("{")
	const end = text.lastIndexOf("}")
	if (start < 0 || end <= start) return undefined
	try {
		return JSON.parse(text.slice(start, end + 1)) as T
	} catch {
		return undefined
	}
}
