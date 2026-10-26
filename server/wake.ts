import type { Mail } from "../shared/mail";
import type { AgentsMailSettings } from "../shared/settings";
import type { AgentInfo } from "./agents";
import { MAX_WAKES_PER_THREAD_HOUR } from "./limits";
import { cleanName, renderBlock } from "./render";

/** Re-wake spacing for a mail still unread: after the first wake, 5 min, then 30 min; at most 3 wakes per mail. */
const REWAKE_MS = [0, 5 * 60_000, 30 * 60_000];
const HARD_CAP_MS = 2 * 60_000;
const FAIL_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000];

export interface WakePorts {
  now: () => number;
  settings: () => AgentsMailSettings;
  /** The agents that hold unread mail right now, with the mails. Alias mailboxes map to their holder. */
  pending: () => Promise<{ agentId: string; mails: Mail[] }[]>;
  /** A fresh read of the agent. */
  fresh: (agentId: string) => Promise<AgentInfo | null>;
  send: (agentId: string, text: string) => Promise<void>;
  /** Whether the agent has the mail tools (its capability is bound). */
  hasTools: (agentId: string) => boolean;
  /** True once the host has delivered a prompt through `agent.prompt`, so injection works on it. */
  injectionLive: () => boolean;
  injectEnabledFor: (agent: AgentInfo) => boolean;
  recordWake: (ids: string[], at: number) => void;
  /** Marks mails shown inline in a wake as read. */
  markInline: (agentId: string, ids: string[], at: number) => void;
}

/** True when the agent can take a prompt now without interrupting anything. */
export function wakeable(agent: AgentInfo, wakeClosed: boolean): boolean {
  if (agent.archived) return false;
  if (agent.requiresAttention && agent.attentionReason === "permission") return false;
  if (agent.status === "idle") return true;
  return wakeClosed && (agent.status === "closed" || agent.status === "error");
}

/**
 * Wakes idle recipients of new mail: trailing debounce, a minimum gap, a global budget, backoff when a wake
 * fails. It never wakes a running agent; the next `turn_ended` (or the sweep) tries again. State is
 * derived from the journal plus a few in-memory timestamps, so a restart loses nothing.
 */
export class WakeEngine {
  private readonly lastMailAt = new Map<string, number>();
  private readonly firstSeenAt = new Map<string, number>();
  private readonly lastWakeAt = new Map<string, number>();
  private readonly failures = new Map<string, { count: number; until: number }>();
  private readonly threadWakes = new Map<string, number[]>();
  private globalWakes: number[] = [];
  private inflight = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly p: WakePorts) {}

  /** A mail arrived for this agent (null: an alias nobody holds). */
  notify(holderId: string | null, at = this.p.now()): void {
    if (!holderId) return;
    this.lastMailAt.set(holderId, at);
    if (!this.firstSeenAt.has(holderId)) this.firstSeenAt.set(holderId, at);
  }

  start(everyMs = 5_000): void {
    this.timer = setInterval(() => void this.sweep().catch((e) => console.error("agents-mail: sweep failed", e)), everyMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One pass over everyone with unread mail. Returns the agents woken. */
  async sweep(): Promise<string[]> {
    const s = this.p.settings();
    if (!s.enabled || !s.wakeEnabled) return [];
    const woken: string[] = [];
    for (const { agentId, mails } of await this.p.pending()) {
      if (await this.tryWake(agentId, mails, s)) woken.push(agentId);
    }
    return woken;
  }

  /** The agent just went idle: try now instead of waiting for the sweep. */
  async poke(agentId: string): Promise<boolean> {
    const s = this.p.settings();
    if (!s.enabled || !s.wakeEnabled) return false;
    const entry = (await this.p.pending()).find((e) => e.agentId === agentId);
    return entry ? this.tryWake(agentId, entry.mails, s) : false;
  }

  private due(agentId: string, mails: Mail[], s: AgentsMailSettings, now: number): Mail[] {
    const first = this.firstSeenAt.get(agentId) ?? Math.min(...mails.map((m) => m.createdAt));
    const last = this.lastMailAt.get(agentId) ?? Math.max(...mails.map((m) => m.createdAt));
    if (now - last < s.wakeDebounceSeconds * 1000 && now - first < HARD_CAP_MS) return [];
    if (now - (this.lastWakeAt.get(agentId) ?? 0) < s.wakeMinGapMinutes * 60_000) return [];
    if (now < (this.failures.get(agentId)?.until ?? 0)) return [];
    return mails.filter((m) => m.wakes < REWAKE_MS.length && (m.wakes === 0 || now - (m.lastWokeAt ?? 0) >= REWAKE_MS[m.wakes]));
  }

  private async tryWake(agentId: string, mails: Mail[], s: AgentsMailSettings): Promise<boolean> {
    if (this.inflight.has(agentId) || mails.length === 0) return false;
    const now = this.p.now();
    let dueMails = this.due(agentId, mails, s, now);
    // A thread that keeps waking its parties cools down.
    dueMails = dueMails.filter((m) => (this.threadWakes.get(m.threadId) ?? []).filter((t) => now - t < 3_600_000).length < MAX_WAKES_PER_THREAD_HOUR);
    if (dueMails.length === 0) return false;
    this.globalWakes = this.globalWakes.filter((t) => now - t < 60_000);
    if (this.globalWakes.length >= s.maxWakesPerMinute) return false;

    this.inflight.add(agentId);
    try {
      // The decision is made on a fresh read, right before the send.
      const agent = await this.p.fresh(agentId);
      if (!agent || !wakeable(agent, s.wakeClosedAgents)) return false;
      const text = this.text(agent, mails, s, now);
      this.globalWakes.push(now);
      this.lastWakeAt.set(agentId, now);
      try {
        await this.p.send(agentId, text.body);
      } catch (error) {
        const count = (this.failures.get(agentId)?.count ?? 0) + 1;
        this.failures.set(agentId, { count, until: now + FAIL_BACKOFF_MS[Math.min(count, FAIL_BACKOFF_MS.length) - 1] });
        console.error(`agents-mail: wake of ${agentId} failed`, error);
        return false;
      }
      this.failures.delete(agentId);
      const at = this.p.now();
      this.p.recordWake(dueMails.map((m) => m.id), at);
      for (const m of dueMails) this.threadWakes.set(m.threadId, [...(this.threadWakes.get(m.threadId) ?? []), at]);
      if (text.inlineIds.length) this.p.markInline(agentId, text.inlineIds, at);
      this.firstSeenAt.delete(agentId);
      return true;
    } finally {
      this.inflight.delete(agentId);
    }
  }

  /**
   * Injection carries the content when the host supports it; agents with the tools get a notice; agents
   * without them get the mail inline (marked read), so they can be mailed with nothing installed on their side.
   */
  private text(agent: AgentInfo, mails: Mail[], s: AgentsMailSettings, now: number): { body: string; inlineIds: string[] } {
    if (this.p.injectionLive() && this.p.injectEnabledFor(agent)) return { body: "[Agents Mail] You have new mail.", inlineIds: [] };
    if (this.p.hasTools(agent.id)) {
      const names = [...new Set(mails.map((m) => cleanName(m.from.name)))].slice(0, 5).join(", ");
      return { body: `[Agents Mail] You have ${mails.length} unread mail${mails.length > 1 ? "s" : ""} (from: ${names}). Call mail_list, then mail_read.`, inlineIds: [] };
    }
    const block = renderBlock(mails, { perMailBytes: Math.min(s.injectPerMailBytes, 4096), totalBytes: Math.max(s.injectMaxBytes, 4096), now, noTools: true });
    if (!block) return { body: "[Agents Mail] You have new mail.", inlineIds: [] };
    const reply = "Mail was sent through Agents Mail. To answer, message the sender with send_agent_prompt.";
    return { body: `[Agents Mail]\n${block.text}\n${reply}`, inlineIds: [...block.whole, ...block.partial] };
  }
}
