import type { Mail } from "../shared/mail";

export interface Thread {
  threadId: string;
  subject: string;
  count: number;
  unread: number;
  lastAt: number;
  /** Senders in order of first appearance. */
  participants: string[];
  mails: Mail[];
}

/** Groups a mailbox's mails into threads, the most recently active first; mails inside a thread are oldest first. */
export function groupThreads(mails: readonly Mail[]): Thread[] {
  const byThread = new Map<string, Mail[]>();
  for (const m of [...mails].sort((a, b) => a.createdAt - b.createdAt)) byThread.set(m.threadId, [...(byThread.get(m.threadId) ?? []), m]);
  return [...byThread]
    .map(([threadId, list]) => ({
      threadId,
      // The first mail names the thread, without the "Re:" replies add.
      subject: list[0].subject.replace(/^(re:\s*)+/i, ""),
      count: list.length,
      unread: list.filter((m) => m.readAt === null).length,
      lastAt: list[list.length - 1].createdAt,
      participants: [...new Set(list.map((m) => m.from.name))],
      mails: list,
    }))
    .sort((a, b) => b.lastAt - a.lastAt);
}

/** The unread badge: empty at zero, capped at 99+. */
export const badge = (n: number): string => (n <= 0 ? "" : n > 99 ? "99+" : String(n));

/** Who a reply to this mail goes to: its sender when it is an agent, else nobody. */
export const replyTarget = (m: Mail): string | null => (m.from.type === "agent" && m.from.agentId ? m.from.agentId : null);

/** What the agent has seen of a mail, shown on each one. */
export function readState(m: Mail): string {
  if (m.readAt === null) return "unread";
  const via = m.readVia === "inject" ? "shown in its context" : m.readVia === "inline" ? "delivered in a wake" : m.readVia === "ui" ? "marked read by you" : m.readVia === "import" ? "imported" : "read";
  return `${via}, ${new Date(m.readAt).toLocaleString()}`;
}
