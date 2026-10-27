Agents Mail gives every agent on a Paseo daemon a mailbox. Any agent can mail any other agent (or an alias such as `@assistant`); the recipient is woken when idle and its unread mail is injected into its context. A **Mail** sidebar row (with the total unread count) opens a screen for the user, and other plugins, such as the Assistant's Mailbox tab, read the mail through a small loopback API.

## Role aliases: the mailbox follows the role

The Mail screen's list shows only **@aliases** (`@assistant`, `@supervisor`, `@user` and role aliases such as `@pcc`, `@daemon-ops`) and never an agent id or a title, so a recreated agent keeps its mailbox. An agent holds a role alias by being created with the label `paseo.mail-alias=<name>` (lowercase letters, digits, `-` and `_`, up to 40; `user` and `human` are reserved), or by claiming it: the tool `mail_alias_claim(name, takeover?)` for itself, or the admin API `POST /api/aliases/claim {name, agentId, takeover?}` for an agent that has no mail tools. A live claim holder wins, then the most recently active agent carrying the label; a live holder blocks another claimant unless `takeover`, an archived one never does. A recreated labelled agent takes the alias over by existing; a claimant claims again. When the holder is archived the alias is simply unheld: mail to it is accepted and waits, and the next holder reads it, history included, and is woken for what is unread. Replies go to the sender's alias, not its agent id, so they reach the recreated agent. An agent's own mail from before it held an alias is re-homed under the alias (one `rehome` journal event; nothing is copied). Mail to an agent that never holds an alias stays in its own mailbox, hidden from the list (the agent still reads it; the admin API lists it). `GET /api/aliases` shows every alias with its holders.

## The human's mailbox and the badge

`@user` (also `@human`) is the human's own mailbox, always present: agents mail it with `mail_send(to="@user")` for information the human should read (decisions and actions still go through the Assistant). Nobody is woken for it and no agent can read it. It is the **only** mailbox with an unread badge, on the Mail sidebar row and in the mailbox list; agent and alias mailboxes show just "n mails". The user reading it in the Mail screen marks it read (the only mailbox where that is the point).

## Mail screen

The sidebar row **Mail** (header) opens a screen with every mailbox (agent or alias, with its unread count; archived agents' mailboxes greyed and read-only), the threads of the selected mailbox, each mail with what the agent has seen of it (unread, shown in its context, read by a tool...), and a compose box that sends **as you** to an agent (id or exact title) or an alias such as `@assistant`, or replies in a thread. It shows every mail's content. Opening an agent's or alias's mailbox never marks anything read, since that would stop the agent being woken for it or shown it: "Mark this thread read" is an explicit button there. Your own mailbox (`@user`) is marked read as you open a thread. Screen params: `mailbox=alias:assistant` opens it on one mailbox. Server RPCs (for this screen): `mail.mailboxes`, `mail.mailbox`, `mail.read`, `mail.send`.

## Tools

One MCP server, `agents-mail`, given to every new agent: `mail_send(to, subject, body, kind)`, `mail_reply(id, body)`, `mail_list`, `mail_read(id)`, `mail_mark_read`, `mail_whois(to)`. The sender is always the calling agent. `to` is an agent id (or a unique prefix of 8+ characters), an exact title, `@alias` or `label:key=value` or `@parent` (the sender's creator); it must match exactly one agent, there is no broadcast. Aliases are a setting (`assistant=paseo.assistant=1`, `supervisor=paseo.factory.supervisor=1` by default); mail to an alias is kept in the alias mailbox and read by whichever agent holds the label, so it survives the Assistant starting a new session. Subagents get the tools too but can mail only `@parent` (the agent that created them) and only their parent can mail them (by agent id, or `mail_reply`); every agent is told in its system prompt to report to its parent by mail, never with `send_agent_prompt`.

## Waking and injection

- **Wake.** New mail wakes the recipient only when it is idle (fresh status check right before the send, and the send itself uses the fork's `activeTurnBehavior: "skip"` when the host has it, so an agent that started a turn in between is not touched; otherwise it steers, never interrupts), after a 20 s trailing debounce, at most once per 2 minutes per agent, never interrupting a running turn and never answering a pending permission. A global budget (6 wakes a minute) keeps a burst from resuming every suspended pod at once. The wake says how many mails and from whom, never their text. A mail still unread is woken for again after 5 and 30 minutes, three wakes at most.
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
