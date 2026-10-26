import { z } from "zod";
import type { ToolContext, ToolDef } from "./tools";

const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

interface RpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: any;
}

/** Minimal MCP server over streamable HTTP (JSON responses, no streaming, no sessions). */
export class McpServer {
  constructor(
    private readonly tools: ToolDef[],
    private readonly version = "0.1.0",
  ) {}

  async handle(message: unknown, ctx: ToolContext): Promise<object | null> {
    const req = message as RpcRequest;
    if (!req || req.jsonrpc !== "2.0" || typeof req.method !== "string") {
      return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } };
    }
    if (req.id === undefined) return null;
    const reply = (result: unknown) => ({ jsonrpc: "2.0", id: req.id, result });
    const fail = (code: number, text: string) => ({ jsonrpc: "2.0", id: req.id, error: { code, message: text } });
    const visible = this.tools;
    switch (req.method) {
      case "initialize": {
        const asked = req.params?.protocolVersion;
        const instructions = await ctx.instructions();
        return reply({
          protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name: "agents-mail", version: this.version },
          instructions,
        });
      }
      case "ping":
        return reply({});
      case "tools/list":
        return reply({
          tools: visible.map((t) => ({ name: t.name, description: t.description, inputSchema: z.toJSONSchema(t.input, { io: "input" }) })),
        });
      case "tools/call": {
        const tool = visible.find((t) => t.name === req.params?.name);
        if (!tool) return fail(-32602, `Unknown tool: ${req.params?.name}`);
        const parsed = tool.input.safeParse(req.params?.arguments ?? {});
        if (!parsed.success) return reply(text(`Invalid arguments: ${z.prettifyError(parsed.error)}`, true));
        try {
          return reply(text(await tool.run(parsed.data, ctx)));
        } catch (err) {
          return reply(text(err instanceof Error ? err.message : String(err), true));
        }
      }
      default:
        return fail(-32601, `Method not found: ${req.method}`);
    }
  }
}

function text(value: unknown, isError = false) {
  const body = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text: body }], ...(isError ? { isError: true } : {}) };
}
