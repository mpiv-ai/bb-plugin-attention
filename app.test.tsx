// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

const app = await loadPluginApp(() => import("./app"));

afterEach(cleanup);

describe("Needs Attention homepage", () => {
  it("keeps the Dismiss control hidden while the feature switch is off", async () => {
    const slot = renderSlot(
      app.homepageSections[0]!,
      { projectId: null },
      {
        settings: { permanentDismissalsEnabled: false },
        rpc: {
          attention: () => ({
            items: [
              {
                threadId: "t_error",
                projectId: "proj_personal",
                title: "Broken thread",
                kind: "error" as const,
                label: "Failed",
                attentionAt: 5_000,
                updatedAt: 5_000,
              },
            ],
            total: 1,
            generatedAt: 6_000,
          }),
        },
      },
    );

    await slot.findByText("Broken thread");
    expect(
      slot.queryByRole("button", { name: "Dismiss Broken thread" }),
    ).toBeNull();
  });

  it("dismisses an occurrence from the New Thread screen", async () => {
    let dismissed = false;
    const item = {
      threadId: "t_error",
      projectId: "proj_personal",
      title: "Broken thread",
      kind: "error" as const,
      label: "Failed",
      attentionAt: 5_000,
      updatedAt: 5_000,
    };
    const slot = renderSlot(
      app.homepageSections[0]!,
      { projectId: null },
      {
        settings: { permanentDismissalsEnabled: true },
        rpc: {
          attention: () => ({
            items: dismissed ? [] : [item],
            total: dismissed ? 0 : 1,
            generatedAt: 6_000,
          }),
          dismiss: () => {
            dismissed = true;
            return { dismissed: true };
          },
        },
      },
    );

    fireEvent.click(
      await slot.findByRole("button", { name: "Dismiss Broken thread" }),
    );

    await waitFor(() => expect(slot.queryByText("Broken thread")).toBeNull());
    expect(slot.inspection.rpcCalls).toContainEqual({
      method: "dismiss",
      input: { threadId: "t_error", kind: "error", attentionAt: 5_000 },
    });
  });
});
