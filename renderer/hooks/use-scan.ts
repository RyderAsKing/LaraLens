"use client";

import { useCallback, useState } from "react";
import type { ScanResult } from "@/lib/types";

type Status = "idle" | "scanning" | "success" | "error";

interface ScanState {
  status: Status;
  result: ScanResult | null;
  projectPath: string | null;
  error: string | null;
}

export function useScan() {
  const [state, setState] = useState<ScanState>({
    status: "idle",
    result: null,
    projectPath: null,
    error: null,
  });

  const scan = useCallback(async (projectPath: string) => {
    if (!projectPath.trim()) return;
    setState({ status: "scanning", result: null, projectPath, error: null });
    try {
      // The IPC boundary returns untyped JSON; cast to the renderer's typed shape.
      const result = (await window.laralens.scan(projectPath)) as unknown as ScanResult;
      if (result.ok) {
        setState({ status: "success", result, projectPath, error: null });
      } else {
        setState({
          status: "error",
          result,
          projectPath,
          error: result.error ?? "Scan failed.",
        });
      }
    } catch (err) {
      setState({
        status: "error",
        result: null,
        projectPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, []);

  const pickDirectory = useCallback(async () => {
    const picked = await window.laralens.pickDirectory();
    return picked;
  }, []);

  const reset = useCallback(() => {
    setState({ status: "idle", result: null, projectPath: null, error: null });
  }, []);

  return { ...state, scan, pickDirectory, reset };
}
