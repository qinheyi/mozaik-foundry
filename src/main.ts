import "dotenv/config"
import fs from "node:fs"
import path from "node:path"
import { createHuman } from "@mozaik-ai/core"
import { createArchitect, createCoder, createReviewer, createTester, registerRoster } from "./agents"
import { FoundryState } from "./board"
import { createCI, nodeTest, summarize } from "./ci"
import { FoundryRunner, MODEL } from "./llm"
import { consoleSink, createObserver, Recorded, Recorder } from "./observer"
import { board, emit, initializeRuntime, join, sendMessage } from "./runtime"
import { startServer } from "./server"

const warn = console.warn
console.warn = (...a: unknown[]) => (String(a[0]).startsWith("mozaik cloud: no API key") ? undefined : warn(...a))

/* ------------------------------- CLI args ------------------------------- */
const argv = process.argv.slice(2)
const arg = (name: string, dflt?: string) => {
	const i = argv.indexOf(`--${name}`)
	return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt
}
const flag = (name: string) => argv.includes(`--${name}`)

const specPath = arg("spec", "specs/spreadsheet.md")!
const replay = arg("replay")
const runName = arg("name", replay ? "replay" : `run-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}`)!
const nCoders = Number(arg("coders", "3"))
const nTesters = Number(arg("testers", "2"))
const nReviewers = Number(arg("reviewers", "1"))
const port = Number(arg("port", "4321"))
const timeoutMin = Number(arg("timeout", "25"))

const outDir = path.resolve("runs", runName)
const workdir = path.join(outDir, "workspace")
fs.rmSync(workdir, { recursive: true, force: true })
fs.mkdirSync(workdir, { recursive: true })

if (!replay && !process.env.MINIMAX_API_KEY) {
	console.error("MINIMAX_API_KEY is not set. Use --replay runs/demo/cassette.json to replay a recorded run for free.")
	process.exit(1)
}

/* ------------------------------- runtime -------------------------------- */
const state = new FoundryState(workdir, { maxCalls: Number(arg("max-calls", "40")), maxTokens: Number(arg("max-tokens", "600000")) })
const runner = new FoundryRunner(replay ? "replay" : "live", replay ? path.resolve(replay) : path.join(outDir, "cassette.json"), Number(arg("speed", "1")))
initializeRuntime({ state, inferenceRunnerConfig: { runner } })

const recorder = new Recorder()
recorder.onEvent(consoleSink)

const client = createHuman({ name: "Client", capabilities: ["submit_spec"], handlers: [] })
const ci = createCI()
const roster = {
	architect: createArchitect(),
	coders: Array.from({ length: nCoders }, (_, i) => createCoder(`Coder-${i + 1}`)),
	testers: Array.from({ length: nTesters }, (_, i) => createTester(`Tester-${i + 1}`)),
	reviewers: Array.from({ length: nReviewers }, (_, i) => createReviewer(nReviewers > 1 ? `Reviewer-${i + 1}` : "Reviewer")),
}

join(createObserver(recorder))
join(client)
state.registerWorker(ci.getId(), "CI", "ci")
registerRoster(roster)
join(ci)
join(roster.architect)
for (const a of [...roster.coders, ...roster.testers, ...roster.reviewers]) join(a)

let finalReport: unknown = null
if (flag("ui")) startServer(port, recorder, () => finalReport)

console.log(`Mozaik Foundry — model ${MODEL}${replay ? " (replay)" : ""} — ${nCoders} coders, ${nTesters} testers, ${nReviewers} reviewer(s) — spec ${specPath}`)
const spec = fs.readFileSync(specPath, "utf8")
setTimeout(() => sendMessage(spec, client.getId()), flag("ui") ? 1500 : 0)

/* --------------------------- watchdog / release -------------------------- */
const deadline = Date.now() + timeoutMin * 60_000
const watchdog = setInterval(() => {
	const b = board()
	if (b.phase === "building" && b.allTerminal()) return void release("all modules terminal")
	const anyBusy = [...b.workers.values()].some((w) => w.status === "busy")
	if (b.phase === "building" && !anyBusy && !b.canSpend()) return void release("budget exhausted")
	if (Date.now() > deadline && b.phase !== "released") return void release("timeout")
	if (b.phase === "aborted") return void release("plan failed")
}, 1000)

let releasing = false
async function release(reason: string) {
	if (releasing) return
	releasing = true
	clearInterval(watchdog)
	const b = board()
	const wasAborted = b.phase === "aborted"
	b.phase = "released"
	const full = wasAborted ? { ok: false, output: "", ms: 0 } : await nodeTest(workdir, ".")
	const totals = summarize(full.output)
	const doneCount = [...b.modules.values()].filter((m) => m.status === "done").length
	const metrics = computeMetrics(recorder.events)
	writeProjectReadme(b, totals)
	emit("run.released", ci.getId(), { ok: full.ok && doneCount === b.modules.size, reason, pass: totals.pass, fail: totals.fail, metrics })
	await new Promise((r) => setTimeout(r, 50))
	finalReport = {
		runName,
		model: MODEL,
		replay: !!replay,
		spec,
		reason,
		tests: totals,
		metrics,
		budget: b.budget,
		peakInFlightInference: runner.peakInFlight,
		modules: b.snapshot().modules,
		files: Object.fromEntries([...b.files.entries()].map(([p, f]) => [p, { ...f }]).concat([["README.md", { content: fs.readFileSync(path.join(workdir, "README.md"), "utf8"), author: "Foundry", version: 1 }]])),
		events: recorder.events,
	}
	fs.writeFileSync(path.join(outDir, "run.json"), JSON.stringify(finalReport))
	fs.writeFileSync(path.join(outDir, "full-test-output.txt"), full.output)
	printSummary(b, totals, metrics, reason)
	if (!flag("ui")) process.exit(0)
	console.log(`(UI still serving on http://localhost:${port}/?live=1 — Ctrl+C to quit)`)
}

type Metrics = ReturnType<typeof computeMetrics>
function computeMetrics(events: Recorded[]) {
	const open = new Map<string, number>()
	const spans: { who: string; start: number; end: number; label: string }[] = []
	for (const e of events) {
		const d = e.data as any
		if (e.type === "inference.started") open.set(`${e.by}`, e.t)
		if (e.type === "model.answer" && open.has(e.by)) {
			spans.push({ who: e.by, start: open.get(e.by)!, end: e.t, label: "llm" })
			open.delete(e.by)
		}
		if (e.type === "ci.started") open.set(`CI:${d.moduleId}`, e.t)
		if (e.type === "ci.finished" && open.has(`CI:${d.moduleId}`)) {
			spans.push({ who: `CI:${d.moduleId}`, start: open.get(`CI:${d.moduleId}`)!, end: e.t, label: "ci" })
			open.delete(`CI:${d.moduleId}`)
		}
	}
	const wall = events.length ? events[events.length - 1].t - events[0].t : 0
	const busy = spans.reduce((s, x) => s + (x.end - x.start), 0)
	// Peak number of overlapping LLM spans
	const pts = spans.filter((s) => s.label === "llm").flatMap((s) => [[s.start, 1], [s.end, -1]] as [number, number][]).sort((a, b) => a[0] - b[0] || a[1] - b[1])
	let cur = 0
	let peak = 0
	for (const [, d] of pts) peak = Math.max(peak, (cur += d))
	return { wallMs: wall, agentBusyMs: busy, parallelism: wall ? +(busy / wall).toFixed(2) : 0, peakConcurrentLLM: peak, llmCalls: spans.filter((s) => s.label === "llm").length, ciRuns: spans.filter((s) => s.label === "ci").length }
}

function writeProjectReadme(b: FoundryState, totals: { pass: number; fail: number }) {
	const rows = [...b.modules.values()].map((m) => `| ${m.spec.id} | ${m.spec.file} | ${m.status} | ${b.workers.get(m.implAuthor ?? "")?.name ?? "-"} | ${b.workers.get(m.testAuthor ?? "")?.name ?? "-"} | ${m.ciRuns} | ${m.spec.purpose} |`)
	const md = `# ${b.projectName}\n\nGenerated by **Mozaik Foundry** from this spec:\n\n> ${b.spec.trim().split("\n").join("\n> ")}\n\n| module | file | status | coder | tests by | CI runs | purpose |\n|---|---|---|---|---|---|---|\n${rows.join("\n")}\n\nFull suite: **${totals.pass} passing, ${totals.fail} failing** (\`npm test\`).\n`
	fs.writeFileSync(path.join(b.workdir, "README.md"), md)
}

function printSummary(b: FoundryState, totals: { pass: number; fail: number }, m: Metrics, reason: string) {
	console.log("\n================ Mozaik Foundry summary ================")
	console.log(`project ${b.projectName} — ${reason}`)
	for (const mod of b.modules.values()) console.log(`  ${mod.status.padEnd(8)} ${mod.spec.id.padEnd(16)} CI runs ${mod.ciRuns}, fixes ${mod.fixRounds}, reviews ${mod.reviewRounds}`)
	console.log(`tests: ${totals.pass} pass / ${totals.fail} fail`)
	console.log(`wall ${(m.wallMs / 1000).toFixed(1)}s, summed agent work ${(m.agentBusyMs / 1000).toFixed(1)}s → parallelism ×${m.parallelism}, peak ${m.peakConcurrentLLM} concurrent LLM loops`)
	console.log(`LLM calls ${b.budget.calls}, tokens ${b.budget.tokens}; output in ${path.relative(process.cwd(), outDir)}/`)
}

process.on("unhandledRejection", (e) => console.error("unhandledRejection", e))
