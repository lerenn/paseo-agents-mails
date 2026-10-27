import { describe, expect, it } from "vitest";
import { PaseoDirectory, fromSnapshot, type AgentsMailPaseo } from "../server/agents";

/** The shapes Paseo returns: list() entries are `{ agent }`, refresh() gives `{ agent, project }`. */
const snapshot = (o: Record<string, unknown> = {}) => ({ id: "a1", title: "Coder", status: "idle", labels: { x: "1" }, parentAgentId: null, requiresAttention: false, attentionReason: null, lastActivityAt: "2026-10-26T10:00:00Z", archivedAt: null, ...o });

function fake(agent: Record<string, unknown>) {
  const sent: string[] = [];
  const listed: unknown[] = [];
  const paseo: AgentsMailPaseo = {
    agents: {
      list: async (options: unknown) => (listed.push(options), { entries: [{ agent }, { agent: snapshot({ id: "gone", archivedAt: "2026-10-25T00:00:00Z" }) }] }),
      ref: () => ({ refresh: async () => ({ agent, project: null }), send: async (t: string) => void sent.push(t) }),
    },
  };
  return { dir: new PaseoDirectory(() => paseo), sent, listed };
}

describe("PaseoDirectory lists background workspaces (regression: @assistant did not resolve)", () => {
  it("asks for agents in background workspaces too, since the Assistant lives in one", async () => {
    const { dir, listed } = fake(snapshot({ labels: { "paseo.assistant": "1" } }));
    await dir.list();
    expect(listed[0]).toEqual({ filter: { includeArchived: false, includeBackground: true } });
  });
});

describe("PaseoDirectory (regression: status read from the right place)", () => {
  it("reads status, title, labels and activity from list() entries and from a refresh() result", async () => {
    const { dir } = fake(snapshot());
    const listed = await dir.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: "a1", title: "Coder", status: "idle", labels: { x: "1" } });
    expect(listed[0].lastActivityAt).toBe(Date.parse("2026-10-26T10:00:00Z"));
    expect(await dir.fresh("a1")).toMatchObject({ status: "idle", title: "Coder" });
  });

  it("sees a running agent as running, and an archived one as gone", async () => {
    expect((await fake(snapshot({ status: "running" })).dir.fresh("a1"))?.status).toBe("running");
    expect(await fake(snapshot({ archivedAt: "2026-10-25T00:00:00Z" })).dir.fresh("a1")).toBeNull();
  });
});

describe("PaseoDirectory.send uses the fork's skip when the host has it", () => {
  const rig = (behavior: (opts: any) => unknown) => {
    const calls: any[] = [];
    const paseo = { agents: { list: async () => ({ entries: [] }), ref: () => ({ refresh: async () => null, send: async (_t: string, opts: any) => (calls.push(opts), behavior(opts)) }) } } as unknown as AgentsMailPaseo;
    return { dir: new PaseoDirectory(() => paseo), calls };
  };

  it("asks for skip first and reports delivered", async () => {
    const { dir, calls } = rig(() => undefined);
    expect(await dir.send("a", "hi")).toBe(true);
    expect(calls).toEqual([{ activeTurnBehavior: "skip" }]);
  });

  it("reports not delivered when the host says the agent is running", async () => {
    const { dir } = rig(() => ({ skipped: true }));
    expect(await dir.send("a", "hi")).toBe(false);
  });

  it("falls back to steer, once and for good, on a host that rejects the value; never interrupt", async () => {
    const { dir, calls } = rig((o) => {
      if (o.activeTurnBehavior === "skip") throw new Error("Invalid enum value for activeTurnBehavior");
    });
    expect(await dir.send("a", "1")).toBe(true);
    expect(await dir.send("a", "2")).toBe(true);
    expect(calls.map((c) => c.activeTurnBehavior)).toEqual(["skip", "steer", "steer"]);
    expect(calls.some((c) => c.activeTurnBehavior === "interrupt")).toBe(false);
  });

  it("does not hide a real failure behind the fallback", async () => {
    const { dir, calls } = rig(() => {
      throw new Error("agent not found");
    });
    await expect(dir.send("a", "x")).rejects.toThrow(/not found/);
    expect(calls).toHaveLength(1);
  });
});

describe("the creating agent (regression: @parent never resolved for agents created in another workspace)", () => {
  const info = (o: Record<string, unknown>) => fromSnapshot(snapshot(o));
  it("keeps the native parentAgentId as the only restriction", () => {
    expect(info({ parentAgentId: "native", labels: { "paseo.parent-agent-id": "daemon" } })).toMatchObject({ parentAgentId: "native", creatorId: "daemon" });
  });
  it("reads the creator from the label the daemon sets on every create_agent child, without restricting", () => {
    expect(info({ labels: { "paseo.parent-agent-id": "daemon", "paseo.parent": "label" } })).toMatchObject({ parentAgentId: null, creatorId: "daemon" });
  });
  it("then from paseo.parent set by the creator", () => {
    expect(info({ labels: { "paseo.parent": " creator-1 " } })).toMatchObject({ parentAgentId: null, creatorId: "creator-1" });
  });
  it("has none without them", () => {
    expect(info({ labels: { x: "1", "paseo.parent": "" } })).toMatchObject({ parentAgentId: null, creatorId: null });
  });
});
