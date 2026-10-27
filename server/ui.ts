import { HUMAN_MAILBOX, aliasMailbox, type Mail } from "../shared/mail";
import type { MailboxSummary } from "../shared/rpc";
import type { AgentInfo } from "./agents";
import type { AliasBook } from "./aliases";

/**
 * Summaries for the Mail screen: only role aliases (@assistant, @pcc...) and the human's own mailbox. A mailbox of a
 * plain agent id is kept but not listed, so a recreated agent keeps its role's mailbox and the list stays short. An
 * alias is listed when it has mail or a live holder; `holder` says who holds it now (null: nobody, mail waits).
 */
export function summarize(mails: Mail[], live: AgentInfo[] | null, book: AliasBook): { mailboxes: MailboxSummary[]; unread: number } {
  const byBox = new Map<string, Mail[]>([[HUMAN_MAILBOX, []]]);
  for (const m of mails) {
    if (m.to.mailbox === HUMAN_MAILBOX || m.to.mailbox.startsWith("alias:")) byBox.set(m.to.mailbox, [...(byBox.get(m.to.mailbox) ?? []), m]);
  }
  for (const a of book.aliases) {
    if (live && book.holders(live, a).length > 0 && !byBox.has(aliasMailbox(a.name))) byBox.set(aliasMailbox(a.name), []);
  }
  const mailboxes = [...byBox].map(([id, list]): MailboxSummary => {
    const isHuman = id === HUMAN_MAILBOX;
    const name = id.slice("alias:".length);
    const alias = isHuman ? undefined : book.find(name);
    const holder = alias && live ? (book.holders(live, alias)[0] ?? null) : null;
    const last = list[list.length - 1];
    return {
      id,
      kind: isHuman ? "human" : "alias",
      label: isHuman ? "You (@user)" : `@${name}`,
      agentId: holder?.id ?? null,
      holder: isHuman ? null : (holder?.title ?? holder?.id ?? null),
      // An alias with nobody holding it is not "archived": its mail waits for the next holder.
      archived: false,
      unread: list.filter((m) => m.readAt === null).length,
      total: list.length,
      lastAt: last?.createdAt ?? null,
    };
  });
  // The human's first, then the most recent mail.
  mailboxes.sort((a, b) => Number(b.kind === "human") - Number(a.kind === "human") || (b.lastAt ?? 0) - (a.lastAt ?? 0) || a.label.localeCompare(b.label));
  // The only badge: mail addressed to the human. Agent-to-agent mail never counts.
  return { mailboxes, unread: mailboxes.find((b) => b.kind === "human")?.unread ?? 0 };
}
