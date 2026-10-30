import fs from "node:fs"
import {
	InferenceInput,
	InferenceOutput,
	InferenceRunner,
	ModelMessageItem,
	OpenAIChatCompletions,
	SemanticEvent,
	TokenUsage,
	InputTokenDetails,
	OutputTokenDetails,
} from "@mozaik-ai/core"
import { board } from "./runtime"

export const MODEL = process.env.FOUNDRY_MODEL || "MiniMax-M3"

/** MiniMax speaks OpenAI Chat Completions; Mozaik's generic adapter just needs a base URL. */
export function minimaxModel() {
	return {
		endpoint: new OpenAIChatCompletions(undefined, {
			baseURL: process.env.MINIMAX_BASE_URL || "https://api.minimaxi.com/v1",
			apiKey: process.env.MINIMAX_API_KEY,
			// reasoning_split keeps <think> out of the answer text; max_tokens caps spend per call.
			// MiniMax-M3 thinks adaptively by default; for many small parallel tasks we turn it off (≈2s vs ≈100s per call).
			extraBody: {
				reasoning_split: true,
				max_completion_tokens: Number(process.env.FOUNDRY_MAX_TOKENS || 8000),
				...(process.env.FOUNDRY_THINKING === "1" ? {} : { thinking: { type: "disabled" } }),
			},
		}),
		specification: {
			name: MODEL,
			provider: "minimax",
			supportsReasoningEffort: false,
			supportedReasoningEfforts: [],
			supportsStreaming: true,
			contextWindowSize: 200000,
			supportedContextItemTypes: [],
			maxOutputTokens: 32000,
			supportsFunctionCalling: true,
			supportsStructuredOutput: false,
		},
	}
}

/** Which agent/work item owns a ModelContext — set when a task-scoped context is created. */
export const contextTags = new Map<string, string>()

type Cassette = Record<string, { text: string; latencyMs: number; tokens: number }>

/**
 * Wraps Mozaik's OpenAIChatCompletions endpoint (pointed at MiniMax) with: retries/backoff (MiniMax 429s
 * under concurrency), a shared token budget on the board, and a cassette so a
 * recorded run can be replayed for free (judges need no API key).
 */
export class FoundryRunner implements InferenceRunner {
	private inner = minimaxModel().endpoint
	private cassette: Cassette = {}
	inFlight = 0
	peakInFlight = 0

	constructor(
		private mode: "live" | "replay",
		private cassettePath: string,
		private replaySpeed = 1,
	) {
		if (mode === "replay") this.cassette = JSON.parse(fs.readFileSync(cassettePath, "utf8"))
	}

	async run(input: InferenceInput): Promise<InferenceOutput> {
		const key = contextTags.get(input.context.id) ?? input.context.id
		this.inFlight++
		this.peakInFlight = Math.max(this.peakInFlight, this.inFlight)
		const t0 = Date.now()
		try {
			if (this.mode === "replay") {
				const hit = this.cassette[key]
				if (!hit) return this.text(`ERROR: no cassette entry for ${key}`, 0)
				await sleep(hit.latencyMs / this.replaySpeed)
				board().charge(hit.tokens)
				return this.text(hit.text, hit.tokens)
			}
			let lastErr: unknown
			let empties = 0
			for (let attempt = 0; attempt < 6; attempt++) {
				try {
					const out = await gate(() => withTimeout(this.inner.infer(input), CALL_TIMEOUT_MS))
					const tokens = out.tokenUsage?.totalTokens ?? 0
					board().charge(tokens)
					const msg = out.items.find((i) => i instanceof ModelMessageItem) as ModelMessageItem | undefined
					const text = stripThink(msg?.content.text ?? "")
					if (!text) {
						const finish = (out.rowResponse as any)?.choices?.[0]?.finish_reason
						// Deterministic: the same prompt yields the same empty answer. Retry once, then hand
						// back an ERROR so the agent re-queues the item with a changed ("shorter") prompt.
						if (++empties >= 2) {
							console.error(`  ! empty answer for ${key} twice (finish=${finish}, ${tokens} tokens) — giving up on this prompt`)
							const errText = `ERROR: empty answer (finish=${finish}); answer was too long — write a much shorter, minimal file`
							this.cassette[key] = { text: errText, latencyMs: Date.now() - t0, tokens }
							fs.writeFileSync(this.cassettePath, JSON.stringify(this.cassette, null, 1))
							return this.text(errText, tokens)
						}
						throw new Error(`empty answer (finish=${finish}, ${tokens} tokens)`)
					}
					this.cassette[key] = { text, latencyMs: Date.now() - t0, tokens }
					fs.writeFileSync(this.cassettePath, JSON.stringify(this.cassette, null, 1))
					return this.text(text, tokens, out)
				} catch (e: any) {
					lastErr = e
					const rateLimited = e?.status === 429 || /2062|rate/i.test(String(e?.message))
					const wait = (rateLimited ? 6000 : 2000) * 1.8 ** attempt + Math.random() * 1500
					console.error(`  ! inference error for ${key} (attempt ${attempt + 1}): ${e?.status ?? ""} ${String(e?.message ?? e).slice(0, 160)} — retry in ${Math.round(wait)}ms`)
					await sleep(wait)
				}
			}
			return this.text(`ERROR: inference failed: ${String((lastErr as any)?.message ?? lastErr)}`, 0)
		} finally {
			this.inFlight--
		}
	}

	async *stream(input: InferenceInput): AsyncGenerator<SemanticEvent> {
		yield SemanticEvent.create("inference.output", input.model, await this.run(input))
	}

	private text(text: string, tokens: number, raw?: InferenceOutput): InferenceOutput {
		return {
			items: [ModelMessageItem.rehydrate({ text: text || "ERROR: empty answer" })],
			tokenUsage: new TokenUsage(0, 0, tokens, new InputTokenDetails(0), new OutputTokenDetails(0)),
			rowResponse: raw?.rowResponse ?? { replay: true },
		}
	}
}

export function stripThink(s: string): string {
	return s.replace(/<think>[\s\S]*?<\/think>/g, "").trim()
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Client-side cap on simultaneous HTTP calls (MiniMax Token Plans rate-limit bursts). Agents still run concurrently; extra calls queue. */
const MAX_INFLIGHT = Number(process.env.FOUNDRY_MAX_INFLIGHT || 5)
let active = 0
const waiters: (() => void)[] = []
async function gate<T>(fn: () => Promise<T>): Promise<T> {
	while (active >= MAX_INFLIGHT) await new Promise<void>((r) => waiters.push(r))
	active++
	try {
		return await fn()
	} finally {
		active--
		waiters.shift()?.()
	}
}

const CALL_TIMEOUT_MS = Number(process.env.FOUNDRY_CALL_TIMEOUT_MS || 90_000)
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
	return new Promise((resolve, reject) => {
		const t = setTimeout(() => reject(new Error(`timeout after ${ms}ms (runaway generation?)`)), ms)
		p.then((v) => (clearTimeout(t), resolve(v)), (e) => (clearTimeout(t), reject(e)))
	})
}
