import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { mailSchema, type Mail, type ReadVia } from "../shared/mail";

type Event =
  | { t: "mail"; mail: Mail }
  | { t: "read"; ids: string[]; at: number; via: ReadVia; by?: string }
  | { t: "inject"; ids: string[]; at: number }
  | { t: "wake"; id: string; at: number }
  | { t: "purge"; ids: string[] }
  | { t: "rehome"; from: string; to: string; ids: string[] };

export interface Retention {
  readMs: number;
  unreadMs: number;
  perMailbox: number;
  total: number;
}

/**
 * Mail kept as an append-only JSONL journal, held in memory. The journal is compacted at start and on
 * `purge`, with a temp file and a rename, so a crash never leaves a half-written state.
 */
export class MailStore {
  private mails = new Map<string, Mail>();

  constructor(private readonly file: string) {
    this.load();
    this.compact();
  }

  private load(): void {
    let text = "";
    try {
      text = readFileSync(this.file, "utf8");
    } catch {
      return;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        this.apply(JSON.parse(line) as Event);
      } catch {
        // A torn last line from a crash: skip it.
      }
    }
  }

  private apply(e: Event): void {
    switch (e.t) {
      case "mail": {
        const parsed = mailSchema.safeParse(e.mail);
        if (parsed.success) this.mails.set(parsed.data.id, parsed.data);
        break;
      }
      case "read":
        for (const id of e.ids) {
          const m = this.mails.get(id);
          if (m && m.readAt === null) {
            m.readAt = e.at;
            m.readVia = e.via;
            if (e.by) m.readBy = e.by;
          }
        }
        break;
      case "inject":
        for (const id of e.ids) {
          const m = this.mails.get(id);
          if (m) m.injectedAt = e.at;
        }
        break;
      case "wake": {
        const m = this.mails.get(e.id);
        if (m) {
          m.wakes += 1;
          m.lastWokeAt = e.at;
        }
        break;
      }
      case "purge":
        for (const id of e.ids) this.mails.delete(id);
        break;
      case "rehome":
        // Mail moves to another mailbox (an agent's mail to its role alias); a version that does not know this event ignores it.
        for (const id of e.ids) {
          const m = this.mails.get(id);
          if (m && m.to.mailbox === e.from) m.to = { ...m.to, mailbox: e.to };
        }
        break;
    }
  }

  private append(e: Event): void {
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const fresh = !existsSync(this.file);
    appendFileSync(this.file, `${JSON.stringify(e)}\n`, { mode: 0o600 });
    if (fresh) chmodSync(this.file, 0o600);
  }

  /** Rewrites the journal as one `mail` event per live mail. */
  private compact(): void {
    if (this.mails.size === 0 && !existsSync(this.file)) return;
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${process.pid}.tmp`;
    const lines = [...this.mails.values()].sort((a, b) => a.createdAt - b.createdAt).map((mail) => JSON.stringify({ t: "mail", mail } satisfies Event));
    writeFileSync(temp, lines.length ? `${lines.join("\n")}\n` : "", { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, this.file);
  }

  add(mail: Mail): Mail {
    this.mails.set(mail.id, mail);
    this.append({ t: "mail", mail });
    return mail;
  }

  /** Names of the role aliases that hold mail. */
  aliasNames(): string[] {
    return [...new Set([...this.mails.values()].filter((m) => m.to.mailbox.startsWith("alias:")).map((m) => m.to.mailbox.slice("alias:".length)))];
  }

  /** Every mail, oldest first. */
  all(): Mail[] {
    return [...this.mails.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  has(id: string): boolean {
    return this.mails.has(id);
  }

  get(id: string): Mail | undefined {
    return this.mails.get(id);
  }

  /** A mailbox's mails, unread first, then newest first. */
  list(mailboxes: string[], o: { unreadOnly?: boolean; threadId?: string; limit?: number } = {}): Mail[] {
    const out = [...this.mails.values()].filter(
      (m) => mailboxes.includes(m.to.mailbox) && (!o.unreadOnly || m.readAt === null) && (!o.threadId || m.threadId === o.threadId),
    );
    out.sort((a, b) => Number(a.readAt !== null) - Number(b.readAt !== null) || b.createdAt - a.createdAt);
    return o.limit ? out.slice(0, o.limit) : out;
  }

  thread(threadId: string): Mail[] {
    return [...this.mails.values()].filter((m) => m.threadId === threadId).sort((a, b) => a.createdAt - b.createdAt);
  }

  unreadCount(mailbox: string): number {
    let n = 0;
    for (const m of this.mails.values()) if (m.to.mailbox === mailbox && m.readAt === null) n++;
    return n;
  }

  /** Mailboxes that hold unread mail. */
  mailboxesWithUnread(): string[] {
    return [...new Set([...this.mails.values()].filter((m) => m.readAt === null).map((m) => m.to.mailbox))];
  }

  /** Marks the given mails of these mailboxes read (every unread one when `ids` is omitted); returns how many changed. */
  markRead(mailboxes: string[], ids: string[] | undefined, via: ReadVia, at: number, by?: string): number {
    const changed = [...this.mails.values()]
      .filter((m) => m.readAt === null && mailboxes.includes(m.to.mailbox) && (!ids || ids.includes(m.id)))
      .map((m) => m.id);
    if (changed.length) {
      const e: Event = { t: "read", ids: changed, at, via, ...(by ? { by } : {}) };
      this.apply(e);
      this.append(e);
    }
    return changed.length;
  }

  /** Moves every mail of one mailbox to another, nothing is copied; returns how many moved. */
  rehome(from: string, to: string): number {
    if (from === to) return 0;
    const ids = [...this.mails.values()].filter((m) => m.to.mailbox === from).map((m) => m.id);
    if (!ids.length) return 0;
    const e: Event = { t: "rehome", from, to, ids };
    this.apply(e);
    this.append(e);
    return ids.length;
  }

  markInjected(ids: string[], at: number): void {
    if (!ids.length) return;
    const e: Event = { t: "inject", ids, at };
    this.apply(e);
    this.append(e);
  }

  recordWake(ids: string[], at: number): void {
    for (const id of ids) {
      const e: Event = { t: "wake", id, at };
      this.apply(e);
      this.append(e);
    }
  }

  /** Drops mails past retention and enforces the size caps (oldest read first); returns how many went. */
  purge(r: Retention, now: number): number {
    const drop = new Set<string>();
    const all = [...this.mails.values()];
    for (const m of all) {
      if (m.readAt !== null ? now - m.readAt > r.readMs : now - m.createdAt > r.unreadMs) drop.add(m.id);
    }
    const survivors = all.filter((m) => !drop.has(m.id));
    const evict = (list: Mail[], cap: number) => {
      if (list.length <= cap) return;
      const order = [...list].sort((a, b) => Number(b.readAt !== null) - Number(a.readAt !== null) || a.createdAt - b.createdAt);
      for (const m of order.slice(0, list.length - cap)) drop.add(m.id);
    };
    const boxes = new Map<string, Mail[]>();
    for (const m of survivors) boxes.set(m.to.mailbox, [...(boxes.get(m.to.mailbox) ?? []), m]);
    for (const list of boxes.values()) evict(list, r.perMailbox);
    evict(survivors.filter((m) => !drop.has(m.id)), r.total);
    if (drop.size) {
      for (const id of drop) this.mails.delete(id);
      this.compact();
    }
    return drop.size;
  }
}
