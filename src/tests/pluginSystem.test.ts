import { describe, expect, it, vi } from "vitest";
import {
  PluginSystem,
  createPluginSystem,
  registerPlugin,
  loadPlugin,
  usePlugin,
} from "../infrastructure/pluginSystem";

describe("SDK plugin system (#1054)", () => {
  it("registers and loads isolated plugin instances", () => {
    const system = createPluginSystem();
    const plugin = { preRequest: () => undefined };

    system.registerPlugin("custom", plugin);

    expect(system.loadPlugin("custom")).not.toBe(plugin);
    expect(system.loadPlugin("custom")).toEqual(plugin);
  });

  it("runs pre-request hooks before a request and preserves updates", async () => {
    const system = new PluginSystem();
    system.use({
      name: "request",
      preRequest: (context) => ({ ...context, prepared: true }),
    });

    await expect(
      system.executePreRequest({ method: "invoke" }),
    ).resolves.toEqual({ method: "invoke", prepared: true });
  });

  it("runs post-request hooks in registration order", async () => {
    const system = new PluginSystem();
    system.registerPlugin("first", {
      postRequest: (result) => ({ ...(result as object), first: true }),
    });
    system.registerPlugin("second", {
      postRequest: (result) => ({ ...(result as object), second: true }),
    });

    await expect(system.executePostRequest({ ok: true })).resolves.toEqual({
      ok: true,
      first: true,
      second: true,
    });
  });

  it("runs error hooks and isolates hook failures", async () => {
    const reportFailure = vi.fn();
    const system = new PluginSystem({ onHookError: reportFailure });
    system.registerPlugin("broken", {
      onError: () => {
        throw new Error("isolated");
      },
    });
    system.registerPlugin("handler", {
      onError: (error) => ({ handled: String(error) }),
    });

    await expect(system.executeError("boom")).resolves.toEqual({
      handled: "boom",
    });
    expect(reportFailure).toHaveBeenCalledWith(
      "broken",
      "error",
      expect.any(Error),
    );
  });

  it("provides a default plugin registry", () => {
    registerPlugin("default-plugin", {});
    expect(loadPlugin("default-plugin")).toEqual({});
    expect(usePlugin({ name: "configured", postRequest: () => undefined })).toBeDefined();
  });
});
