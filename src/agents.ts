import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import {
	Agent,
	createAgent,
	DeveloperMessageItem,
	ModelContext,
	ModelMessageItem,
	SituationContext,
	SituationHandler,
	SituationProcessor,
	SituationSpecification,
} from "@mozaik-ai/core"
import { ModuleSpec, WorkItem, WorkKind, WorkerState } from "./board"
import { contextTags, MODEL } from "./llm"
import * as P from "./prompts"
import { board, emit, emitNow, runLoop } from "./runtime"

/* ------------------------------------------------------------------ */
/* Shared plumbing                                                     */
/* ------------------------------------------------------------------ */

const keyCounters = new Map<string, number>()

/**
 * Each work item gets a fresh, task-scoped ModelContext (system prompt + one
 * user turn). Tokens stay flat no matter how long the run is, and the tag
 * lets the runner record / replay the call deterministically.
 */
function startInference(agent: Agent, tag: string, prompt: string): void {
	const n = (keyCounters.get(tag) ?? 0) + 1
	keyCounters.set(tag, n)
	const context = ModelContext.create().addContextItem(DeveloperMessageItem.create(agent.getDeveloperMessage()))
	contextTags.set(context.id, `${tag}#${n}`)
	runLoop(agent.getId(), prompt, { model: MODEL, context, tools: [] })
}

const WAKE_EVENTS = new Set(["participant.joined", "board.planned", "board.changed", "artifact.submitted", "ci.finished", "review.finished"])

/** "There might be work for me": any board event while I'm idle. */
class WakeSpecification extends SituationSpecification {
	isSatisfiedBy({ event, participant }: SituationContext): boolean {
		if (!WAKE_EVENTS.has(event.type)) return false
		const w = board().workers.get(participant.getId())
		return !!w && w.status === "idle" && board().phase === "building"
	}
}

/** My own Mozaik agent loop produced an answer. */
class OwnAnswerSpecification extends SituationSpecification {
	isSatisfiedBy({ event, participant }: SituationContext): boolean {
		return event.type === "model.answer" && event.producerId === participant.getId()
	}
}

const answerText = (ctx: SituationContext) => ((ctx.event.payload as { answer: ModelMessageItem }).answer?.content?.text ?? "").trim()

const fileOf = (id: string) => board().files.get(id)?.content ?? ""

/** `node --check` on generated code before it lands on the board; a truncated or broken answer is re-queued instead. */
function syntaxError(code: string): string | undefined {
	const tmp = path.join(board().workdir, `.check-${process.pid}-${Math.random().toString(36).slice(2)}.mjs`)
	fs.writeFileSync(tmp, code)
	try {
		const r = spawnSync(process.execPath, ["--check", tmp], { encoding: "utf8", timeout: 5000 })
		if (r.status === 0) return undefined
		return (r.stderr || "syntax error").split("\n").filter((l) => /Error|^\s*\^|:\d+$/.test(l)).slice(0, 4).join(" ").replace(tmp, "file")
	} finally {
		fs.rmSync(tmp, { force: true })
	}
}

const MAX_ATTEMPTS = 3

/** Shared guard for coder/tester answers: returns code, or re-queues the item with a note and returns undefined. */
function acceptCode(agentId: string, item: WorkItem, text: string, file: string): string | undefined {
	const b = board()
	const code = P.extractCode(text)
	const problem = !code ? "no complete ```js block (answer cut off?) — keep it shorter" : syntaxError(code)
	if (!problem) return code
	if (item.attempt < MAX_ATTEMPTS) {
		b.addWork(item.kind, item.moduleId, { preferredAssignee: agentId, notes: `${problem}${item.notes ? "\n\n" + item.notes : ""}`.slice(0, 4000), attempt: item.attempt + 1 })
		note(agentId, `rejected own ${file} (${problem.slice(0, 80)}), retrying`, { moduleId: item.moduleId })
	} else {
		const m = b.module(item.moduleId)
		m.status = "failed"
		note(agentId, `gave up on ${file} after ${item.attempt} attempts`, { moduleId: item.moduleId })
		emit("board.changed", agentId, { reason: "gave up" })
	}
	return undefined
}

function persist(file: string, content: string, author: string): number {
	const b = board()
	const v = b.writeFile(file, content, author)
	fs.writeFileSync(path.join(b.workdir, file), content)
	return v
}

function note(agentId: string, text: string, extra: Record<string, unknown> = {}) {
	emitNow("agent.note", agentId, { text, ...extra })
}

/** Worker = claim-on-wake + act-on-own-answer. Roles differ only in which work they claim and how they apply results. */
function workerHandlers(
	kinds: WorkKind[],
	start: (agent: Agent, item: WorkItem) => void,
	finish: (agent: Agent, item: WorkItem, text: string) => void,
): SituationHandler[] {
	const claim: SituationProcessor = {
		apply(ctx) {
			const agent = ctx.participant as Agent
			const item = board().tryClaim(agent.getId(), kinds)
			if (!item) return
			note(agent.getId(), `claimed ${item.kind}:${item.moduleId}`, { workItemId: item.id, kind: item.kind, moduleId: item.moduleId })
			start(agent, item)
		},
	}
	const done: SituationProcessor = {
		apply(ctx) {
			const agent = ctx.participant as Agent
			const item = board().currentItem(agent.getId())
			if (!item) return
			try {
				finish(agent, item, answerText(ctx))
			} catch (e) {
				console.error(`${agent.getManifest().name} failed to apply result`, e)
			}
			board().complete(agent.getId())
			emit("board.changed", agent.getId(), { reason: `${item.kind}:${item.moduleId} finished` })
		},
	}
	return [
		{ specification: new WakeSpecification(), processor: claim },
		{ specification: new OwnAnswerSpecification(), processor: done },
	]
}

/* ------------------------------------------------------------------ */
/* Architect: spec -> module contracts -> work items                   */
/* ------------------------------------------------------------------ */

export function createArchitect(): Agent {
	const onSpec: SituationHandler = {
		specification: new (class extends SituationSpecification {
			isSatisfiedBy({ event }: SituationContext) {
				return event.type === "message.sent" && board().phase === "idle"
			}
		})(),
		processor: {
			apply(ctx) {
				const agent = ctx.participant as Agent
				const b = board()
				b.spec = (ctx.event.payload as { message: string }).message
				b.phase = "planning"
				b.worker(agent.getId()).status = "busy"
				note(agent.getId(), "planning modules from spec")
				startInference(agent, "plan|root", P.planPrompt(b.spec))
			},
		},
	}
	const onPlan: SituationHandler = {
		specification: new OwnAnswerSpecification(),
		processor: {
			apply(ctx) {
				const agent = ctx.participant as Agent
				const b = board()
				const plan = P.extractJson<{ project: string; modules: ModuleSpec[] }>(answerText(ctx))
				b.worker(agent.getId()).status = "idle"
				if (!plan?.modules?.length) {
					b.phase = "aborted"
					note(agent.getId(), "could not parse a plan: " + answerText(ctx).slice(0, 300))
					emit("run.released", agent.getId(), { ok: false, reason: "plan parse failed" })
					return
				}
				const ids = new Set(plan.modules.map((m) => m.id))
				const modules = plan.modules.map((m) => ({
					...m,
					file: m.file || `${m.id}.js`,
					deps: (m.deps ?? []).filter((d) => ids.has(d) && d !== m.id),
					exports: m.exports ?? [],
					acceptance: m.acceptance ?? [],
				}))
				b.projectName = plan.project || "foundry-project"
				b.addModules(modules)
				b.phase = "building"
				fs.writeFileSync(path.join(b.workdir, "package.json"), JSON.stringify({ name: b.projectName, type: "module", private: true, scripts: { test: "node --test" } }, null, 2))
				fs.writeFileSync(path.join(b.workdir, "PLAN.json"), JSON.stringify(plan, null, 2))
				b.worker(agent.getId()).completed++
				note(agent.getId(), `planned ${modules.length} modules: ${modules.map((m) => m.id + (m.deps.length ? `(<-${m.deps.join(",")})` : "")).join(" ")}`)
				emit("board.planned", agent.getId(), { modules: modules.map((m) => m.id) })
			},
		},
	}
	return createAgent({ name: "Architect", capabilities: ["plan"], instruction: P.ARCHITECT, tools: [], handlers: [onSpec, onPlan] })
}

/* ------------------------------------------------------------------ */
/* Coder: impl + fix                                                   */
/* ------------------------------------------------------------------ */

export function createCoder(name: string): Agent {
	return createAgent({
		name,
		capabilities: ["impl", "fix"],
		instruction: P.CODER,
		tools: [],
		handlers: workerHandlers(
			["fix", "impl"],
			(agent, item) => {
				const b = board()
				const m = b.module(item.moduleId)
				if (item.kind === "impl") return startInference(agent, `impl|${m.spec.id}`, P.implPrompt(b, m.spec, item.attempt > 1 ? item.notes : undefined))
				startInference(agent, `fix|${m.spec.id}`, P.fixPrompt(b, m.spec, fileOf(m.spec.file), fileOf(`${m.spec.id}.test.js`), item.notes ?? ""))
			},
			(agent, item, text) => {
				const b = board()
				const m = b.module(item.moduleId)
				if (item.kind === "fix" && /^\s*TEST_BUG:/i.test(text)) {
					const reason = text.split("\n")[0].replace(/^\s*TEST_BUG:\s*/i, "")
					b.addWork("fixtest", m.spec.id, { preferredAssignee: m.testAuthor, notes: `Implementer says: ${reason}\n\nCI output:\n${m.lastCiOutput ?? ""}` })
					note(agent.getId(), `disputes tests of ${m.spec.id}: ${reason}`, { moduleId: m.spec.id })
					return
				}
				const code = acceptCode(agent.getId(), item, text, m.spec.file)
				if (!code) return
				m.implAuthor = m.implAuthor ?? agent.getId()
				m.implVersion = persist(m.spec.file, code, agent.getManifest().name)
				if (m.status === "planned" && m.testVersion > 0) m.status = "ready_for_ci"
				if (m.status === "red") m.status = "ready_for_ci"
				emit("artifact.submitted", agent.getId(), { moduleId: m.spec.id, file: m.spec.file, version: m.implVersion, kind: item.kind })
			},
		),
	})
}

/* ------------------------------------------------------------------ */
/* Test writer: tests from contract only (runs in parallel with coder) */
/* ------------------------------------------------------------------ */

export function createTester(name: string): Agent {
	return createAgent({
		name,
		capabilities: ["test", "fixtest"],
		instruction: P.TESTER,
		tools: [],
		handlers: workerHandlers(
			["fixtest", "test"],
			(agent, item) => {
				const b = board()
				const m = b.module(item.moduleId)
				if (item.kind === "test") return startInference(agent, `test|${m.spec.id}`, P.testPrompt(b, m.spec, item.attempt > 1 ? item.notes : undefined))
				startInference(agent, `fixtest|${m.spec.id}`, P.fixTestPrompt(m.spec, fileOf(`${m.spec.id}.test.js`), item.notes ?? ""))
			},
			(agent, item, text) => {
				const b = board()
				const m = b.module(item.moduleId)
				const code = acceptCode(agent.getId(), item, text, `${m.spec.id}.test.js`)
				if (!code) return
				m.testAuthor = m.testAuthor ?? agent.getId()
				m.testVersion = persist(`${m.spec.id}.test.js`, code, agent.getManifest().name)
				if (m.status === "planned" && m.implVersion > 0) m.status = "ready_for_ci"
				if (m.status === "red") m.status = "ready_for_ci"
				emit("artifact.submitted", agent.getId(), { moduleId: m.spec.id, file: `${m.spec.id}.test.js`, version: m.testVersion, kind: item.kind })
			},
		),
	})
}

/* ------------------------------------------------------------------ */
/* Reviewer                                                            */
/* ------------------------------------------------------------------ */

export function createReviewer(name: string): Agent {
	return createAgent({
		name,
		capabilities: ["review"],
		instruction: P.REVIEWER,
		tools: [],
		handlers: workerHandlers(
			["review"],
			(agent, item) => {
				const m = board().module(item.moduleId)
				m.status = "reviewing"
				startInference(agent, `review|${m.spec.id}`, P.reviewPrompt(m.spec, fileOf(m.spec.file), fileOf(`${m.spec.id}.test.js`), m.lastCiOutput ?? ""))
			},
			(agent, item, text) => {
				const b = board()
				const m = b.module(item.moduleId)
				const verdict = P.extractJson<{ verdict: string; notes: string }>(text) ?? { verdict: "approve", notes: "(unparseable review, defaulting to approve)" }
				m.reviewRounds++
				m.reviewNotes = verdict.notes
				if (verdict.verdict === "changes" && m.fixRounds < b.limits.maxFixRounds) {
					m.status = "red"
					b.addWork("fix", m.spec.id, { preferredAssignee: m.implAuthor, notes: `Code review requested changes:\n${verdict.notes}` })
				} else {
					m.status = "done"
					emit("module.done", agent.getId(), { moduleId: m.spec.id })
				}
				emit("review.finished", agent.getId(), { moduleId: m.spec.id, verdict: verdict.verdict, notes: verdict.notes })
			},
		),
	})
}

export type Roster = { architect: Agent; coders: Agent[]; testers: Agent[]; reviewers: Agent[] }

export function registerRoster(r: Roster): void {
	const b = board()
	const reg = (a: Agent, role: WorkerState["role"]) => b.registerWorker(a.getId(), a.getManifest().name, role)
	reg(r.architect, "architect")
	r.coders.forEach((a) => reg(a, "coder"))
	r.testers.forEach((a) => reg(a, "tester"))
	r.reviewers.forEach((a) => reg(a, "reviewer"))
}
