import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";

describe("agent inbox", () => {
  it("persists messages, captures identity from context, and separates read/archive/restore", async () => {
    let { bb, harness } = createFakePluginHost({ pluginId: "attention" });
    await plugin(bb);
    await harness.behavior.callAgentTool("leave_inbox_message", { text: "Review the result", severity: "needs-decision" }, { projectId: "p1", threadId: "t1" });
    await expect(harness.behavior.callAgentTool("leave_inbox_message", { text: "spoof", severity: "routine", projectId: "p2" })).rejects.toThrow();
    const list = (projectId = "p1", archived = false) => harness.behavior.callRpc("inboxMessages", { projectId, archived, offset: 0 }) as Promise<any>;
    const first = await list();
    expect(first.unread).toBe(1);
    expect(first.messages[0]).toMatchObject({ projectId: "p1", threadId: "t1", text: "Review the result" });
    expect((await list("p2")).total).toBe(0);
    ({ bb, harness } = await harness.lifecycle.reload(plugin));
    expect((await list()).total).toBe(1);
    const id = first.messages[0].id;
    await harness.behavior.callRpc("inboxMessageState", { id, action: "read" });
    expect((await list()).unread).toBe(0);
    expect((await list()).total).toBe(1);
    await harness.behavior.callRpc("inboxMessageState", { id, action: "archive" });
    expect((await list()).total).toBe(0);
    expect((await list("p1", true)).total).toBe(1);
    await harness.behavior.callRpc("inboxMessageState", { id, action: "restore" });
    expect((await list()).total).toBe(1);
    await harness.lifecycle.dispose();
  });
  it("paginates messages without changing the unread count", async () => {
    let { bb, harness } = createFakePluginHost({ pluginId: "attention" });
    await plugin(bb);
    for (let i = 0; i < 101; i++) await harness.behavior.callAgentTool("leave_inbox_message", { text: `Message ${i}`, severity: "routine" }, { projectId: "p", threadId: "t" });
    const result: any = await harness.behavior.callRpc("inboxMessages", { projectId: null, archived: false, offset: 100 });
    expect(result.messages).toHaveLength(1);
    expect(result.total).toBe(101);
    expect(result.unread).toBe(101);
    await harness.lifecycle.dispose();
  });
});
