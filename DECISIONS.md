# Technical Decisions

> Part of [Cave Man Claude Memory (CMCM)](CAVEMAN_CM.md) — append-only log of non-obvious technical decisions.

## 2026-05-11 — Cave man knowledge system over embedding-based RAG

Chose markdown files + git over vector DB / embedding pipeline (claude-os approach).
Why: Zero infrastructure overhead. Project knowledge (decisions, patterns, handoff) is small enough to fit in LLM context window. Git provides versioning and diffing for free. No Python server, no Redis, no embedding costs. Portable — copy files to any project and it works.

## 2026-05-16 — New `criticalError` helper for crash logging, not reuse of `error`

Chose adding `criticalError(tag, ...args)` to `logger.ts` over reusing existing `error()` for crash/signal handlers in `src/index.ts` (M1).
Why: `error()` has a mutually-exclusive contract — writes to `error.log` when initialized, falls back to stderr only when not. Tool-level errors want this (avoid polluting MCP stdio with stderr garbage when a file sink exists). Crash handlers need the opposite — stderr is the resilient channel always visible to the MCP client and shell; `error.log` is additive persistence when available. Two different contracts, two functions. Considered overloading `error()` with a boolean flag — rejected as a boolean parameter smell (Clean Code: booleans-as-parameters usually mean the function does two things).
