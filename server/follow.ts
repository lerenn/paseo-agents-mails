import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { HUMAN_MAILBOX, aliasMailbox } from "../shared/mail";
import { matchesRule, parseLabelRules, type AgentInfo, type LabelRule } from "./agents";
import type { AliasBook } from "./aliases";

/** What a grant lets an agent do in a followed mailbox. Reading is always part of it. */
export interface Grant {
  mark: boolean;
  wake: boolean;
}

export interface GrantRule {
  /** `@alias` (whoever holds it) or a label rule. */
  selector: { alias: string } | { rule: LabelRule };
  mailboxes: string[];
  grant: Grant;
}

/** `@user` / `@human` is the human's mailbox, `@name` a role alias mailbox; anything else is not a mailbox. */
export function mailboxFromSpec(spec: string): string | null {
  const s = spec.trim().toLowerCase();
  if (s === HUMAN_MAILBOX || /^@?(user|human)$/.test(s)) return HUMAN_MAILBOX;
  const alias = /^(?:alias:|@)([a-z0-9][a-z0-9_-]{0,39})$/.exec(s);
  return alias ? aliasMailbox(alias[1]) : null;
}

/**
 * One rule per line: `<selector> = <mailbox>[, <mailbox>] [: read|mark|wake ...]`, for example
 * `@assistant = @user : read+mark, wake`. The selector is `@alias` or a label (`key=value`, `key`). Permissions
 * default to `read`; `mark` and `wake` each add to it. Malformed lines grant nothing.
 */
export function parseGrants(text: string): GrantRule[] {
  const out: GrantRule[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    const left = colon < 0 ? line : line.slice(0, colon);
    const perms = colon < 0 ? "read" : line.slice(colon + 1);
    const eq = left.lastIndexOf("=");
    if (eq <= 0) continue;
    const selectorText = left.slice(0, eq).trim();
    const mailboxes = left
      .slice(eq + 1)
      .split(",")
      .map(mailboxFromSpec)
      .filter((m): m is string => !!m);
    const words = perms.toLowerCase().split(/[\s,+]+/).filter(Boolean);
    if (!selectorText || !mailboxes.length || words.some((w) => !["read", "mark", "wake"].includes(w))) continue;
    const selector = selectorText.startsWith("@") ? { alias: selectorText.slice(1).trim().toLowerCase() } : { rule: parseLabelRules(selectorText)[0] };
    if ("rule" in selector && !selector.rule) continue;
    out.push({ selector, mailboxes, grant: { mark: words.includes("mark"), wake: words.includes("wake") } });
  }
  return out;
}

/** The mailboxes (other than its own) an agent follows, with what it may do there. Subagents follow nothing. */
export function grantsFor(agent: AgentInfo, agents: AgentInfo[], book: AliasBook, rules: GrantRule[], own: string[]): Map<string, Grant> {
  const out = new Map<string, Grant>();
  if (agent.parentAgentId || agent.archived) return out;
  for (const r of rules) {
    const applies = "alias" in r.selector ? (() => { const al = book.find(r.selector.alias); return !!al && book.holders(agents, al).some((h) => h.id === agent.id); })() : matchesRule(agent.labels, r.selector.rule);
    if (!applies) continue;
    for (const box of r.mailboxes) {
      if (own.includes(box)) continue;
      const prev = out.get(box);
      out.set(box, { mark: !!prev?.mark || r.grant.mark, wake: !!prev?.wake || r.grant.wake });
    }
  }
  return out;
}

export const mailboxDisplay = (mailbox: string): string => (mailbox === HUMAN_MAILBOX ? "@user" : mailbox.startsWith("alias:") ? `@${mailbox.slice(6)}` : mailbox);

export interface AuditEntry {
  at: number;
  actor: { agentId: string; name: string };
  action: "list" | "read" | "mark_read";
  mailbox: string;
  mailIds: string[];
  count: number;
  ok: boolean;
  reason?: string;
}

export interface AuditSink {
  record(entry: AuditEntry): void;
}

/** Append-only JSONL of who looked at or marked which followed mail. Not part of the mail journal, so mail compaction never drops it. */
export class AuditLog implements AuditSink {
  constructor(private readonly file: string) {}

  record(entry: AuditEntry): void {
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const fresh = !existsSync(this.file);
    appendFileSync(this.file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    if (fresh) chmodSync(this.file, 0o600);
  }

  /** The newest entries first. */
  recent(limit = 200): AuditEntry[] {
    return this.load().slice(-limit).reverse();
  }

  private load(): AuditEntry[] {
    let text = "";
    try {
      text = readFileSync(this.file, "utf8");
    } catch {
      return [];
    }
    const out: AuditEntry[] = [];
    for (const line of text.split("\n")) {
      try {
        if (line.trim()) out.push(JSON.parse(line) as AuditEntry);
      } catch {
        // A torn last line.
      }
    }
    return out;
  }

  /** Drops entries older than the retention; returns how many went. */
  purge(maxAgeMs: number, now: number): number {
    const all = this.load();
    const kept = all.filter((e) => now - e.at <= maxAgeMs);
    if (kept.length === all.length) return 0;
    const temp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temp, kept.map((e) => JSON.stringify(e)).join("\n") + (kept.length ? "\n" : ""), { mode: 0o600 });
    renameSync(temp, this.file);
    return all.length - kept.length;
  }
}
