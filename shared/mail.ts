import { z } from "zod";

export const API_VERSION = 1;

/** Sizes in characters (subject) and bytes (body). */
export const MAX_SUBJECT = 200;
export const MAX_BODY_BYTES = 16 * 1024;
export const MAX_KIND = 32;

export const mailSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  inReplyTo: z.string().nullable(),
  /** `alias` is the role alias the sender held when it wrote: a reply goes to it, so it reaches a recreated agent. */
  from: z.object({ type: z.enum(["agent", "human", "system"]), agentId: z.string().optional(), name: z.string(), alias: z.string().optional() }),
  /** `mailbox` is `agent:<id>` or `alias:<name>`; `display` is what the sender typed. */
  to: z.object({ mailbox: z.string(), agentId: z.string().optional(), display: z.string() }),
  subject: z.string(),
  body: z.string(),
  /** A free tag: start, blocked, pr, done, question, info... */
  kind: z.string(),
  createdAt: z.number(),
  readAt: z.number().nullable(),
  readVia: z.enum(["tool", "inject", "inline", "ui", "import"]).nullable(),
  /** The agent that marked a followed mail read (readVia stays "tool" so an older plugin still loads the journal). */
  readBy: z.string().optional(),
  /** Set when an injection showed only part of the mail, or all of it. */
  injectedAt: z.number().nullable(),
  wakes: z.number(),
  lastWokeAt: z.number().nullable(),
});
export type Mail = z.output<typeof mailSchema>;
export type ReadVia = NonNullable<Mail["readVia"]>;

export const agentMailbox = (agentId: string) => `agent:${agentId}`;
/** The human's own mailbox, always there: agents mail it with `@user`, and only its unread count is a badge. */
export const HUMAN_MAILBOX = "human:user";
export const aliasMailbox = (name: string) => `alias:${name}`;
