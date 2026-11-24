/**
 * SDK plugin system.
 *
 * Plugins are isolated by name and receive independent hook invocations.
 * Hook failures are contained and do not alter the plugin registry.
 */

export interface PluginRequestContext {
  [key: string]: unknown;
}

export type PluginPreRequestHook = (
  context: PluginRequestContext,
) => PluginRequestContext | void | Promise<PluginRequestContext | void>;

export type PluginPostRequestHook = (
  result: unknown,
  context: PluginRequestContext,
) => unknown | void | Promise<unknown | void>;

export type PluginErrorHook = (
  error: unknown,
  context: PluginRequestContext,
) => unknown | void | Promise<unknown | void>;

export interface SDKPlugin {
  preRequest?: PluginPreRequestHook;
  postRequest?: PluginPostRequestHook;
  onError?: PluginErrorHook;
  /** Alias for onError. */
  error?: PluginErrorHook;
  /** Alias for error handling hooks. */
  errorHandling?: PluginErrorHook;
}

export interface PluginConfig {
  name: string;
  plugin?: SDKPlugin;
  preRequest?: PluginPreRequestHook;
  postRequest?: PluginPostRequestHook;
  onError?: PluginErrorHook;
  error?: PluginErrorHook;
  errorHandling?: PluginErrorHook;
  hooks?: SDKPlugin;
}

export interface PluginSystemOptions {
  /** Receives plugin hook failures while allowing subsequent plugins to run. */
  onHookError?: (
    pluginName: string,
    hook: "preRequest" | "postRequest" | "error",
    error: unknown,
  ) => void;
}

export type PluginConfigInput = PluginConfig;

function normalizePlugin(config: PluginConfigInput): {
  name: string;
  plugin: SDKPlugin;
} {
  if ("name" in config) {
    const name = config.name;
    if (typeof name !== "string" || name.trim().length === 0) {
      throw new Error("Plugin name must be a non-empty string");
    }
    const plugin: SDKPlugin = {
      ...config.hooks,
      ...(config.plugin ?? {}),
      ...(config.preRequest !== undefined
        ? { preRequest: config.preRequest }
        : {}),
      ...(config.postRequest !== undefined
        ? { postRequest: config.postRequest }
        : {}),
      ...(config.onError !== undefined ? { onError: config.onError } : {}),
      ...(config.error !== undefined ? { error: config.error } : {}),
      ...(config.errorHandling !== undefined
        ? { errorHandling: config.errorHandling }
        : {}),
    };
    return { name, plugin };
  }

  throw new Error("Plugin configuration must include a name");
}

function reportHookError(
  pluginName: string,
  hook: "preRequest" | "postRequest" | "error",
  error: unknown,
): void {
  console.error(`[sorokit] plugin "${pluginName}" ${hook} hook failed`, error);
}

/**
 * Register and invoke request lifecycle hooks.
 *
 * @example
 * const plugins = new PluginSystem();
 * plugins.use({
 *   name: "request-metadata",
 *   preRequest: (context) => ({ ...context, source: "my-app" }),
 *   postRequest: (result) => result,
 *   onError: (error) => error,
 * });
 * const context = await plugins.executePreRequest({ method: "account.get" });
 */
export class PluginSystem {
  private readonly plugins = new Map<string, SDKPlugin>();

  constructor(
    private readonly options: PluginSystemOptions = {},
  ) {}

  private reportHookFailure(
    pluginName: string,
    hook: "preRequest" | "postRequest" | "error",
    error: unknown,
  ): void {
    (this.options.onHookError ?? reportHookError)(pluginName, hook, error);
  }

  registerPlugin(name: string, plugin: SDKPlugin): void {
    if (typeof name !== "string" || name.trim().length === 0) {
      throw new Error("Plugin name must be a non-empty string");
    }
    if (plugin === null || typeof plugin !== "object") {
      throw new Error("Plugin must be an object");
    }
    this.plugins.set(name, { ...plugin });
  }

  loadPlugin(name: string): SDKPlugin | undefined {
    const plugin = this.plugins.get(name);
    return plugin === undefined ? undefined : { ...plugin };
  }

  use(pluginConfig: PluginConfigInput): PluginSystem {
    const normalized = normalizePlugin(pluginConfig);
    this.registerPlugin(normalized.name, normalized.plugin);
    return this;
  }

  async executePreRequest(
    context: PluginRequestContext = {},
  ): Promise<PluginRequestContext> {
    let current = { ...context };
    for (const [pluginName, plugin] of this.plugins) {
      if (plugin.preRequest === undefined) continue;
      try {
        const updated = await plugin.preRequest({ ...current });
        if (updated !== undefined && updated !== null) {
          current = { ...updated };
        }
      } catch (error) {
        this.reportHookFailure(pluginName, "preRequest", error);
      }
    }
    return current;
  }

  async executePostRequest(
    result: unknown,
    context: PluginRequestContext = {},
  ): Promise<unknown> {
    let current = result;
    for (const [pluginName, plugin] of this.plugins) {
      if (plugin.postRequest === undefined) continue;
      try {
        const updated = await plugin.postRequest(current, { ...context });
        if (updated !== undefined) {
          current = updated;
        }
      } catch (error) {
        this.reportHookFailure(pluginName, "postRequest", error);
      }
    }
    return current;
  }

  async executeError(
    error: unknown,
    context: PluginRequestContext = {},
  ): Promise<unknown> {
    let current = error;
    for (const [pluginName, plugin] of this.plugins) {
      const hook =
        plugin.onError ?? plugin.error ?? plugin.errorHandling;
      if (hook === undefined) continue;
      try {
        const updated = await hook(current, { ...context });
        if (updated !== undefined) {
          current = updated;
        }
      } catch (hookError) {
        this.reportHookFailure(pluginName, "error", hookError);
      }
    }
    return current;
  }

  async preRequest(context?: PluginRequestContext): Promise<PluginRequestContext> {
    return this.executePreRequest(context);
  }

  async postRequest(
    result: unknown,
    context?: PluginRequestContext,
  ): Promise<unknown> {
    return this.executePostRequest(result, context);
  }

  async handleError(
    error: unknown,
    context?: PluginRequestContext,
  ): Promise<unknown> {
    return this.executeError(error, context);
  }

  unregisterPlugin(name: string): boolean {
    return this.plugins.delete(name);
  }

  clear(): void {
    this.plugins.clear();
  }

  listPlugins(): string[] {
    return Array.from(this.plugins.keys());
  }
}

export function createPluginSystem(): PluginSystem {
  return new PluginSystem();
}

const defaultPluginSystem = new PluginSystem();

export function registerPlugin(name: string, plugin: SDKPlugin): void {
  defaultPluginSystem.registerPlugin(name, plugin);
}

export function loadPlugin(name: string): SDKPlugin | undefined {
  return defaultPluginSystem.loadPlugin(name);
}

export function usePlugin(pluginConfig: PluginConfigInput): PluginSystem {
  return defaultPluginSystem.use(pluginConfig);
}

export function getPluginSystem(): PluginSystem {
  return defaultPluginSystem;
}
