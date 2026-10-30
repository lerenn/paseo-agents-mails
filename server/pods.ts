import type { AgentInfo } from "./agents";

/**
 * The pod control the Kubernetes Runtime offers other plugins on `globalThis` (its server/pod-control.ts): the Pods screen's
 * Suspend / Resume path. `resume` resolves once the pod is ready, answers `ok` at once for a running pod and
 * `{ ok: false }` for a workspace without a pod.
 */
export const POD_CONTROL_KEY = Symbol.for("paseo.kubernetes-runtime");

export interface PodControl {
  podAction(workspaceId: string, action: "suspend" | "resume", options: { force?: boolean }): Promise<{ ok: boolean; message?: string; busy?: string }>;
}

/** A workspace that answered "no pod" is not asked again for this long (each ask may make the runtime list its sandboxes). */
const NO_POD_TTL_MS = 10 * 60_000;

/**
 * Builds the wake engine's `resume` port; it does nothing when no runtime offers pod control or the agent has no pod. Looked up at each
 * call, as the runtime registers (and re-registers on reload) on its own schedule.
 */
export function podResumer(opts: { target?: Record<symbol, unknown>; now?: () => number; timeoutMs?: number } = {}): (agent: AgentInfo) => Promise<void> {
  const target = opts.target ?? (globalThis as Record<symbol, unknown>);
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  const noPod = new Map<string, number>();
  return async (agent) => {
    const control = target[POD_CONTROL_KEY] as PodControl | undefined;
    const ws = agent.workspaceId;
    if (!ws || typeof control?.podAction !== "function") return;
    const seen = noPod.get(ws);
    if (seen !== undefined && now() - seen < NO_POD_TTL_MS) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      control.podAction(ws, "resume", {}),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
        (timer as { unref?: () => void }).unref?.();
      }),
    ]).finally(() => clearTimeout(timer));
    if (result && !result.ok && /no pod/i.test(result.message ?? "")) noPod.set(ws, now());
    else noPod.delete(ws);
  };
}
