import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { matchesRule, type AgentInfo, type Alias } from "./agents";

/** The creation label that makes an agent hold the role alias `@<value>`. */
export const ALIAS_LABEL = "paseo.mail-alias";
export const RESERVED_ALIASES = ["user", "human"];
export const ALIAS_NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/;

export const validAliasName = (name: string): boolean => ALIAS_NAME.test(name) && !RESERVED_ALIASES.includes(name);

export interface Claim {
  agentId: string;
  at: number;
}

/**
 * Explicit alias claims (`mail_alias_claim`, the admin API), kept in the plugin data folder. A claim also keeps the alias
 * NAME known after its holder is archived: the holder is released (a dead claimant holds nothing), the alias stays, and
 * mail to it waits for the next holder.
 */
export class ClaimStore {
  private claims: Record<string, Claim>;

  constructor(private readonly file: string) {
    this.claims = this.load();
  }

  private load(): Record<string, Claim> {
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, Partial<Claim>>;
      return Object.fromEntries(Object.entries(raw).flatMap(([n, c]) => (validAliasName(n) && typeof c.agentId === "string" ? [[n, { agentId: c.agentId, at: Number(c.at) || 0 }]] : [])));
    } catch {
      return {};
    }
  }

  private save(): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, JSON.stringify(this.claims), "utf8");
    renameSync(temp, this.file);
  }

  all(): Record<string, Claim> {
    return { ...this.claims };
  }

  set(name: string, agentId: string, at: number): void {
    this.claims[name] = { agentId, at };
    this.save();
  }
}

/**
 * Who holds which role alias. Aliases come from three places: the settings (`assistant`, `supervisor`: a label rule),
 * the creation label `paseo.mail-alias=<name>` on a live agent, and explicit claims. A live claim holder comes first,
 * then the agents carrying the label, the most recently active first; archived agents hold nothing, so a recreated
 * agent takes the alias over by existing (labelled) or by claiming again.
 */
export class AliasBook {
  private constructor(
    readonly aliases: Alias[],
    private readonly claims: Record<string, Claim>,
  ) {}

  static build(settingsAliases: Alias[], agents: AgentInfo[], claims: Record<string, Claim> = {}, knownNames: readonly string[] = []): AliasBook {
    const byName = new Map(settingsAliases.map((a) => [a.name, a]));
    const live = agents.filter((a) => !a.archived && !a.parentAgentId);
    const add = (name: string) => {
      if (validAliasName(name) && !byName.has(name)) byName.set(name, { name, rule: { key: ALIAS_LABEL, value: name } });
    };
    for (const a of live) if (a.labels[ALIAS_LABEL]) add(a.labels[ALIAS_LABEL].toLowerCase());
    for (const name of Object.keys(claims)) add(name);
    // Aliases that hold mail stay addressable while nobody holds them.
    for (const name of knownNames) add(name);
    return new AliasBook([...byName.values()], claims);
  }

  find(name: string): Alias | undefined {
    return this.aliases.find((a) => a.name === name.toLowerCase());
  }

  /** The live agents holding an alias, the holder (who gets the mail) first. */
  holders(agents: AgentInfo[], alias: Alias): AgentInfo[] {
    const live = agents.filter((a) => !a.archived && !a.parentAgentId);
    const labelled = live
      .filter((a) => matchesRule(a.labels, alias.rule) || a.labels[ALIAS_LABEL]?.toLowerCase() === alias.name)
      .sort((x, y) => y.lastActivityAt - x.lastActivityAt);
    const claimant = this.claims[alias.name] && live.find((a) => a.id === this.claims[alias.name].agentId);
    return claimant ? [claimant, ...labelled.filter((a) => a.id !== claimant.id)] : labelled;
  }

  /** The aliases whose mailbox this agent may read: the ones it holds. */
  heldBy(agent: AgentInfo, agents: AgentInfo[]): Alias[] {
    return this.aliases.filter((al) => this.holders(agents, al).some((h) => h.id === agent.id));
  }
}
