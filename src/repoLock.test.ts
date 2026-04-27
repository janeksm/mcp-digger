import { describe, expect, it } from "vitest";
import { withRepoLock } from "./repoLock.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("withRepoLock", () => {
  it("serializes calls on the same key", async () => {
    const order: string[] = [];

    const a = withRepoLock("repo1", async () => {
      order.push("start-A");
      await delay(50);
      order.push("end-A");
    });

    const b = withRepoLock("repo1", async () => {
      order.push("start-B");
      await delay(10);
      order.push("end-B");
    });

    await Promise.all([a, b]);

    expect(order).toEqual(["start-A", "end-A", "start-B", "end-B"]);
  });

  it("allows concurrent execution on different keys", async () => {
    const order: string[] = [];

    const a = withRepoLock("repo1", async () => {
      order.push("start-A");
      await delay(50);
      order.push("end-A");
    });

    const b = withRepoLock("repo2", async () => {
      order.push("start-B");
      await delay(10);
      order.push("end-B");
    });

    await Promise.all([a, b]);

    expect(order[0]).toBe("start-A");
    expect(order[1]).toBe("start-B");
  });

  it("propagates return values", async () => {
    const result = await withRepoLock("repo1", async () => 42);
    expect(result).toBe(42);
  });

  it("propagates rejections", async () => {
    await expect(
      withRepoLock("repo1", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });

  it("runs next holder even when previous rejects", async () => {
    const first = withRepoLock("repo1", async () => {
      throw new Error("fail");
    });

    const second = withRepoLock("repo1", async () => "ok");

    await expect(first).rejects.toThrow("fail");
    await expect(second).resolves.toBe("ok");
  });
});
