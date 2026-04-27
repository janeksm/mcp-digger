import { debug } from "./logger.js";

const locks = new Map<string, Promise<void>>();

export function withRepoLock<T>(
  repoName: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = locks.get(repoName) ?? Promise.resolve();
  debug("repoLock", "queued:", repoName);
  const next = prev.then(fn, fn);
  locks.set(
    repoName,
    next.then(
      () => {},
      () => {},
    ),
  );
  return next;
}
