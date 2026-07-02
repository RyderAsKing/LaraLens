"use client";

import { useCallback, useEffect, useState } from "react";
import type { OpencodeStatus } from "@/lib/opencode-types";

/**
 * React hook for the opencode subsystem.
 *
 * Subscribes to real-time status changes via IPC and exposes actions for
 * start/stop/restart. On mount, fetches the current status so the UI is
 * correct even before any change event fires.
 */
export function useOpencode() {
  const [status, setStatus] = useState<OpencodeStatus | null>(null);

  useEffect(() => {
    // Fetch the current status immediately (in case the server is already
    // running from a previous scan in this session).
    window.opencode.getStatus().then(setStatus).catch(() => {});

    const unsubscribe = window.opencode.onStatusChange((next) => {
      setStatus(next);
    });

    return unsubscribe;
  }, []);

  const start = useCallback(() => {
    window.opencode.start().catch((err) => {
      console.error("[opencode] start failed:", err);
    });
  }, []);

  const stop = useCallback(() => {
    window.opencode.stop().catch((err) => {
      console.error("[opencode] stop failed:", err);
    });
  }, []);

  const restart = useCallback(() => {
    window.opencode.restart().catch((err) => {
      console.error("[opencode] restart failed:", err);
    });
  }, []);

  return { status, start, stop, restart };
}
