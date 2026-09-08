import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { buildSnapshot } from "./server";

const message = z.object({
  id: z.number(), projectId: z.string(), threadId: z.string(), text: z.string(),
  severity: z.enum(["routine", "needs-decision", "urgent"]), createdAt: z.number(),
  readAt: z.number().nullable(), archivedAt: z.number().nullable(),
});
export const inboxContract = defineRpcContract({
  inboxMessages: {
    input: z.object({ projectId: z.string().nullable(), archived: z.boolean(), offset: z.number().int().nonnegative() }).strict(),
    output: z.object({ messages: z.array(message), total: z.number(), unread: z.number() }),
  },
  inboxAttention: {
    input: z.object({ projectId: z.string().nullable() }).strict(),
    output: z.object({ items: z.array(z.object({ threadId: z.string(), projectId: z.string(), title: z.string(), kind: z.enum(["error", "interaction", "unread"]), label: z.string(), detail: z.string().optional(), attentionAt: z.number(), updatedAt: z.number() })), total: z.number(), generatedAt: z.number() }),
  },
  inboxMessageState: {
    input: z.object({ id: z.number().int().positive(), action: z.enum(["read", "archive", "restore"]) }).strict(),
    output: z.object({ updated: z.boolean() }),
  },
});
export function registerInbox(bb: BbPluginApi, snapshot: (projectId: string | null) => ReturnType<typeof buildSnapshot>) {
  const db = bb.storage.database();
  const changed = () => bb.realtime.publish("attention-changed", {});
  bb.agents.registerTool({
    name: "leave_inbox_message",
    description: "Leave a durable message for the user in the Agent Inbox.",
    instructions: "Use for a result, decision, or important information the user needs to read. Be concise and include relevant links. Completed turns already appear automatically; do not duplicate routine completion updates. This does not grant approval or replace a pending user interaction.",
    parameters: z.object({ text: z.string().trim().min(1).max(16000), severity: z.enum(["routine", "needs-decision", "urgent"]) }).strict(),
    async execute({ text, severity }, { projectId, threadId }) {
      const result = db.prepare("INSERT INTO inbox_messages (project_id, thread_id, body, severity, created_at) VALUES (?, ?, ?, ?, ?)").run(projectId, threadId, text, severity, Date.now());
      changed();
      return `Stored inbox message #${result.lastInsertRowid}.`;
    },
  });
  bb.rpc.register(inboxContract, {
    inboxAttention: ({ projectId }) => snapshot(projectId),
    inboxMessages: ({ projectId, archived, offset }) => {
      const scope = "(? IS NULL OR project_id = ?)";
      const where = `${scope} AND archived_at IS ${archived ? "NOT " : ""}NULL`;
      const messages = db.prepare(`SELECT id, project_id AS projectId, thread_id AS threadId, body AS text, severity, created_at AS createdAt, read_at AS readAt, archived_at AS archivedAt FROM inbox_messages WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT 100 OFFSET ?`).all(projectId, projectId, offset) as z.infer<typeof message>[];
      const { total } = db.prepare(`SELECT COUNT(*) AS total FROM inbox_messages WHERE ${where}`).get(projectId, projectId) as { total: number };
      const { unread } = db.prepare(`SELECT COUNT(*) AS unread FROM inbox_messages WHERE ${scope} AND read_at IS NULL AND archived_at IS NULL`).get(projectId, projectId) as { unread: number };
      return { messages, total, unread };
    },
    inboxMessageState: ({ id, action }) => {
      const sql = action === "read" ? "read_at = COALESCE(read_at, ?)" : action === "archive" ? "archived_at = ?" : "archived_at = NULL";
      const statement = db.prepare(`UPDATE inbox_messages SET ${sql} WHERE id = ?`);
      const result = action === "restore" ? statement.run(id) : statement.run(Date.now(), id);
      changed();
      return { updated: result.changes > 0 };
    },
  });
}
