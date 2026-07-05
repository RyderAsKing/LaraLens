import { app, ipcMain, type BrowserWindow } from "electron";
import electronUpdater from "electron-updater";
import type { UpdateInfo, ProgressInfo } from "builder-util-runtime";

type AutoUpdater = {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  on(event: "checking-for-update", listener: () => void): void;
  on(event: "update-available", listener: (info: UpdateInfo) => void): void;
  on(event: "update-not-available", listener: () => void): void;
  on(event: "download-progress", listener: (progress: ProgressInfo) => void): void;
  on(event: "update-downloaded", listener: () => void): void;
  on(event: "error", listener: (error: Error) => void): void;
};

const { autoUpdater } = electronUpdater as { autoUpdater: AutoUpdater };

/**
 * LaraLens auto-updater.
 *
 * Wraps `electron-updater` so that:
 *   - it never downloads or installs anything without an explicit user
 *     click in the renderer (autoDownload=false, autoInstallOnAppQuit=false);
 *   - it exposes a small typed IPC surface for the renderer to observe
 *     state and trigger check / download / install;
 *   - it works in development too (handlers respond with a clear "not
 *     available in dev" status without throwing on import).
 *
 * Channel contract (all on the `laralens:` namespace):
 *   laralens:update:check       (invoke)  -> UpdateStatus   manual check
 *   laralens:update:download    (invoke)  -> UpdateStatus   begin download
 *   laralens:update:install     (invoke)  -> boolean        quit & install
 *   laralens:update:get-state   (invoke)  -> UpdateStatus   read current state
 *   laralens:update:state       (push)    -> UpdateStatus   state broadcasts
 */

export type UpdateState =
  | "idle"
  | "checking"
  | "update-available"
  | "downloading"
  | "downloaded"
  | "up-to-date"
  | "unsupported"
  | "error";

export interface UpdateStatus {
  state: UpdateState;
  /** Version of the running app. */
  currentVersion: string;
  /** Version of the available update (when applicable). */
  version?: string;
  /** Release notes that ship with the update (markdown from GitHub). */
  releaseNotes?: string;
  /** Download completion percent, 0..100 (only while downloading). */
  progress?: number;
  /** Human-readable error message when state === "error". */
  error?: string;
}

let state: UpdateState = "idle";
let info: UpdateInfo | null = null;
let errorMsg: string | null = null;
let progressPct = 0;
let windows: BrowserWindow[] = [];
let started = false;

const canUpdate = () => app.isPackaged;

/**
 * electron-updater can only patch AppImage builds on Linux. When LaraLens
 * is installed via the .deb or .rpm package there's no in-place updater, so
 * we surface an explicit `unsupported` state and ask the user to reinstall
 * from the GitHub Releases page. APPIMAGE is set by the AppImage runtime.
 */
function isUnsupportedLinux() {
  return (
    process.platform === "linux" &&
    app.isPackaged &&
    !process.env.APPIMAGE
  );
}

function unsupportedMessage(): string {
  return "Auto-update isn't supported for .deb/.rpm installs. Download the latest AppImage (or new .deb/.rpm) from the GitHub Releases page.";
}

function currentStatus(): UpdateStatus {
  const status: UpdateStatus = {
    state,
    currentVersion: app.getVersion(),
  };
  if (info) {
    status.version = info.version;
    const notes = info.releaseNotes;
    if (typeof notes === "string") {
      status.releaseNotes = notes;
    } else if (Array.isArray(notes) && notes.length > 0 && typeof notes[0].note === "string") {
      status.releaseNotes = notes[0].note;
    }
  }
  if (state === "downloading") status.progress = progressPct;
  if (state === "error" && errorMsg) status.error = errorMsg;
  if (state === "unsupported") status.error = unsupportedMessage();
  return status;
}

function setState(next: UpdateState): void {
  state = next;
  broadcast();
}

function broadcast(): void {
  const status = currentStatus();
  for (const win of windows) {
    if (!win.isDestroyed()) {
      win.webContents.send("laralens:update:state", status);
    }
  }
}

/** Register a window so it receives state broadcasts; auto-deregisters on close. */
export function attachWindow(win: BrowserWindow): void {
  if (!windows.includes(win)) windows.push(win);
  win.on("closed", () => {
    windows = windows.filter((w) => w !== win);
  });
}

/** Initialize auto-updater. Safe to call once on app startup. */
export function initUpdater(): void {
  if (started) return;
  started = true;

  // IPC handlers are always registered (even in dev) so the renderer call
  // surface is stable. The autoUpdater wiring only happens when packaged.
  ipcMain.handle("laralens:update:check", async (): Promise<UpdateStatus> => {
    if (isUnsupportedLinux()) {
      errorMsg = unsupportedMessage();
      setState("unsupported");
      return currentStatus();
    }
    if (!canUpdate()) {
      errorMsg = "Auto-update is only available in installed builds.";
      setState("error");
      return currentStatus();
    }
    try {
      await autoUpdater.checkForUpdates();
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : String(err);
      setState("error");
    }
    return currentStatus();
  });

  ipcMain.handle("laralens:update:download", async (): Promise<UpdateStatus> => {
    if (isUnsupportedLinux()) {
      errorMsg = unsupportedMessage();
      setState("unsupported");
      return currentStatus();
    }
    if (!canUpdate()) {
      errorMsg = "Auto-update is only available in installed builds.";
      setState("error");
      return currentStatus();
    }
    if (state !== "update-available" && state !== "error") {
      // No known update to download; nudge the user to check first.
      return currentStatus();
    }
    try {
      progressPct = 0;
      setState("downloading");
      await autoUpdater.downloadUpdate();
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : String(err);
      setState("error");
    }
    return currentStatus();
  });

  ipcMain.handle("laralens:update:install", async (): Promise<boolean> => {
    if (isUnsupportedLinux() || !canUpdate() || state !== "downloaded") return false;
    // quitAndInstall(isSilent=false, isForceRunAfter=true):
    //   - isSilent=false so Windows shows the NSIS elevation/confirm dialog
    //     instead of silently reinstalling;
    //   - isForceRunAfter=true so the app relaunches once the new build lands.
    // The invoke resolves just before the app quits.
    setImmediate(() => {
      try {
        autoUpdater.quitAndInstall(false, true);
      } catch (err) {
        errorMsg = err instanceof Error ? err.message : String(err);
        setState("error");
      }
    });
    return true;
  });

  ipcMain.handle("laralens:update:get-state", (): UpdateStatus => currentStatus());

  if (!canUpdate()) {
    console.log("[updater] dev build — autoUpdater disabled, IPC stubs active");
    return;
  }

  if (isUnsupportedLinux()) {
    console.log("[updater] linux non-AppImage build — autoUpdate disabled");
    errorMsg = unsupportedMessage();
    state = "unsupported";
    broadcast();
    return;
  }

  // Production wiring: never download or install without an explicit click.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on("checking-for-update", () => setState("checking"));
  autoUpdater.on("update-available", (i: UpdateInfo) => {
    info = i;
    setState("update-available");
  });
  autoUpdater.on("update-not-available", () => {
    // Don't clobber a useful "downloaded" state if a re-check happens.
    if (state !== "downloaded") setState("up-to-date");
  });
  autoUpdater.on("download-progress", (p: ProgressInfo) => {
    progressPct = Math.round(p.percent);
    if (state !== "downloading") setState("downloading");
    else broadcast();
  });
  autoUpdater.on("update-downloaded", () => {
    progressPct = 100;
    setState("downloaded");
  });
  autoUpdater.on("error", (err: Error) => {
    errorMsg = err?.message ?? String(err);
    setState("error");
  });

  // Silent startup check: metadata-only because autoDownload=false.
  // Any update found shows up in the Settings dialog when the user opens it.
  autoUpdater.checkForUpdates().catch((err: Error) => {
    // Non-fatal: the renderer can retry manually via the button.
    console.warn("[updater] startup check failed:", err?.message);
  });
}
