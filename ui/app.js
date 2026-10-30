/* Mozaik Foundry UI — renders the recorded Mozaik event stream (live via SSE, or replayed from runs/*.json). */
const $ = (id) => document.getElementById(id)
const qs = new URLSearchParams(location.search)
const LIVE = qs.has("live")
const RUN = qs.get("run") || "runs/demo.json"
const COLS = [["planned", "Planned"], ["testing", "In CI"], ["red", "Red → fixing"], ["reviewing", "Review"], ["done", "Done ✔"], ["failed", "Failed"]]
const ROLE_COLOR = { architect: "#d2a8ff", coder: "#79c0ff", tester: "#e3b341", reviewer: "#58a6ff", ci: "#3fb950", client: "#8b949e" }

let events = []
let report = null
let cursor = 0 // number of events applied
let clock = 0 // ms of virtual time
let playing = true
let lastFrame = performance.now()
let activeFile = qs.get("file")

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c])
const sec = (ms) => (ms / 1000).toFixed(1) + "s"

function colOf(status) {
	if (status === "green") return "reviewing"
	return COLS.some(([k]) => k === status) ? status : "planned"
}

function currentBoard() {
	for (let i = cursor - 1; i >= 0; i--) if (events[i].board) return events[i].board
	return null
}

function spansUntil(n) {
	const open = new Map(), spans = []
	for (let i = 0; i < n; i++) {
		const e = events[i], d = e.data || {}
		if (e.type === "inference.started") open.set(e.by, { who: e.by, role: e.role, start: e.t, label: `${d.kind || "?"}:${d.moduleId || "-"}`, kind: "llm" })
		if (e.type === "model.answer" && open.has(e.by)) { spans.push({ ...open.get(e.by), end: e.t }); open.delete(e.by) }
		if (e.type === "ci.started") open.set("CI:" + d.moduleId, { who: "CI", role: "ci", start: e.t, label: d.moduleId, kind: "ci", key: "CI:" + d.moduleId })
		if (e.type === "ci.finished" && open.has("CI:" + d.moduleId)) { spans.push({ ...open.get("CI:" + d.moduleId), end: e.t, ok: d.ok }); open.delete("CI:" + d.moduleId) }
	}
	for (const s of open.values()) spans.push({ ...s, end: null })
	return spans
}

function renderStats(b, spans) {
	const now = clock
	const busy = b ? b.workers.filter((w) => w.status === "busy").length : 0
	const llmNow = spans.filter((s) => s.kind === "llm" && s.end == null).length
	const ciNow = spans.filter((s) => s.kind === "ci" && s.end == null).length
	const busyMs = spans.reduce((a, s) => a + ((s.end ?? now) - s.start), 0)
	const par = now > 0 ? busyMs / now : 0
	const done = b ? b.modules.filter((m) => m.status === "done").length : 0
	const stat = (v, l, hot) => `<div class="stat ${hot ? "hot" : ""}"><b>${v}</b><span>${l}</span></div>`
	$("stats").innerHTML =
		stat(busy, "agents busy", busy > 1) + stat(llmNow, "LLM loops now", llmNow > 1) + stat(ciNow, "CI runs now", ciNow > 1) +
		stat("×" + par.toFixed(2), "parallelism", par > 1) + stat(`${done}/${b ? b.modules.length : 0}`, "modules done") +
		stat(b ? b.budget.calls : 0, "LLM calls") + stat(b ? (b.budget.tokens / 1000).toFixed(1) + "k" : 0, "tokens")
	$("project").textContent = b ? `${b.projectName || "…"} · phase: ${b.phase}` : ""
}

function renderAgents(b) {
	if (!b) return
	const work = new Map(b.work.map((w) => [w.id, w]))
	$("agents").innerHTML = b.workers.map((w) => {
		const it = w.workItemId && work.get(w.workItemId)
		const task = w.status === "busy" ? (it ? `${it.kind} · ${it.moduleId}` : w.role === "architect" ? "planning" : w.role === "ci" ? "running tests" : "working") : "idle — waiting for work"
		return `<div class="agent role-${w.role} ${w.status}"><span class="dot"></span><span class="name">${esc(w.name)}</span><span class="task">${esc(task)}</span><span class="count">${w.completed || 0}✓</span></div>`
	}).join("")
}

function renderKanban(b) {
	if (!b) { $("kanban").innerHTML = '<div class="col"><h3>waiting for plan…</h3></div>'; return }
	const nameOf = new Map(b.workers.map((w) => [w.id, w.name]))
	$("kanban").innerHTML = COLS.map(([key, title]) => {
		const mods = b.modules.filter((m) => colOf(m.status) === key)
		return `<div class="col"><h3>${title} (${mods.length})</h3>${mods.map((m) => {
			const items = b.work.filter((w) => w.moduleId === m.id && w.status !== "done")
			const chips = items.map((w) => `<span class="chip ${w.status}" title="${esc(w.id)}">${w.kind}${w.assignee ? " · " + esc(nameOf.get(w.assignee) || "") : w.preferredAssignee ? " → " + esc(nameOf.get(w.preferredAssignee) || "") : ""}</span>`).join("")
			return `<div class="card s-${m.status}"><b>${esc(m.id)}</b> <span class="meta">${esc(m.file)}</span>
				<div class="meta purpose">${esc(m.purpose || "")}</div>
				<div class="meta">deps: ${m.deps.length ? m.deps.map(esc).join(", ") : "—"} · impl v${m.implVersion} · test v${m.testVersion} · CI ${m.ciRuns} · fix ${m.fixRounds}</div>
				<div class="chips">${chips}</div></div>`
		}).join("")}</div>`
	}).join("")
}

function describe(e) {
	const d = e.data || {}
	switch (e.type) {
		case "message.sent": return ["", "📨 spec sent to the factory"]
		case "inference.started": return ["", `⟳ LLM loop on ${d.kind || "?"}:${d.moduleId || "-"}`]
		case "model.answer": return ["", "✓ model answered"]
		case "agent.note": return ["", d.text]
		case "artifact.submitted": return ["", `📄 wrote ${d.file} v${d.version}`]
		case "ci.started": return ["", `▶ node --test ${d.moduleId}.test.js`]
		case "ci.finished": return d.ok ? ["ci-green", `● ${d.moduleId} GREEN — ${d.pass} pass (${d.ms}ms)`] : ["ci-red", `● ${d.moduleId} RED — ${d.fail} fail / ${d.pass} pass → ${d.status}`]
		case "review.finished": return ["", `🔍 review ${d.moduleId}: ${String(d.verdict).toUpperCase()} ${d.notes ? "— " + String(d.notes).slice(0, 120) : ""}`]
		case "module.done": return ["done", `✔ module ${d.moduleId} done`]
		case "board.planned": return ["", `🗂 board planned: ${(d.modules || []).join(", ")}`]
		case "board.changed": return null
		case "run.released": return [d.ok ? "done" : "ci-red", `🚀 RELEASE ${d.ok ? "OK" : "INCOMPLETE"} — ${d.pass} tests pass, ${d.fail} fail (${d.reason || ""})`]
		default: return ["", e.type]
	}
}

let logCount = 0
function renderLog(reset) {
	const el = $("log")
	if (reset) { el.innerHTML = ""; logCount = 0 }
	let html = ""
	for (; logCount < cursor; logCount++) {
		const e = events[logCount], r = describe(e)
		if (!r) continue
		html += `<div class="ev ${r[0]}" title="${esc(e.type)}"><span class="t">${sec(e.t)}</span><span class="who" style="color:${ROLE_COLOR[e.role] || "#8b949e"}">${esc(e.by)}</span>${esc(r[1])}</div>`
	}
	if (html) { el.insertAdjacentHTML("beforeend", html); el.scrollTop = el.scrollHeight }
}

function renderGantt(b, spans) {
	const lanes = (b ? b.workers.map((w) => w.name) : []).filter((n) => n !== "Client")
	const ciLanes = [...new Set(spans.filter((s) => s.kind === "ci").map((s) => s.key))]
	const all = [...lanes.filter((n) => n !== "CI"), ...ciLanes]
	const total = Math.max(clock, report?.metrics?.wallMs || (events.length ? events[events.length - 1].t : 1), 1)
	const W = 1000, L = 110, H = 20, top = 18
	const x = (t) => L + ((W - L - 10) * t) / total
	let svg = `<svg viewBox="0 0 ${W} ${top + all.length * H + 8}">`
	for (let i = 0; i <= 10; i++) { const t = (total * i) / 10; svg += `<line x1="${x(t)}" x2="${x(t)}" y1="12" y2="${top + all.length * H}" stroke="#30363d"/><text x="${x(t) - 12}" y="10">${sec(t)}</text>` }
	all.forEach((lane, i) => {
		const y = top + i * H
		svg += `<text x="4" y="${y + 14}">${esc(lane)}</text>`
		for (const s of spans) {
			const match = s.kind === "ci" ? s.key === lane : s.who === lane
			if (!match) continue
			const end = s.end ?? clock
			const color = s.kind === "ci" ? (s.end == null ? "#3fb95088" : s.ok ? "#3fb950" : "#f85149") : ROLE_COLOR[s.role] || "#888"
			svg += `<rect x="${x(s.start)}" y="${y + 3}" width="${Math.max(2, x(end) - x(s.start))}" height="${H - 6}" rx="3" fill="${color}" opacity="${s.end == null ? 0.6 : 0.9}"><title>${esc(lane)} ${esc(s.label)} ${sec(end - s.start)}</title></rect>`
		}
	})
	svg += `<line x1="${x(clock)}" x2="${x(clock)}" y1="12" y2="${top + all.length * H}" stroke="#fff" stroke-dasharray="3 3"/></svg>`
	$("gantt").innerHTML = svg
}

function renderFiles(b) {
	const files = b ? b.files : []
	const content = report?.files || {}
	$("filesnote").textContent = report ? "final content of each file (versions shown on tabs)" : LIVE ? "content appears when the run releases" : ""
	const names = files.map((f) => f.path)
	if (cursor >= events.length && content["README.md"]) names.push("README.md")
	if (!activeFile || !names.includes(activeFile)) activeFile = names[0] || null
	$("filetabs").innerHTML = names.map((n) => {
		const f = files.find((x) => x.path === n)
		return `<button class="${n === activeFile ? "on" : ""}" data-f="${esc(n)}">${esc(n)}${f ? ` v${f.version} · ${esc(f.author)}` : ""}</button>`
	}).join("")
	$("filebody").textContent = activeFile ? content[activeFile]?.content ?? "(content available after release)" : "no files yet"
}
$("filetabs").addEventListener("click", (ev) => { const f = ev.target.closest("button")?.dataset.f; if (f) { activeFile = f; renderFiles(currentBoard()) } })

function render(reset) {
	const b = currentBoard()
	const spans = spansUntil(cursor)
	renderStats(b, spans); renderAgents(b); renderKanban(b); renderLog(reset); renderGantt(b, spans)
	renderFiles(b)
	$("clock").textContent = sec(clock)
	const total = events.length ? events[events.length - 1].t : 1
	if (!LIVE) $("scrub").value = Math.round((1000 * clock) / total)
}

function seek(t) {
	clock = t
	const before = cursor
	cursor = 0
	while (cursor < events.length && events[cursor].t <= clock) cursor++
	render(cursor < before)
}

function tick(now) {
	const dt = now - lastFrame
	lastFrame = now
	if (!LIVE && playing && events.length) {
		const end = events[events.length - 1].t
		if (clock < end) seek(Math.min(end, clock + dt * Number($("speed").value)))
		else { playing = false; $("play").textContent = "↻ replay" }
	}
	requestAnimationFrame(tick)
}

$("play").onclick = () => {
	if (LIVE) return
	const end = events.length ? events[events.length - 1].t : 0
	if (!playing && clock >= end) seek(0)
	playing = !playing
	$("play").textContent = playing ? "⏸ pause" : "▶ play"
}
$("scrub").oninput = (e) => { const total = events.length ? events[events.length - 1].t : 0; seek((total * Number(e.target.value)) / 1000) }

async function boot() {
	if (LIVE) {
		$("mode").textContent = "LIVE"
		$("play").disabled = true; $("scrub").disabled = true
		const t0 = performance.now()
		const es = new EventSource("/api/live")
		es.onmessage = (m) => {
			const e = JSON.parse(m.data)
			events.push(e)
			cursor = events.length
			clock = Math.max(clock, e.t)
			if (e.type === "run.released") setTimeout(async () => { report = await (await fetch("/api/final")).json(); render() }, 400)
			render()
		}
		setInterval(() => { if (events.length && !report) { clock = Math.max(clock, events[events.length - 1].t); render() } }, 500)
	} else {
		report = await (await fetch(RUN)).json()
		events = report.events
		$("mode").textContent = `REPLAY · ${report.runName} · ${report.model}${report.replay ? " (cassette)" : ""}`
		const at = qs.get("t")
		if (at != null) { playing = false; $("play").textContent = "▶ play"; seek(at === "end" ? events[events.length - 1].t : Number(at)) } else seek(0)
	}
	requestAnimationFrame(tick)
}
boot().catch((err) => { $("log").textContent = "failed to load: " + err })
