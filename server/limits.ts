import type { Mail } from "../shared/mail";

export class LimitError extends Error {}

const WINDOW_MS = 10 * 60_000;
const LOOP_WINDOW_MS = 60 * 60_000;
export const PING_PONG_LENGTH = 8;
export const MAX_WAKES_PER_THREAD_HOUR = 6;

const sender = (m: Mail) => m.from.agentId ?? `${m.from.type}:${m.from.name}`;

/** True when the last 8 mails of a thread, all within the hour, alternate between exactly two parties. */
export function pingPong(thread: Mail[], now: number): boolean {
  const last = thread.slice(-PING_PONG_LENGTH);
  if (last.length < PING_PONG_LENGTH) return false;
  if (last.some((m) => now - m.createdAt > LOOP_WINDOW_MS)) return false;
  if (new Set(last.map(sender)).size !== 2) return false;
  return last.every((m, i) => i === 0 || sender(m) !== sender(last[i - 1]));
}

export interface LimitSettings {
  sendsPer10Minutes: number;
  pairSendsPer10Minutes: number;
  maxUnreadPerMailbox: number;
}

/** Send-side limits; the counters are in memory, so a restart forgives. The human is exempt. */
export class SendLimits {
  private sends: { from: string; to: string; at: number }[] = [];

  /** Throws a LimitError saying what to do; records the send otherwise. */
  check(o: { from: string; mailbox: string; unread: number; thread: Mail[]; now: number }, s: LimitSettings): void {
    const { from, mailbox, unread, thread, now } = o;
    this.sends = this.sends.filter((x) => now - x.at < WINDOW_MS);
    if (unread >= s.maxUnreadPerMailbox) throw new LimitError(`Mailbox full: ${unread} unread mails there already. Wait for the recipient to read them.`);
    if (this.sends.filter((x) => x.from === from).length >= s.sendsPer10Minutes) {
      throw new LimitError(`Rate limit: ${s.sendsPer10Minutes} mails per 10 minutes. Batch your updates into fewer mails.`);
    }
    if (this.sends.filter((x) => x.from === from && x.to === mailbox).length >= s.pairSendsPer10Minutes) {
      throw new LimitError(`Rate limit: ${s.pairSendsPer10Minutes} mails per 10 minutes to the same recipient. Wait, or batch.`);
    }
    if (pingPong(thread, now)) throw new LimitError("This thread is looping (8 alternating mails within the hour). Stop, or ask the human.");
    this.sends.push({ from, to: mailbox, at: now });
  }
}
