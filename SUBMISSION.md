# Submission draft — JigJoy Mozaik Hackathon (not submitted)

**Project name:** Mozaik Foundry

**Track:** Freestyle

**Repository:** https://github.com/qinheyi/mozaik-foundry

**Live demo:** https://mozaik-foundry.vercel.app (web UI replaying a recorded live run; no API key needed)

**What it does (short):**
Mozaik Foundry is a concurrent multi-agent software factory. You give it a plain-English spec; an Architect agent splits it into modules with explicit contracts, then three Coder agents, two Tester agents, a Reviewer and a CI runner all work on one shared board simultaneously. Coders implement while testers write tests against the same contracts, CI runs `node --test` as soon as both halves exist, failures route back to the agent that owns the file, and the run finishes with a runnable JavaScript package, a test report, and a replayable event log shown in a web UI (kanban, event bus, Gantt timeline of every LLM call and CI run, generated code). The spec is just a Markdown file, so the same factory builds different software (a spreadsheet formula engine, a Markdown renderer, …).

**How the agents run concurrently:**
Every role is a Mozaik participant joined to a single runtime: `createAgent` for the LLM roles (Architect, Coder-1..3, Tester-1..2, Reviewer) and `createHuman` for CI, the Client and an Observer. Each agent has two `SituationHandler`s: on any wake event (`board.planned`, `board.changed`, `artifact.submitted`, `ci.finished`) an idle agent atomically claims a work item from the shared `RuntimeState` and starts a Mozaik `runLoop` with a fresh task-scoped `ModelContext`. `runLoop` is fire-and-forget, so many inference loops run at the same time; when an agent's own answer event arrives, its second handler applies the result and publishes `board.changed`, which wakes the others. CI runs up to four test suites as parallel child processes, so testing overlaps with coding. In the recorded run the CLI shows up to 5 agents busy at once, peak 6 concurrent LLM loops, and ×1.41–×1.78 parallelism (summed agent work ÷ wall-clock).

**Shared state & coordination:**
A `FoundryState` blackboard (modules + contracts, work items, versioned files, worker status, token/call budget). Claims are race-free because Mozaik publishes synchronously and `tryClaim` is a single synchronous check-and-set. Fixes carry a preferred assignee (the original author); CI arbitrates stuck red builds by sending them to the test author instead; agents syntax-check and re-queue their own truncated answers; a shared budget and a release gate end the run.

**Tech:** TypeScript, Node 20+, `@mozaik-ai/core` 4.2, MiniMax-M3 via Mozaik's `OpenAIChatCompletions` adapter (OpenAI-compatible endpoint), vanilla-JS web UI on Vercel.

**Results of the recorded run:** Two recorded live runs on the spreadsheet spec. v1: 5 modules planned, 4 done and reviewed, 37 tests pass / 1 fail, 230.9 s wall, ×1.41 parallelism, peak 6 concurrent LLM loops, 28 LLM calls, 101.9k tokens. Latest code: 4 modules, 3 done, 25 pass / 5 fail, 70.8 s wall, ×1.65, peak 6 loops, 18 calls, 65.0k tokens. In both runs the top-level integration module failed within the fix budget, and the factory reports it honestly (RELEASE INCOMPLETE) instead of looping.

**How to run:** `npm install && npm run replay` (free replay, open http://localhost:4321/?live=1) or set `MINIMAX_API_KEY` and run `npx tsx src/main.ts --spec specs/spreadsheet.md --ui`.

**Screenshots:** `docs/screenshots/01-board-midrun.png`, `02-final-timeline.png`, `03-generated-code.png`, `04-cli-log.png`
