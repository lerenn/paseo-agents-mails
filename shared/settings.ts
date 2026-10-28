import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const DEFAULT_MILESTONE_INSTRUCTION =
  "Mail {to} with the mail_send tool (to, subject, body, kind) only at milestones: start, blocked (you are stuck), PR opened or merged, done. Not at every step. kind is one of start | blocked | pr | done. Keep the subject to one line and the body to a few lines.";

export const settingsSchema = z.object({
  enabled: z.boolean().default(true),
  /** Wake idle recipients when mail arrives. */
  wakeEnabled: z.boolean().default(true),
  wakeDebounceSeconds: z.number().int().min(0).default(20),
  wakeMinGapMinutes: z.number().min(0).default(2),
  /** Global budget so a burst of mail does not resume every suspended pod at once. */
  maxWakesPerMinute: z.number().int().min(1).default(6),
  /** Wake agents whose status is closed or error (a suspended pod may show as one); archived agents never. */
  wakeClosedAgents: z.boolean().default(true),

  /** Inject unread mail into an agent's context (session start, and before each turn when the host has `agent.prompt`). */
  injectEnabled: z.boolean().default(true),
  injectExcludeLabels: z.string().default(""),
  injectMaxBytes: z.number().int().min(256).default(8192),
  injectPerMailBytes: z.number().int().min(128).default(2048),

  /** Label rules (`key=value` or `key`, comma or newline separated) of agents that do not get the mail tools. Subagents never do. */
  toolsExcludeLabels: z.string().default(""),
  /** Aliases, one `name=label` or `name=label=value` per line: `@name` addresses the agent holding that label. */
  aliases: z.string().default("assistant=paseo.assistant=1\nsupervisor=paseo.factory.supervisor=1"),

  /**
   * Who may follow (read, mark read, be woken for) mailboxes other than their own, one rule per line:
   * `<@alias or label key=value> = <@user|@alias>[, ...] [: read|mark|wake ...]`, for example `@assistant = @user : read+mark, wake`.
   * Empty by default: nobody follows anything.
   */
  followGrants: z.string().default(""),
  auditRetentionDays: z.number().min(1).default(90),

  /** The milestone rule: new top-level agents matching it are told to mail `milestoneTo`, if it resolves to an agent. Empty `milestoneTo` turns it off. */
  milestoneTo: z.string().default("@assistant"),
  milestoneIncludeLabels: z.string().default("paseo.factory.supervisor=1"),
  milestoneExcludeLabels: z.string().default("paseo.factory=1"),
  milestoneInstruction: z.string().default(DEFAULT_MILESTONE_INSTRUCTION),

  /** How the human appears as a sender. */
  humanName: z.string().default("the user"),
  sendsPer10Minutes: z.number().int().min(1).default(30),
  pairSendsPer10Minutes: z.number().int().min(1).default(10),
  maxUnreadPerMailbox: z.number().int().min(1).default(100),
  readRetentionDays: z.number().min(0.01).default(14),
  unreadRetentionDays: z.number().min(0.01).default(60),
  maxMailsPerMailbox: z.number().int().min(10).default(500),
  maxMailsTotal: z.number().int().min(100).default(20000),
});
export type AgentsMailSettings = z.output<typeof settingsSchema>;

export const agentsMailSettings = defineSettings({
  id: "agents-mail",
  scope: "host",
  version: 1,
  schema: settingsSchema,
});
