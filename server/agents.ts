/** What Agents Mail needs to know about an agent; built from a Paseo agent snapshot. */
export interface AgentInfo {
  id: string;
  title: string | null;
  labels: Record<string, string>;
  parentAgentId: string | null;
  archived: boolean;
  status: "initializing" | "idle" | "running" | "error" | "closed" | string;
  requiresAttention: boolean;
  attentionReason: string | null;
  lastActivityAt: number;
}

/** The directory of agents, and the one way to message one. The real one is backed by the Paseo API. */
export interface Directory {
  /** Live (not archived) agents. */
  list(): Promise<AgentInfo[]>;
  /** A fresh read of one agent; null when it is gone. */
  fresh(id: string): Promise<AgentInfo | null>;
  send(id: string, text: string): Promise<void>;
}

export interface LabelRule {
  key: string;
  /** `*` accepts any value. */
  value: string;
}

/** `a=1, b` or one rule per line; a bare key means any value. */
export function parseLabelRules(text: string): LabelRule[] {
  return text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const i = s.indexOf("=");
      return i < 0 ? { key: s, value: "*" } : { key: s.slice(0, i).trim(), value: s.slice(i + 1).trim() || "*" };
    });
}

export const matchesRule = (labels: Record<string, string>, rule: LabelRule) => (rule.value === "*" ? rule.key in labels : labels[rule.key] === rule.value);
export const matchesAny = (labels: Record<string, string>, rules: LabelRule[]) => rules.some((r) => matchesRule(labels, r));

export interface Alias {
  name: string;
  rule: LabelRule;
}

/** One `name=key=value` (or `name=key`) per line. Malformed lines are ignored. */
export function parseAliases(text: string): Alias[] {
  const out: Alias[] = [];
  for (const line of text.split("\n")) {
    const s = line.trim().replace(/^@/, "");
    const i = s.indexOf("=");
    if (i <= 0) continue;
    const name = s.slice(0, i).trim().toLowerCase();
    const [rule] = parseLabelRules(s.slice(i + 1));
    if (/^[a-z0-9][a-z0-9_-]*$/.test(name) && rule) out.push({ name, rule });
  }
  return out;
}

export function fromSnapshot(agent: unknown): AgentInfo | null {
  const a = agent as Record<string, unknown> | null | undefined;
  if (!a || typeof a.id !== "string") return null;
  const at = typeof a.lastActivityAt === "string" ? Date.parse(a.lastActivityAt) : Number(a.lastActivityAt ?? 0);
  return {
    id: a.id,
    title: typeof a.title === "string" ? a.title : null,
    labels: (a.labels as Record<string, string> | undefined) ?? {},
    parentAgentId: typeof a.parentAgentId === "string" ? a.parentAgentId : null,
    archived: Boolean(a.archivedAt),
    status: typeof a.status === "string" ? a.status : "idle",
    requiresAttention: Boolean(a.requiresAttention),
    attentionReason: typeof a.attentionReason === "string" ? a.attentionReason : null,
    lastActivityAt: Number.isFinite(at) ? at : 0,
  };
}

/** The slice of the Paseo SDK used; the real `PaseoApi` satisfies it. */
export interface AgentsMailPaseo {
  agents: {
    list(options: unknown): Promise<{ entries: unknown[] }>;
    ref(agentId: string): {
      refresh(): Promise<unknown>;
      send(text: string, options?: { activeTurnBehavior?: "steer" | "interrupt" }): Promise<unknown>;
    };
  };
}

const LIST_TTL_MS = 5_000;

export class PaseoDirectory implements Directory {
  private cache: { at: number; agents: AgentInfo[] } | null = null;

  constructor(
    private readonly paseo: () => AgentsMailPaseo | null,
    private readonly now: () => number = Date.now,
  ) {}

  private api(): AgentsMailPaseo {
    const api = this.paseo();
    if (!api) throw new Error("Paseo API not available yet");
    return api;
  }

  async list(): Promise<AgentInfo[]> {
    if (this.cache && this.now() - this.cache.at < LIST_TTL_MS) return this.cache.agents;
    // Background workspaces are left out by default; the Assistant lives in one, and @assistant must resolve to it.
    const { entries } = await this.api().agents.list({ filter: { includeArchived: false, includeBackground: true } });
    const agents = entries.flatMap((e) => {
      const info = fromSnapshot((e as { agent?: unknown }).agent);
      return info && !info.archived ? [info] : [];
    });
    this.cache = { at: this.now(), agents };
    return agents;
  }

  async fresh(id: string): Promise<AgentInfo | null> {
    try {
      const found = (await this.api().agents.ref(id).refresh()) as { agent?: unknown } | null;
      const info = fromSnapshot(found?.agent);
      return info && !info.archived ? info : null;
    } catch {
      return null;
    }
  }

  async send(id: string, text: string): Promise<void> {
    // Never "interrupt": mail waits for a running agent.
    await this.api().agents.ref(id).send(text, { activeTurnBehavior: "steer" });
  }

  invalidate(): void {
    this.cache = null;
  }
}
