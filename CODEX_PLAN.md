**Implementation Plan**

## 1. Files To Modify

### `src/cacheManager.ts`
- Export `RepoMeta`.
- Add a public `readMeta(cacheDir, repoName)` or `readRepoMeta(...)` wrapper around the current private implementation.
- Keep current behavior: missing, malformed, or incomplete meta returns `undefined`.
- Why: `dig_status` needs `commitHash` and `updatedAt` to show cache age and commit.

### `src/sourceExtractor.ts`
- Export generated-file classification support.
- Recommended small API:
  ```ts
  export function isGeneratedCsFile(filePath: string): boolean
  export function countCsFileStats(files: string[]): {
    totalCsFiles: number;
    indexableCsFiles: number;
    generatedCsFiles: number;
  }
  ```
- Keep `filterCsFiles()` behavior unchanged, but implement it using the exported helper.
- Why: `dig_status` needs to compute total `.cs` files and generated skips with the same rules indexing uses.

### `src/tools/digStatus.ts`
- Import:
  - `readMeta`, `readIndex` from `cacheManager.ts`
  - `parseIndex`, `countCsFileStats` from `sourceExtractor.ts`
  - `listFiles`, possibly `isValidRepo` reuse from `gitClient.ts`
- Add per-repo index stats after local/remote connectivity checks and before repo issue summary.
- Aggregate across `repo.packages`.
- Count:
  - indexed files: unique `IndexEntry.filePath` values per package, namespaced by package name/path to avoid collisions.
  - types: entries where `kind !== "method"`.
  - methods: entries where `kind === "method"`.
  - total files/skipped generated: from git `listFiles(repoDir, pkg.pathInRepo + "/")` only when a usable local checkout exists.
- Resolve repo dir:
  - local repo: `repo.localPath`
  - managed repo: `repo.managedSourcePath` only if it exists and is a valid git repo
- Format examples:
  - Full data:
    ```md
    - **Indexed:** 87/90 files (3 skipped: generated) - **Symbols:** 342 types, 1204 methods - **Cache age:** 2h14m - **Commit:** abc1234
    ```
  - Cache exists but source checkout unavailable:
    ```md
    - **Indexed:** 87 files (total unavailable: source repo not ready) - **Symbols:** 342 types, 1204 methods - **Cache age:** 2h14m - **Commit:** abc1234
    ```
  - No cache:
    ```md
    - **Indexed:** no cache found
    ```

### `src/tools/digStatus.test.ts`
- Add tests for index stats rendering and edge cases.
- Existing helpers are enough, though tests may need to write meta/index cache files via `markFresh()` and `writeIndex()`.

## 2. Files To Create

None.

This can be implemented within the existing modules. Avoid adding a new utility file unless `digStatus.ts` becomes noticeably noisy.

## 3. Edge Cases

- No repo packages configured: show `Indexed: no packages configured` or omit stats. Prefer showing a short diagnostic.
- Package has no `index.dat`: count it as missing cache, not zero indexed files.
- Some packages have index cache and others do not: aggregate available indexes and include a note like `1 package missing index`.
- Empty `index.dat`: valid cache with `0` types, `0` methods, `0` indexed files.
- Invalid/corrupt index lines: `parseIndex()` already filters invalid kinds; stats should not throw.
- Missing or malformed `meta.json`: show cache age and commit as unavailable.
- Invalid `updatedAt`: show `Cache age: unknown`.
- Future `updatedAt`: clamp to `0m` or show `unknown`; clamping is simpler and avoids weird negative ages.
- Missing managed checkout: do not clone/fetch during `dig_status`; show indexed count from cache only.
- Invalid local repo path: connectivity section already reports failure; index stats should avoid `listFiles()` and not add another thrown error.
- Generated suffix case sensitivity: current generated filter is case-sensitive. Keep that behavior unless separately changing indexing semantics.
- Same file name in multiple packages: namespace unique file keys by package path/name.
- Same file with multiple symbols: count unique file paths, not index rows.
- Multiple packages sharing the same cache path would double count; config probably prevents this, but stats should key by package identity plus file path.

## 4. Test Plan (TDD)

Write these tests first in `src/tools/digStatus.test.ts`.

1. **Renders aggregate index stats for a local repo with cache and source files** `M`
   - Create repo with:
     - `src/Lib/A.cs`
     - `src/Lib/B.cs`
     - `src/Lib/Generated.g.cs`
   - Write index with entries from `A.cs` and `B.cs`, including both type and method rows.
   - Mark repo fresh.
   - Assert output contains:
     - `Indexed:** 2/3 files`
     - `1 skipped: generated` or `1 skipped: generated`
     - `Symbols:** 2 types, 1 methods`
     - `Commit:** <short hash>`

2. **Aggregates stats across multiple packages in one repo** `M`
   - Two packages under same repo.
   - Write index cache for both.
   - Assert file/type/method totals are summed.

3. **Uses unique indexed file count when multiple symbols are in one file** `S`
   - One `index.dat` with class and multiple methods in `A.cs`.
   - Assert indexed file count is `1`, not number of entries.

4. **Shows cache-only stats when source checkout is unavailable** `M`
   - URL/managed repo config with packages and cache, but no managed clone.
   - Avoid calling git file listing.
   - Assert output contains indexed file count and `total unavailable`.

5. **Shows no cache found when meta and indexes are absent** `S`
   - Valid local repo, package configured, no cache files.
   - Assert output contains `Indexed:** no cache found`.

6. **Handles malformed index cache without throwing** `S`
   - Write invalid index lines.
   - Assert stats render as zero symbols/files or partial valid count.

7. **Formats cache age from `updatedAt`** `M`
   - Write meta with controlled ISO timestamp.
   - Use fake timers if existing test style allows, otherwise assert the `Cache age:**` label appears.
   - Prefer fake timers for exact `2h14m`.

8. **Handles invalid meta timestamp** `S`
   - Write malformed meta manually or expose helper behavior through `readMeta`.
   - Assert `Cache age:** unknown`.

Optional `src/cacheManager.test.ts` additions:
- `readMeta()` returns commit and updatedAt for valid meta.
- `readMeta()` returns `undefined` for missing/malformed meta.

Optional `src/sourceExtractor.test.ts` additions:
- `countCsFileStats()` counts total `.cs`, indexable `.cs`, and generated suffixes consistently with `filterCsFiles()`.

## 5. Risks

- **Staleness semantics:** The index file count comes from cache, while total file count comes from current checkout. If the checkout moved after cache generation, `87/90` can reveal staleness but may confuse users. The displayed cached commit mitigates this.
- **Managed repos not cloned:** `dig_status` must stay a health check and should not clone/fetch just to compute totals.
- **Meta is repo-level, indexes are package-level:** A repo can have fresh meta but missing package indexes if a previous run partially failed. Tests should cover partial cache.
- **Method/type parsing is only as accurate as existing `parseIndex()` data:** This task should report current index contents, not reinterpret source.
- **Output brittleness:** Existing tests use substring assertions. Keep new tests similarly tolerant except for small helper functions.
- **Windows path behavior:** Index paths are forward-slash package-relative paths. Use normalized string keys when aggregating.

## 6. Implementation Steps

1. **Add failing tests for happy-path local repo stats** `M`
   - Update `digStatus.test.ts`.
   - Use `writeIndex()` and `markFresh()`.
   - Assert indexed ratio, symbols, cache age label, and commit short hash.

2. **Add failing tests for multi-package aggregation and unique file counting** `M`
   - Same file with multiple symbols should count once.
   - Multiple packages should sum cleanly.

3. **Add failing tests for missing checkout/cache edge cases** `M`
   - Managed repo without clone should not throw.
   - No index/meta should produce `no cache found`.

4. **Add focused helper tests for generated-file stats** `S`
   - In `sourceExtractor.test.ts`, prove generated suffix counts match `filterCsFiles()`.

5. **Export cache metadata reader** `S`
   - In `cacheManager.ts`, export `RepoMeta`.
   - Make `readMeta()` public or add `readRepoMeta()`.

6. **Add source file stats helper** `S`
   - In `sourceExtractor.ts`, export generated file helper and `countCsFileStats()`.
   - Refactor `filterCsFiles()` to use the helper.

7. **Implement index stats aggregation in `digStatus.ts`** `L`
   - Add helper such as `formatIndexStats(config, repo)`.
   - Read repo meta.
   - Read every package index.
   - Parse entries.
   - Count unique files, type entries, method entries.
   - Try git file totals only when repo dir exists and is valid.
   - Return resilient diagnostic lines instead of throwing.

8. **Implement cache age formatting** `M`
   - Add small pure helper:
     ```ts
     formatCacheAge(updatedAt: string, now = new Date()): string
     ```
   - Cover minutes, hours/minutes, days/hours if desired.
   - Invalid timestamp returns `unknown`.

9. **Run targeted tests** `S`
   - `npm test -- src/tools/digStatus.test.ts`
   - `npm test -- src/sourceExtractor.test.ts`
   - Fix failures.

10. **Run full verification** `M`
   - `npm run typecheck`
   - `npm run lint`
   - `npm test`

11. **Review output manually** `S`
   - Call `dig_status` against a fixture or existing local config if available.
   - Confirm the new line appears after connectivity checks and before final summary.