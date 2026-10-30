import { createHuman, Human, SemanticEvent, SituationContext, SituationSpecification } from "@mozaik-ai/core"
import { board, resolveRuntime } from "./runtime"

export type Recorded = { t: number; type: string; by: string; role?: string; data: Record<string, unknown>; board?: unknown }

const SKIP = new Set(["inference.stream", "message_received.started", "message_received.completed", "inference.completed", "participant.joined"])

/** Everything that happens on the Mozaik bus, in order — feeds the CLI log, the web UI (SSE) and the replay file. */
export class Recorder {
	events: Recorded[] = []
	private listeners = new Set<(e: Recorded) => void>()
	constructor(private t0 = Date.now()) {}

	onEvent(fn: (e: Recorded) => void): () => void {
		this.listeners.add(fn)
		return () => this.listeners.delete(fn)
	}

	record(event: SemanticEvent): void {
		if (SKIP.has(event.type)) return
		const b = board()
		const who = b.workers.get(event.producerId)
		const name = who?.name ?? safeName(event.producerId)
		const p = (event.payload ?? {}) as Record<string, any>
		let data: Record<string, unknown> = {}
		switch (event.type) {
			case "inference.started":
				data = { loopId: p.loopId, workItemId: who?.workItemId, moduleId: who?.workItemId ? b.work.get(who.workItemId)?.moduleId : undefined, kind: who?.workItemId ? b.work.get(who.workItemId)?.kind : who?.role === "architect" ? "plan" : undefined }
				break
			case "model.answer":
				data = { loopId: p.loopId, preview: String(p.answer?.content?.text ?? "").slice(0, 240) }
				break
			case "message.sent":
				data = { preview: String(p.message ?? "").slice(0, 400) }
				break
			default:
				data = { ...p }
		}
		const rec: Recorded = { t: Date.now() - this.t0, type: event.type, by: name, role: who?.role, data, board: b.snapshot() }
		this.events.push(rec)
		for (const l of this.listeners) l(rec)
	}
}

function safeName(id: string): string {
	try {
		return resolveRuntime().getParticipant(id)?.getManifest().name ?? id.slice(0, 8)
	} catch {
		return id.slice(0, 8)
	}
}

export function createObserver(recorder: Recorder): Human {
	return createHuman({
		name: "Observer",
		capabilities: [],
		handlers: [
			{
				specification: new (class extends SituationSpecification {
					isSatisfiedBy(_: SituationContext) {
						return true
					}
				})(),
				processor: { apply: (ctx) => recorder.record(ctx.event) },
			},
		],
	})
}

/* ---------------------------- pretty CLI log ---------------------------- */

const C = { dim: "\x1b[2m", reset: "\x1b[0m", bold: "\x1b[1m", red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", blue: "\x1b[34m", magenta: "\x1b[35m", cyan: "\x1b[36m" }
const ROLE_COLOR: Record<string, string> = { architect: C.magenta, coder: C.cyan, tester: C.yellow, reviewer: C.blue, ci: C.green }

export function consoleSink(e: Recorded): void {
	const ts = `${C.dim}[+${(e.t / 1000).toFixed(1).padStart(6)}s]${C.reset}`
	const who = `${ROLE_COLOR[e.role ?? ""] ?? ""}${e.by.padEnd(10)}${C.reset}`
	const b = e.board as any
	const busy = b ? b.workers.filter((w: any) => w.status === "busy").length : 0
	const conc = `${C.dim}busy=${busy}${C.reset}`
	const d = e.data as any
	let msg = ""
	switch (e.type) {
		case "message.sent":
			msg = `${C.bold}spec received${C.reset}`
			break
		case "inference.started":
			msg = `⟳ thinking on ${d.kind ?? "?"}:${d.moduleId ?? "-"}`
			break
		case "model.answer":
			msg = `✓ answered (${String(d.preview).length >= 240 ? "long" : String(d.preview).replace(/\s+/g, " ").slice(0, 60)})`
			break
		case "agent.note":
			msg = String(d.text)
			break
		case "artifact.submitted":
			msg = `📄 wrote ${d.file} v${d.version}`
			break
		case "ci.started":
			msg = `▶ node --test ${d.moduleId}.test.js (impl/test v${d.versions})`
			break
		case "ci.finished":
			msg = d.ok ? `${C.green}● ${d.moduleId} GREEN${C.reset} ${d.pass} pass (${d.ms}ms)` : `${C.red}● ${d.moduleId} RED${C.reset} ${d.fail} fail / ${d.pass} pass → ${d.status}`
			break
		case "review.finished":
			msg = `review ${d.moduleId}: ${d.verdict === "approve" ? C.green + "APPROVE" : C.yellow + "CHANGES"}${C.reset} ${String(d.notes ?? "").replace(/\s+/g, " ").slice(0, 90)}`
			break
		case "module.done":
			msg = `${C.green}${C.bold}✔ module ${d.moduleId} done${C.reset}`
			break
		case "board.planned":
			msg = `${C.bold}board: ${(d.modules as string[]).length} modules, ${b?.work?.length ?? 0} work items open${C.reset}`
			break
		case "run.released":
			msg = `${C.bold}RELEASE ${d.ok ? C.green + "OK" : C.red + "INCOMPLETE"}${C.reset} ${d.reason ?? ""}`
			break
		default:
			return
	}
	console.log(`${ts} ${who} ${conc} ${msg}`)
}
