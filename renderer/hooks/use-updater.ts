"use client";

import { useCallback, useEffect, useState } from "react";
import type { UpdateStatus, UpdateState } from "@/preload";

export type { UpdateStatus, UpdateState };

const IDLE: UpdateStatus = { state: "idle", currentVersion: "" };

/**
 * React binding for the LaraLens auto-updater.
 *
 * Flow (all gates a user action):
 *   1. idle / up-to-date  -- show "Check for updates"  -> check()
 *   2. update-available    -- show "Download"           -> download()
 *   3. downloading (pct)   -- spinner + progress %
 *   4. downloaded           -- show "Install & restart"  -> install()
 *
 * Nothing downloads or installs unless the renderer calls the relevant
 * method; the startup check is metadata-only (autoDownload=false on the
 * main-process side), so by itself it only flips state to
 * "update-available".
 */
export function useUpdater() {
  const [status, setStatus] = useState<UpdateStatus>(IDLE);
  // True while an explicit user action (check / download / install) is in
  // flight and its terminal broadcast hasn't arrived yet.
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let mounted = true;

    // Subscribe to pushed state changes from main.
    const unsubscribe = window.laralens.updater.onState((next) => {
      if (!mounted) return;
      setStatus(next);
      // Reset busy when we reach a terminal state for the initiated action.
      if (
        next.state === "idle" ||
        next.state === "up-to-date" ||
        next.state === "update-available" ||
        next.state === "downloaded" ||
        next.state === "error"
      ) {
        setBusy(false);
      }
    });

    // Pull the current status once on mount so the UI reflects startup-time
    // state changes (e.g. a silent startup check already found an update).
    window.laralens.updater
      .getState()
      .then((next) => {
        if (mounted) setStatus(next);
      })
      .catch(() => {
        /* ignore — IPC may not be ready yet */
      });

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  const check = useCallback(async () => {
    setBusy(true);
    try {
      const next = await window.laralens.updater.check();
      setStatus(next);
      if (next.state === "error" || next.state === "up-to-date" || next.state === "update-available") {
        setBusy(false);
      }
    } catch {
      setBusy(false);
    }
  }, []);

  const download = useCallback(async () => {
    setBusy(true);
    try {
      const next = await window.laralens.updater.download();
      setStatus(next);
      if (next.state === "error") setBusy(false);
    } catch {
      setBusy(false);
    }
  }, []);

  const install = useCallback(async () => {
    setBusy(true);
    try {
      await window.laralens.updater.install();
    } finally {
      // app may quit and relaunch before this runs; keep UI sane otherwise.
      setBusy(false);
    }
  }, []);

  return { status, busy, check, download, install };
}