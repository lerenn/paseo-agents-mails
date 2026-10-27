import { HUMAN_MAILBOX, agentMailbox, aliasMailbox } from "../shared/mail";
import { matchesRule, type AgentInfo } from "./agents";
import type { AliasBook } from "./aliases";

export class AddressError extends Error {}

export interface Resolved {
  mailbox: string;
  agentId?: string;
  /** The agent that gets woken: the agent itself, or the alias holder (null when nobody holds it). */
  holderId: string | null;
  display: string;
  note?: string;
}

const describe = (a: AgentInfo) => `${a.id} ("${a.title ?? "untitled"}")`;

/** Top-level, live agents only: subagents report to their parent by the usual result path. */
const addressable = (agents: AgentInfo[]) => agents.filter((a) => !a.archived && !a.parentAgentId);

/** The mailboxes this agent may read: its own and the aliases it currently holds. */
export function mailboxesOf(agent: AgentInfo, agents: AgentInfo[], book: AliasBook): string[] {
  return [agentMailbox(agent.id), ...book.heldBy(agent, agents).map((al) => aliasMailbox(al.name))];
}

/**
 * Turns a recipient string into a mailbox: agent id (or unique prefix of 8+), `@alias`, exact title,
 * `label:key=value`, `@parent` (the sender's creator), or a bare alias name when no agent matches. Never guesses between several agents.
 */
export function resolveAddress(to: string, agents: AgentInfo[], book: AliasBook, senderId: string | null): Resolved {
  const text = to.trim();
  if (!text) throw new AddressError("Empty recipient.");
  const live = addressable(agents);

  const viaAlias = (name: string): Resolved => {
    const alias = book.find(name);
    if (!alias) throw new AddressError(`Unknown alias @${name}. Known: ${["@user", ...book.aliases.map((a) => `@${a.name}`)].join(", ")}.`);
    const held = book.holders(agents, alias);
    if (senderId && held.length === 1 && held[0].id === senderId) throw new AddressError(`You are @${alias.name}; you cannot mail yourself.`);
    return {
      mailbox: aliasMailbox(alias.name),
      holderId: held[0]?.id ?? null,
      display: `@${alias.name}`,
      note: held.length === 0 ? `no agent holds @${alias.name} right now; queued until one does` : undefined,
    };
  };
  const viaAgent = (a: AgentInfo): Resolved => {
    if (a.id === senderId) throw new AddressError("You cannot mail yourself.");
    return { mailbox: agentMailbox(a.id), agentId: a.id, holderId: a.id, display: a.title ?? a.id };
  };

  // The sending agent's parent (the agent that created it).
  if (/^@parent$/i.test(text)) {
    const me = senderId ? agents.find((a) => a.id === senderId) : undefined;
    if (!me) throw new AddressError("@parent is for agents: only an agent has a parent.");
    if (!me.parentAgentId) throw new AddressError("You have no parent agent (you were not created by another agent), so @parent does not apply to you.");
    const parent = agents.find((a) => a.id === me.parentAgentId);
    if (!parent || parent.archived) throw new AddressError(`Your parent agent ${me.parentAgentId} is gone (archived or unknown).`);
    return viaAgent(parent);
  }

  // The human: always present, never woken (they read it in the Mail screen).
  if (/^@(user|human)$/i.test(text)) return { mailbox: HUMAN_MAILBOX, holderId: null, display: "@user" };
  if (text.startsWith("@")) return viaAlias(text.slice(1));

  if (text.toLowerCase().startsWith("label:")) {
    const [key, ...rest] = text.slice(6).split("=");
    const value = rest.join("=") || "*";
    const found = live.filter((a) => matchesRule(a.labels, { key: key.trim(), value: value.trim() }));
    if (found.length === 0) throw new AddressError(`No live agent has the label ${text.slice(6)}.`);
    if (found.length > 1) throw new AddressError(`${found.length} agents have the label ${text.slice(6)} (${found.map(describe).join(", ")}); name one.`);
    return viaAgent(found[0]);
  }

  const byId = agents.find((a) => a.id === text);
  const byPrefix = text.length >= 8 ? agents.filter((a) => a.id.startsWith(text)) : [];
  const matched = byId ? [byId] : byPrefix;
  if (matched.length > 1) throw new AddressError(`Id prefix "${text}" is ambiguous (${matched.map(describe).join(", ")}).`);
  if (matched.length === 1) {
    const a = matched[0];
    if (a.archived) throw new AddressError(`Agent ${describe(a)} is archived.`);
    if (a.parentAgentId) throw new AddressError(`Agent ${describe(a)} is a subagent; mail its parent instead.`);
    return viaAgent(a);
  }

  const exact = live.filter((a) => a.title === text);
  const loose = exact.length ? exact : live.filter((a) => a.title?.toLowerCase() === text.toLowerCase());
  if (loose.length > 1) throw new AddressError(`${loose.length} agents are titled "${text}" (${loose.map(describe).join(", ")}); use an id.`);
  if (loose.length === 1) return viaAgent(loose[0]);

  if (book.find(text)) return viaAlias(text);
  throw new AddressError(`No live agent matches "${text}" (unknown, archived or a subagent). Use an agent id, an exact title, @alias or label:key=value.`);
}
