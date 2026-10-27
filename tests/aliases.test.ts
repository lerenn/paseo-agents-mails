import { describe, expect, it } from "vitest";
import { parseAliases } from "../server/agents";
import { ALIAS_LABEL, AliasBook, ClaimStore, validAliasName } from "../server/aliases";
import { agent, setup } from "../server/testing";

const settings = parseAliases("assistant=paseo.assistant=1");
const SENDER = { type: "agent" as const, agentId: "sender-1", name: "Sender" };

describe("AliasBook", () => {
  it("defines @aliases from the paseo.mail-alias label and from live claims, besides the settings ones", () => {
    const agents = [agent("a", { labels: { [ALIAS_LABEL]: "PCC" } }), agent("b", { labels: { [ALIAS_LABEL]: "daemon-ops" } }), agent("c"), agent("d", { archived: true, labels: { [ALIAS_LABEL]: "ghost" } })];
    const book = AliasBook.build(settings, agents, { prbr: { agentId: "c", at: 1 }, gone: { agentId: "zzz", at: 1 } }, ["retired"]);
    // A claim or held mail keeps a name known after its holder is gone; an archived label alone does not define one.
    expect(book.aliases.map((a) => a.name).sort()).toEqual(["assistant", "daemon-ops", "gone", "pcc", "prbr", "retired"]);
  });

  it("ignores reserved and malformed names", () => {
    expect(validAliasName("pcc")).toBe(true);
    expect(validAliasName("security-coordinator")).toBe(true);
    for (const bad of ["user", "human", "PCC", "a b", "", "-x", "x".repeat(41)]) expect(validAliasName(bad)).toBe(false);
    const book = AliasBook.build([], [agent("a", { labels: { [ALIAS_LABEL]: "user" } }), agent("b", { labels: { [ALIAS_LABEL]: "Bad Name" } })]);
    expect(book.aliases).toEqual([]);
  });

  it("the live claim holder comes first, then labelled agents, newest first; archived and subagents hold nothing", () => {
    const agents = [
      agent("old", { labels: { [ALIAS_LABEL]: "pcc" }, lastActivityAt: 1 }),
      agent("new", { labels: { [ALIAS_LABEL]: "pcc" }, lastActivityAt: 9 }),
      agent("claimant", { lastActivityAt: 0 }),
      agent("sub", { labels: { [ALIAS_LABEL]: "pcc" }, parentAgentId: "x" }),
      agent("dead", { labels: { [ALIAS_LABEL]: "pcc" }, archived: true }),
    ];
    const withClaim = AliasBook.build([], agents, { pcc: { agentId: "claimant", at: 1 } });
    const alias = withClaim.find("pcc")!;
    expect(withClaim.holders(agents, alias).map((a) => a.id)).toEqual(["claimant", "new", "old"]);
    const noClaim = AliasBook.build([], agents);
    expect(noClaim.holders(agents, noClaim.find("pcc")!).map((a) => a.id)).toEqual(["new", "old"]);
    // A claim of an archived agent is ignored.
    const dead = AliasBook.build([], agents, { pcc: { agentId: "dead", at: 1 } });
    expect(dead.holders(agents, dead.find("pcc")!).map((a) => a.id)).toEqual(["new", "old"]);
  });

  it("an agent may read the mailboxes of the aliases it holds", () => {
    const agents = [agent("a", { labels: { [ALIAS_LABEL]: "pcc" } }), agent("b")];
    const book = AliasBook.build(settings, agents);
    expect(book.heldBy(agents[0], agents).map((x) => x.name)).toEqual(["pcc"]);
    expect(book.heldBy(agents[1], agents)).toEqual([]);
  });
});

describe("ClaimStore", () => {
  it("persists claims", async () => {
    const t = setup([]);
    const file = `${t.dir}/claims.json`;
    const store = new ClaimStore(file);
    store.set("pcc", "a1", 5);
    store.set("prbr", "a2", 6);
    expect(new ClaimStore(file).all()).toEqual({ pcc: { agentId: "a1", at: 5 }, prbr: { agentId: "a2", at: 6 } });
    store.set("pcc", "a3", 7); // a later claim replaces the earlier one
    expect(new ClaimStore(file).all().pcc).toEqual({ agentId: "a3", at: 7 });
  });
});

describe("claiming a role alias", () => {
  const roster = () => [agent("sender-1", { title: "Sender" }), agent("pcc-1", { title: "PCC" }), agent("pcc-2", { title: "PCC (session 2)" })];

  it("mail to @pcc reaches the claimant, and the claimant's own mail moves under the alias", async () => {
    const t = setup(roster());
    await t.service.send(SENDER, { to: "pcc-1", subject: "before the alias" });
    expect(t.store.unreadCount("agent:pcc-1")).toBe(1);
    expect(await t.service.claimAlias("pcc-1", "@PCC")).toEqual({ alias: "@pcc", rehomed: 1, replaced: null });
    expect(t.store.unreadCount("agent:pcc-1")).toBe(0);
    expect(t.store.unreadCount("alias:pcc")).toBe(1);
    const { resolved } = await t.service.send(SENDER, { to: "@pcc", subject: "after" });
    expect(resolved.holderId).toBe("pcc-1");
    expect((await t.service.list("pcc-1", {})).map((m) => m.subject).sort()).toEqual(["after", "before the alias"]);
  });

  it("a live holder blocks another claimant unless takeover; an archived one never does", async () => {
    const t = setup(roster());
    await t.service.claimAlias("pcc-1", "pcc");
    await expect(t.service.claimAlias("pcc-2", "pcc")).rejects.toThrow(/held by PCC \(pcc-1\); pass takeover/);
    expect(await t.service.claimAlias("pcc-2", "pcc", true)).toMatchObject({ replaced: "pcc-1" });
    // The old one is archived, the new one is recreated again: no flag needed.
    t.directory.agents.find((a) => a.id === "pcc-2")!.archived = true;
    t.directory.agents.push(agent("pcc-3", { title: "PCC (session 3)" }));
    expect(await t.service.claimAlias("pcc-3", "pcc")).toMatchObject({ replaced: null });
  });

  it("a recreated agent finds the history and the unread mail of the role, and is the one to wake", async () => {
    const t = setup(roster());
    await t.service.claimAlias("pcc-1", "pcc");
    await t.service.send(SENDER, { to: "@pcc", subject: "read already" });
    await t.service.read("pcc-1", (await t.service.list("pcc-1", {}))[0].id);
    t.directory.agents.find((a) => a.id === "pcc-1")!.archived = true; // released on archive
    const { resolved } = await t.service.send(SENDER, { to: "@pcc", subject: "while nobody holds it" });
    expect(resolved).toMatchObject({ holderId: null });
    expect(resolved.note).toMatch(/queued/);
    await t.service.claimAlias("pcc-2", "pcc");
    const mine = await t.service.list("pcc-2", {});
    expect(mine.map((m) => [m.subject, m.readAt !== null])).toEqual([["while nobody holds it", false], ["read already", true]]);
    expect((await t.service.injection("pcc-2"))?.text).toMatch(/while nobody holds it/);
  });

  it("refuses bad names, reserved names, subagents and agents that are gone", async () => {
    const t = setup([...roster(), agent("sub", { parentAgentId: "pcc-1" })]);
    await expect(t.service.claimAlias("pcc-1", "user")).rejects.toThrow(/not a role alias name/);
    await expect(t.service.claimAlias("pcc-1", "Bad Name")).rejects.toThrow(/not a role alias name/);
    await expect(t.service.claimAlias("sub", "x")).rejects.toThrow(/subagent/);
    await expect(t.service.claimAlias("nobody", "x")).rejects.toThrow(/not alive/);
  });
});

describe("replies follow the role, not the agent id", () => {
  it("a reply to a mail from an agent holding @pcc goes to @pcc, so it reaches the recreated agent", async () => {
    const t = setup([agent("sender-1", { title: "Sender" }), agent("pcc-1", { title: "PCC" }), agent("pcc-2", { title: "PCC 2" })]);
    await t.service.claimAlias("pcc-1", "pcc");
    const { mail } = await t.service.send({ type: "agent", agentId: "pcc-1", name: "PCC" }, { to: "sender-1", subject: "question" });
    expect(mail.from.alias).toBe("pcc");
    t.directory.agents.find((a) => a.id === "pcc-1")!.archived = true;
    await t.service.claimAlias("pcc-2", "pcc");
    const reply = await t.service.reply({ type: "agent", agentId: "sender-1", name: "Sender" }, mail.id, "answer");
    expect(reply.mail.to).toMatchObject({ mailbox: "alias:pcc", display: "@pcc" });
    expect((await t.service.list("pcc-2", {})).map((m) => m.subject)).toContain("Re: question");
  });
});

describe("reconcile", () => {
  it("re-homes a labelled agent's own mail under its alias; a claim of an archived agent keeps the alias name but holds nothing", async () => {
    const t = setup([agent("sender-1"), agent("lab", { title: "Labelled", labels: { [ALIAS_LABEL]: "prbr" } }), agent("c", { title: "Claimant" })]);
    await t.service.send(SENDER, { to: "lab", subject: "to the id" });
    await t.service.claimAlias("c", "pcc");
    t.directory.agents.find((a) => a.id === "c")!.archived = true;
    const out = await t.service.reconcile();
    expect(out).toEqual({ rehomed: 1 });
    expect(t.claims.all().pcc.agentId).toBe("c"); // kept: the name stays addressable
    expect((await t.service.send(SENDER, { to: "@pcc", subject: "nobody holds it" })).resolved.holderId).toBeNull();
    expect(t.store.unreadCount("alias:prbr")).toBe(1);
    expect(t.store.unreadCount("agent:lab")).toBe(0);
    expect(await t.service.reconcile()).toEqual({ rehomed: 0 });
  });

  it("the move is one journal event: it survives a restart and an older reader ignores it", async () => {
    const t = setup([agent("sender-1"), agent("lab", { labels: { [ALIAS_LABEL]: "prbr" } })]);
    await t.service.send(SENDER, { to: "lab", subject: "x" });
    await t.service.reconcile();
    const { MailStore } = await import("../server/store");
    expect(new MailStore(t.journal).unreadCount("alias:prbr")).toBe(1);
  });
});
