import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { mailSchema } from "./mail";

export const mailboxSummarySchema = z.object({
  /** `agent:<id>` or `alias:<name>`. */
  id: z.string(),
  kind: z.enum(["human", "alias"]),
  /** `@alias`, or "You (@user)". */
  label: z.string(),
  /** The agent holding the alias now, or null. */
  agentId: z.string().nullable(),
  /** Its title: who the alias is held by, null when nobody holds it (mail waits). */
  holder: z.string().nullable(),
  /** Kept for the screen; aliases are never archived. */
  archived: z.boolean(),
  unread: z.number(),
  total: z.number(),
  lastAt: z.number().nullable(),
});
export type MailboxSummary = z.output<typeof mailboxSummarySchema>;

/** Every mailbox that holds mail or belongs to a live alias holder, the human's first; `unread` is the human mailbox's unread count, the only badge. */
export const mailboxesRpc = defineRpc({
  name: "mail.mailboxes",
  input: z.object({}),
  output: z.object({ mailboxes: z.array(mailboxSummarySchema), unread: z.number() }),
});

/** All the mails of one mailbox, oldest first. Reading never marks anything read. */
export const mailboxMailsRpc = defineRpc({
  name: "mail.mailbox",
  input: z.object({ mailbox: z.string() }),
  output: z.object({ mails: z.array(mailSchema) }),
});

/** Marks mails read on purpose: the agent will no longer be woken for them or shown them. */
export const markReadRpc = defineRpc({
  name: "mail.read",
  input: z.object({ mailbox: z.string(), ids: z.array(z.string()).optional() }),
  output: z.object({ marked: z.number() }),
});

/** Sends a mail as the user, to an agent (id, title) or an alias (`@assistant`); threads under `inReplyTo`. */
export const sendRpc = defineRpc({
  name: "mail.send",
  input: z.object({ to: z.string().min(1), subject: z.string().min(1).max(200), body: z.string().max(16_384).default(""), kind: z.string().max(32).default("info"), inReplyTo: z.string().optional() }),
  output: z.object({ id: z.string(), threadId: z.string(), to: z.string() }),
});
