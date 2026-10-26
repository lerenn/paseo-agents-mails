import { describe, expect, it } from "vitest";
import { PaseoDirectory, type AgentsMailPaseo } from "../server/agents";

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
