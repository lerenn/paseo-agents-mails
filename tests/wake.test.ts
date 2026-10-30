import { describe, expect, it, vi } from "vitest";
import { CONFIRM_WINDOW_MS, FAIL_RESET_MS, RESUME_WAIT_MS, WakeEngine, isAmbiguousSendFailure, wakeable } from "../server/wake";
import type { AgentInfo } from "../server/agents";
import { agent, setup } from "../server/testing";

const A = { type: "agent" as const, agentId: "aaaaaaaa-1", name: "Coder A" };

function rig(opts: { tools?: boolean; live?: boolean; settings?: Parameters<typeof setup>[1]; resume?: (agent: AgentInfo) => Promise<void> } = {}) {
  const t = setup([agent("aaaaaaaa-1"), agent("bbbbbbbb-2")], { sendsPer10Minutes: 1000, pairSendsPer10Minutes: 1000, ...opts.settings });
  const wake = new WakeEngine({
    now: () => t.clock.now,
    settings: t.settings,
    async pending() {
      return t.store.mailboxesWithUnread().map((box) => ({ agentId: box.slice(6), mails: t.store.list([box], { unreadOnly: true }) }));
    },
    fresh: (id) => t.directory.fresh(id),
    send: (id, text) => t.directory.send(id, text),
    hasTools: () => opts.tools ?? true,
    injectionLive: () => opts.live ?? false,
    injectEnabledFor: () => true,
    recordWake: (ids, at) => t.store.recordWake(ids, at),
    markInline: (_a, ids, at) => void t.store.markRead(["agent:bbbbbbbb-2"], ids, "inline", at),
    resume: opts.resume,
    resumeQuickMs: 20,
  });
  const send = async (subject = "hi", body = "") => {
    const r = await t.service.send(A, { to: "bbbbbbbb-2", subject, body });
    wake.notify("bbbbbbbb-2", t.clock.now);
    return r.mail;
  };
  return { t, wake, send };
}

describe("wake", () => {
  it("waits out the debounce, then wakes once with counts and names only", async () => {
    const { t, wake, send } = rig();
    await send("secret subject");
    expect(await wake.sweep()).toEqual([]);
    t.clock.now += 21_000;
    expect(await wake.sweep()).toEqual(["bbbbbbbb-2"]);
    const text = t.directory.sent[0].text;
    expect(text).toMatch(/1 unread mail \(from: Coder A\)/);
    expect(text).not.toMatch(/secret/);
    t.clock.now += 21_000;
    expect(await wake.sweep()).toEqual([]);
  });

  it("restarts the debounce on a new mail but caps it at two minutes", async () => {
    const { t, wake, send } = rig();
    await send();
    for (let i = 0; i < 4; i++) {
      t.clock.now += 15_000;
      await send(`m${i}`);
      expect(await wake.sweep()).toEqual([]);
    }
    t.clock.now += 70_000;
    await send("late");
    expect(await wake.sweep()).toEqual(["bbbbbbbb-2"]);
  });

  it("never wakes a running agent or one waiting on a permission", async () => {
    const { t, wake, send } = rig();
    await send();
    t.clock.now += 30_000;
    t.directory.agents[1].status = "running";
    expect(await wake.sweep()).toEqual([]);
    t.directory.agents[1] = { ...t.directory.agents[1], status: "idle", requiresAttention: true, attentionReason: "permission" };
    expect(await wake.sweep()).toEqual([]);
    t.directory.agents[1] = { ...t.directory.agents[1], requiresAttention: false, attentionReason: null };
    expect(await wake.sweep()).toEqual(["bbbbbbbb-2"]);
  });

  it("closed agents wake only when allowed; archived never", () => {
    expect(wakeable(agent("x", { status: "closed" }), true)).toBe(true);
    expect(wakeable(agent("x", { status: "closed" }), false)).toBe(false);
    expect(wakeable(agent("x", { archived: true }), true)).toBe(false);
  });

  it("respects the minimum gap, re-wakes at most three times, and the global budget", async () => {
    const { t, wake, send } = rig();
    await send();
    t.clock.now += 30_000;
    await wake.sweep();
    await send("second");
    t.clock.now += 30_000;
    expect(await wake.sweep()).toEqual([]);
    t.clock.now += 3 * 60_000;
    expect(await wake.sweep()).toEqual(["bbbbbbbb-2"]);
    let wakes = 0;
    for (let i = 0; i < 6; i++) {
      t.clock.now += 40 * 60_000;
      wakes += (await wake.sweep()).length;
    }
    expect(wakes).toBe(2); // each mail is woken for at most three times in all
    expect(t.store.list(["agent:bbbbbbbb-2"]).every((m) => m.wakes <= 3)).toBe(true);
  });

  it("does not count a send the host skipped (the agent started a turn meanwhile) as a wake, and tries again", async () => {
    const { t, wake, send } = rig();
    await send();
    t.clock.now += 30_000;
    t.directory.skipSend = true;
    expect(await wake.sweep()).toEqual([]);
    expect(t.store.list(["agent:bbbbbbbb-2"])[0].wakes).toBe(0);
    t.directory.skipSend = false;
    // No min-gap or backoff was started by the skipped attempt: the next sweep wakes at once.
    expect(await wake.sweep()).toEqual(["bbbbbbbb-2"]);
    expect(t.directory.sent).toHaveLength(1);
  });

  it("keeps the mail unread when the send fails, and backs off", async () => {
    const { t, wake, send } = rig();
    await send();
    t.clock.now += 30_000;
    t.directory.failSend = true;
    expect(await wake.sweep()).toEqual([]);
    expect(t.store.unreadCount("agent:bbbbbbbb-2")).toBe(1);
    t.directory.failSend = false;
    t.clock.now += 3 * 60_000;
    expect(await wake.sweep()).toEqual(["bbbbbbbb-2"]);
  });

  it("gives tool-less recipients the mail inline and marks it read", async () => {
    const { t, wake, send } = rig({ tools: false });
    await send("PR opened", "see #5");
    t.clock.now += 30_000;
    await wake.sweep();
    const text = t.directory.sent[0].text;
    expect(text).toMatch(/untrusted="true"/);
    expect(text).toMatch(/see #5/);
    expect(text).toMatch(/send_agent_prompt/);
    expect(t.store.unreadCount("agent:bbbbbbbb-2")).toBe(0);
  });

  it("sends a minimal wake once injection is live, to an agent that has the mail tools", async () => {
    const { t, wake, send } = rig({ live: true, tools: true });
    await send("x", "body text");
    t.clock.now += 30_000;
    await wake.sweep();
    expect(t.directory.sent[0].text).toBe("[Agents Mail] You have new mail.");
    expect(t.store.unreadCount("agent:bbbbbbbb-2")).toBe(1); // the injection, not the wake, delivers and marks it
  });

  it("still gives an agent WITHOUT the tools the mail inline when injection is live (regression: a bare wake stranded it)", async () => {
    const { t, wake, send } = rig({ live: true, tools: false });
    await send("PR opened", "see #7");
    t.clock.now += 30_000;
    await wake.sweep();
    const text = t.directory.sent[0].text;
    expect(text).toMatch(/untrusted="true"/);
    expect(text).toMatch(/see #7/);
    expect(t.store.unreadCount("agent:bbbbbbbb-2")).toBe(0);
  });

  it("holds back wakes beyond the per-minute budget", async () => {
    const t = setup([agent("aaaaaaaa-1"), ...["b1", "b2", "b3"].map((id) => agent(id))], { maxWakesPerMinute: 2 });
    for (const id of ["b1", "b2", "b3"]) await t.service.send(A, { to: id, subject: "x" });
    const wake = new WakeEngine({
      now: () => t.clock.now,
      settings: t.settings,
      pending: async () => t.store.mailboxesWithUnread().map((box) => ({ agentId: box.slice(6), mails: t.store.list([box], { unreadOnly: true }) })),
      fresh: (id) => t.directory.fresh(id),
      send: (id, text) => t.directory.send(id, text),
      hasTools: () => true,
      injectionLive: () => false,
      injectEnabledFor: () => true,
      recordWake: (ids, at) => t.store.recordWake(ids, at),
      markInline: () => undefined,
    });
    t.clock.now += 30_000;
    expect(await wake.sweep()).toHaveLength(2);
    t.clock.now += 61_000;
    expect(await wake.sweep()).toHaveLength(1);
  });

  it("does nothing when wake is off", async () => {
    const { t, wake, send } = rig({ settings: { wakeEnabled: false } });
    await send();
    t.clock.now += 30_000;
    expect(await wake.sweep()).toEqual([]);
  });

  describe("ambiguous sends", () => {
    const timeout = () => new Error("Timeout waiting for message (60000ms)");

    it("classes daemon timeouts as ambiguous, plain errors as failures", () => {
      expect(isAmbiguousSendFailure(timeout())).toBe(true);
      expect(isAmbiguousSendFailure(new Error("socket hang up"))).toBe(true);
      expect(isAmbiguousSendFailure(new Error("Agent not found"))).toBe(false);
    });

    it("a timeout followed by a turn start counts as delivered, with no resend and no backoff", async () => {
      const { t, wake, send } = rig();
      await send();
      t.clock.now += 30_000;
      t.directory.sendError = timeout();
      expect(await wake.sweep()).toEqual([]);
      expect(t.store.list(["agent:bbbbbbbb-2"])[0].wakes).toBe(0);
      t.directory.sendError = null;
      // While unconfirmed, nothing is sent again.
      t.clock.now += 60_000;
      expect(await wake.sweep()).toEqual([]);
      expect(t.directory.sent).toHaveLength(0);
      wake.turnStarted("bbbbbbbb-2", t.clock.now);
      expect(await wake.sweep()).toEqual(["bbbbbbbb-2"]);
      expect(t.store.list(["agent:bbbbbbbb-2"])[0].wakes).toBe(1);
      expect(t.directory.sent).toHaveLength(0);
    });

    it("a timeout followed by newer activity or a running status counts as delivered", async () => {
      const { t, wake, send } = rig();
      await send();
      t.clock.now += 30_000;
      t.directory.sendError = timeout();
      await wake.sweep();
      t.directory.sendError = null;
      t.directory.agents[1] = { ...t.directory.agents[1], lastActivityAt: t.clock.now + 1 };
      t.clock.now += 5_000;
      expect(await wake.sweep()).toEqual(["bbbbbbbb-2"]);
      expect(t.store.list(["agent:bbbbbbbb-2"])[0].wakes).toBe(1);
    });

    it("a timeout with no turn in the window counts as a failure and is retried after the backoff", async () => {
      const { t, wake, send } = rig();
      await send();
      t.clock.now += 30_000;
      t.directory.sendError = timeout();
      await wake.sweep();
      t.directory.sendError = null;
      t.clock.now += CONFIRM_WINDOW_MS - 1_000;
      expect(await wake.sweep()).toEqual([]);
      t.clock.now += 2_000;
      expect(await wake.sweep()).toEqual([]); // the window closed: a failure, first backoff (1 min)
      expect(t.directory.sent).toHaveLength(0);
      t.clock.now += 30_000;
      expect(await wake.sweep()).toEqual([]);
      t.clock.now += 31_000;
      expect(await wake.sweep()).toEqual(["bbbbbbbb-2"]);
      expect(t.directory.sent).toHaveLength(1);
      expect(t.store.unreadCount("agent:bbbbbbbb-2")).toBe(1);
    });

    it("drops the confirmation when the mail is read meanwhile", async () => {
      const { t, wake, send } = rig();
      const mail = await send();
      t.clock.now += 30_000;
      t.directory.sendError = timeout();
      await wake.sweep();
      t.directory.sendError = null;
      t.store.markRead(["agent:bbbbbbbb-2"], [mail.id], "tool", t.clock.now);
      await wake.sweep();
      await send("next");
      t.clock.now += CONFIRM_WINDOW_MS + 60_000;
      expect(await wake.sweep()).toEqual(["bbbbbbbb-2"]);
      expect(t.directory.sent).toHaveLength(1);
    });
  });

  it("resets the failure count after a quiet period", async () => {
    const { t, wake, send } = rig();
    await send();
    t.clock.now += 30_000;
    t.directory.failSend = true;
    await wake.sweep(); // 1st failure: 1 min
    t.clock.now += 61_000;
    await wake.sweep(); // 2nd: 5 min
    t.clock.now += 5 * 60_000 + 1_000;
    await wake.sweep(); // 3rd: 15 min
    t.clock.now += FAIL_RESET_MS;
    await wake.sweep(); // quiet for 30 min: counts as a 1st failure again, 1 min
    t.directory.failSend = false;
    t.clock.now += 61_000;
    expect(await wake.sweep()).toEqual(["bbbbbbbb-2"]);
  });

  describe("suspended pods", () => {
    it("resumes the pod before sending", async () => {
      const order: string[] = [];
      const { t, wake, send } = rig({ resume: async (a) => void order.push(`resume ${a.id}`) });
      await send();
      t.clock.now += 30_000;
      expect(await wake.sweep()).toEqual(["bbbbbbbb-2"]);
      expect(order).toEqual(["resume bbbbbbbb-2"]);
      expect(t.directory.sent).toHaveLength(1);
    });

    it("does not hold the sweep on a slow resume; sends once the pod is ready", async () => {
      let ready!: () => void;
      const resume = vi.fn(() => new Promise<void>((r) => (ready = r)));
      const { t, wake, send } = rig({ resume });
      await send();
      t.clock.now += 30_000;
      expect(await wake.sweep()).toEqual([]);
      t.clock.now += 5_000;
      expect(await wake.sweep()).toEqual([]); // still resuming, no second resume, no failure
      expect(resume).toHaveBeenCalledTimes(1);
      expect(t.directory.sent).toHaveLength(0);
      ready();
      await vi.waitFor(() => expect(t.directory.sent).toHaveLength(1)); // poked when the resume settles
      expect(t.store.list(["agent:bbbbbbbb-2"])[0].wakes).toBe(1);
    });

    it("sends anyway when the resume takes longer than the bound", async () => {
      const { t, wake, send } = rig({ resume: () => new Promise<void>(() => undefined) });
      await send();
      t.clock.now += 30_000;
      expect(await wake.sweep()).toEqual([]);
      t.clock.now += RESUME_WAIT_MS;
      expect(await wake.sweep()).toEqual(["bbbbbbbb-2"]);
    });
  });
});
