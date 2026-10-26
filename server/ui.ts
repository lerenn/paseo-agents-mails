import { agentMailbox, aliasMailbox, type Mail } from "../shared/mail";
import type { MailboxSummary } from "../shared/rpc";
import { holders } from "./address";
import type { AgentInfo, Alias } from "./agents";

/** Summaries for the Mail screen: every mailbox with mail, plus the aliases that have a live holder. */
export function summarize(mails: Mail[], live: AgentInfo[] | null, aliases: Alias[]): { mailboxes: MailboxSummary[]; unread: number } {
  const byBox = new Map<string, Mail[]>();
  for (const m of mails) byBox.set(m.to.mailbox, [...(byBox.get(m.to.mailbox) ?? []), m]);
  for (const a of aliases) {
    if (live && holders(live, a).length > 0 && !byBox.has(aliasMailbox(a.name))) byBox.set(aliasMailbox(a.name), []);
  }
  const liveIds = new Set((live ?? []).map((a) => a.id));
  const mailboxes = [...byBox].map(([id, list]): MailboxSummary => {
    const isAlias = id.startsWith("alias:");
    const agentId = isAlias ? null : id.slice("agent:".length);
    const last = list[list.length - 1];
    const title = live?.find((a) => a.id === agentId)?.title;
    return {
      id,
      kind: isAlias ? "alias" : "agent",
      label: isAlias ? `@${id.slice("alias:".length)}` : (title ?? last?.to.display ?? agentId ?? id),
      agentId,
      // Unknown liveness (no directory) is not "archived".
      archived: !isAlias && live !== null && agentId !== null && !liveIds.has(agentId),
      unread: list.filter((m) => m.readAt === null).length,
      total: list.length,
      lastAt: last?.createdAt ?? null,
    };
  });
  // Alive first, then most recent mail.
  mailboxes.sort((a, b) => Number(a.archived) - Number(b.archived) || (b.lastAt ?? 0) - (a.lastAt ?? 0) || a.label.localeCompare(b.label));
  return { mailboxes, unread: mailboxes.reduce((n, b) => n + b.unread, 0) };
}

export { agentMailbox };
