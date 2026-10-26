import { useRpc } from "@getpaseo/plugin/client";
import type { PluginScreenProps, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import type { PluginTheme } from "@getpaseo/plugin";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { mailboxMailsRpc, mailboxesRpc, markReadRpc, sendRpc, type MailboxSummary } from "../shared/rpc";
import { badge, groupThreads, readState, replyTarget, type Thread } from "./model";

export const SCREEN_ID = "mail";
const REFRESH_MS = 10_000;
const BOXES_KEY = ["agents-mail", "mailboxes"];

export function useMailboxes() {
  const list = useRpc(mailboxesRpc);
  return useQuery({ queryKey: BOXES_KEY, queryFn: () => list({}), refetchInterval: REFRESH_MS });
}

function UnreadBadge({ text }: { text: string }) {
  return (
    <View accessibilityLabel={`${text} unread`} style={{ minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 5, alignItems: "center", justifyContent: "center", backgroundColor: "#d33" }}>
      <Text style={{ color: "#fff", fontSize: 11, fontWeight: "600" }}>{text}</Text>
    </View>
  );
}

/** The sidebar row: a mail icon and the total unread count. */
export function MailSidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  const unread = useMailboxes().data?.unread ?? 0;
  return (
    <SidebarRow
      icon="Mail"
      active={currentScreen?.screenId === SCREEN_ID}
      onPress={() => openScreen({ screenId: SCREEN_ID })}
      trailing={unread > 0 ? <UnreadBadge text={badge(unread)} /> : undefined}
    />
  );
}

const card = (theme: PluginTheme, o: { selected?: boolean; muted?: boolean } = {}) => ({
  marginHorizontal: 10,
  marginVertical: 4,
  padding: 10,
  gap: 2,
  borderRadius: 10,
  borderWidth: 1,
  borderColor: o.selected ? theme.colors.accent : theme.colors.border,
  backgroundColor: theme.colors.surface1,
  opacity: o.muted ? 0.5 : 1,
});

function Button({ theme, label, onPress, disabled }: { theme: PluginTheme; label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress} style={{ paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, backgroundColor: theme.colors.surface2, opacity: disabled ? 0.5 : 1 }}>
      <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>{label}</Text>
    </Pressable>
  );
}

function MailboxList({ theme, boxes, selected, onSelect }: { theme: PluginTheme; boxes: readonly MailboxSummary[]; selected: string | null; onSelect: (id: string) => void }) {
  return (
    <ScrollView>
      {boxes.length === 0 ? <Text style={{ color: theme.colors.foregroundMuted, padding: 16 }}>No mail yet.</Text> : null}
      {boxes.map((b) => (
        <Pressable key={b.id} accessibilityRole="button" onPress={() => onSelect(b.id)} style={card(theme, { selected: b.id === selected, muted: b.archived })}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <Text style={{ color: theme.colors.foreground, fontSize: 14, fontWeight: b.unread ? "600" : "400", flexShrink: 1 }}>{b.label}</Text>
            {b.unread > 0 ? <UnreadBadge text={badge(b.unread)} /> : null}
          </View>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
            {b.kind === "alias" ? "alias" : b.archived ? "archived agent" : "agent"} · {b.total} mail{b.total === 1 ? "" : "s"}
          </Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

function ThreadList({ theme, threads, selected, onSelect }: { theme: PluginTheme; threads: readonly Thread[]; selected: string | null; onSelect: (id: string) => void }) {
  return (
    <ScrollView>
      {threads.length === 0 ? <Text style={{ color: theme.colors.foregroundMuted, padding: 16 }}>This mailbox is empty.</Text> : null}
      {threads.map((t) => (
        <Pressable key={t.threadId} accessibilityRole="button" onPress={() => onSelect(t.threadId)} style={card(theme, { selected: t.threadId === selected, muted: t.unread === 0 })}>
          <Text style={{ color: theme.colors.foreground, fontSize: 14, fontWeight: t.unread ? "600" : "400" }}>{t.subject}</Text>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
            {t.participants.join(", ")} · {t.count} mail{t.count === 1 ? "" : "s"}
            {t.unread ? ` · ${t.unread} unread` : ""} · {new Date(t.lastAt).toLocaleString()}
          </Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

function Compose({ theme, defaultTo, replyTo, onSent }: { theme: PluginTheme; defaultTo: string; replyTo?: { id: string; subject: string }; onSent: () => void }) {
  const send = useRpc(sendRpc);
  const [to, setTo] = useState(defaultTo);
  const [subject, setSubject] = useState(replyTo ? `Re: ${replyTo.subject}` : "");
  const [body, setBody] = useState("");
  useEffect(() => setTo(defaultTo), [defaultTo]);
  const mutation = useMutation({
    mutationFn: () => send({ to: to.trim(), subject: subject.trim(), body, kind: "info", inReplyTo: replyTo?.id }),
    onSuccess: () => {
      setBody("");
      if (!replyTo) setSubject("");
      onSent();
    },
  });
  const input = { color: theme.colors.foreground, backgroundColor: theme.colors.surface2, borderRadius: 8, padding: 8 };
  const ready = to.trim() && subject.trim();
  return (
    <View style={{ padding: 10, gap: 6 }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>Send as you to an agent (id or exact title) or an alias such as @assistant</Text>
      <TextInput value={to} onChangeText={setTo} placeholder="To" placeholderTextColor={theme.colors.foregroundMuted} style={input} autoCapitalize="none" />
      <TextInput value={subject} onChangeText={setSubject} placeholder="Subject" placeholderTextColor={theme.colors.foregroundMuted} style={input} />
      <TextInput value={body} onChangeText={setBody} placeholder="Message" placeholderTextColor={theme.colors.foregroundMuted} style={[input, { minHeight: 70 }]} multiline />
      {mutation.error ? <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>{mutation.error.message}</Text> : null}
      <View style={{ flexDirection: "row" }}>
        <Button theme={theme} label={mutation.isPending ? "Sending…" : "Send"} disabled={!ready || mutation.isPending} onPress={() => mutation.mutate()} />
      </View>
    </View>
  );
}

function ThreadView({ theme, thread, mailbox, archived, onChanged }: { theme: PluginTheme; thread: Thread; mailbox: MailboxSummary; archived: boolean; onChanged: () => void }) {
  const markRead = useRpc(markReadRpc);
  const mark = useMutation({ mutationFn: () => markRead({ mailbox: mailbox.id, ids: thread.mails.filter((m) => m.readAt === null).map((m) => m.id) }), onSuccess: onChanged });
  const last = thread.mails[thread.mails.length - 1];
  const target = replyTarget(last) ?? replyTarget(thread.mails[0]);
  return (
    <ScrollView>
      <Text style={{ color: theme.colors.foreground, fontSize: 16, fontWeight: "600", padding: 12 }}>{thread.subject}</Text>
      {thread.mails.map((m) => (
        <View key={m.id} style={card(theme, { muted: m.readAt !== null })}>
          <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>
            {m.from.name} → {m.to.display} <Text style={{ fontWeight: "400", color: theme.colors.foregroundMuted }}>({m.kind})</Text>
          </Text>
          <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>{m.body || "(no text)"}</Text>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
            {new Date(m.createdAt).toLocaleString()} · {readState(m)}
          </Text>
        </View>
      ))}
      {thread.unread > 0 ? (
        <View style={{ padding: 10, gap: 4 }}>
          <Button theme={theme} label="Mark this thread read" disabled={mark.isPending} onPress={() => mark.mutate()} />
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>Opening a mailbox never marks anything read. Marking read means the agent will not be woken or shown these mails.</Text>
        </View>
      ) : null}
      {archived ? <Text style={{ color: theme.colors.foregroundMuted, padding: 12 }}>This agent is archived: mail to it cannot be sent.</Text> : <Compose theme={theme} defaultTo={target ?? mailbox.agentId ?? mailbox.label} replyTo={{ id: last.id, subject: thread.subject }} onSent={onChanged} />}
    </ScrollView>
  );
}

export function MailScreen({ theme, layout, params }: PluginScreenProps) {
  const queryClient = useQueryClient();
  const boxesQuery = useMailboxes();
  const boxes = boxesQuery.data?.mailboxes ?? [];
  const [mailboxId, setMailboxId] = useState<string | null>(params.mailbox ?? null);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const selected = boxes.find((b) => b.id === mailboxId) ?? null;
  const read = useRpc(mailboxMailsRpc);
  const mails = useQuery({ queryKey: ["agents-mail", "mailbox", mailboxId], queryFn: () => read({ mailbox: mailboxId! }), enabled: mailboxId !== null, refetchInterval: REFRESH_MS });
  const threads = groupThreads(mails.data?.mails ?? []);
  const thread = threads.find((t) => t.threadId === threadId) ?? null;
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["agents-mail"] });
  };
  const compact = layout.compact;
  const column = (width: number | undefined, children: React.ReactNode) => (
    <View style={{ width, flex: width ? undefined : 1, borderRightWidth: width ? 1 : 0, borderRightColor: theme.colors.border }}>{children}</View>
  );

  const list = column(compact ? undefined : 260, <MailboxList theme={theme} boxes={boxes} selected={mailboxId} onSelect={(id) => { setMailboxId(id); setThreadId(null); setComposing(false); }} />);
  const middle = selected
    ? column(compact ? undefined : 300, (
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: "row", gap: 8, padding: 8, alignItems: "center" }}>
            {compact ? <Button theme={theme} label="‹ Mailboxes" onPress={() => { setMailboxId(null); setThreadId(null); }} /> : null}
            <Text style={{ color: theme.colors.foreground, fontWeight: "600", flexShrink: 1 }}>{selected.label}</Text>
            <View style={{ flex: 1 }} />
            {selected.archived ? null : <Button theme={theme} label="New mail" onPress={() => { setComposing(true); setThreadId(null); }} />}
          </View>
          <ThreadList theme={theme} threads={threads} selected={threadId} onSelect={(id) => { setThreadId(id); setComposing(false); }} />
        </View>
      ))
    : null;
  const detail = thread && selected ? (
    <View style={{ flex: 1 }}>
      {compact ? <View style={{ padding: 8 }}><Button theme={theme} label="‹ Threads" onPress={() => setThreadId(null)} /></View> : null}
      <ThreadView key={thread.threadId} theme={theme} thread={thread} mailbox={selected} archived={selected.archived} onChanged={refresh} />
    </View>
  ) : composing && selected ? (
    <ScrollView><Compose theme={theme} defaultTo={selected.kind === "alias" ? selected.label : selected.agentId ?? ""} onSent={() => { setComposing(false); refresh(); }} /></ScrollView>
  ) : null;

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
      {boxesQuery.error ? <Text style={{ color: theme.colors.statusDanger, padding: 12 }}>Could not load the mailboxes: {boxesQuery.error.message}</Text> : null}
      {compact ? (
        <View style={{ flex: 1 }}>{detail ?? middle ?? list}</View>
      ) : (
        <View style={{ flex: 1, flexDirection: "row" }}>
          {list}
          {middle}
          <View style={{ flex: 1 }}>{detail ?? <Text style={{ color: theme.colors.foregroundMuted, padding: 16 }}>{selected ? "Pick a thread, or write a new mail." : "Pick a mailbox."}</Text>}</View>
        </View>
      )}
    </View>
  );
}
