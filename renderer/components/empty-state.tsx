"use client";

import { FolderOpen, Loader2, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

interface EmptyStateProps {
  status: "idle" | "scanning" | "success" | "error";
  error: string | null;
  onPickAndScan: () => void;
}

export function EmptyState({ status, error, onPickAndScan }: EmptyStateProps) {
  if (status === "scanning") {
    return (
      <Shell>
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        <Title>Analyzing project</Title>
        <Subtitle>
          Scanning routes, controllers, models, middleware, commands, and
          providers in the main process…
        </Subtitle>
      </Shell>
    );
  }

  if (status === "error") {
    return (
      <Shell>
        <AlertCircle className="h-8 w-8 text-destructive" />
        <Title>Scan failed</Title>
        <Subtitle>{error ?? "An unexpected error occurred."}</Subtitle>
        <Button onClick={onPickAndScan} className="mt-2">
          <FolderOpen />
          Try Again
        </Button>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="flex h-14 w-14 items-center justify-center rounded-xl border bg-card">
        <FolderOpen className="h-6 w-6 text-muted-foreground" />
      </div>
      <Title>Open a Laravel project to begin</Title>
      <Subtitle>
        LaraLens parses your routes, controllers, models, and call chains with a
        native Node scanner — then renders the architecture as an interactive
        graph. No PHP runtime required.
      </Subtitle>
      <Button onClick={onPickAndScan} size="lg" className="mt-2">
        <FolderOpen />
        Select Project Directory
      </Button>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-8 text-center">
      <div className="flex max-w-md flex-col items-center gap-3">{children}</div>
    </div>
  );
}

function Title({ children }: { children: React.ReactNode }) {
  return <h1 className="mt-2 text-lg font-semibold text-foreground">{children}</h1>;
}

function Subtitle({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}
