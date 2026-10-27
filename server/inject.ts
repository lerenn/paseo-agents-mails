import type { PluginBeforeRequests } from "@getpaseo/plugin/server";
import { matchesAny, parseLabelRules, type AgentInfo } from "./agents";
import type { AliasBook } from "./aliases";
import type { AgentsMailSettings } from "../shared/settings";

type CreateRequest = PluginBeforeRequests["agent.create"];

export const SERVER_NAME = "agents-mail";
export const CAPABILITY_ENV = "PASEO_AGENTS_MAIL_CAPABILITY";
export const OFF_ENV = "PASEO_AGENTS_MAIL";
export const INJECT_OFF_ENV = "PASEO_AGENTS_MAIL_INJECT";

/** `labels` and `parentAgentId` come from daemons with the create context; older ones lack them. */
export function createContext(request: CreateRequest): { labels: Record<string, string>; parentAgentId: string | null } | null {
  const r = request as CreateRequest & { labels?: Record<string, string>; parentAgentId?: string | null };
  if (r.labels === undefined || r.parentAgentId === undefined) return null;
  return { labels: r.labels, parentAgentId: r.parentAgentId };
}

/** The rule every agent with the mail tools is told, so a subagent reports through mail and not by prompting its parent. */
export const PARENT_RULE = "A subagent reports to its parent only by mail (mail_send to @parent), never with send_agent_prompt. Blocking questions for the human still go through the inbox (inbox_ask).";

/** Whether a new agent gets the mail tools: any agent (a subagent too, to mail @parent), not opted out by env or label. */
export function wantsTools(agent: { labels: Record<string, string>; parentAgentId: string | null }, env: Record<string, string> | undefined, s: AgentsMailSettings): boolean {
  if (!s.enabled) return false;
  if (env?.[OFF_ENV]?.toLowerCase() === "off") return false;
  return !matchesAny(agent.labels, parseLabelRules(s.toolsExcludeLabels));
}

/** Whether the milestone line applies to a new agent: `milestoneTo` must currently resolve to an agent other than itself. */
export function milestoneText(
  agent: { labels: Record<string, string> },
  s: AgentsMailSettings,
  live: AgentInfo[],
  book: AliasBook,
): string | null {
  const to = s.milestoneTo.trim();
  if (!to) return null;
  const alias = book.find(to.replace(/^@/, ""));
  if (!alias || book.holders(live, alias).length === 0) return null;
  const include = parseLabelRules(s.milestoneIncludeLabels);
  const exclude = parseLabelRules(s.milestoneExcludeLabels);
  if (matchesAny(agent.labels, include)) return fill(s, to);
  if (matchesAny(agent.labels, exclude)) return null;
  // The alias holder itself reads the mail, it is never told to send it.
  if (matchesAny(agent.labels, [alias.rule])) return null;
  return fill(s, to);
}

const fill = (s: AgentsMailSettings, to: string) => s.milestoneInstruction.replaceAll("{to}", to);

/** Gives a new agent the mail server and, when it applies, the milestone line. */
export function injectTools(request: CreateRequest, o: { url: string; capability: string; tools: string[]; milestone: string | null }): CreateRequest {
  const prompt = request.config.systemPrompt;
  const added = [o.milestone, PARENT_RULE].filter(Boolean).join("\n\n");
  return {
    ...request,
    config: {
      ...request.config,
      systemPrompt: prompt ? `${prompt}\n\n${added}` : added,
      mcpServers: {
        ...(request.config.mcpServers ?? {}),
        [SERVER_NAME]: { type: "http", url: `${o.url}/mcp`, headers: { authorization: `Bearer ${o.capability}` }, alwaysLoad: true },
      },
      toolPolicy: {
        preapproved: [
          ...(request.config.toolPolicy?.preapproved ?? []),
          ...o.tools.map((tool) => ({ kind: "mcp" as const, server: SERVER_NAME, tool })),
        ],
      },
    },
    env: { ...(request.env ?? {}), [CAPABILITY_ENV]: o.capability },
  };
}

/** The host drops a `prepend` longer than this (fork `agent.prompt` hook), so we never send one. */
export const MAX_PREPEND = 16_000;

/**
 * Adds our block to the `prepend` earlier plugins may have set, never overwriting it. Returns null when the
 * result would be over the host's limit: then nothing is injected and the mail stays unread.
 */
export function composePrepend(existing: string | undefined, block: string): string | null {
  const out = existing ? `${existing}\n\n${block}` : block;
  return out.length <= MAX_PREPEND ? out : null;
}
