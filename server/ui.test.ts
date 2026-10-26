import { describe, expect, it } from "vitest";
import type { Mail } from "../shared/mail";
import { parseAliases } from "./agents";
import { summarize } from "./ui";
import { agent } from "./testing";

const mail = (id: string, box: string, at: number, readAt: number | null = null, display = "x"): Mail => ({
  id, threadId: id, inReplyTo: null, from: { type: "agent", agentId: "s", name: "S" }, to: { mailbox: box, display },
  subject: "s", body: "b", kind: "info", createdAt: at, readAt, readVia: readAt ? "tool" : null, injectedAt: null, wakes: 0, lastWokeAt: null,
});
const aliases = parseAliases("assistant=paseo.assistant=1");

describe("summarize (Mail screen)", () => {
  it("puts the human's mailbox first, counts only mail addressed to the human as the badge, greys archived agents, then live and recent", () => {
    const out = summarize(
      [mail("1", "agent:live", 10, null, "Live One"), mail("2", "agent:live", 20), mail("3", "agent:gone", 30, null, "Gone One"), mail("4", "alias:assistant", 5, 6), mail("5", "human:user", 40), mail("6", "human:user", 41, 42)],
      [agent("live", { title: "Live One" }), agent("asst", { labels: { "paseo.assistant": "1" } })],
      aliases,
    );
    // Agent-to-agent mail (3 unread in agent mailboxes) never counts: the badge is the human's 1.
    expect(out.unread).toBe(1);
    expect(out.mailboxes.map((b) => [b.id, b.kind, b.archived, b.unread, b.total])).toEqual([
      ["human:user", "human", false, 1, 2],
      ["agent:live", "agent", false, 2, 2],
      ["alias:assistant", "alias", false, 0, 1],
      ["agent:gone", "agent", true, 1, 1],
    ]);
    expect(out.mailboxes[0].label).toBe("You (@user)");
    expect(out.mailboxes[3].label).toBe("Gone One");
    expect(out.mailboxes[2].label).toBe("@assistant");
  });

  it("the human's mailbox is always there, even with no mail at all, and never archived", () => {
    const out = summarize([], [], aliases);
    expect(out.mailboxes).toHaveLength(1);
    expect(out.mailboxes[0]).toMatchObject({ id: "human:user", kind: "human", archived: false, unread: 0, total: 0 });
    expect(out.unread).toBe(0);
    expect(summarize([], null, aliases).mailboxes[0].archived).toBe(false);
  });

  it("lists an alias with a live holder even before it has mail, and does not call agents archived when liveness is unknown", () => {
    const out = summarize([mail("1", "agent:x", 1)], [agent("asst", { labels: { "paseo.assistant": "1" } })], aliases);
    expect(out.mailboxes.map((b) => b.id).sort()).toEqual(["agent:x", "alias:assistant", "human:user"]);
    const unknown = summarize([mail("1", "agent:x", 1)], null, aliases);
    expect(unknown.mailboxes.find((b) => b.id === "agent:x")?.archived).toBe(false);
  });
});
