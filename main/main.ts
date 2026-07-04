import path from "node:path";
import fs from "node:fs/promises";
import { app, ipcMain, BrowserWindow } from "electron";
import serve from "electron-serve";
import type { Agent as OpencodeAgent, Provider as OpencodeProvider } from "@opencode-ai/sdk";
import { createWindow } from "./helpers/create-window";
import { scanProject } from "./scanner/index";
import * as opencode from "./opencode";
import * as chat from "./opencode/chat";
import * as settings from "./settings";
import type { ChatPermissionResponse } from "./opencode/types";

const isProd = process.env.NODE_ENV === "production";
let currentProjectRoot: string | null = null;

if (isProd) {
  serve({ directory: "app" });
}

(async () => {
  // IPC: scanner. Runs entirely in the main process using Node fs + php-parser.
  // Returns the full graph schema { meta, nodes, edges } + summary.
  ipcMain.handle(
    "laralens:scan",
    async (_event, projectPath: string): Promise<ScanResult> => {
      try {
        const root = path.resolve(projectPath);
        const result = await scanProject(root);
        if (result.ok) {
          currentProjectRoot = root;
          // Fire-and-forget: don't block the scan result on opencode startup.
          opencode.startForProject(root).catch((err) => {
            console.error("[opencode] auto-start failed:", err);
          });
        }
        return result;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        return {
          ok: false,
          error: message,
          graph: { meta: { project: "", analyzedAt: "", nodeCount: 0, edgeCount: 0 }, nodes: [], edges: [] },
          summary: { totalRoutes: 0, totalControllers: 0, totalModels: 0, totalCommands: 0, totalMiddleware: 0, totalProviders: 0, durationMs: 0 },
        };
      }
    }
  );

  ipcMain.handle("laralens:pick-directory", async () => {
    const { dialog } = await import("electron");
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory"],
      title: "Select a Laravel project root",
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle("laralens:read-code-file", async (_event, file: string) => {
    try {
      if (!currentProjectRoot) {
        return { ok: false, error: "No project has been scanned yet." };
      }

      const resolvedFile = path.resolve(file);
      const relative = path.relative(currentProjectRoot, resolvedFile);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        return { ok: false, error: "Cannot open files outside the scanned project." };
      }

      const content = await fs.readFile(resolvedFile, "utf8");
      return { ok: true, content };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // -------------------------------------------------------------------------
  // Global LaraLens settings
  // -------------------------------------------------------------------------
  ipcMain.handle("laralens:settings:get", () => settings.getSettings());

  ipcMain.handle(
    "laralens:settings:update",
    (_event, patch: Partial<settings.LaraLensSettings>) => settings.updateSettings(patch)
  );

  ipcMain.handle(
    "laralens:settings:options",
    async (_event, payload?: { projectRoot?: string | null }): Promise<SettingsOptionsResult> => {
      const root = payload?.projectRoot || currentProjectRoot;
      const cached = settings.getCachedCatalog();

      // No project scanned yet — return saved settings + cached catalog so the
      // user still sees their last selections instead of empty dropdowns.
      if (!root) {
        const selectable = new Set(cached.agents.map((a) => a.name));
        return {
          ok: false,
          settings: settings.reconcileSavedAgentAgainstCatalog(selectable),
          providers: cached.providers,
          agents: cached.agents,
          error: "Scan a Laravel project to refresh providers, models, and agents.",
        };
      }

      const ocClient = opencode.getClient();
      if (!ocClient) {
        const selectable = new Set(cached.agents.map((a) => a.name));
        return {
          ok: false,
          settings: settings.reconcileSavedAgentAgainstCatalog(selectable),
          providers: cached.providers,
          agents: cached.agents,
          error: "OpenCode is not connected. Showing last cached providers and agents.",
        };
      }

      try {
        const [providersResult, agentsResult] = await Promise.all([
          ocClient.config.providers({ query: { directory: root } }),
          ocClient.app.agents({ query: { directory: root } }),
        ]);

        const errors = [providersResult.error, agentsResult.error]
          .filter(Boolean)
          .map((error) => describeSettingsSdkError(error as { name: string; data?: unknown }));

        // Filter out subagent-only agents everywhere: they cannot be used as
        // the top-level chat agent, so we never show them in the catalog or
        // the select. This also means a previously-saved subagent name (e.g.
        // "build") will be reset by reconcileSavedAgentAgainstCatalog below.
        const serializedProviders = (providersResult.data?.providers ?? []).map(serializeProvider);
        const serializedAgents = (agentsResult.data ?? [])
          .map(serializeAgent)
          .filter((agent) => agent.mode !== "subagent");

        if (errors.length === 0) {
          settings.cacheCatalog(serializedProviders, serializedAgents);
        }

        const selectableNames = new Set(serializedAgents.map((a) => a.name));
        return {
          ok: errors.length === 0,
          settings: settings.reconcileSavedAgentAgainstCatalog(selectableNames),
          providers: serializedProviders,
          agents: serializedAgents,
          error: errors.length > 0 ? errors.join("; ") : undefined,
        };
      } catch (error) {
        const selectable = new Set(cached.agents.map((a) => a.name));
        return {
          ok: false,
          settings: settings.reconcileSavedAgentAgainstCatalog(selectable),
          providers: cached.providers,
          agents: cached.agents,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
  );

  const port = process.argv[2] ?? "8888";

  ipcMain.handle(
    "laralens:open-code-window",
    async (_event, payload: { file: string; line?: number }) => {
      const query = new URLSearchParams({ file: payload.file });
      if (payload.line) query.set("line", String(payload.line));

      const codeWindow = createWindow("code", {
        width: 980,
        height: 720,
        minWidth: 720,
        minHeight: 480,
        title: path.basename(payload.file),
        autoHideMenuBar: true,
      });

      if (isProd) {
        await codeWindow.loadURL(`app://./code-viewer?${query.toString()}`);
      } else {
        await codeWindow.loadURL(`http://localhost:${port}/code-viewer?${query.toString()}`);
      }
    }
  );

  // -------------------------------------------------------------------------
  // OpenCode IPC + lifecycle
  // -------------------------------------------------------------------------
  // Broadcast status changes to all renderer windows so the toolbar chip stays
  // in sync without each window polling.
  opencode.subscribe((status) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("opencode:status-changed", status);
    }
  });

  // Keep the chat manager's client reference in sync with the server lifecycle.
  // When the server is connected, hand it the SDK client. Detach only on
  // terminal states; transient states such as `starting` should not by
  // themselves mark in-flight chat messages as errored.
  opencode.subscribe((status) => {
    if (status.state === "connected" && status.projectRoot) {
      chat.setClient(opencode.getClient());
    } else if (
      status.state === "stopped" ||
      status.state === "error" ||
      status.state === "not_installed"
    ) {
      chat.setClient(null);
    }
  });

  // Forward chat streaming events from the main process to all renderer windows.
  chat.setBroadcaster((channel, payload) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(channel, payload);
    }
  });

  ipcMain.handle("opencode:status", () => opencode.getStatus());
  ipcMain.handle("opencode:start", () => {
    if (!currentProjectRoot) return;
    return opencode.startForProject(currentProjectRoot);
  });
  ipcMain.handle("opencode:stop", () => opencode.stop());
  ipcMain.handle("opencode:restart", () => opencode.restart());

  // -------------------------------------------------------------------------
  // OpenCode Chat IPC
  // -------------------------------------------------------------------------
  ipcMain.handle(
    "opencode:chat:send",
    async (_event, payload: { projectRoot: string; text: string }) => {
      if (!payload?.projectRoot || typeof payload.text !== "string") {
        return { ok: false, error: "Invalid request." };
      }
      return chat.send(payload.projectRoot, payload.text);
    }
  );

  ipcMain.handle(
    "opencode:chat:history",
    async (_event, projectRoot: string) => {
      return chat.history(projectRoot);
    }
  );

  ipcMain.handle(
    "opencode:chat:clear",
    async (_event, projectRoot: string) => {
      chat.clear(projectRoot);
      return { ok: true };
    }
  );

  ipcMain.handle(
    "opencode:chat:abort",
    async (_event, projectRoot: string) => {
      return chat.abort(projectRoot);
    }
  );

  ipcMain.handle(
    "opencode:chat:permission:reply",
    async (
      _event,
      payload: { projectRoot: string; permissionID: string; response: ChatPermissionResponse }
    ) => {
      const validResponses = new Set<ChatPermissionResponse>(["once", "always", "reject"]);
      if (
        !payload?.projectRoot ||
        !payload.permissionID ||
        !validResponses.has(payload.response)
      ) {
        return { ok: false, error: "Invalid permission reply." };
      }
      return chat.replyPermission(payload.projectRoot, payload.permissionID, payload.response);
    }
  );

  // Kick off detection as soon as possible (before any window opens).
  opencode.detect().catch((err) => {
    console.error("[opencode] detection failed:", err);
  });

  // Synchronously kill the server when the app is closing so it doesn't
  // outlive LaraLens.
  app.on("before-quit", () => {
    chat.dispose();
    opencode.dispose();
  });

  await app.whenReady();

  const mainWindow = createWindow("main", {
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    title: "LaraLens",
    autoHideMenuBar: true,
  });

  if (isProd) {
    await mainWindow.loadURL("app://./");
  } else {
    app.setPath("userData", `${app.getPath("userData")} (development)`);
    await mainWindow.loadURL(`http://localhost:${port}/`);
    mainWindow.webContents.openDevTools();
  }
})();

app.on("window-all-closed", () => {
  app.quit();
});

export type ScanResult = {
  ok: boolean;
  error?: string;
  graph: GraphPayload;
  summary: ScanSummary;
};

export type GraphPayload = {
  meta: { project: string; analyzedAt: string; nodeCount: number; edgeCount: number };
  nodes: unknown[];
  edges: unknown[];
};

export type ScanSummary = {
  totalRoutes: number;
  totalControllers: number;
  totalModels: number;
  totalCommands: number;
  totalMiddleware: number;
  totalProviders: number;
  durationMs: number;
};

// Re-export the settings catalog types so preload/renderer type files can import
// them from a single source of truth (`main/settings.ts`).
export type {
  SettingsModel,
  SettingsProvider,
  SettingsAgent,
} from "./settings";
export type SettingsOptionsResult = {
  ok: boolean;
  settings: settings.LaraLensSettings;
  providers: settings.SettingsProvider[];
  agents: settings.SettingsAgent[];
  error?: string;
};

function serializeProvider(provider: OpencodeProvider): settings.SettingsProvider {
  return {
    id: provider.id,
    name: provider.name,
    source: provider.source,
    models: Object.values(provider.models)
      .map((model) => ({
        id: model.id,
        providerID: model.providerID,
        name: model.name,
        status: model.status,
        contextLimit: model.limit.context,
        outputLimit: model.limit.output,
        supportsTools: model.capabilities.toolcall,
        supportsReasoning: model.capabilities.reasoning,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

function serializeAgent(agent: OpencodeAgent): settings.SettingsAgent {
  return {
    name: agent.name,
    description: agent.description,
    mode: agent.mode,
    builtIn: agent.builtIn,
    color: agent.color,
    model: agent.model,
  };
}

function describeSettingsSdkError(error: { name: string; data?: unknown }): string {
  if (
    error.data &&
    typeof error.data === "object" &&
    "message" in error.data &&
    typeof (error.data as { message: unknown }).message === "string"
  ) {
    return `${error.name}: ${(error.data as { message: string }).message}`;
  }
  return error.name;
}
