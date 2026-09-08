// bb-plugin-attention — "Needs attention" homepage section.
//
// Snapshot of every visible thread that wants the user: an error state, a
// pending interaction (approval / question / plugin form), or a finished
// turn bb itself considers unread (latestAttentionAt > lastReadAt). Ranked
// error > interaction > unread, most recently attended first, capped at ten.
//
// The section id "attention" sorts before "daily-ops", so this renders above
// the daily ops homepage section (client renders sections in plugin-id order).
import { defineRpcContract, type BbPluginApi, type PluginThreadEventPayloads } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { registerInbox } from "./inbox-server";

const attentionItem = z.object({
  threadId: z.string(),
  projectId: z.string(),
  title: z.string(),
  kind: z.enum(["error", "interaction", "unread"]),
  label: z.string(),
  detail: z.string().optional(),
  attentionAt: z.number(),
  updatedAt: z.number(),
});

export const rpcContract = defineRpcContract({
  attention: {
    input: z.object({ projectId: z.string().nullable() }).strict(),
    output: z.object({
      items: z.array(attentionItem),
      total: z.number().int(),
      generatedAt: z.number(),
    }),
  },
  dismiss: {
    input: z
      .object({
        threadId: z.string(),
        kind: z.enum(["error", "interaction", "unread"]),
        attentionAt: z.number().int().nonnegative(),
      })
      .strict(),
    output: z.object({ dismissed: z.boolean() }).strict(),
  },
});

type ThreadDto = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["list"]>>[number];
type Interaction = Awaited<
  ReturnType<BbPluginApi["sdk"]["threads"]["interactions"]["list"]>
>[number];
type AttentionItem = z.output<typeof attentionItem>;

const MAX_ITEMS = 10;
const RANK = { error: 0, interaction: 1, unread: 2 } as const;
type Kind = keyof typeof RANK;

function threadTitle(thread: ThreadDto): string {
  return thread.title ?? thread.titleFallback ?? "Untitled thread";
}

function interactionMeta(interaction: Interaction): {
  label: string;
  detail?: string;
} {
  const payload = interaction.payload;
  if (payload.kind === "user_question") {
    const prompt = payload.questions[0]?.prompt ?? "Answer a question in bb";
    return { label: "Question for you", detail: prompt };
  }
  if (payload.kind === "plugin") {
    return { label: "Awaiting your input", detail: payload.title };
  }
  if (!("subject" in payload)) {
    return {
      label: "Awaiting your input",
      detail: "title" in payload ? payload.title : undefined,
    };
  }
  // provider approval
  const subject = payload.subject;
  if (subject.kind === "plan") {
    return {
      label: "Plan ready for review",
      detail: subject.planFilePath ?? "Approve or revise the plan.",
    };
  }
  if (subject.kind === "command") {
    return { label: "Needs approval", detail: subject.command };
  }
  if (subject.kind === "file_change") {
    return { label: "Needs approval", detail: subject.writeScope ?? "Edit files" };
  }
  return {
    label: "Needs approval",
    detail:
      "toolName" in subject
        ? subject.toolName ?? undefined
        : "tool" in subject
          ? subject.tool
          : undefined,
  };
}

export async function buildSnapshot(
  bb: BbPluginApi,
  projectId: string | null,
  isDismissed: (item: AttentionItem) => boolean = () => false,
  full = false,
): Promise<z.output<(typeof rpcContract)["attention"]["output"]>> {
  const threads: ThreadDto[] = [];
  let offset = 0;
  do {
    const page = await bb.sdk.threads.list({ projectId: projectId ?? undefined, archived: false, limit: 500, offset });
    threads.push(...page);
    if (!full || page.length < 500) break;
    offset += page.length;
  } while (true);

  const items: AttentionItem[] = [];
  for (const thread of threads) {
    if (thread.visibility !== "visible") continue; // background workers stay hidden
    if (thread.archivedAt !== null || thread.deletedAt !== null) continue;

    let kind: Kind | null = null;
    let label = "";
    let detail: string | undefined;

    if (thread.status === "error" || thread.runtime.displayStatus === "error") {
      kind = "error";
      label = "Failed";
    } else if (thread.hasPendingInteraction || thread.status === "active") {
      try {
        const pending = (await bb.sdk.threads.interactions.list({
          threadId: thread.id,
        })).find((item) => item.status === "pending");
        if (pending) {
          kind = "interaction";
          const meta = interactionMeta(pending);
          label = meta.label;
          detail = meta.detail;
        }
      } catch (error) {
        bb.log.warn(
          `interactions lookup failed for ${thread.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    } else if (
      thread.status === "idle" &&
      thread.latestAttentionAt > (thread.lastReadAt ?? 0)
    ) {
      kind = "unread";
      label = "Unread completed turn";
    }

    if (kind === null) continue;

    const item: AttentionItem = {
      threadId: thread.id,
      projectId: thread.projectId,
      title: threadTitle(thread),
      kind,
      label,
      ...(detail ? { detail } : {}),
      attentionAt: thread.latestAttentionAt,
      updatedAt: thread.updatedAt,
    };
    if (!isDismissed(item)) items.push(item);
  }

  items.sort(
    (a, b) =>
      RANK[a.kind] - RANK[b.kind] || b.attentionAt - a.attentionAt,
  );

  return {
    items: full ? items : items.slice(0, MAX_ITEMS),
    total: items.length,
    generatedAt: Date.now(),
  };
}

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");

  const settings = bb.settings.define({
    permanentDismissalsEnabled: {
      type: "boolean",
      label: "Permanent dismissals",
      default: false,
    },
  });
  const database = bb.storage.database();
  bb.storage.migrate(database, [
    `CREATE TABLE IF NOT EXISTS dismissed_attention (
      thread_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      attention_at INTEGER NOT NULL,
      dismissed_at INTEGER NOT NULL,
      PRIMARY KEY (thread_id, kind)
    )`,
    `CREATE TABLE inbox_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL, thread_id TEXT NOT NULL, body TEXT NOT NULL,
      severity TEXT NOT NULL, created_at INTEGER NOT NULL,
      read_at INTEGER, archived_at INTEGER
    ); CREATE INDEX inbox_messages_scope ON inbox_messages(project_id, archived_at, created_at);`,
  ]);
  const findDismissal = database.prepare(
    `SELECT attention_at AS attentionAt
     FROM dismissed_attention
     WHERE thread_id = ? AND kind = ?`,
  );
  const saveDismissal = database.prepare(
    `INSERT INTO dismissed_attention (thread_id, kind, attention_at, dismissed_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(thread_id, kind) DO UPDATE SET
       attention_at = excluded.attention_at,
       dismissed_at = excluded.dismissed_at`,
  );

  const getSnapshot = async (projectId: string | null, full = false) => {
    const { permanentDismissalsEnabled } = await settings.get();
    return buildSnapshot(
      bb,
      projectId,
      permanentDismissalsEnabled
        ? (item) => {
            const row = findDismissal.get(item.threadId, item.kind) as
              | { attentionAt: number }
              | undefined;
            return row?.attentionAt === item.attentionAt;
          }
        : undefined,
      full,
    );
  };

  registerInbox(bb, (projectId) => getSnapshot(projectId, true));

  bb.rpc.register(rpcContract, {
    attention: ({ projectId }) => getSnapshot(projectId),
    dismiss: async ({ threadId, kind, attentionAt }) => {
      const { permanentDismissalsEnabled } = await settings.get();
      if (!permanentDismissalsEnabled) return { dismissed: false };
      saveDismissal.run(threadId, kind, attentionAt, Date.now());
      bb.realtime.publish("attention-changed", { threadId });
      return { dismissed: true };
    },
  });

  // Tell open homepages to refetch when a thread finishes or fails, so the
  // section updates live while the user sits on the new-thread screen.
  const changed = (
    payload:
      | PluginThreadEventPayloads["thread.idle"]
      | PluginThreadEventPayloads["thread.failed"],
  ) => {
    bb.realtime.publish("attention-changed", {
      threadId: payload.thread.id,
      status: payload.thread.status,
    });
  };
  bb.events.on("thread.idle", changed);
  bb.events.on("thread.failed", changed);

  bb.background.service("attention-watch", {
    async start(signal) {
      const unsubscribe = bb.sdk.subscribe({
        event: "thread:changed",
        callback: (event) => {
          if (
            event.id
          ) {
            bb.realtime.publish("attention-changed", {
              threadId: event.id,
            });
          }
        },
      });

      await new Promise<void>((resolve) => {
        const stop = () => {
          unsubscribe();
          resolve();
        };
        if (signal.aborted) {
          stop();
          return;
        }
        signal.addEventListener("abort", stop, { once: true });
      });
    },
  });

  bb.cli.register({
    name: "attention",
    summary: "List threads that need your attention (errors, pending input, unread turns)",
    commands: [
      {
        name: "list",
        summary: "Show the top attention threads",
        usage: "bb attention list [--project <projectId>]",
      },
    ],
    async run(argv) {
      const projectFlag = argv.find((arg) => arg.startsWith("--project"));
      const projectId = projectFlag
        ? projectFlag.replace(/^--project=?(\s*)/, "") || null
        : null;
      const snapshot = await getSnapshot(projectId);

      if (snapshot.items.length === 0) {
        return { exitCode: 0, stdout: "Nothing needs your attention." };
      }
      const lines = snapshot.items.map((item, index) => {
        const when = new Date(item.attentionAt).toLocaleString();
        const badge = item.kind.toUpperCase().padEnd(11);
        return `${index + 1}. [${badge}] ${item.title} (${when})${
          item.detail ? ` — ${item.detail}` : ""
        }`;
      });
      lines.push(
        `\n${snapshot.total} thread${snapshot.total === 1 ? "" : "s"} needing attention; showing top ${snapshot.items.length}.`,
      );
      return { exitCode: 0, stdout: lines.join("\n") };
    },
  });
}
