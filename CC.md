# CC — Node.js / TypeScript Clean Code Rules

> Pragmatic principal-developer rules for this codebase. Complements (does not duplicate) the **Pragmatic Clean Code** section in `CLAUDE.md` — that one covers language-agnostic principles; this one covers Node.js + TypeScript specifics. Read before writing, modifying, or reviewing code.
>
> Sources: [goldbergyoni/nodebestpractices](https://github.com/goldbergyoni/nodebestpractices) · [labs42io/clean-code-typescript](https://github.com/labs42io/clean-code-typescript) · [ryanmcdermott/clean-code-javascript](https://github.com/ryanmcdermott/clean-code-javascript).

---

## 1. TypeScript discipline

- **`strict: true`** in `tsconfig.json` is non-negotiable. Includes `noImplicitAny`, `strictNullChecks`, `strictFunctionTypes`, `noImplicitThis`. Don't add `// @ts-ignore` to silence errors — fix the type.
- **`any` is a smell.** Prefer `unknown` + a type guard. When you truly must use `any`, document why with one line.
- **`unknown` for external input**, then narrow via type guards (`typeof`, `instanceof`, custom `is` predicates).
- **Use `readonly`** for immutable fields and arrays you don't mutate. Catches accidental mutation at compile time.
- **Prefer `interface` for public shapes, `type` for unions/intersections/utility types.** Interfaces merge; types don't. Pick the right tool.
- **Avoid non-null assertions (`x!`).** They lie to the type checker and crash at runtime. Prefer narrowing, defaulting, or branching.
- **No string enums for internal use.** Use literal unions: `type Mode = "explicit" | "auto" | "wildcard"`. Smaller, faster, no runtime cost.
- **Lowercase primitives** (`string`, `number`, `boolean`) — not `String`/`Number`/`Boolean`.
- **Explicit return types on exported functions.** Forces you to think about the contract. Inference is fine for locals.
- **`import type`** when importing only for type position. Helps tree-shakers and signals intent.
- **Use `node:` protocol** for built-ins: `import * as fs from "node:fs"`. Disambiguates from npm packages, future-proof.

## 2. Async patterns

- **`async`/`await` only.** No raw `.then()` chains. Don't mix.
- **Never floating promises.** Either `await`, return, or explicitly `void promise`. `no-floating-promises` lint rule catches these.
- **`await` before `return`** in `try` blocks — without it, the catch can't see the rejection (stack lost). `return await fn()` inside try is correct.
- **`Promise.all` for parallel, sequential `for-await` for ordered work.** Don't `Promise.all` over a side-effectful sequence that needs ordering.
- **Never block the event loop.** No `fs.readFileSync` / `child_process.execFileSync` in request handlers or hot paths. Defer CPU-heavy work to worker threads or a separate process.
- **Top-level await is fine** in ESM, but module-scope async work with side effects (DB connects, network) is a smell — call it from an explicit `main()` so it's testable.
- **Don't `await` inside `Array.prototype.map`** when you want parallelism — wrap with `Promise.all(arr.map(...))`. Inside `for-of` is sequential by design.

## 3. Error handling

- **Throw `Error` objects only** (or subclasses). Never `throw "string"`, `throw 42`, or POJOs — loses stack trace and type info.
- **Subclass `Error` for known failure modes.** `class ConfigError extends Error { ... }`. Lets callers `instanceof`-check.
- **Operational vs programmer errors.** Operational (network down, file missing) is recoverable — handle near the boundary. Programmer (null deref, type error) is a bug — let it crash + restart.
- **Catch at the boundary, not everywhere.** Wrap I/O at the lowest layer that has enough context to act (retry, fall back, surface to user). Inner functions throw cleanly.
- **`process.on("unhandledRejection", ...)` and `process.on("uncaughtException", ...)`** — log and exit. Never swallow these silently.
- **Don't use `try`/`catch` for control flow.** Use return values, discriminated unions, or `Result`-style types when the failure is expected.
- **Preserve cause chain** with `new Error("wrapping context", { cause: err })`. Don't drop the original.
- **EventEmitter `'error'` events bypass try/catch.** Subscribe explicitly or the process dies.

## 4. Module hygiene

- **ESM with explicit `.js` extensions in relative imports** (TypeScript `NodeNext` resolution). `import { foo } from "./bar.js"` — even though the source is `bar.ts`.
- **No default exports for library/internal code.** Named exports make renames safe, refactors visible, and prevent the `import Foo from "./foo"` typo loophole.
- **Group imports at file top.** No `require` or dynamic `import()` mid-function unless lazy-loading is a deliberate optimization.
- **One responsibility per file.** Filename matches the dominant export.
- **No barrel files (`index.ts` that re-exports everything)** unless the package boundary truly needs it — they break tree-shaking and cause circular-import nightmares.
- **Side-effect-free modules.** Importing a file shouldn't perform network calls, log lines, or schedule timers. Initialise via explicit `init()` calls.

## 5. Testing (vitest)

- **AAA structure.** Arrange / Act / Assert — visually separated, no leakage.
- **Test behaviour, not implementation.** Refactor-safe tests assert on observable outputs, not on internal call counts.
- **Test name = spec sentence.** `it("returns []" when sourceRoot does not exist")` — reads as documentation.
- **One logical assertion per test.** Multiple `expect()` calls are fine if they verify one behaviour.
- **Mock at the boundary** — network, FS, child_process — not at internal seams. Internal mocks couple tests to structure.
- **Real I/O in temp dirs** is often simpler than mocking. `fs.mkdtempSync` + cleanup beats elaborate `vi.mock` for FS-heavy logic.
- **Vitest module isolation** via `vi.resetModules()` + dynamic `import()` when testing singletons (loggers, caches).
- **No shared state between tests.** Each test arranges its own fixtures. `beforeEach` for per-test setup, never `before` for shared mutable state.
- **Tests are documentation.** A reader should learn how to use the API from the test file.

## 6. Security

- **Validate at the boundary** with Zod (or equivalent) on every external input (MCP tool input, HTTP request, config file, env var). Internal code trusts validated types.
- **Never log secrets.** Redact PATs / API keys / passwords. Use a redacting logger wrapper at the boundary.
- **Escape regex user input** — `RegExp` from user input enables ReDoS. Quote with `escapeRegExp` or use string `.includes()` when possible.
- **Path traversal:** reject `..` segments in any user-supplied path. Resolve and assert the result is under the expected root.
- **No `child_process.exec(<user input>)`.** Use `execFile` with an args array. Never string-concat shell.
- **No `eval`, no `Function(...)`, no `vm` for untrusted input.** If you need dynamic dispatch, a switch/map is almost always enough.
- **`npm audit` clean before release.** Lock with `package-lock.json`. Pin major versions of dependencies you depend on heavily.
- **Run as non-root** in containers.

## 7. Performance

- **Don't optimise without a benchmark.** Profile first (`node --prof`, `clinic.js`, `0x`). Most "slow" code is actually fine.
- **Avoid sync FS in hot paths.** `await fs.promises.readFile`, not `fs.readFileSync`.
- **Stream large data.** `fs.createReadStream` + pipelines for files >10MB. Don't load into memory.
- **`Map`/`Set` for >100 entries**; plain object lookups slow down past that and don't iterate predictably.
- **Cache expensive idempotent results** by a stable key. Invalidate explicitly.
- **Beware closures holding large objects.** `arr.map(x => x.id)` discards `arr`; `arr.map(x => () => x.id)` retains it.
- **Use LTS Node** in CI and production. Latest only for dev experimentation.

## 8. Logging & observability

- **One mature logger** (Pino, Winston) — don't mix `console.log` with structured logging.
- **Write to stdout / stderr only** in libraries. Let the host wire up file sinks.
- **Tag logs with context** (`logger.child({ requestId, tool })`). Easier to grep later.
- **Debug logs gated behind a flag.** Never ship code that emits noise by default.
- **Errors get the full chain** — message, `.cause`, stack. Don't `console.error(err.message)` — `console.error(err)` is correct.

## 9. Project-specific echoes

- This codebase follows **`config-is-source-of-truth`** ([[config-is-source-of-truth]]) — modules receive resolved config at registration, never read env vars directly.
- **`tools-never-throw`** ([[tools-never-throw]]) — MCP tool handlers always return a result; errors become `toolError()` with `isError: true`.
- **`sequential-repo-processing`** ([[sequential-repo-processing]]) — for-loops over repos, not `Promise.all`, to avoid concurrent git contention.

## 10. When in doubt

- Default to the simpler option. Two lines of duplication beat a premature abstraction.
- Read the test before the implementation when in doubt about intent.
- If a rule above conflicts with a rule in `CLAUDE.md` § Pragmatic Clean Code, `CLAUDE.md` wins (project-specific overrides general).
- If a rule above conflicts with an entry in `DECISIONS.md`, the decision wins (with-context override).
