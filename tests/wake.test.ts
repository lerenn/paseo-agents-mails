import { describe, expect, it } from "vitest";
import { WakeEngine, wakeable } from "../server/wake";
import { agent, setup } from "../server/testing";

const A = { type: "agent" as const, agentId: "aaaaaaaa-1", name: "Coder A" };

function rig(opts: { tools?: boolean; live?: boolean; settings?: Parameters<typeof setup>[1] } = {}) {
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

  it("sends a minimal wake once injection is live", async () => {
    const { t, wake, send } = rig({ live: true, tools: false });
    await send("x", "body text");
    t.clock.now += 30_000;
    await wake.sweep();
    expect(t.directory.sent[0].text).toBe("[Agents Mail] You have new mail.");
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
});
