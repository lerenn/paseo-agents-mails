import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { API_VERSION } from "./shared/mail";
import { mailboxMailsRpc, mailboxesRpc, markReadRpc, sendRpc } from "./shared/rpc";
import { summarize } from "./server/ui";
import { agentsMailSettings, settingsSchema } from "./shared/settings";
import { adminApi, newAdminToken } from "./server/admin";
import { ClaimStore } from "./server/aliases";
import { PaseoDirectory, matchesAny, parseLabelRules, type AgentsMailPaseo } from "./server/agents";
import { AuditLog } from "./server/follow";
import { MailHttp } from "./server/http";
import { CAPABILITY_ENV, createContext, injectTools, milestoneText, MAX_PREPEND, composePrepend, wantsTools } from "./server/inject";
import { McpServer } from "./server/mcp";
import { MailService } from "./server/service";
import { MailStore } from "./server/store";
import { CapabilityStore } from "./server/tokens";
import { USAGE, mailTools, toolNames } from "./server/tools";
import { podResumer } from "./server/pods";
import { WakeEngine } from "./server/wake";

const DEFAULT_PORT = 47843;

/** What the fork's `agent.prompt` hook hands over (the final contract); only `prepend` is honoured on return. */
interface PromptRequest {
  agentId: string;
  labels: Record<string, string>;
  parentAgentId: string | null;
  prompt: string;
  source: "user" | "agent";
  sourceAgentId: string | null;
  isFirstPrompt: boolean;
  prepend?: string;
}
const paseoHome = process.env.PASEO_HOME ?? path.join(homedir(), ".paseo");
const dataDir = path.join(paseoHome, "plugin-data", "agents-mail");
/** Where other plugins find the admin API. */
const endpointFile = process.env.AGENTS_MAIL_ENDPOINT ?? path.join(paseoHome, "agents-mail", "endpoint.json");

type Settings = ReturnType<typeof settingsSchema.parse>;

function readOrCreateToken(file: string): string {
  try {
    const existing = readFileSync(file, "utf8").trim();
    if (existing) return existing;
  } catch {
    // First start.
  }
  const token = newAdminToken();
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, token, { mode: 0o600 });
  chmodSync(file, 0o600);
  return token;
}

function writeEndpoint(file: string, url: string, token: string): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify({ url, token, apiVersion: API_VERSION }), { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, file);
}

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(agentsMailSettings);
  let latest: Settings = settingsSchema.parse({});
  const apply = (state: Awaited<ReturnType<typeof settings.read>>) => {
    latest = state.status === "ready" ? state.values : settingsSchema.parse({});
  };
  const ready = settings.read().then(apply);
  const unsubscribeSettings = settings.subscribe(apply);

  const store = new MailStore(process.env.AGENTS_MAIL_JOURNAL ?? path.join(dataDir, "mail.jsonl"));
  const claims = new ClaimStore(process.env.AGENTS_MAIL_ALIASES ?? path.join(dataDir, "aliases.json"));
  const tokens = new CapabilityStore(process.env.AGENTS_MAIL_CAPABILITIES ?? path.join(dataDir, "capabilities.json"));
  const audit = new AuditLog(process.env.AGENTS_MAIL_AUDIT ?? path.join(dataDir, "audit.jsonl"));
  const adminToken = readOrCreateToken(process.env.AGENTS_MAIL_ADMIN_TOKEN ?? path.join(dataDir, "admin-token"));

  // The Paseo API only reaches a plugin through hook and RPC contexts; keep the first one seen.
  let paseo: AgentsMailPaseo | null = null;
  const capture = (ctx: { paseo: unknown } | undefined) => {
    if (ctx?.paseo && !paseo) paseo = ctx.paseo as AgentsMailPaseo;
  };
  const directory = new PaseoDirectory(() => paseo);

  /** True once the host has handed a prompt to our `agent.prompt` hook: until then it may not exist. */
  let promptHookLive = false;

  const service: MailService = new MailService({
    store,
    claims,
    directory,
    settings: () => latest,
    now: Date.now,
    audit,
    onMail: (mail, holderId) => {
      wake.notify(holderId, mail.createdAt);
    },
  });

  const injectAllowed = (agent: { labels: Record<string, string>; parentAgentId: string | null }): boolean =>
    latest.enabled && latest.injectEnabled && !agent.parentAgentId && !matchesAny(agent.labels, parseLabelRules(latest.injectExcludeLabels));

  const wake = new WakeEngine({
    now: Date.now,
    settings: () => latest,
    async pending() {
      const live = await directory.list();
      const book = service.book(live);
      const byAgent = new Map<string, import("./shared/mail").Mail[]>();
      for (const box of store.mailboxesWithUnread()) {
        // The human's mailbox is read in the Mail screen: nobody is woken for it.
        if (box.startsWith("human:")) continue;
        let target: string | undefined;
        if (box.startsWith("agent:")) target = box.slice(6);
        else {
          const alias = book.find(box.slice(6));
          target = alias ? book.holders(live, alias)[0]?.id : undefined;
        }
        if (!target) continue;
        byAgent.set(target, [...(byAgent.get(target) ?? []), ...store.list([box], { unreadOnly: true })]);
      }
      // Mailboxes an agent follows (settings `followGrants`, wake granted): the only way anyone is woken for the human's mail.
      const followed = new Map((await service.followedUnread(live)).map((f) => [f.agentId, f.mails.sort((a, b) => a.createdAt - b.createdAt)]));
      for (const id of followed.keys()) if (!byAgent.has(id)) byAgent.set(id, []);
      return [...byAgent].map(([agentId, mails]) => ({ agentId, mails: mails.sort((a, b) => a.createdAt - b.createdAt), followed: followed.get(agentId) }));
    },
    fresh: (id) => directory.fresh(id),
    send: (id, text) => directory.send(id, text),
    hasTools: (id) => tokens.hasAgent(id),
    injectionLive: () => promptHookLive,
    injectEnabledFor: (agent) => injectAllowed(agent),
    recordWake: (ids, at) => store.recordWake(ids, at),
    markInline: (agentId, ids, at) => {
      void service.mailboxes(agentId).then((boxes) => store.markRead(boxes, ids, "inline", at));
    },
    // A suspended Kubernetes Runtime pod is resumed before the wake, so the prompt does not sit behind a pod boot.
    resume: podResumer(),
  });
  wake.start();

  const instructionsFor = async (agentId: string | undefined): Promise<string> => {
    if (!agentId || !latest.enabled || !latest.injectEnabled) return USAGE;
    const agent = (await directory.list()).find((a) => a.id === agentId);
    if (!agent || !injectAllowed(agent)) return USAGE;
    const block = await service.injection(agentId);
    return block ? `${USAGE}\n\n${block.text}` : USAGE;
  };

  const nameOf = async (agentId: string, hint?: string) => {
    if (hint) return hint;
    const found = (await directory.list().catch(() => [])).find((a) => a.id === agentId);
    return found?.title || agentId;
  };

  let url: string | null = null;
  const http = new MailHttp({
    tokens,
    mcp: new McpServer(mailTools),
    context: (capability) => ({
      service,
      nameOf,
      instructions: async () => {
        const base = await instructionsFor(capability.agentId);
        const follow = capability.agentId && latest.enabled ? await service.followNotice(capability.agentId).catch(() => null) : null;
        return follow ? `${base}\n\n${follow}` : base;
      },
    }),
    admin: adminApi(service, store, () => latest.humanName, audit),
    adminToken: () => adminToken,
  });
  const port = Number(process.env.PASEO_AGENTS_MAIL_PORT ?? DEFAULT_PORT);
  const started = http.start(port).then(
    (u) => {
      url = u;
      writeEndpoint(endpointFile, u, adminToken);
    },
    (err: Error) => {
      console.error(`agents-mail: cannot listen on 127.0.0.1:${port}: ${err.message}. Set PASEO_AGENTS_MAIL_PORT on the daemon.`);
    },
  );

  const purge = () => {
    try {
      audit.purge(latest.auditRetentionDays * 86_400_000, Date.now());
      const n = service.purge();
      if (n) console.log(`agents-mail: purged ${n} mails`);
    } catch (error) {
      console.error("agents-mail: purge failed", error);
    }
  };
  void ready.then(purge);
  const purgeTimer = setInterval(purge, 24 * 3_600_000);

  const removeCreate = server.before("agent.create", async ({ request }, ctx) => {
    capture(ctx);
    // Daemons without the create context give no labels or parent: inject nothing rather than everywhere.
    const agent = createContext(request);
    if (!agent) return;
    await ready;
    if (!wantsTools(agent, request.env, latest)) return;
    await started;
    // Without the endpoint the agent just does not get the tools; creating it must not fail.
    if (!url) return;
    let milestone: string | null = null;
    try {
      const live = await directory.list();
      milestone = milestoneText(agent, latest, live, service.book(live));
    } catch {
      milestone = null;
    }
    const capability = tokens.create({ role: "agent", name: request.config.title ?? undefined });
    return injectTools(request, { url, capability, tools: toolNames(), milestone });
  });
  // The Mail screen. It only reads: opening a mailbox never marks anything read, since that would stop the agent being
  // woken for it or shown it.
  server.handle(mailboxesRpc, async (_input, ctx) => {
    capture(ctx);
    const live = await directory.list().catch(() => null);
    return summarize(store.all(), live, service.book(live ?? []));
  });
  server.handle(mailboxMailsRpc, async (input, ctx) => {
    capture(ctx);
    return { mails: store.list([input.mailbox]).sort((a, b) => a.createdAt - b.createdAt) };
  });
  server.handle(markReadRpc, async (input, ctx) => {
    capture(ctx);
    return { marked: store.markRead([input.mailbox], input.ids, "ui", Date.now()) };
  });
  server.handle(sendRpc, async (input, ctx) => {
    capture(ctx);
    const { mail, resolved } = await service.send({ type: "human", name: latest.humanName }, input);
    return { id: mail.id, threadId: mail.threadId, to: resolved.display };
  });
  const removeOpen = server.before("agent.session_open", ({ request }, ctx) => {
    capture(ctx);
    const capability = request.env[CAPABILITY_ENV];
    if (capability) tokens.bind(capability, request.agentId);
  });

  // Fork hook (feature flag pluginPromptHook): runs before a prompt reaches the agent and may set `prepend`, which the
  // host puts in front of the prompt. A host without it ignores or refuses the registration, and injection falls back
  // to session start (MCP instructions) and wakes.
  let removePrompt: () => void = () => {};
  try {
    const before = server.before as unknown as (name: string, handler: (input: { request: PromptRequest }, ctx: any) => unknown) => (() => void) | undefined;
    removePrompt =
      before.call(server, "agent.prompt", async ({ request }, ctx) => {
        capture(ctx);
        promptHookLive = true;
        try {
          if (!request?.agentId || !latest.enabled || !latest.injectEnabled) return;
          if (!injectAllowed({ labels: request.labels ?? {}, parentAgentId: request.parentAgentId ?? null })) return;
          const room = MAX_PREPEND - (request.prepend ? request.prepend.length + 2 : 0);
          const block = await service.injection(request.agentId, "inject", Math.max(256, room - 300));
          if (!block) return;
          return { ...request, prepend: composePrepend(request.prepend, block.text) ?? request.prepend };
        } catch (error) {
          console.error("agents-mail: injection failed", error);
        }
      }) ?? (() => {});
  } catch {
    // No agent.prompt hook on this host.
  }

  const removeTurnStarted = server.on("agent.turn_started", ({ agent }, ctx) => {
    capture(ctx);
    wake.turnStarted(agent.id);
  });
  const removeTurnEnded = server.on("agent.turn_ended", ({ agent }, ctx) => {
    capture(ctx);
    // Give the status a moment to settle to idle, then wake if mail is waiting.
    setTimeout(() => void wake.poke(agent.id).catch((e) => console.error("agents-mail: poke failed", e)), 1500);
  });
  const reconcile = () => void service.reconcile().then((r) => r.rehomed && console.log(`agents-mail: re-homed ${r.rehomed} mails under role aliases`), (e) => paseo && console.error("agents-mail: reconcile failed", e));
  const reconcileTimer = setInterval(reconcile, 60_000);
  setTimeout(reconcile, 15_000);
  const removeCreated = server.on("agent.created", (_event, ctx) => {
    capture(ctx);
    directory.invalidate();
    // A new agent may carry a paseo.mail-alias label: give it its role's mailbox.
    setTimeout(reconcile, 2_000);
  });
  const removeArchived = server.on("agent.archived", ({ agent }, ctx) => {
    capture(ctx);
    tokens.revokeAgent(agent.id);
    directory.invalidate();
  });

  return () => {
    removeCreate();
    removeOpen();
    removePrompt();
    removeTurnStarted();
    removeTurnEnded();
    removeCreated();
    removeArchived();
    unsubscribeSettings();
    clearInterval(purgeTimer);
    clearInterval(reconcileTimer);
    wake.stop();
    try {
      rmSync(endpointFile, { force: true });
    } catch {
      // Best effort.
    }
    void http.stop();
  };
}
