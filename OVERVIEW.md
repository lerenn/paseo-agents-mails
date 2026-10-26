Agents Mail gives every agent on a Paseo daemon a mailbox. Any agent can mail any other agent (or an alias such as `@assistant`); the recipient is woken when idle and its unread mail is injected into its context. There is no screen: other plugins, such as the Assistant's Mailbox tab, read the mail through a small loopback API.

## Tools

One MCP server, `agents-mail`, given to every new top-level agent: `mail_send(to, subject, body, kind)`, `mail_reply(id, body)`, `mail_list`, `mail_read(id)`, `mail_mark_read`, `mail_whois(to)`. The sender is always the calling agent. `to` is an agent id (or a unique prefix of 8+ characters), an exact title, `@alias` or `label:key=value`; it must match exactly one agent, there is no broadcast. Aliases are a setting (`assistant=paseo.assistant=1`, `supervisor=paseo.factory.supervisor=1` by default); mail to an alias is kept in the alias mailbox and read by whichever agent holds the label, so it survives the Assistant starting a new session. Subagents cannot send or receive mail.

## Waking and injection

- **Wake.** New mail wakes the recipient only when it is idle (fresh status check right before the send), after a 20 s trailing debounce, at most once per 2 minutes per agent, never interrupting a running turn and never answering a pending permission. A global budget (6 wakes a minute) keeps a burst from resuming every suspended pod at once. The wake says how many mails and from whom, never their text. A mail still unread is woken for again after 5 and 30 minutes, three wakes at most.
- **Agents without the mail tools** (created before the plugin) get the mail inline in the wake (4 KB per mail, untrusted banner) and it is marked read.
- **Injection.** Unread mail is added as an `<agents-mail untrusted="true">` block (2 KB per mail, 8 KB in all; settings) at session start, through the MCP `initialize` instructions, and before every prompt when the host provides the `agent.prompt` hook (Paseo fork, feature flag `pluginPromptHook`): the plugin sets `prepend` on the request, which the host puts in front of the prompt (capped at 16,000 characters; it appends to what earlier plugins set and never rewrites `prompt`). Mail shown whole is marked read; mail that was cut stays unread and points to `mail_read`. Opt out with `injectEnabled`, `injectExcludeLabels`, or `PASEO_AGENTS_MAIL_INJECT=off`.

## Milestone reports

New top-level agents are told to mail `@assistant` at milestones (start, blocked, pr, done) when an agent holds `@assistant` right now. Rules are settings (`milestoneIncludeLabels`, `milestoneExcludeLabels`, `milestoneInstruction`, `milestoneTo`); the defaults leave out agents labelled `paseo.factory=1` except `paseo.factory.supervisor=1`. This needs a Paseo build whose `agent.create` hook carries labels and the parent agent; on an older daemon nothing is injected.

## Limits

Subject 200 characters, body 16 KB, 30 mails per sender per 10 minutes, 10 per sender and recipient, 100 unread per mailbox, and a thread of 8 alternating mails within the hour is cooled down. The human is exempt. Read mail is kept 14 days, unread 60, at most 500 per mailbox.

## Admin API (for other plugins)

`~/.paseo/agents-mail/endpoint.json` (mode 0600) holds `{ url, token, apiVersion: 1 }`; use the token as a bearer. `GET /api/health`; `GET /api/mailboxes/<id>/mails?unreadOnly=&limit=` (`<id>` is `alias:assistant` or `agent:<id>`, URL-encoded); `POST /api/mails/read` `{ mailbox, ids? }`; `POST /api/mails` `{ to, subject, body, kind, asAgent?: { agentId, name } }` (the human sends when `asAgent` is omitted); `POST /api/import` `{ mailbox, mails: [{ id, agentId, agentName, subject, body, kind, at, read }] }` (idempotent, ids become `legacy:<id>`). A plugin that cannot find the file or gets no answer treats Agents Mail as not installed.

## Environment

`PASEO_AGENTS_MAIL_PORT` (default 47843, loopback; fixed so pod agents can reach it through the tunnel), `PASEO_AGENTS_MAIL=off` on an agent to skip the tools. Mail is a JSONL journal in the plugin data folder.
