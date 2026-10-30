import { RuntimeState } from "@mozaik-ai/core"

/**
 * The shared blackboard every participant reads and writes.
 *
 * Mozaik delivers events synchronously on one JS thread, so every mutation
 * below is atomic with respect to other agents: two coders that react to the
 * same `board.changed` event can never claim the same work item.
 */

export type ModuleSpec = {
	id: string
	file: string
	purpose: string
	exports: string[]
	deps: string[]
	acceptance: string[]
}

export type ModuleStatus =
	| "planned" // waiting for implementation + tests
	| "ready_for_ci" // both files exist, waiting on deps / CI slot
	| "testing" // CI is running node --test
	| "red" // tests failed, a fix item is open
	| "green" // tests pass, waiting for review
	| "reviewing"
	| "done" // green + approved
	| "failed" // gave up after max attempts

export type WorkKind = "impl" | "test" | "fix" | "fixtest" | "review"
export type WorkStatus = "open" | "claimed" | "done" | "cancelled"

export type WorkItem = {
	id: string
	kind: WorkKind
	moduleId: string
	status: WorkStatus
	assignee?: string
	/** Only this agent may claim it (ownership: the author fixes its own code). */
	preferredAssignee?: string
	notes?: string
	attempt: number
	createdAt: number
	claimedAt?: number
	doneAt?: number
}

export type ModuleState = {
	spec: ModuleSpec
	status: ModuleStatus
	implAuthor?: string
	testAuthor?: string
	implVersion: number
	testVersion: number
	lastTestedVersions?: string
	ciRuns: number
	fixRounds: number
	reviewRounds: number
	lastCiOutput?: string
	lastFail?: number
	lastFixKind?: "fix" | "fixtest"
	reviewNotes?: string
}

export type WorkerState = {
	id: string
	name: string
	role: "architect" | "coder" | "tester" | "reviewer" | "ci"
	status: "idle" | "busy"
	workItemId?: string
	completed: number
}

export type Budget = { maxCalls: number; maxTokens: number; calls: number; tokens: number }

export class FoundryState extends RuntimeState {
	spec = ""
	projectName = ""
	phase: "idle" | "planning" | "building" | "released" | "aborted" = "idle"
	modules = new Map<string, ModuleState>()
	work = new Map<string, WorkItem>()
	files = new Map<string, { content: string; author: string; version: number }>()
	workers = new Map<string, WorkerState>()
	budget: Budget
	startedAt = Date.now()
	private seq = 0

	constructor(
		public readonly workdir: string,
		budget: Partial<Budget> = {},
		public readonly limits = { maxFixRounds: 4, maxReviewRounds: 1, ciParallelism: 4 },
	) {
		super()
		this.budget = { maxCalls: 40, maxTokens: 400_000, calls: 0, tokens: 0, ...budget }
	}

	registerWorker(id: string, name: string, role: WorkerState["role"]): void {
		this.workers.set(id, { id, name, role, status: "idle", completed: 0 })
	}

	worker(id: string): WorkerState {
		const w = this.workers.get(id)
		if (!w) throw new Error(`unknown worker ${id}`)
		return w
	}

	addModules(specs: ModuleSpec[]): void {
		for (const spec of specs) {
			this.modules.set(spec.id, { spec, status: "planned", implVersion: 0, testVersion: 0, ciRuns: 0, fixRounds: 0, reviewRounds: 0 })
			this.addWork("impl", spec.id)
			this.addWork("test", spec.id)
		}
	}

	addWork(kind: WorkKind, moduleId: string, extra: Partial<WorkItem> = {}): WorkItem {
		const item: WorkItem = { id: `w${++this.seq}-${kind}-${moduleId}`, kind, moduleId, status: "open", attempt: 1, createdAt: Date.now(), ...extra }
		this.work.set(item.id, item)
		return item
	}

	/** Atomic claim: returns the item if this worker won it, otherwise undefined. */
	tryClaim(workerId: string, kinds: WorkKind[]): WorkItem | undefined {
		const worker = this.worker(workerId)
		if (worker.status !== "idle" || !this.canSpend()) return undefined
		const open = [...this.work.values()].filter((w) => w.status === "open" && kinds.includes(w.kind))
		// Own fixes first, then anything not reserved for someone else (FIFO).
		const mine = open.find((w) => w.preferredAssignee === workerId)
		const free = open.find((w) => !w.preferredAssignee || !this.workers.has(w.preferredAssignee))
		const pick = mine ?? free
		if (!pick) return undefined
		pick.status = "claimed"
		pick.assignee = workerId
		pick.claimedAt = Date.now()
		worker.status = "busy"
		worker.workItemId = pick.id
		return pick
	}

	complete(workerId: string, status: WorkStatus = "done"): WorkItem | undefined {
		const worker = this.worker(workerId)
		const item = worker.workItemId ? this.work.get(worker.workItemId) : undefined
		if (item) {
			item.status = status
			item.doneAt = Date.now()
		}
		worker.status = "idle"
		worker.workItemId = undefined
		worker.completed++
		return item
	}

	currentItem(workerId: string): WorkItem | undefined {
		const id = this.workers.get(workerId)?.workItemId
		return id ? this.work.get(id) : undefined
	}

	writeFile(path: string, content: string, author: string): number {
		const version = (this.files.get(path)?.version ?? 0) + 1
		this.files.set(path, { content, author, version })
		return version
	}

	canSpend(): boolean {
		return this.budget.calls < this.budget.maxCalls && this.budget.tokens < this.budget.maxTokens
	}

	charge(tokens: number): void {
		this.budget.calls++
		this.budget.tokens += tokens
	}

	module(id: string): ModuleState {
		const m = this.modules.get(id)
		if (!m) throw new Error(`unknown module ${id}`)
		return m
	}

	allTerminal(): boolean {
		return this.modules.size > 0 && [...this.modules.values()].every((m) => m.status === "done" || m.status === "failed")
	}

	snapshot() {
		return {
			projectName: this.projectName,
			phase: this.phase,
			elapsedMs: Date.now() - this.startedAt,
			budget: { ...this.budget },
			modules: [...this.modules.values()].map((m) => ({
				id: m.spec.id,
				file: m.spec.file,
				purpose: m.spec.purpose,
				deps: m.spec.deps,
				status: m.status,
				implAuthor: m.implAuthor,
				testAuthor: m.testAuthor,
				implVersion: m.implVersion,
				testVersion: m.testVersion,
				ciRuns: m.ciRuns,
				fixRounds: m.fixRounds,
				reviewRounds: m.reviewRounds,
			})),
			work: [...this.work.values()].map((w) => ({ ...w, notes: w.notes?.slice(0, 300) })),
			workers: [...this.workers.values()].map((w) => ({ ...w })),
			files: [...this.files.entries()].map(([path, f]) => ({ path, author: f.author, version: f.version, bytes: f.content.length })),
		}
	}
}
