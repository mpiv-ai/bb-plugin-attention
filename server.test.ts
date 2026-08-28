import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";

const base = {
  projectId: "proj_personal",
  environmentId: null,
  providerId: "anthropic",
  sectionId: null,
  parentThreadId: null,
  sourceThreadId: null,
  originKind: null,
  originPluginId: null,
  pinnedAt: null,
  deletedAt: null,
  environmentHostId: null,
  environmentName: null,
  environmentBranchName: null,
  environmentWorkspaceDisplayKind: "other" as const,
};

function listThread(overrides: Record<string, unknown>) {
  return {
    ...base,
    status: "idle",
    visibility: "visible",
    archivedAt: null,
    lastReadAt: null,
    latestAttentionAt: 1_000,
    updatedAt: 1_000,
    runtime: { displayStatus: "idle", hostReconnectGraceExpiresAt: null },
    activity: {
      activeWorkflowCount: 0,
      activeBackgroundAgentCount: 0,
      activeBackgroundCommandCount: 0,
      activePlanModeCount: 0,
      activeGoalCount: 0,
    },
    pinSortKey: null,
    hasPendingInteraction: false,
    ...overrides,
  };
}

const pendingInteraction = (threadId: string) => ({
  id: `ia_${threadId}`,
  threadId,
  status: "pending" as const,
  statusReason: null,
  createdAt: 2_000,
  expiresAt: null,
  resolvedAt: null,
  turnId: "turn_1",
  providerId: "anthropic",
  providerThreadId: "provider-thread-1",
  providerRequestId: "provider-request-1",
  payload: {
    kind: "user_question" as const,
    questions: [
      {
        id: "q1",
        prompt: "Ship it now or wait for review?",
        multiSelect: false,
        allowFreeText: false,
      },
    ],
  },
  resolution: null,
});

describe("attention snapshot", () => {
  it("leaves attention visible while permanent dismissals are disabled", async () => {
    const failed = listThread({
      id: "t_error",
      title: "Broken thread",
      titleFallback: null,
      status: "error",
      runtime: { displayStatus: "error", hostReconnectGraceExpiresAt: null },
      latestAttentionAt: 5_000,
    });
    const { bb, harness } = createFakePluginHost({
      pluginId: "attention",
      sdk: {
        threads: {
          list: async () => [failed],
          interactions: { list: async () => [] },
        },
      },
    });
    await plugin(bb);

    expect(
      await harness.behavior.callRpc("dismiss", {
        threadId: failed.id,
        kind: "error",
        attentionAt: 5_000,
      }),
    ).toEqual({ dismissed: false });
    const snapshot = (await harness.behavior.callRpc("attention", {
      projectId: null,
    })) as { items: Array<{ threadId: string }> };
    expect(snapshot.items).toEqual([
      expect.objectContaining({ threadId: failed.id }),
    ]);
  });

  it("ranks error > interaction > unread, excludes hidden/archived/active", async () => {
    const failed = listThread({
      id: "t_error",
      title: "Broken thread",
      titleFallback: null,
      status: "error",
      runtime: { displayStatus: "idle", hostReconnectGraceExpiresAt: null },
      latestAttentionAt: 5_000,
    });
    const waiting = listThread({
      id: "t_wait",
      title: "Ask me something",
      titleFallback: null,
      hasPendingInteraction: true,
      latestAttentionAt: 4_000,
    });
    const unread = listThread({
      id: "t_unread",
      title: "Finished turn",
      titleFallback: null,
      latestAttentionAt: 3_000,
    });
    const hidden = listThread({
      id: "t_hidden",
      title: "Hidden worker",
      titleFallback: null,
      visibility: "hidden",
      status: "error",
    });
    const archived = listThread({
      id: "t_archived",
      title: "Archived failure",
      titleFallback: null,
      status: "error",
      archivedAt: 500,
    });
    const active = listThread({
      id: "t_active",
      title: "Still working",
      titleFallback: null,
      status: "active",
      runtime: { displayStatus: "active", hostReconnectGraceExpiresAt: null },
    });

    const { bb, harness } = createFakePluginHost({
      pluginId: "attention",
      sdk: {
        threads: {
          list: async () => [failed, waiting, unread, hidden, archived, active],
          interactions: {
            list: async ({ threadId }: { threadId: string }) =>
              threadId === "t_wait" ? [pendingInteraction(threadId)] : [],
          },
        },
      },
    });
    await plugin(bb);

    const result = (await harness.behavior.callRpc("attention", {
      projectId: null,
    })) as {
      items: Array<{
        threadId: string;
        kind: string;
        label: string;
      }>;
      total: number;
    };
    const { items, total } = result;

    expect(total).toBe(3);
    expect(items.map((item) => item.threadId)).toEqual([
      "t_error",
      "t_wait",
      "t_unread",
    ]);
    expect(items[0]).toMatchObject({ kind: "error", label: "Failed" });
    expect(items[1]).toMatchObject({
      kind: "interaction",
      label: "Question for you",
      detail: "Ship it now or wait for review?",
    });
    expect(items[2]).toMatchObject({
      kind: "unread",
      label: "Turn finished — reply needed",
    });

    // Active threads are also checked because their summary flag may lag.
    expect(harness.inspection.sdk.callsTo("threads.interactions.list")).toHaveLength(2);
  });

  it("caps the list at ten and sorts by attention recency within a kind", async () => {
    const many = Array.from({ length: 12 }, (_, index) =>
      listThread({
        id: `t_${index}`,
        title: `Thread ${index}`,
        titleFallback: null,
        latestAttentionAt: 1000 + index,
      }),
    );
    const { bb, harness } = createFakePluginHost({
      pluginId: "attention",
      sdk: {
        threads: {
          list: async () => many,
          interactions: { list: async () => [] },
        },
      },
    });
    await plugin(bb);

    const result = (await harness.behavior.callRpc("attention", {
      projectId: null,
    })) as { items: Array<{ threadId: string }>; total: number };
    const { items, total } = result;

    expect(total).toBe(12);
    expect(items).toHaveLength(10);
    // newest attention first
    expect(items[0].threadId).toBe("t_11");
    expect(items[9].threadId).toBe("t_2");
  });

  it("surfaces an active AskUserQuestion when the thread flag is stale", async () => {
    const waiting = listThread({
      id: "t_active_question",
      title: "Active question",
      titleFallback: null,
      status: "active",
      runtime: { displayStatus: "active", hostReconnectGraceExpiresAt: null },
      hasPendingInteraction: false,
      latestAttentionAt: 4_000,
    });
    const { bb, harness } = createFakePluginHost({
      pluginId: "attention",
      sdk: {
        threads: {
          list: async () => [waiting],
          interactions: {
            list: async () => [pendingInteraction(waiting.id)],
          },
        },
      },
    });
    await plugin(bb);

    const result = (await harness.behavior.callRpc("attention", {
      projectId: null,
    })) as { items: Array<{ threadId: string; kind: string; detail?: string }> };

    expect(result.items).toEqual([
      expect.objectContaining({
        threadId: waiting.id,
        kind: "interaction",
        detail: "Ship it now or wait for review?",
      }),
    ]);
  });

  it("keeps a dismissed occurrence hidden across reloads and shows a later occurrence", async () => {
    const failed = listThread({
      id: "t_error",
      title: "Broken thread",
      titleFallback: null,
      status: "error",
      runtime: { displayStatus: "error", hostReconnectGraceExpiresAt: null },
      latestAttentionAt: 5_000,
    });
    const unread = listThread({
      id: "t_unread",
      title: "Finished thread",
      titleFallback: null,
      latestAttentionAt: 4_000,
    });
    const { bb, harness } = createFakePluginHost({
      pluginId: "attention",
      settings: { permanentDismissalsEnabled: true },
      sdk: {
        threads: {
          list: async () => [failed, unread],
          interactions: { list: async () => [] },
        },
      },
    });
    await plugin(bb);

    await harness.behavior.callRpc("dismiss", {
      threadId: failed.id,
      kind: "error",
      attentionAt: 5_000,
    });
    const reloaded = await harness.lifecycle.reload(plugin);

    const dismissed = (await reloaded.harness.behavior.callRpc("attention", {
      projectId: null,
    })) as { items: Array<{ threadId: string }> };
    expect(dismissed.items).toEqual([
      expect.objectContaining({ threadId: unread.id }),
    ]);

    failed.latestAttentionAt = 6_000;
    const laterOccurrence = (await reloaded.harness.behavior.callRpc("attention", {
      projectId: null,
    })) as { items: Array<{ threadId: string }> };
    expect(laterOccurrence.items).toEqual([
      expect.objectContaining({ threadId: failed.id }),
      expect.objectContaining({ threadId: unread.id }),
    ]);
  });

  it("exposes the same ranked list through the CLI", async () => {
    const failed = listThread({
      id: "t_error",
      title: "Broken thread",
      titleFallback: null,
      status: "error",
      runtime: { displayStatus: "idle", hostReconnectGraceExpiresAt: null },
    });
    const { bb, harness } = createFakePluginHost({
      pluginId: "attention",
      sdk: {
        threads: {
          list: async () => [failed],
          interactions: { list: async () => [] },
        },
      },
    });
    await plugin(bb);

    const run = await harness.behavior.runCli(["list"]);
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("Broken thread");
    expect(run.stdout).toContain("ERROR");
  });

  it("publishes attention refreshes for interaction lifecycle changes", async () => {
    let onThreadChange:
      | ((event: { id?: string; changes: readonly string[] }) => void)
      | undefined;
    let unsubscribeCalls = 0;
    const { bb, harness } = createFakePluginHost({
      pluginId: "attention",
      sdk: {
        subscribe: ({ callback }: { callback: typeof onThreadChange }) => {
          onThreadChange = callback;
          return () => {
            unsubscribeCalls += 1;
          };
        },
      },
    });
    await plugin(bb);

    const service = harness.behavior.runService("attention-watch");
    onThreadChange?.({ id: "t_question", changes: ["status-changed"] });
    onThreadChange?.({ id: "t_question", changes: ["interactions-changed"] });

    expect(harness.inspection.realtimeSignals).toEqual([
      {
        channel: "attention-changed",
        payload: { threadId: "t_question" },
      },
    ]);

    service.controller.abort();
    await service.done;
    expect(unsubscribeCalls).toBe(1);
  });
});
