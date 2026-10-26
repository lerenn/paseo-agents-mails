import { describe, expect, it } from "vitest";
import type { Mail } from "../shared/mail";
import { badge, groupThreads, readState, replyTarget } from "./model";

const mail = (id: string, threadId: string, at: number, o: Partial<Mail> = {}): Mail => ({
  id, threadId, inReplyTo: null, from: { type: "agent", agentId: "a", name: "Coder" }, to: { mailbox: "agent:b", display: "B" },
  subject: "PR up", body: "b", kind: "info", createdAt: at, readAt: null, readVia: null, injectedAt: null, wakes: 0, lastWokeAt: null, ...o,
});

describe("groupThreads", () => {
  it("groups by thread, orders by latest activity, counts unread, names the thread from its first mail", () => {
    const threads = groupThreads([
      mail("3", "t1", 30, { subject: "Re: PR up", readAt: 31, readVia: "tool", from: { type: "agent", agentId: "b", name: "Reviewer" } }),
      mail("1", "t1", 10),
      mail("2", "t2", 20, { subject: "Other" }),
    ]);
    expect(threads.map((t) => t.threadId)).toEqual(["t1", "t2"]);
    expect(threads[0]).toMatchObject({ subject: "PR up", count: 2, unread: 1, lastAt: 30, participants: ["Coder", "Reviewer"] });
    expect(threads[0].mails.map((m) => m.id)).toEqual(["1", "3"]);
    expect(threads[1].subject).toBe("Other");
  });
  it("is empty for no mail", () => expect(groupThreads([])).toEqual([]));
});

describe("badge, replyTarget, readState", () => {
  it("caps the badge", () => {
    expect(badge(0)).toBe("");
    expect(badge(7)).toBe("7");
    expect(badge(150)).toBe("99+");
  });
  it("replies go to agents only", () => {
    expect(replyTarget(mail("1", "t", 1))).toBe("a");
    expect(replyTarget(mail("1", "t", 1, { from: { type: "human", name: "You" } }))).toBeNull();
  });
  it("says what the agent has seen", () => {
    expect(readState(mail("1", "t", 1))).toBe("unread");
    expect(readState(mail("1", "t", 1, { readAt: 5, readVia: "inject" }))).toMatch(/^shown in its context/);
    expect(readState(mail("1", "t", 1, { readAt: 5, readVia: "ui" }))).toMatch(/^marked read by you/);
  });
});
