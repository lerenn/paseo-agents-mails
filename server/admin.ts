import { randomUUID } from "node:crypto";
import { z } from "zod";
import { API_VERSION, MAX_BODY_BYTES, type Mail } from "../shared/mail";
import { AddressError } from "./address";
import { LimitError } from "./limits";
import { UsageError, type MailService } from "./service";
import type { MailStore } from "./store";

type Reply = { status: number; body: unknown };

const importSchema = z.object({
  mailbox: z.string().regex(/^(agent|alias):.+/),
  mails: z
    .array(
      z.object({
        id: z.string().min(1),
        agentId: z.string(),
        agentName: z.string(),
        subject: z.string(),
        body: z.string().max(MAX_BODY_BYTES),
        kind: z.string(),
        at: z.number(),
        read: z.boolean(),
      }),
    )
    .max(5000),
});

const sendSchema = z.object({
  to: z.string().min(1),
  subject: z.string().min(1),
  body: z.string().default(""),
  kind: z.string().default("info"),
  /** Mail sent on behalf of an agent (the Assistant's legacy `assistant_mail`); omitted means the human. */
  asAgent: z.object({ agentId: z.string(), name: z.string() }).optional(),
  inReplyTo: z.string().optional(),
});

/** The loopback admin API, the contract other plugins (the Assistant's Mailbox tab) build on. Versioned by `apiVersion`. */
export function adminApi(service: MailService, store: MailStore, humanName: () => string) {
  return async (req: { method: string; path: string; query: URLSearchParams; body: unknown }): Promise<Reply> => {
    try {
      const route = req.path.replace(/^\/api/, "");
      if (req.method === "GET" && route === "/health") return { status: 200, body: { ok: true, apiVersion: API_VERSION } };

      const list = /^\/mailboxes\/([^/]+)\/mails$/.exec(route);
      if (req.method === "GET" && list) {
        const mailbox = decodeURIComponent(list[1]);
        const limit = Math.min(Number(req.query.get("limit") ?? 200) || 200, 1000);
        const mails = store.list([mailbox], { unreadOnly: req.query.get("unreadOnly") === "true", limit });
        return { status: 200, body: { mails: mails.map(publicMail), unread: store.unreadCount(mailbox) } };
      }
      if (req.method === "POST" && route === "/mails/read") {
        const body = z.object({ mailbox: z.string(), ids: z.array(z.string()).optional() }).parse(req.body);
        return { status: 200, body: { marked: store.markRead([body.mailbox], body.ids, "ui", Date.now()) } };
      }
      if (req.method === "POST" && route === "/mails") {
        const body = sendSchema.parse(req.body);
        const from = body.asAgent ? { type: "agent" as const, ...body.asAgent } : { type: "human" as const, name: humanName() };
        const { mail, resolved } = await service.send(from, body);
        return { status: 200, body: { id: mail.id, threadId: mail.threadId, to: resolved.display } };
      }
      if (req.method === "GET" && route === "/aliases") {
        const agents = await service.directory().list();
        const book = service.book(agents);
        return { status: 200, body: { aliases: book.aliases.map((a) => ({ name: a.name, holders: book.holders(agents, a).map((h) => ({ id: h.id, title: h.title })) })) } };
      }
      if (req.method === "POST" && route === "/aliases/claim") {
        const body = z.object({ name: z.string().min(1), agentId: z.string().min(1), takeover: z.boolean().default(false) }).parse(req.body);
        return { status: 200, body: await service.claimAlias(body.agentId, body.name, body.takeover) };
      }
      if (req.method === "POST" && route === "/import") {
        const body = importSchema.parse(req.body);
        let imported = 0;
        for (const m of body.mails) {
          const id = m.id.startsWith("legacy:") ? m.id : `legacy:${m.id}`;
          if (store.has(id)) continue;
          const mail: Mail = {
            id,
            threadId: id,
            inReplyTo: null,
            from: { type: "agent", agentId: m.agentId, name: m.agentName },
            to: { mailbox: body.mailbox, display: body.mailbox.startsWith("alias:") ? `@${body.mailbox.slice(6)}` : body.mailbox },
            subject: m.subject.slice(0, 200) || "(no subject)",
            body: m.body,
            kind: m.kind,
            createdAt: m.at,
            readAt: m.read ? m.at : null,
            readVia: m.read ? "import" : null,
            // Imported mail is history: it is never injected or woken for.
            injectedAt: m.at,
            wakes: 3,
            lastWokeAt: null,
          };
          store.add(mail);
          imported += 1;
        }
        return { status: 200, body: { imported } };
      }
      return { status: 404, body: { error: "not found" } };
    } catch (err) {
      if (err instanceof z.ZodError) return { status: 400, body: { error: z.prettifyError(err) } };
      if (err instanceof AddressError || err instanceof UsageError || err instanceof LimitError) return { status: 422, body: { error: err.message } };
      throw err;
    }
  };
}

const publicMail = (m: Mail) => ({ ...m, id: m.id });

export const newAdminToken = () => randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
