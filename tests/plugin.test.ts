import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settingsSchema } from "../shared/settings";

type Handler = (input: any, ctx: any) => any;

/** Loads the real plugin entry against a fake server context, the way the daemon does. */
async function load() {
  const dir = mkdtempSync(path.join(tmpdir(), "plugin-"));
  Object.assign(process.env, {
    PASEO_HOME: dir,
    PASEO_AGENTS_MAIL_PORT: "0",
    AGENTS_MAIL_JOURNAL: path.join(dir, "mail.jsonl"),
    AGENTS_MAIL_CAPABILITIES: path.join(dir, "caps.json"),
    AGENTS_MAIL_ADMIN_TOKEN: path.join(dir, "admin-token"),
    AGENTS_MAIL_ENDPOINT: path.join(dir, "endpoint.json"),
  });
  const befores = new Map<string, Handler>();
  const handles = new Map<string, Handler>();
  const server: any = {
    registerSettings: () => ({ read: async () => ({ status: "ready", revision: "1", values: settingsSchema.parse({}) }), subscribe: () => () => {} }),
    handle: (contract: { name: string }, h: Handler) => void handles.set(contract.name, h),
    before: (name: string, h: Handler) => (befores.set(name, h), () => {}),
    on: () => () => {},
  };
  const agents = [
    { id: "aaaaaaaa-1", title: "Coder A", labels: {}, status: "idle" },
    { id: "bbbbbbbb-2", title: "Coder B", labels: {}, status: "idle" },
  ];
  const ctx = { paseo: { agents: { list: async () => ({ entries: agents.map((agent) => ({ agent })) }), ref: () => ({ refresh: async () => null, send: async () => {} }) } } };
  vi.resetModules();
  const { default: contribute } = await import("../index.server");
  const cleanup = contribute(server);
  // The endpoint file appears once the HTTP server listens.
  let endpoint: { url: string; token: string; apiVersion: number } | null = null;
  for (let i = 0; i < 50 && !endpoint; i++) {
    try {
      endpoint = JSON.parse(readFileSync(process.env.AGENTS_MAIL_ENDPOINT!, "utf8"));
    } catch {
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  const api = async (route: string, body?: unknown) => {
    const res = await fetch(`${endpoint!.url}${route}`, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${endpoint!.token}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: (await res.json()) as any };
  };
  return { befores, handles, ctx, endpoint: endpoint!, api, cleanup: cleanup as () => void };
}

let loaded: Awaited<ReturnType<typeof load>>;
beforeEach(async () => {
  loaded = await load();
});
afterEach(() => loaded.cleanup());

const prompt = (o: Record<string, unknown> = {}) => ({
  agentId: "bbbbbbbb-2",
  labels: {},
  parentAgentId: null,
  prompt: "go on",
  source: "user",
  sourceAgentId: null,
  isFirstPrompt: false,
  ...o,
});

describe("plugin entry", () => {
  it("publishes the endpoint file with the api version and answers health", async () => {
    expect(loaded.endpoint.apiVersion).toBe(1);
    expect((await loaded.api("/api/health")).json).toEqual({ ok: true, apiVersion: 1 });
  });

  it("registers the agent.prompt hook and prepends unread mail once, as the fork contract says", async () => {
    const hook = loaded.befores.get("agent.prompt")!;
    expect(hook).toBeTypeOf("function");
    // Capture the Paseo API through a hook context, then mail agent B as the human.
    await hook({ request: prompt({ agentId: "nobody" }) }, loaded.ctx);
    const sent = await loaded.api("/api/mails", { to: "Coder B", subject: "PR up", body: "see #7", kind: "pr" });
    expect(sent.status).toBe(200);
    const out = await hook({ request: prompt({ prepend: "from an earlier plugin" }) }, loaded.ctx);
    expect(out.prepend).toMatch(/^from an earlier plugin\n\n<agents-mail untrusted="true">/);
    expect(out.prepend).toMatch(/PR up/);
    expect(out.prepend).toMatch(/see #7/);
    expect(out.prompt).toBe("go on");
    // Marked read: not delivered twice.
    expect(await hook({ request: prompt() }, loaded.ctx)).toBeUndefined();
  });

  it("leaves subagents alone and stays silent without mail", async () => {
    const hook = loaded.befores.get("agent.prompt")!;
    await hook({ request: prompt({ agentId: "nobody" }) }, loaded.ctx);
    await loaded.api("/api/mails", { to: "Coder B", subject: "x" });
    expect(await hook({ request: prompt({ parentAgentId: "p" }) }, loaded.ctx)).toBeUndefined();
    expect(await hook({ request: prompt({ agentId: "aaaaaaaa-1" }) }, loaded.ctx)).toBeUndefined();
  });
});

describe("the human's mailbox in the plugin entry", () => {
  it("an agent's mail to @user counts as the one badge, shows first, and wakes nobody; reading it clears it", async () => {
    // Capture the Paseo API through a hook context first, as the daemon does.
    await loaded.befores.get("agent.prompt")!({ request: prompt({ agentId: "nobody" }) }, loaded.ctx);
    const sent = await loaded.api("/api/mails", { to: "@user", subject: "Report", body: "b", kind: "info", asAgent: { agentId: "aaaaaaaa-1", name: "Coder A" } });
    expect(sent.status).toBe(200);
    await loaded.api("/api/mails", { to: "Coder B", subject: "agent to agent", asAgent: { agentId: "aaaaaaaa-1", name: "Coder A" } });
    const out = await loaded.handles.get("mail.mailboxes")!({}, loaded.ctx);
    expect(out.unread).toBe(1); // only the mail addressed to the human
    expect(out.mailboxes[0]).toMatchObject({ id: "human:user", kind: "human", unread: 1 });
    expect(out.mailboxes.find((b: any) => b.id === "agent:bbbbbbbb-2").unread).toBe(1); // still there, just not a badge
    const cleared = await loaded.handles.get("mail.read")!({ mailbox: "human:user" }, loaded.ctx);
    expect(cleared.marked).toBe(1);
    expect((await loaded.handles.get("mail.mailboxes")!({}, loaded.ctx)).unread).toBe(0);
  });
});
