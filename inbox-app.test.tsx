// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { writeFileSync } from "node:fs";
const app = await loadPluginApp(() => import("./app"));
afterEach(cleanup);
it("shows both sources and keeps message read separate from thread navigation", async () => {
  let read = false;
  const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
    sidebarThreads: { projects: [{ id: "p", name: "Example project" }] as any },
    rpc: {
      inboxAttention: () => ({ items: [{ threadId: "t", projectId: "p", title: "Review the proposed change", kind: "interaction", label: "Question for you", detail: "Which approach should we use?", attentionAt: 1788860000000, updatedAt: 1788860000000 }], total: 1, generatedAt: 1788860000000 }),
      inboxMessages: () => ({ messages: [{ id: 1, threadId: "t2", projectId: "p", text: "The verification report is ready to read. Open the thread for the report and supporting evidence.", severity: "routine", createdAt: 1788860000000, readAt: read ? 1 : null, archivedAt: null }], total: 1, unread: read ? 0 : 1 }),
      inboxMessageState: () => { read = true; return { updated: true }; },
    },
  });
  await slot.findByText("Review the proposed change");
  expect((slot.getAllByRole("combobox")[0] as HTMLSelectElement).value).toBe("");
  expect((slot.getAllByRole("combobox")[1] as HTMLSelectElement).value).toBe("attention");
  expect(slot.queryByText("Message · Unread")).toBeNull();
  fireEvent.change(slot.getAllByRole("combobox")[1]!, { target: { value: "all" } });
  await slot.findByText("Message · Unread");
  expect(slot.getByText("Message · Unread")).toBeTruthy();
  if (process.env.INBOX_PREVIEW_HTML) writeFileSync(process.env.INBOX_PREVIEW_HTML, slot.container.innerHTML);
  fireEvent.click(slot.getByRole("button", { name: "Mark read" }));
  await waitFor(() => expect(slot.queryByText("Message · Unread")).toBeNull());
  expect(slot.getByText("Review the proposed change")).toBeTruthy();
  expect(app.navPanels).toHaveLength(1);
});

it("dismisses only the filtered displayed occurrences and messages", async () => {
  const dismissed: unknown[] = [];
  const archived: unknown[] = [];
  const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
    settings: { permanentDismissalsEnabled: true },
    sidebarThreads: { projects: [{ id: "p", name: "Example project" }] as any },
    rpc: {
      inboxAttention: ({ projectId }: any) => ({ items: [{ threadId: projectId ?? "other", projectId: projectId ?? "other", title: "Pending thread", kind: "error", label: "Error", attentionAt: 100, updatedAt: 100 }], total: 1, generatedAt: 100 }),
      inboxMessages: () => ({ messages: [{ id: 42, threadId: "t", projectId: "p", text: "Visible message", severity: "routine", createdAt: 100, readAt: null, archivedAt: null }], total: 101, unread: 101 }),
      dismiss: (input: unknown) => { dismissed.push(input); return { dismissed: true }; },
      inboxMessageState: (input: unknown) => { archived.push(input); return { updated: true }; },
    },
  });
  await slot.findByText("Pending thread");
  fireEvent.change(slot.getAllByRole("combobox")[0]!, { target: { value: "p" } });
  await slot.findByText("Pending thread");
  fireEvent.click(slot.getByRole("button", { name: "Dismiss All" }));
  await waitFor(() => expect(dismissed).toEqual([{ threadId: "p", kind: "error", attentionAt: 100 }]));
  expect(archived).toEqual([]);
  await waitFor(() => expect(slot.queryByText("Dismissing…")).toBeNull());
  fireEvent.change(slot.getAllByRole("combobox")[1]!, { target: { value: "all" } });
  await slot.findByText("Visible message");
  fireEvent.click(slot.getByRole("button", { name: "Dismiss All" }));
  await waitFor(() => expect(archived).toEqual([{ id: 42, action: "archive" }]));
});
