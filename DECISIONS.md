# Technical Decisions

> Part of [Cave Man Claude Memory (CMCM)](CAVEMAN_CM.md) — append-only log of non-obvious technical decisions.

## 2026-05-11 — Cave man knowledge system over embedding-based RAG

Chose markdown files + git over vector DB / embedding pipeline (claude-os approach).
Why: Zero infrastructure overhead. Project knowledge (decisions, patterns, handoff) is small enough to fit in LLM context window. Git provides versioning and diffing for free. No Python server, no Redis, no embedding costs. Portable — copy files to any project and it works.
