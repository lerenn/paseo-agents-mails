import { describe, expect, it } from "vitest";
import { MailStore } from "../server/store";
import { agent, setup } from "../server/testing";

const A = { type: "agent" as const, agentId: "aaaaaaaa-1", name: "Coder A" };
const agents = () => [
  agent("aaaaaaaa-1", { title: "Coder A" }),
  agent("bbbbbbbb-2", { title: "Coder B" }),
  agent("cccccccc-3", { title: "Assistant", labels: { "paseo.assistant": "1" } }),
  agent("dddddddd-4", { title: "Sub", parentAgentId: "aaaaaaaa-1" }),
];

describe("send and addressing", () => {
  it("delivers by id, prefix, title and label, and the sender is the caller", async () => {
    const t = setup(agents());
    for (const to of ["bbbbbbbb-2", "bbbbbbbb", "Coder B", "label:paseo.assistant=1"]) {
      const { mail } = await t.service.send(A, { to, subject: "hi" });
      expect(mail.from.agentId).toBe("aaaaaaaa-1");
    }
    expect(t.store.unreadCount("agent:bbbbbbbb-2")).toBe(3);
    expect(t.store.unreadCount("agent:cccccccc-3")).toBe(1);
  });

  it("@assistant goes to the alias mailbox and survives a new holder", async () => {
    const t = setup(agents());
    await t.service.send(A, { to: "@assistant", subject: "start" });
    expect(t.notified.at(-1)?.holder).toBe("cccccccc-3");
    t.directory.agents = agents().map((a) => (a.id === "cccccccc-3" ? agent("eeeeeeee-5", { labels: { "paseo.assistant": "1" } }) : a));
    expect(await t.service.list("eeeeeeee-5", {})).toHaveLength(1);
    expect(await t.service.list("bbbbbbbb-2", {})).toHaveLength(0);
  });

  it("queues for an alias nobody holds", async () => {
    const t = setup([agent("aaaaaaaa-1")]);
    const { resolved } = await t.service.send(A, { to: "@assistant", subject: "x" });
    expect(resolved.note).toMatch(/queued/);
    expect(t.notified.at(-1)?.holder).toBeNull();
  });

  it("rejects archived, subagents, self, unknown and ambiguous recipients", async () => {
    const list = [...agents(), agent("ffffffff-6", { title: "Twin" }), agent("gggggggg-7", { title: "Twin" }), agent("hhhhhhhh-8", { archived: true })];
    const t = setup(list);
    await expect(t.service.send(A, { to: "hhhhhhhh-8", subject: "x" })).rejects.toThrow(/archived/);
    await expect(t.service.send({ ...A, agentId: "bbbbbbbb-2", name: "B" }, { to: "dddddddd-4", subject: "x" })).rejects.toThrow(/only its parent can mail/);
    await expect(t.service.send(A, { to: "aaaaaaaa-1", subject: "x" })).rejects.toThrow(/yourself/);
    await expect(t.service.send(A, { to: "nobody", subject: "x" })).rejects.toThrow(/No live agent/);
    await expect(t.service.send(A, { to: "Twin", subject: "x" })).rejects.toThrow(/2 agents/);
    await expect(t.service.send({ ...A, agentId: "dddddddd-4" }, { to: "Coder B", subject: "x" })).rejects.toThrow(/only its parent/);
  });

  it("@parent resolves to the creator; a subagent mails only its parent", async () => {
    const t = setup(agents());
    const sub = { type: "agent" as const, agentId: "dddddddd-4", name: "Sub" };
    const { mail, resolved } = await t.service.send(sub, { to: "@parent", subject: "done" });
    expect(mail.to).toMatchObject({ mailbox: "agent:aaaaaaaa-1", agentId: "aaaaaaaa-1" });
    expect(resolved.holderId).toBe("aaaaaaaa-1");
    expect((await t.service.whois("dddddddd-4", "@parent")).holder).toBe("aaaaaaaa-1");
    await expect(t.service.send(sub, { to: "aaaaaaaa-1", subject: "x" })).resolves.toBeTruthy();
    await expect(t.service.send(sub, { to: "@assistant", subject: "x" })).rejects.toThrow(/only its parent/);
  });

  it("a parent mails its own subagent by id and replies to its mail; others cannot", async () => {
    const t = setup(agents());
    const sub = { type: "agent" as const, agentId: "dddddddd-4", name: "Sub" };
    const { mail: up } = await t.service.send(sub, { to: "@parent", subject: "q" });
    const down = await t.service.reply(A, up.id, "answer");
    expect(down.mail.to).toMatchObject({ mailbox: "agent:dddddddd-4", agentId: "dddddddd-4" });
    await t.service.send(A, { to: "dddddddd-4", subject: "go" });
    expect(t.store.unreadCount("agent:dddddddd-4")).toBe(2);
    await expect(t.service.send({ type: "agent", agentId: "bbbbbbbb-2", name: "B" }, { to: "dddddddd-4", subject: "x" })).rejects.toThrow(/only its parent can mail/);
    await expect(t.service.send(A, { to: "Sub", subject: "x" })).rejects.toThrow(/No live agent/);
  });

  it("@parent errors clearly without a parent or with a gone parent", async () => {
    const t = setup(agents());
    await expect(t.service.send(A, { to: "@parent", subject: "x" })).rejects.toThrow(/no parent/);
    await expect(t.service.send({ type: "human", name: "me" }, { to: "@parent", subject: "x" })).rejects.toThrow(/for agents/);
    t.directory.agents = agents().map((a) => (a.id === "aaaaaaaa-1" ? { ...a, archived: true } : a));
    await expect(t.service.send({ type: "agent", agentId: "dddddddd-4", name: "Sub" }, { to: "@parent", subject: "x" })).rejects.toThrow(/gone/);
  });

  it("a label parent adds @parent and restricts nothing: still mails @assistant and is mailed by others", async () => {
    const t = setup([...agents(), agent("eeeeeeee-5", { title: "Worker", creatorId: "aaaaaaaa-1" })]);
    const worker = { type: "agent" as const, agentId: "eeeeeeee-5", name: "Worker" };
    expect((await t.service.whois("eeeeeeee-5", "@parent")).holder).toBe("aaaaaaaa-1");
    const { resolved } = await t.service.send(worker, { to: "@parent", subject: "done" });
    expect(resolved.agentId).toBe("aaaaaaaa-1");
    await t.service.send(worker, { to: "@assistant", subject: "milestone" });
    await t.service.send(A, { to: "eeeeeeee-5", subject: "next" });
    await t.service.send({ type: "agent", agentId: "bbbbbbbb-2", name: "B" }, { to: "eeeeeeee-5", subject: "hi" });
  });

  it("@parent errors clearly when the label points to a missing agent", async () => {
    const t = setup([...agents(), agent("eeeeeeee-5", { title: "Worker", creatorId: "ffffffff-6" })]);
    await expect(t.service.send({ type: "agent", agentId: "eeeeeeee-5", name: "Worker" }, { to: "@parent", subject: "x" })).rejects.toThrow(/ffffffff-6 is gone/);
  });

  it("enforces size caps", async () => {
    const t = setup(agents());
    await expect(t.service.send(A, { to: "Coder B", subject: "x", body: "a".repeat(17 * 1024) })).rejects.toThrow(/16 KB/);
    await expect(t.service.send(A, { to: "Coder B", subject: "x".repeat(201) })).rejects.toThrow(/Subject/);
  });
});

describe("read, reply, threads", () => {
  it("reads only your own mailboxes; reply threads", async () => {
    const t = setup(agents());
    const { mail } = await t.service.send(A, { to: "Coder B", subject: "q", body: "why?" });
    await expect(t.service.read("cccccccc-3", mail.id)).rejects.toThrow(/No mail/);
    expect((await t.service.read("bbbbbbbb-2", mail.id)).readAt).not.toBeNull();
    const B = { type: "agent" as const, agentId: "bbbbbbbb-2", name: "Coder B" };
    const reply = await t.service.reply(B, mail.id, "because");
    expect(reply.mail.threadId).toBe(mail.threadId);
    expect(reply.mail.subject).toBe("Re: q");
    expect(reply.mail.to.agentId).toBe("aaaaaaaa-1");
  });

  it("markRead without ids clears the mailbox", async () => {
    const t = setup(agents());
    await t.service.send(A, { to: "Coder B", subject: "1" });
    await t.service.send(A, { to: "Coder B", subject: "2" });
    expect(await t.service.markRead("bbbbbbbb-2", undefined)).toBe(2);
  });
});

describe("limits", () => {
  it("rate limits per pair, caps unread, stops ping-pong", async () => {
    const t = setup(agents(), { pairSendsPer10Minutes: 3, maxUnreadPerMailbox: 100 });
    for (let i = 0; i < 3; i++) await t.service.send(A, { to: "Coder B", subject: String(i) });
    await expect(t.service.send(A, { to: "Coder B", subject: "4" })).rejects.toThrow(/same recipient/);

    const u = setup(agents(), { maxUnreadPerMailbox: 2 });
    await u.service.send(A, { to: "Coder B", subject: "1" });
    await u.service.send(A, { to: "Coder B", subject: "2" });
    await expect(u.service.send(A, { to: "Coder B", subject: "3" })).rejects.toThrow(/Mailbox full/);

    const p = setup(agents(), { pairSendsPer10Minutes: 100, sendsPer10Minutes: 100 });
    const B = { type: "agent" as const, agentId: "bbbbbbbb-2", name: "Coder B" };
    let last = (await p.service.send(A, { to: "Coder B", subject: "go" })).mail;
    let failed = false;
    for (let i = 0; i < 12 && !failed; i++) {
      try {
        last = (await p.service.reply(i % 2 === 0 ? B : A, last.id, "ok")).mail;
      } catch (e) {
        failed = /looping/.test((e as Error).message);
        if (!failed) throw e;
      }
    }
    expect(failed).toBe(true);
  });

  it("the human is exempt and sends as human", async () => {
    const t = setup(agents(), { sendsPer10Minutes: 1 });
    for (let i = 0; i < 3; i++) await t.service.send({ type: "human", name: "Louis" }, { to: "Coder B", subject: String(i) });
    expect(t.store.unreadCount("agent:bbbbbbbb-2")).toBe(3);
  });
});

describe("store", () => {
  it("survives a restart, keeps read state, and tolerates a torn line", async () => {
    const t = setup(agents());
    const { mail } = await t.service.send(A, { to: "Coder B", subject: "q" });
    await t.service.read("bbbbbbbb-2", mail.id);
    const { appendFileSync } = await import("node:fs");
    appendFileSync(t.journal, '{"t":"mail","mail":{"id":');
    const again = new MailStore(t.journal);
    expect(again.get(mail.id)?.readAt).not.toBeNull();
  });

  it("purges by retention and caps", async () => {
    const t = setup(agents());
    const a = (await t.service.send(A, { to: "Coder B", subject: "old" })).mail;
    await t.service.read("bbbbbbbb-2", a.id);
    t.clock.now += 15 * 86_400_000;
    await t.service.send(A, { to: "Coder B", subject: "new" });
    expect(t.service.purge()).toBe(1);
    expect(t.store.has(a.id)).toBe(false);
    const c = setup(agents(), { maxMailsPerMailbox: 10, sendsPer10Minutes: 100, pairSendsPer10Minutes: 100 });
    for (let i = 0; i < 14; i++) await c.service.send(A, { to: "Coder B", subject: String(i) });
    expect(c.service.purge()).toBeGreaterThanOrEqual(4);
  });
});

describe("@user, the human's mailbox", () => {
  it("agents can mail it with @user or @human; it is never woken and nobody else can read it", async () => {
    const t = setup(agents());
    const { mail, resolved } = await t.service.send(A, { to: "@user", subject: "Report ready", body: "see the Your Actions tab", kind: "info" });
    expect(resolved).toMatchObject({ mailbox: "human:user", holderId: null, display: "@user" });
    expect(t.notified.at(-1)?.holder).toBeNull(); // nobody to wake
    expect(mail.to.mailbox).toBe("human:user");
    await t.service.send(A, { to: "@HUMAN", subject: "second" });
    expect(t.store.unreadCount("human:user")).toBe(2);
    // No agent reads it: not the sender, not the Assistant.
    expect(await t.service.list("aaaaaaaa-1", {})).toHaveLength(0);
    expect(await t.service.list("cccccccc-3", {})).toHaveLength(0);
    await expect(t.service.read("cccccccc-3", mail.id)).rejects.toThrow(/No mail/);
    expect((await t.service.whois("aaaaaaaa-1", "@user")).mailbox).toBe("human:user");
  });

  it("the human cannot mail themselves, and the usual limits apply to agents mailing the human", async () => {
    const t = setup(agents(), { pairSendsPer10Minutes: 2, maxUnreadPerMailbox: 100 });
    await expect(t.service.send({ type: "human", name: "Louis" }, { to: "@user", subject: "x" })).rejects.toThrow(/nobody to mail/);
    await t.service.send(A, { to: "@user", subject: "1" });
    await t.service.send(A, { to: "@user", subject: "2" });
    await expect(t.service.send(A, { to: "@user", subject: "3" })).rejects.toThrow(/same recipient/);
  });

  it("the user marks it read in the screen (the only mailbox where that is the point)", async () => {
    const t = setup(agents());
    await t.service.send(A, { to: "@user", subject: "FYI" });
    expect(t.store.markRead(["human:user"], undefined, "ui", t.clock.now)).toBe(1);
    expect(t.store.unreadCount("human:user")).toBe(0);
  });
});
