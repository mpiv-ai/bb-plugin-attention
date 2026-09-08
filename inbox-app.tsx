import { useCallback, useEffect, useRef, useState } from "react";
import { experimental_useSidebarThreads, useBbNavigate, useRealtime, useRealtimeConnectionState, useRpc, useSettings } from "@get-bb/plugin-sdk/app";
import type { z } from "zod";
import type { rpcContract } from "./server";
import type { inboxContract } from "./inbox-server";

type Messages = z.infer<typeof inboxContract.inboxMessages.output>;
type Attention = z.infer<typeof inboxContract.inboxAttention.output>;
function useInbox(projectId: string | null, archived = false, offset = 0) {
  const rpc = useRpc<typeof inboxContract>();
  const [data, setData] = useState<{ messages: Messages; attention: Attention } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);
  const refresh = useCallback(() => {
    const request = ++sequence.current;
    void Promise.all([rpc.call("inboxMessages", { projectId, archived, offset }), rpc.call("inboxAttention", { projectId })]).then(([messages, attention]) => {
      if (sequence.current === request) { setData({ messages, attention }); setError(null); }
    }).catch(() => { if (sequence.current === request) setError("Could not refresh the inbox. Try again."); });
  }, [rpc, projectId, archived, offset]);
  const connection = useRealtimeConnectionState();
  useEffect(() => { setData(null); refresh(); return () => { sequence.current++; }; }, [refresh]);
  useEffect(() => { if (connection === "connected") refresh(); }, [connection, refresh]);
  useRealtime("attention-changed", refresh);
  return { data, error, refresh, rpc };
}
export function InboxCount() {
  const { data, error } = useInbox(null);
  if (error) return <span title={error}>!</span>;
  const count = data ? data.attention.total : 0;
  return count ? <span aria-label={`${count} threads needing attention`}>{count}</span> : null;
}
export function InboxPanel() {
  const sidebar = experimental_useSidebarThreads();
  const navigate = useBbNavigate();
  const { values: settings } = useSettings();
  const attentionRpc = useRpc<typeof rpcContract>();
  const [dismissing, setDismissing] = useState(false);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [view, setView] = useState("attention");
  const [offset, setOffset] = useState(0);
  const { data, error, refresh, rpc } = useInbox(projectId, view === "archived", offset);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const change = async (id: number, action: "read" | "archive" | "restore") => {
    setBusy(id); setActionError(null);
    try { const result = await rpc.call("inboxMessageState", { id, action }); if (!result.updated) throw new Error(); refresh(); }
    catch { setActionError("Could not update this message. Try again."); }
    finally { setBusy(null); }
  };
  const visibleAttention = data && (view === "all" || view === "attention") ? data.attention.items : [];
  const visibleMessages = data && (view === "all" || view === "messages") ? data.messages.messages : [];
  const dismissalEnabled = visibleAttention.length === 0 || settings?.permanentDismissalsEnabled === true;
  const dismissAll = async () => {
    if (dismissing || !dismissalEnabled) return;
    setDismissing(true); setActionError(null);
    try {
      const results = await Promise.allSettled([
        ...visibleAttention.map(({ threadId, kind, attentionAt }) => attentionRpc.call("dismiss", { threadId, kind, attentionAt }).then(result => { if (!result.dismissed) throw new Error(); })),
        ...visibleMessages.map(({ id }) => rpc.call("inboxMessageState", { id, action: "archive" }).then(result => { if (!result.updated) throw new Error(); })),
      ]);
      if (results.some(result => result.status === "rejected")) setActionError("Some items could not be dismissed. Refresh and try again.");
    } finally { refresh(); setDismissing(false); }
  };
  const projectName = (id: string) => sidebar.projects.find(p => p.id === id)?.name ?? id;
  return <main className="agent-inbox-scroll" aria-label="Inbox"><div className="agent-inbox">
    <div className="inbox-toolbar">
      <label>Project <select disabled={dismissing} value={projectId ?? ""} onChange={e => { setProjectId(e.target.value || null); setOffset(0); }}><option value="">All projects</option>{sidebar.projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      <label>Show <select disabled={dismissing} value={view} onChange={e => { setView(e.target.value); setOffset(0); }}><option value="all">Everything</option><option value="attention">Threads needing attention</option><option value="messages">Agent messages</option><option value="archived">Archived messages</option></select></label>
      <button disabled={dismissing} onClick={refresh}>Refresh</button>
      {view !== "archived" && <button disabled={dismissing || busy !== null || !data || !dismissalEnabled || visibleAttention.length + visibleMessages.length === 0} title={!dismissalEnabled ? "Enable Permanent dismissals in plugin settings to dismiss attention threads." : "Dismiss all items displayed by the current filters and message page"} onClick={() => void dismissAll()}>{dismissing ? "Dismissing…" : "Dismiss All"}</button>}
    </div>
    {error || actionError ? <p role="alert">{error ?? actionError}</p> : null}
    {!data && !error ? <p role="status">Loading inbox…</p> : null}
    {data && <>
      {(view === "all" || view === "attention") && <section><h2>Threads needing attention <span>{data.attention.total}</span></h2>
        {data.attention.items.length === 0 ? <p className="attention-empty">No threads need your attention.</p> : data.attention.items.map(item => <article className="inbox-card" key={item.threadId}>
          <div className="inbox-meta"><span>{item.label}</span><span>{projectName(item.projectId)}</span></div>
          <button className="inbox-title" onClick={() => navigate.toThread(item.threadId)}>{item.title}</button>
          {item.detail && <p className="inbox-body">{item.detail}</p>}
          <div className="inbox-meta"><time>{new Date(item.attentionAt).toLocaleString()}</time><span>{item.kind === "interaction" ? "Respond in thread" : item.kind === "error" ? "Review error in thread" : "Open to read"}</span></div>
        </article>)}
      </section>}
      {view !== "attention" && <section><h2>{view === "archived" ? "Archived messages" : "Agent messages"} <span>{data.messages.total}</span></h2>
        {!data.messages.total && <p className="attention-empty">No messages in this view.</p>}
        {data.messages.messages.map(message => <article className="inbox-card" key={message.id}>
          <div className="inbox-meta"><strong>{message.severity === "needs-decision" ? "Needs decision" : message.severity === "urgent" ? "Urgent" : "Message"}{message.readAt === null ? " · Unread" : ""}</strong><span>{projectName(message.projectId)}</span><time>{new Date(message.createdAt).toLocaleString()}</time></div>
          <p className="inbox-body">{message.text}</p>
          <div className="inbox-actions"><button onClick={() => navigate.toThread(message.threadId)}>Open thread / reply</button>
            {message.readAt === null && <button disabled={dismissing || busy !== null} onClick={() => void change(message.id, "read")}>Mark read</button>}
            <button disabled={dismissing || busy !== null} onClick={() => void change(message.id, message.archivedAt === null ? "archive" : "restore")}>{message.archivedAt === null ? "Archive" : "Restore"}</button>
          </div>
        </article>)}
        {data.messages.total > 100 && <div className="inbox-actions"><button disabled={dismissing || offset === 0} onClick={() => setOffset(Math.max(0, offset - 100))}>Previous</button><span>{offset + 1}–{Math.min(offset + 100, data.messages.total)} of {data.messages.total}</span><button disabled={dismissing || offset + 100 >= data.messages.total} onClick={() => setOffset(offset + 100)}>Next</button></div>}
      </section>}
    </>}
  </div></main>;
}
