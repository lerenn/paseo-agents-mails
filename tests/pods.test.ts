import { describe, expect, it, vi } from "vitest";
import { POD_CONTROL_KEY, podResumer } from "../server/pods";
import { agent } from "../server/testing";

describe("podResumer", () => {
  it("does nothing without a runtime or a workspace", async () => {
    await expect(podResumer({ target: {} })(agent("a", { workspaceId: "w1" }))).resolves.toBeUndefined();
    const podAction = vi.fn(async () => ({ ok: true }));
    await podResumer({ target: { [POD_CONTROL_KEY]: { podAction } } })(agent("a"));
    expect(podAction).not.toHaveBeenCalled();
  });

  it("resumes the agent's workspace and waits for it", async () => {
    let done = false;
    const podAction = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10));
      done = true;
      return { ok: true };
    });
    await podResumer({ target: { [POD_CONTROL_KEY]: { podAction } } })(agent("a", { workspaceId: "w1" }));
    expect(podAction).toHaveBeenCalledWith("w1", "resume", {});
    expect(done).toBe(true);
  });

  it("gives up waiting after the bound", async () => {
    const podAction = vi.fn(() => new Promise<{ ok: boolean }>(() => undefined));
    await expect(podResumer({ target: { [POD_CONTROL_KEY]: { podAction } }, timeoutMs: 10 })(agent("a", { workspaceId: "w1" }))).resolves.toBeUndefined();
  });

  it("remembers a workspace without a pod for a while", async () => {
    const clock = { now: 0 };
    const podAction = vi.fn(async () => ({ ok: false, message: "This workspace has no pod." }));
    const resume = podResumer({ target: { [POD_CONTROL_KEY]: { podAction } }, now: () => clock.now });
    const a = agent("a", { workspaceId: "local" });
    await resume(a);
    await resume(a);
    expect(podAction).toHaveBeenCalledTimes(1);
    clock.now += 11 * 60_000;
    await resume(a);
    expect(podAction).toHaveBeenCalledTimes(2);
  });
});
