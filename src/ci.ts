import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { createHuman, Human, SituationContext, SituationSpecification } from "@mozaik-ai/core"
import { ModuleState } from "./board"
import { board, emit } from "./runtime"

/**
 * CI is a non-LLM participant on the same bus. It watches the board and runs
 * `node --test` for every module whose impl + tests exist and whose deps are
 * green — several suites in parallel, while the LLM agents keep working.
 */

const running = new Set<string>()

function runnable(m: ModuleState): boolean {
	const b = board()
	if (running.has(m.spec.id)) return false
	if (!["ready_for_ci", "planned", "red"].includes(m.status)) return false
	if (m.implVersion === 0 || m.testVersion === 0) return false
	if (m.lastTestedVersions === `${m.implVersion}/${m.testVersion}`) return false
	const openFix = [...b.work.values()].some((w) => w.moduleId === m.spec.id && (w.kind === "fix" || w.kind === "fixtest") && w.status !== "done" && w.status !== "cancelled")
	if (openFix) return false
	// Wait for dependencies to be green (or terminal) so a red here is this module's fault.
	return m.spec.deps.every((d) => ["green", "reviewing", "done", "failed"].includes(b.modules.get(d)?.status ?? "failed"))
}

function nodeTest(cwd: string, file: string): Promise<{ ok: boolean; output: string; ms: number }> {
	const t0 = Date.now()
	return new Promise((resolve) => {
		const child = spawn(process.execPath, ["--test", "--test-reporter=spec", file], { cwd, env: { PATH: process.env.PATH ?? "" } })
		let out = ""
		child.stdout.on("data", (d) => (out += d))
		child.stderr.on("data", (d) => (out += d))
		const timer = setTimeout(() => child.kill("SIGKILL"), 20_000)
		child.on("close", (code) => {
			clearTimeout(timer)
			resolve({ ok: code === 0, output: out.replace(/\x1b\[[0-9;]*m/g, ""), ms: Date.now() - t0 })
		})
	})
}

function testFileBroken(dir: string, file: string): boolean {
	return spawnSync(process.execPath, ["--check", file], { cwd: dir, timeout: 5000 }).status !== 0
}

function readImpl(dir: string, file: string): string {
	try {
		return fs.readFileSync(path.join(dir, file), "utf8")
	} catch {
		return "(missing)"
	}
}

function summarize(output: string): { pass: number; fail: number } {
	const pass = Number(/ℹ pass (\d+)/.exec(output)?.[1] ?? 0)
	const fail = Number(/ℹ fail (\d+)/.exec(output)?.[1] ?? 0)
	return { pass, fail }
}

function failureDigest(output: string): string {
	// Keep the failing test names + assertion messages, drop the noise.
	const lines = output.split("\n")
	const keep = lines.filter((l) => /✖|Error|expected|actual|assert|at .*\.js:\d+|SyntaxError|ReferenceError|TypeError|not a function|does not provide/i.test(l))
	return (keep.length ? keep : lines).slice(0, 80).join("\n")
}

function tick(ciId: string): void {
	const b = board()
	if (b.phase !== "building") return
	for (const m of b.modules.values()) {
		if (running.size >= b.limits.ciParallelism) return
		if (!runnable(m)) continue
		const versions = `${m.implVersion}/${m.testVersion}`
		running.add(m.spec.id)
		m.status = "testing"
		m.ciRuns++
		b.worker(ciId).status = "busy"
		emit("ci.started", ciId, { moduleId: m.spec.id, versions, run: m.ciRuns })
		nodeTest(b.workdir, `${m.spec.id}.test.js`).then(({ ok, output, ms }) => {
			running.delete(m.spec.id)
			if (running.size === 0) b.worker(ciId).status = "idle"
			m.lastTestedVersions = versions
			m.lastCiOutput = output
			const { pass, fail } = summarize(output)
			if (ok) {
				if (m.reviewRounds >= b.limits.maxReviewRounds) {
					m.status = "done"
				} else {
					m.status = "green"
					b.addWork("review", m.spec.id)
				}
			} else {
				m.fixRounds++
				if (m.fixRounds > b.limits.maxFixRounds) {
					m.status = "failed"
				} else {
					m.status = "red"
					const digest = failureDigest(output)
					const testBroken = pass === 0 && testFileBroken(b.workdir, `${m.spec.id}.test.js`)
					const stuck = m.fixRounds >= 2 && m.lastFail !== undefined && fail >= m.lastFail && m.lastFixKind !== "fixtest"
					if (testBroken || stuck) {
						// Arbitration: the coder is not making progress (or the test file itself is broken) — send it to the test author with the implementation as evidence.
						const why = testBroken ? "the test file itself fails to load" : `the implementation has been fixed ${m.fixRounds - 1}x without progress; the tests may assume details the contract does not state`
						m.lastFixKind = "fixtest"
						b.addWork("fixtest", m.spec.id, { preferredAssignee: m.testAuthor, notes: `CI arbitration: ${why}.\n\nCI output:\n${digest}\n\nCurrent implementation ${m.spec.file}:\n${readImpl(b.workdir, m.spec.file).slice(0, 6000)}` })
					} else {
						m.lastFixKind = "fix"
						b.addWork("fix", m.spec.id, { preferredAssignee: m.implAuthor, notes: `CI failed (${fail} failing, ${pass} passing):\n${digest}` })
					}
				}
				m.lastFail = fail
			}
			b.worker(ciId).completed++
			emit("ci.finished", ciId, { moduleId: m.spec.id, ok, pass, fail, ms, versions, status: m.status })
			if (m.status === "done") emit("module.done", ciId, { moduleId: m.spec.id })
			emit("board.changed", ciId, { reason: `ci ${m.spec.id} ${ok ? "green" : "red"}` })
		})
	}
}

const CI_WAKE = new Set(["artifact.submitted", "board.changed", "ci.finished", "review.finished", "module.done"])

export function createCI(): Human {
	return createHuman({
		name: "CI",
		capabilities: ["run_tests"],
		handlers: [
			{
				specification: new (class extends SituationSpecification {
					isSatisfiedBy({ event }: SituationContext) {
						return CI_WAKE.has(event.type)
					}
				})(),
				processor: { apply: (ctx) => tick(ctx.participant.getId()) },
			},
		],
	})
}

export { nodeTest, summarize }
