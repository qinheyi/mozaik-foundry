import fs from "node:fs"
import http from "node:http"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { Recorder } from "./observer"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const UI = path.join(ROOT, "ui")
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml" }

/** Tiny static + SSE server. Live mode streams the recorder; without one it just serves ui/ (replay files). */
export function startServer(port: number, recorder?: Recorder, final?: () => unknown): http.Server {
	const server = http.createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://x")
		if (url.pathname === "/api/live" && recorder) {
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" })
			for (const e of recorder.events) res.write(`data: ${JSON.stringify(e)}\n\n`)
			const off = recorder.onEvent((e) => res.write(`data: ${JSON.stringify(e)}\n\n`))
			req.on("close", () => off())
			return
		}
		if (url.pathname === "/api/final") {
			res.writeHead(200, { "content-type": "application/json" })
			res.end(JSON.stringify(final?.() ?? null))
			return
		}
		const file = path.join(UI, url.pathname === "/" ? "index.html" : path.normalize(url.pathname))
		if (!file.startsWith(UI) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
			res.writeHead(404).end("not found")
			return
		}
		res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" })
		fs.createReadStream(file).pipe(res)
	})
	server.listen(port, () => console.log(`UI → http://localhost:${port}/${recorder ? "?live=1" : ""}`))
	return server
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
	startServer(Number(process.env.PORT || 4321))
}
