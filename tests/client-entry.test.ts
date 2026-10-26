import { describe, expect, it, vi } from "vitest";

vi.mock("@getpaseo/plugin/client", () => ({ useRpc: () => async () => ({}) }));
vi.mock("@getpaseo/plugin/client/ui", () => ({ SidebarRow: () => null }));
vi.mock("react-native", () => ({ Pressable: () => null, ScrollView: () => null, Text: () => null, TextInput: () => null, View: () => null }));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({}), useMutation: () => ({}), useQueryClient: () => ({}) }));

describe("client entry", () => {
  it("adds a Mail screen and a Mail row to the sidebar header, and cleans up", async () => {
    const { default: contribute } = await import("../index.client");
    const client = { addScreen: vi.fn(), addSidebarHeaderItem: vi.fn() };
    const cleanup = contribute(client as never);
    expect(client.addScreen).toHaveBeenCalledWith(expect.objectContaining({ id: "mail", title: "Mail" }));
    expect(client.addSidebarHeaderItem).toHaveBeenCalledWith(expect.objectContaining({ id: "mail", title: "Mail" }));
    expect(() => cleanup()).not.toThrow();
  });
});
