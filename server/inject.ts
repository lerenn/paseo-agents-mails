import type { PluginBeforeRequests } from "@getpaseo/plugin/server";
import { matchesAny, parseLabelRules, type AgentInfo, type Alias } from "./agents";
import { holders } from "./address";
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

/** Whether a new agent gets the mail tools: top-level, not opted out by env or label. */
export function wantsTools(agent: { labels: Record<string, string>; parentAgentId: string | null }, env: Record<string, string> | undefined, s: AgentsMailSettings): boolean {
  if (!s.enabled || agent.parentAgentId) return false;
  if (env?.[OFF_ENV]?.toLowerCase() === "off") return false;
  return !matchesAny(agent.labels, parseLabelRules(s.toolsExcludeLabels));
}

/** Whether the milestone line applies to a new agent: `milestoneTo` must currently resolve to an agent other than itself. */
export function milestoneText(
  agent: { labels: Record<string, string> },
  s: AgentsMailSettings,
  live: AgentInfo[],
  aliases: Alias[],
): string | null {
  const to = s.milestoneTo.trim();
  if (!to) return null;
  const alias = aliases.find((a) => `@${a.name}` === to.toLowerCase());
  if (!alias || holders(live, alias).length === 0) return null;
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
  return {
    ...request,
    config: {
      ...request.config,
      ...(o.milestone ? { systemPrompt: prompt ? `${prompt}\n\n${o.milestone}` : o.milestone } : {}),
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

type Block = { type: string; text?: string; [k: string]: unknown };

/**
 * Prepends text to a prompt in the shapes the host may hand over (`agent.prompt` is a fork hook, not in the
 * published API): a plain string, `{ input: { type: "message", content: [...] } }`, or `{ text }`.
 * Returns null for a prompt it does not recognise (commands, empty): those are left alone.
 */
export function prependToPrompt<T>(prompt: T, block: string): T | null {
  if (typeof prompt === "string") return `${block}\n\n${prompt}` as T;
  const p = prompt as { input?: { type?: string; content?: Block[] }; text?: string } | null;
  if (!p || typeof p !== "object") return null;
  if (p.input?.type === "message" && Array.isArray(p.input.content)) {
    return { ...p, input: { ...p.input, content: [{ type: "text", text: `${block}\n\n` }, ...p.input.content] } } as T;
  }
  if (typeof p.text === "string") return { ...p, text: `${block}\n\n${p.text}` } as T;
  return null;
}
