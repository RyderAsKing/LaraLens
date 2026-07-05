import path from "node:path";
import { app, BrowserWindow, BrowserWindowConstructorOptions } from "electron";
import Store from "electron-store";

interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  isMaximized?: boolean;
}

export function createWindow(
  name: string,
  options: BrowserWindowConstructorOptions
): BrowserWindow {
  const appIcon = app.isPackaged
    ? path.join(process.resourcesPath, "icon.png")
    : path.join(process.cwd(), "resources", "icon.png");

  const store = new Store<WindowState>({
    name: `window-state-${name}`,
    defaults: {
      width: options.width ?? 1440,
      height: options.height ?? 900,
    },
  });
  const state = store.store;
  const window = new BrowserWindow({
    ...options,
    icon: options.icon ?? appIcon,
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(import.meta.dirname, "preload.js"),
      ...options.webPreferences,
    },
  });

  if (state.isMaximized) {
    window.maximize();
  }

  const saveState = () => {
    if (window.isMaximized()) {
      store.set("isMaximized", true);
    } else {
      const bounds = window.getBounds();
      store.set({
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        isMaximized: false,
      });
    }
  };

  window.on("close", saveState);

  return window;
}
