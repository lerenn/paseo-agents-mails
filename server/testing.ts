import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { settingsSchema } from "../shared/settings";
import type { AgentInfo, Directory } from "./agents";
import { ClaimStore } from "./aliases";
import type { AuditEntry } from "./follow";
import { MailService } from "./service";
import { MailStore } from "./store";

export const agent = (id: string, o: Partial<AgentInfo> = {}): AgentInfo => ({
  id,
  title: id,
  labels: {},
  parentAgentId: null,
  creatorId: null,
  archived: false,
  status: "idle",
  requiresAttention: false,
  attentionReason: null,
  lastActivityAt: 1,
  ...o,
});

export class FakeDirectory implements Directory {
  sent: { id: string; text: string }[] = [];
  failSend = false;
  /** Throw this from send instead (e.g. a daemon timeout). */
  sendError: Error | null = null;
  /** Pretend the host skipped the send because the agent started a turn. */
  skipSend = false;
  constructor(public agents: AgentInfo[]) {}
  async list() {
    return this.agents.filter((a) => !a.archived);
  }
  async fresh(id: string) {
    return this.agents.find((a) => a.id === id && !a.archived) ?? null;
  }
  async send(id: string, text: string) {
    if (this.sendError) throw this.sendError;
    if (this.failSend) throw new Error("send failed");
    if (this.skipSend) return false;
    this.sent.push({ id, text });
    return true;
  }
}

export function setup(agents: AgentInfo[], settings: Partial<ReturnType<typeof settingsSchema.parse>> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "agents-mail-"));
  const store = new MailStore(path.join(dir, "mail.jsonl"));
  const directory = new FakeDirectory(agents);
  const clock = { now: 1_000_000 };
  const audit: AuditEntry[] = [];
  const notified: { id: string; holder: string | null }[] = [];
  const service = new MailService({
    store,
    claims: new ClaimStore(path.join(dir, "aliases.json")),
    directory,
    settings: () => settingsSchema.parse(settings),
    now: () => clock.now,
    onMail: (m, holder) => notified.push({ id: m.id, holder }),
    audit: { record: (e) => void audit.push(e) },
  });
  return { dir, store, claims: (service as unknown as { p: { claims: ClaimStore } }).p.claims, directory, clock, service, notified, audit, settings: () => settingsSchema.parse(settings), journal: path.join(dir, "mail.jsonl") };
}
