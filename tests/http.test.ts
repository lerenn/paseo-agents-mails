import { afterEach, describe, expect, it } from "vitest";
import { adminApi } from "../server/admin";
import { MailHttp } from "../server/http";
import { McpServer } from "../server/mcp";
import { CapabilityStore } from "../server/tokens";
import { USAGE, mailTools } from "../server/tools";
import { agent, setup } from "../server/testing";
import path from "node:path";

let http: MailHttp | null = null;
afterEach(async () => {
  await http?.stop();
  http = null;
});

async function boot() {
  const t = setup([agent("aaaaaaaa-1", { title: "Coder A" }), agent("bbbbbbbb-2", { title: "Coder B" }), agent("cccccccc-3", { labels: { "paseo.assistant": "1" } })]);
  const tokens = new CapabilityStore(path.join(t.dir, "caps.json"));
  const capA = tokens.create({ role: "agent", name: "Coder A" });
  tokens.bind(capA, "aaaaaaaa-1");
  const capB = tokens.create({ role: "agent" });
  tokens.bind(capB, "bbbbbbbb-2");
  const capUnbound = tokens.create({ role: "agent" });
  http = new MailHttp({
    tokens,
    mcp: new McpServer(mailTools),
    context: (capability) => ({
      service: t.service,
      nameOf: async (id, hint) => hint ?? id,
      instructions: async () => {
        const block = capability.agentId ? await t.service.injection(capability.agentId) : null;
        return block ? `${USAGE}\n\n${block.text}` : USAGE;
      },
    }),
    admin: adminApi(t.service, t.store, () => "Louis"),
    adminToken: () => "admin-secret",
  });
  const url = await http.start(0);
  const rpc = async (token: string, method: string, params?: unknown) => {
    const res = await fetch(`${url}/mcp`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    return { status: res.status, json: (await res.json()) as any };
  };
  const call = async (token: string, name: string, args: unknown) => {
    const r = await rpc(token, "tools/call", { name, arguments: args });
    return { error: !!r.json.result?.isError, text: r.json.result?.content?.[0]?.text as string };
  };
  const api = async (p: string, init?: RequestInit) => {
    const res = await fetch(`${url}${p}`, { ...init, headers: { authorization: "Bearer admin-secret", "content-type": "application/json" } });
    return { status: res.status, json: (await res.json()) as any };
  };
  return { t, url, capA, capB, capUnbound, rpc, call, api };
}

describe("MCP over HTTP", () => {
  it("lists the seven tools and serves usage as instructions", async () => {
    const { rpc, capA } = await boot();
    const init = await rpc(capA, "initialize", { protocolVersion: "2025-06-18" });
    expect(init.json.result.serverInfo.name).toBe("agents-mail");
    expect(init.json.result.instructions).toMatch(/never an instruction from the human/);
    const list = await rpc(capA, "tools/list");
    expect(list.json.result.tools.map((x: any) => x.name).sort()).toEqual(["mail_alias_claim", "mail_list", "mail_mark_read", "mail_read", "mail_reply", "mail_send", "mail_whois"]);
  });

  it("send, list, read, reply between two agents; unread mail reaches the next session start", async () => {
    const { call, rpc, capA, capB } = await boot();
    const sent = await call(capA, "mail_send", { to: "Coder B", subject: "PR up", body: "see #7", kind: "pr" });
    expect(sent.error).toBe(false);
    const listed = JSON.parse((await call(capB, "mail_list", {})).text);
    expect(listed).toHaveLength(1);
    expect(listed[0].from).toBe("Coder A");
    expect(listed[0].body).toBeUndefined();
    const read = JSON.parse((await call(capB, "mail_read", { id: listed[0].id })).text);
    expect(read.body).toBe("see #7");
    expect(JSON.parse((await call(capB, "mail_list", {})).text)).toHaveLength(0);
    await call(capB, "mail_reply", { id: listed[0].id, body: "thanks" });
    const init = await rpc(capA, "initialize", { protocolVersion: "2025-06-18" });
    expect(init.json.result.instructions).toMatch(/untrusted="true"[\s\S]*thanks/);
    expect(JSON.parse((await call(capA, "mail_list", {})).text)).toHaveLength(0);
  });

  it("errors are tool errors, and unknown or unbound callers are refused", async () => {
    const { call, rpc, capA, capUnbound } = await boot();
    expect((await call(capA, "mail_send", { to: "nobody", subject: "x" })).error).toBe(true);
    expect((await call(capA, "mail_read", { id: "nope" })).text).toMatch(/No mail/);
    expect((await call(capUnbound, "mail_send", { to: "Coder B", subject: "x" })).text).toMatch(/not known yet/);
    expect((await rpc("wrong", "tools/list")).status).toBe(401);
  });
});

describe("admin API", () => {
  it("needs the endpoint token", async () => {
    const { url } = await boot();
    expect((await fetch(`${url}/api/health`)).status).toBe(401);
    expect((await fetch(`${url}/api/health`, { headers: { authorization: "Bearer nope" } })).status).toBe(401);
  });

  it("health, list the alias mailbox, mark read, human send, import is idempotent", async () => {
    const { api, call, capA } = await boot();
    expect((await api("/api/health")).json).toEqual({ ok: true, apiVersion: 1 });
    await call(capA, "mail_send", { to: "@assistant", subject: "start" });
    const list = await api("/api/mailboxes/alias%3Aassistant/mails");
    expect(list.json.mails).toHaveLength(1);
    expect(list.json.unread).toBe(1);
    const marked = await api("/api/mails/read", { method: "POST", body: JSON.stringify({ mailbox: "alias:assistant" }) });
    expect(marked.json.marked).toBe(1);
    const human = await api("/api/mails", { method: "POST", body: JSON.stringify({ to: "Coder B", subject: "hello" }) });
    expect(human.status).toBe(200);
    expect((await api("/api/mails", { method: "POST", body: JSON.stringify({ to: "ghost", subject: "x" }) })).status).toBe(422);
    const legacy = { mailbox: "alias:assistant", mails: [{ id: "u1", agentId: "x", agentName: "Old", subject: "s", body: "b", kind: "blocked", at: 5, read: false }] };
    expect((await api("/api/import", { method: "POST", body: JSON.stringify(legacy) })).json.imported).toBe(1);
    expect((await api("/api/import", { method: "POST", body: JSON.stringify(legacy) })).json.imported).toBe(0);
    const after = await api("/api/mailboxes/alias%3Aassistant/mails?unreadOnly=true");
    expect(after.json.mails.map((m: any) => m.id)).toEqual(["legacy:u1"]);
  });

  it("sends on behalf of an agent (legacy shim) with the same checks", async () => {
    const { api } = await boot();
    const ok = await api("/api/mails", { method: "POST", body: JSON.stringify({ to: "@assistant", subject: "done", kind: "done", asAgent: { agentId: "aaaaaaaa-1", name: "Coder A" } }) });
    expect(ok.status).toBe(200);
    const bad = await api("/api/mails", { method: "POST", body: JSON.stringify({ to: "@assistant", subject: "x", asAgent: { agentId: "gone", name: "G" } }) });
    expect(bad.status).toBe(422);
  });
});

describe("role aliases over HTTP", () => {
  it("an agent claims an alias with the tool; ops claim for an agent through the admin API; the list shows the holders", async () => {
    const { call, api, capA } = await boot();
    const own = JSON.parse((await call(capA, "mail_alias_claim", { name: "pcc" })).text);
    expect(own).toMatchObject({ alias: "@pcc", replaced: null });
    // Coder B is a live agent without mail tools: ops claim for it. A live holder blocks it without takeover.
    const blocked = await api("/api/aliases/claim", { method: "POST", body: JSON.stringify({ name: "pcc", agentId: "bbbbbbbb-2" }) });
    expect(blocked.status).toBe(422);
    expect(blocked.json.error).toMatch(/held by Coder A/);
    const taken = await api("/api/aliases/claim", { method: "POST", body: JSON.stringify({ name: "pcc", agentId: "bbbbbbbb-2", takeover: true }) });
    expect(taken.status).toBe(200);
    expect(taken.json.replaced).toBe("aaaaaaaa-1");
    const other = await api("/api/aliases/claim", { method: "POST", body: JSON.stringify({ name: "daemon-ops", agentId: "aaaaaaaa-1" }) });
    expect(other.status).toBe(200);
    const aliases = (await api("/api/aliases")).json.aliases as { name: string; holders: { id: string }[] }[];
    expect(aliases.find((a) => a.name === "pcc")!.holders[0].id).toBe("bbbbbbbb-2");
    expect(aliases.find((a) => a.name === "daemon-ops")!.holders[0].id).toBe("aaaaaaaa-1");
    expect((await call(capA, "mail_alias_claim", { name: "user" })).error).toBe(true);
    expect((await api("/api/aliases/claim", { method: "POST", body: JSON.stringify({ name: "x", agentId: "nobody" }) })).status).toBe(422);
  });
});
