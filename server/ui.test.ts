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
  it("counts unread per mailbox and in total, greys archived agents, puts live and recent first", () => {
    const out = summarize(
      [mail("1", "agent:live", 10, null, "Live One"), mail("2", "agent:live", 20), mail("3", "agent:gone", 30, null, "Gone One"), mail("4", "alias:assistant", 5, 6)],
      [agent("live", { title: "Live One" }), agent("asst", { labels: { "paseo.assistant": "1" } })],
      aliases,
    );
    expect(out.unread).toBe(3);
    expect(out.mailboxes.map((b) => [b.id, b.archived, b.unread, b.total])).toEqual([
      ["agent:live", false, 2, 2],
      ["alias:assistant", false, 0, 1],
      ["agent:gone", true, 1, 1],
    ]);
    expect(out.mailboxes[2].label).toBe("Gone One");
    expect(out.mailboxes[1].label).toBe("@assistant");
  });
  it("lists an alias with a live holder even before it has mail, and does not call agents archived when liveness is unknown", () => {
    const out = summarize([mail("1", "agent:x", 1)], [agent("asst", { labels: { "paseo.assistant": "1" } })], aliases);
    expect(out.mailboxes.map((b) => b.id).sort()).toEqual(["agent:x", "alias:assistant"]);
    const unknown = summarize([mail("1", "agent:x", 1)], null, aliases);
    expect(unknown.mailboxes[0].archived).toBe(false);
  });
});
