import { describe, expect, it } from "vitest";
import type { Mail } from "../shared/mail";
import { parseAliases } from "./agents";
import { AliasBook } from "./aliases";
import { summarize } from "./ui";
import { agent } from "./testing";

const mail = (id: string, box: string, at: number, readAt: number | null = null, display = "x"): Mail => ({
  id, threadId: id, inReplyTo: null, from: { type: "agent", agentId: "s", name: "S" }, to: { mailbox: box, display },
  subject: "s", body: "b", kind: "info", createdAt: at, readAt, readVia: readAt ? "tool" : null, injectedAt: null, wakes: 0, lastWokeAt: null,
});
const aliases = parseAliases("assistant=paseo.assistant=1");
const book = (live: ReturnType<typeof agent>[] | null, claims = {}) => AliasBook.build(aliases, live ?? [], claims);

describe("summarize (Mail screen): aliases and the human only", () => {
  it("lists only @aliases and the human's mailbox, the human first, with who holds each; agent-id mailboxes are hidden", () => {
    const live = [agent("live", { title: "Live One" }), agent("asst", { title: "Assistant", labels: { "paseo.assistant": "1" } }), agent("pcc", { title: "PCC", labels: { "paseo.mail-alias": "pcc" } })];
    const out = summarize(
      [mail("1", "agent:live", 10, null, "Live One"), mail("2", "agent:gone", 30, null, "Gone One"), mail("3", "alias:assistant", 5, 6), mail("4", "human:user", 40), mail("5", "human:user", 41, 42), mail("6", "alias:pcc", 20)],
      live,
      book(live),
    );
    expect(out.mailboxes.map((b) => [b.id, b.kind, b.unread, b.total, b.holder])).toEqual([
      ["human:user", "human", 1, 2, null],
      ["alias:pcc", "alias", 1, 1, "PCC"],
      ["alias:assistant", "alias", 0, 1, "Assistant"],
    ]);
    expect(out.mailboxes.map((b) => b.label)).toEqual(["You (@user)", "@pcc", "@assistant"]);
    // The badge is only the human's 1: the unread agent-id mail (2) and the alias mail never count.
    expect(out.unread).toBe(1);
  });

  it("an alias keeps its mailbox (and mail) when nobody holds it, with no holder shown", () => {
    const out = summarize([mail("1", "alias:pcc", 20)], [agent("x")], book([agent("x")]));
    expect(out.mailboxes.find((b) => b.id === "alias:pcc")).toMatchObject({ holder: null, total: 1, archived: false });
  });

  it("the human's mailbox is always there, even with no mail and with unknown liveness", () => {
    expect(summarize([], [], book([])).mailboxes).toHaveLength(1);
    expect(summarize([], null, book(null)).mailboxes[0]).toMatchObject({ id: "human:user", kind: "human", unread: 0 });
  });

  it("lists an alias with a live holder before it has any mail", () => {
    const live = [agent("asst", { labels: { "paseo.assistant": "1" } })];
    expect(summarize([], live, book(live)).mailboxes.map((b) => b.id).sort()).toEqual(["alias:assistant", "human:user"]);
  });

  it("a claim makes the claimant the holder", () => {
    const live = [agent("old", { title: "Daemon ops (old)" }), agent("new", { title: "Daemon ops (session 2)" })];
    const out = summarize([mail("1", "alias:daemon-ops", 1)], live, book(live, { "daemon-ops": { agentId: "new", at: 1 } }));
    expect(out.mailboxes.find((b) => b.id === "alias:daemon-ops")).toMatchObject({ holder: "Daemon ops (session 2)", agentId: "new" });
  });
});
