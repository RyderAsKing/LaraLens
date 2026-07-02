import path from "node:path";
import fs from "node:fs/promises";
import { app, ipcMain, BrowserWindow } from "electron";
import serve from "electron-serve";
import { createWindow } from "./helpers/create-window";
import { scanProject } from "./scanner/index";
import * as opencode from "./opencode";

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

  ipcMain.handle("opencode:status", () => opencode.getStatus());
  ipcMain.handle("opencode:start", () => {
    if (!currentProjectRoot) return;
    return opencode.startForProject(currentProjectRoot);
  });
  ipcMain.handle("opencode:stop", () => opencode.stop());
  ipcMain.handle("opencode:restart", () => opencode.restart());

  // Kick off detection as soon as possible (before any window opens).
  opencode.detect().catch((err) => {
    console.error("[opencode] detection failed:", err);
  });

  // Synchronously kill the server when the app is closing so it doesn't
  // outlive LaraLens.
  app.on("before-quit", () => {
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
