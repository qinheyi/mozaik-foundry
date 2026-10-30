import { defineRuntime, SemanticEvent } from "@mozaik-ai/core"
import { FoundryState } from "./board"

export const { initializeRuntime, resolveRuntime, resolveParticipant, join, leave, sendMessage, sendEvent, runLoop } =
	defineRuntime<FoundryState>()

export const board = (): FoundryState => resolveRuntime().state

/** Custom domain events that ride on the same Mozaik event bus as model events. */
export type FoundryEventType =
	| "board.planned"
	| "board.changed"
	| "artifact.submitted"
	| "ci.started"
	| "ci.finished"
	| "review.finished"
	| "module.done"
	| "run.released"
	| "agent.note"

/**
 * Publish a domain event on the next macrotask so the publisher's handler
 * finishes before peers react (no re-entrant handler chains).
 */
export function emit(type: FoundryEventType, producerId: string, payload: Record<string, unknown> = {}): void {
	setImmediate(() => {
		try {
			sendEvent(SemanticEvent.create(type, producerId, payload), producerId)
		} catch (e) {
			console.error("emit failed", type, e)
		}
	})
}

/** Synchronous publish, for observer-only notes that must appear in causal order. */
export function emitNow(type: FoundryEventType, producerId: string, payload: Record<string, unknown> = {}): void {
	sendEvent(SemanticEvent.create(type, producerId, payload), producerId)
}
