import { randomUUID } from "node:crypto";
import { MAX_BODY_BYTES, MAX_KIND, MAX_SUBJECT, agentMailbox, type Mail, type ReadVia } from "../shared/mail";
import type { AgentsMailSettings } from "../shared/settings";
import { resolveAddress, mailboxesOf, type Resolved } from "./address";
import { parseAliases, type AgentInfo, type Alias, type Directory } from "./agents";
import { LimitError, SendLimits } from "./limits";
import { cleanName, renderBlock, type Rendered } from "./render";
import type { MailStore } from "./store";

export class UsageError extends Error {}

export interface Sender {
  type: "agent" | "human" | "system";
  agentId?: string;
  name: string;
}

export interface SendInput {
  to: string;
  subject: string;
  body?: string;
  kind?: string;
  inReplyTo?: string;
}

export interface Ports {
  store: MailStore;
  directory: Directory;
  settings: () => AgentsMailSettings;
  now: () => number;
  /** Called after a mail is stored, with the agent that should be woken (null when nobody holds the alias). */
  onMail: (mail: Mail, holderId: string | null) => void;
}

/** The mailbox logic behind the MCP tools and the admin API. */
export class MailService {
  private readonly limits = new SendLimits();

  constructor(private readonly p: Ports) {}

  aliases(): Alias[] {
    return parseAliases(this.p.settings().aliases);
  }

  /** The agent behind a tool call; throws when it is gone or archived. */
  private async caller(agentId: string): Promise<AgentInfo> {
    const found = (await this.p.directory.list()).find((a) => a.id === agentId) ?? (await this.p.directory.fresh(agentId));
    if (!found) throw new UsageError("Your agent is not known to Paseo (archived?).");
    return found;
  }

  async mailboxes(agentId: string): Promise<string[]> {
    const agent = await this.caller(agentId).catch(() => null);
    return agent ? mailboxesOf(agent, this.aliases()) : [agentMailbox(agentId)];
  }

  async send(sender: Sender, input: SendInput): Promise<{ mail: Mail; resolved: Resolved }> {
    const s = this.p.settings();
    if (!s.enabled) throw new UsageError("Agents Mail is switched off.");
    const subject = input.subject.trim();
    const body = input.body ?? "";
    const kind = (input.kind ?? "info").trim();
    if (!subject || subject.length > MAX_SUBJECT) throw new UsageError(`Subject must be 1 to ${MAX_SUBJECT} characters.`);
    if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) throw new UsageError(`Body is over ${MAX_BODY_BYTES / 1024} KB; shorten it.`);
    if (kind.length > MAX_KIND) throw new UsageError(`kind is at most ${MAX_KIND} characters.`);

    let senderAgent: AgentInfo | null = null;
    if (sender.type === "agent") {
      if (!sender.agentId) throw new UsageError("This agent is not known yet; try again after its first turn.");
      senderAgent = await this.caller(sender.agentId);
      if (senderAgent.parentAgentId) throw new UsageError("Subagents cannot send mail; report to your parent through your result.");
    }
    const agents = await this.p.directory.list();
    const resolved = resolveAddress(input.to, agents, this.aliases(), senderAgent?.id ?? null);

    const parent = input.inReplyTo ? this.p.store.get(input.inReplyTo) : undefined;
    const id = randomUUID();
    const threadId = parent?.threadId ?? id;
    if (sender.type === "agent") {
      this.limits.check(
        {
          from: sender.agentId!,
          mailbox: resolved.mailbox,
          unread: this.p.store.unreadCount(resolved.mailbox),
          thread: parent ? this.p.store.thread(threadId) : [],
          now: this.p.now(),
        },
        s,
      );
    }
    const mail: Mail = {
      id,
      threadId,
      inReplyTo: parent?.id ?? null,
      from: { type: sender.type, ...(sender.agentId ? { agentId: sender.agentId } : {}), name: cleanName(sender.name, 80) },
      to: { mailbox: resolved.mailbox, ...(resolved.agentId ? { agentId: resolved.agentId } : {}), display: resolved.display },
      subject,
      body,
      kind,
      createdAt: this.p.now(),
      readAt: null,
      readVia: null,
      injectedAt: null,
      wakes: 0,
      lastWokeAt: null,
    };
    this.p.store.add(mail);
    this.p.onMail(mail, resolved.holderId);
    return { mail, resolved };
  }

  async reply(sender: Sender, id: string, body: string, kind?: string): Promise<{ mail: Mail; resolved: Resolved }> {
    const original = this.p.store.get(id);
    if (!original || !(await this.canSee(sender.agentId, original))) throw new UsageError(`No mail "${id}" in your mailbox.`);
    if (original.from.type !== "agent" || !original.from.agentId) throw new UsageError("That mail did not come from an agent; there is nobody to reply to.");
    const subject = /^re:/i.test(original.subject) ? original.subject : `Re: ${original.subject}`;
    return this.send(sender, { to: original.from.agentId, subject: subject.slice(0, MAX_SUBJECT), body, kind: kind ?? "info", inReplyTo: original.id });
  }

  private async canSee(agentId: string | undefined, mail: Mail): Promise<boolean> {
    return !!agentId && (await this.mailboxes(agentId)).includes(mail.to.mailbox);
  }

  async list(agentId: string, o: { unreadOnly?: boolean; thread?: string; limit?: number }): Promise<Mail[]> {
    return this.p.store.list(await this.mailboxes(agentId), o);
  }

  async read(agentId: string, id: string): Promise<Mail> {
    const mail = this.p.store.get(id);
    if (!mail || !(await this.canSee(agentId, mail))) throw new UsageError(`No mail "${id}" in your mailbox.`);
    this.p.store.markRead([mail.to.mailbox], [id], "tool", this.p.now());
    return this.p.store.get(id)!;
  }

  async markRead(agentId: string, ids: string[] | undefined): Promise<number> {
    return this.p.store.markRead(await this.mailboxes(agentId), ids, "tool", this.p.now());
  }

  async whois(agentId: string, to: string): Promise<{ mailbox: string; display: string; holder: string | null; note?: string }> {
    const resolved = resolveAddress(to, await this.p.directory.list(), this.aliases(), agentId);
    return { mailbox: resolved.mailbox, display: resolved.display, holder: resolved.holderId, note: resolved.note };
  }

  /**
   * Unread mail for an agent as an injection block; mails shown whole are marked read, cut ones keep
   * their unread state and are not injected again. Null when there is nothing new to show.
   */
  async injection(agentId: string, via: ReadVia = "inject"): Promise<Rendered | null> {
    const s = this.p.settings();
    const now = this.p.now();
    const boxes = await this.mailboxes(agentId);
    const fresh = this.p.store.list(boxes, { unreadOnly: true }).filter((m) => m.injectedAt === null).sort((a, b) => a.createdAt - b.createdAt);
    const rendered = renderBlock(fresh, { perMailBytes: s.injectPerMailBytes, totalBytes: s.injectMaxBytes, now });
    if (!rendered) return null;
    this.p.store.markInjected([...rendered.whole, ...rendered.partial], now);
    for (const box of boxes) this.p.store.markRead([box], rendered.whole, via, now);
    return rendered;
  }

  /** Retention and caps; run at start and daily. */
  purge(): number {
    const s = this.p.settings();
    return this.p.store.purge(
      { readMs: s.readRetentionDays * 86_400_000, unreadMs: s.unreadRetentionDays * 86_400_000, perMailbox: s.maxMailsPerMailbox, total: s.maxMailsTotal },
      this.p.now(),
    );
  }
}

export { LimitError };
