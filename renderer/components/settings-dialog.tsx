"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Bot, Cpu, Download, ExternalLink, Loader2, RefreshCw, RotateCcw, Save, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useUpdater } from "@/hooks/use-updater";
import type {
  LaraLensSettings,
  ModelSelection,
  SettingsAgent,
  SettingsOptionsResult,
  SettingsProvider,
} from "@/lib/settings-types";

const EMPTY_SETTINGS: LaraLensSettings = {
  defaultAgent: null,
  defaultModel: null,
};

interface SettingsDialogProps {
  open: boolean;
  projectRoot: string | null;
  onClose: () => void;
}

export function SettingsDialog({ open, projectRoot, onClose }: SettingsDialogProps) {
  const [settings, setSettings] = useState<LaraLensSettings>(EMPTY_SETTINGS);
  const [providers, setProviders] = useState<SettingsProvider[]>([]);
  const [agents, setAgents] = useState<SettingsAgent[]>([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [selectedAgent, setSelectedAgent] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const updater = useUpdater();

  const applyOptions = useCallback((result: SettingsOptionsResult) => {
    setSettings(result.settings);
    setSelectedModel(modelKey(result.settings.defaultModel));
    setSelectedAgent(result.settings.defaultAgent ?? "");
    setProviders(result.providers);
    setAgents(result.agents);
    setError(result.ok ? null : result.error ?? null);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setSaved(false);
    setError(null);
    try {
      const result = await window.laralens.settings.options(projectRoot);
      applyOptions(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load settings.");
      try {
        const current = await window.laralens.settings.get();
        setSettings(current);
        setSelectedModel(modelKey(current.defaultModel));
        setSelectedAgent(current.defaultAgent ?? "");
      } catch {
        setSettings(EMPTY_SETTINGS);
      }
    } finally {
      setLoading(false);
    }
  }, [applyOptions, projectRoot]);

  useEffect(() => {
    if (!open) return;
    void load();
  }, [load, open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose, open]);

  const modelCount = useMemo(
    () => providers.reduce((total, provider) => total + provider.models.length, 0),
    [providers]
  );
  const selectableAgents = useMemo(
    () => agents.filter((agent) => agent.mode !== "subagent"),
    [agents]
  );
  const knownModelSelected = useMemo(
    () => providers.some((provider) => provider.models.some((model) => modelKey(model) === selectedModel)),
    [providers, selectedModel]
  );
  const knownAgentSelected = useMemo(
    () => selectableAgents.some((agent) => agent.name === selectedAgent),
    [selectableAgents, selectedAgent]
  );
  const selectedAgentDetails = useMemo(
    () => agents.find((agent) => agent.name === selectedAgent),
    [agents, selectedAgent]
  );

  const save = useCallback(async () => {
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const next = await window.laralens.settings.update({
        defaultModel: parseModelKey(selectedModel),
        defaultAgent: selectedAgent && knownAgentSelected ? selectedAgent : null,
      });
      setSettings(next);
      setSelectedModel(modelKey(next.defaultModel));
      setSelectedAgent(next.defaultAgent ?? "");
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save settings.");
    } finally {
      setSaving(false);
    }
  }, [knownAgentSelected, selectedAgent, selectedModel]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm animate-settings-fade-in" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <div className="flex max-h-[86vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-[var(--chassis)] bg-[var(--void)] shadow-2xl animate-settings-pop-in">
        <header className="flex items-start justify-between gap-4 border-b border-[var(--chassis)] px-5 py-4">
          <div className="min-w-0">
            <h2 id="settings-title" className="text-base font-semibold text-[var(--flare)]">
              LaraLens Settings
            </h2>
            <p className="mt-1 text-sm text-[var(--etch)]">
              Choose the default OpenCode agent and model LaraLens should use for project chat.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-[var(--etch)] transition-colors hover:bg-[var(--accent)]/30 hover:text-[var(--flare)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--aperture)]"
            aria-label="Close settings"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {error && (
            <div className="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
              {error}
            </div>
          )}

          <div className="flex flex-col gap-8 px-1 py-2">
            <div>
              <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-[var(--flare)]">
                <Cpu className="h-4 w-4 text-[var(--aperture)]" />
                Default model
              </div>
              <p className="mb-2 text-xs text-[var(--etch)]">
                {providers.length} providers · {modelCount} models
              </p>

              <select
                id="default-model"
                value={selectedModel}
                onChange={(event) => setSelectedModel(event.target.value)}
                disabled={loading}
                className="w-full rounded-md border border-[var(--chassis)] bg-[var(--void)] px-3 py-2 text-sm text-[var(--flare)] outline-none transition-colors focus:border-[var(--aperture)] focus:ring-2 focus:ring-[var(--aperture)]/30 disabled:opacity-60"
              >
                <option value="">Auto / OpenCode default</option>
                {selectedModel && !knownModelSelected && settings.defaultModel && (
                  <option value={selectedModel}>{modelLabel(settings.defaultModel)} (saved)</option>
                )}
                {providers.map((provider) => (
                  <optgroup key={provider.id} label={`${provider.name} (${provider.source})`}>
                    {provider.models.map((model) => (
                      <option key={`${provider.id}:${model.id}`} value={modelKey(model)}>
                        {model.name}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>

            <div>
              <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-[var(--flare)]">
                <Bot className="h-4 w-4 text-[var(--aperture)]" />
                Default agent
              </div>
              <p className="mb-2 text-xs text-[var(--etch)]">
                {selectableAgents.length} agents available
              </p>

              <select
                id="default-agent"
                value={selectedAgent}
                onChange={(event) => setSelectedAgent(event.target.value)}
                disabled={loading}
                className="w-full rounded-md border border-[var(--chassis)] bg-[var(--void)] px-3 py-2 text-sm text-[var(--flare)] outline-none transition-colors focus:border-[var(--aperture)] focus:ring-2 focus:ring-[var(--aperture)]/30 disabled:opacity-60"
              >
                <option value="">OpenCode default</option>
                {selectedAgent && !knownAgentSelected && (
                  <option value={selectedAgent}>
                    {selectedAgent} {selectedAgentDetails?.mode === "subagent" ? "(subagent-only; not used for chat)" : "(saved)"}
                  </option>
                )}
                {selectableAgents.map((agent) => (
                  <option key={agent.name} value={agent.name}>
                    {agent.name} — {agent.mode}{agent.builtIn ? " · built-in" : ""}
                  </option>
                ))}
              </select>
              {selectedAgentDetails?.mode === "subagent" && (
                <p className="mt-2 text-xs text-amber-200">
                  Subagent-only agents cannot be used as the top-level chat agent. Saving will reset this to OpenCode default.
                </p>
              )}
            </div>

            <UpdateSection updater={updater} />
          </div>
        </div>

        <footer className="flex items-center justify-between gap-3 border-t border-[var(--chassis)] px-5 py-3">
          <div className="text-xs text-[var(--etch)]">
            {saved ? "Settings saved. New chat prompts will use these defaults." : "Defaults apply to new chat prompts."}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={load} disabled={loading || saving}>
              {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              Refresh lists
            </Button>
            <Button size="sm" onClick={save} disabled={loading || saving}>
              {saving ? <Loader2 className="animate-spin" /> : <Save />}
              Save settings
            </Button>
          </div>
        </footer>
      </div>
    </div>
  );
}

function modelKey(model: ModelSelection | { providerID: string; id: string } | null): string {
  if (!model) return "";
  return JSON.stringify({
    providerID: model.providerID,
    modelID: "modelID" in model ? model.modelID : model.id,
  });
}

function parseModelKey(value: string): ModelSelection | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<ModelSelection>;
    if (typeof parsed.providerID === "string" && typeof parsed.modelID === "string") {
      return { providerID: parsed.providerID, modelID: parsed.modelID };
    }
  } catch {
    // Ignore invalid persisted option values.
  }
  return null;
}

function modelLabel(model: ModelSelection): string {
  return `${model.providerID} / ${model.modelID}`;
}

interface UpdateSectionProps {
  updater: ReturnType<typeof useUpdater>;
}

function UpdateSection({ updater }: UpdateSectionProps) {
  const { status, busy, check, download, install } = updater;
  const { state, currentVersion, version, releaseNotes, progress, error } = status;

  const versionLabel = currentVersion ? `v${currentVersion}` : "";
  const updateLabel = version ? `v${version}` : "";

  return (
    <div>
      <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-[var(--flare)]">
        <Download className="h-4 w-4 text-[var(--aperture)]" />
        Updates {versionLabel && <span className="text-[var(--etch)] font-normal">· installed {versionLabel}</span>}
      </div>

      {/* Status line */}
      <div className="mb-3 text-xs text-[var(--etch)]">
        {state === "idle" && "No update check has been run yet in this session."}
        {state === "checking" && "Checking for updates…"}
        {state === "up-to-date" && (
          <span className="text-emerald-300">You&apos;re on the latest version{versionLabel ? ` (${versionLabel})` : ""}.</span>
        )}
        {state === "update-available" && updateLabel && (
          <span className="text-[var(--flare)]">An update to {updateLabel} is available.</span>
        )}
        {state === "downloading" && updateLabel && (
          <span className="text-[var(--flare)]">Downloading {updateLabel}… {progress ?? 0}%</span>
        )}
        {state === "downloaded" && updateLabel && (
          <span className="text-emerald-300">{updateLabel} is ready to install.</span>
        )}
        {state === "error" && <span className="text-amber-200">{error ?? "Update check failed."}</span>}
        {state === "unsupported" && (
          <span className="text-amber-200">{error ?? "Auto-update isn't supported for this install."}</span>
        )}
      </div>

      {/* Progress bar while downloading */}
      {(state === "downloading") && (
        <div className="mb-3 h-1.5 w-full overflow-hidden rounded bg-[var(--chassis)]">
          <div
            className="h-full bg-[var(--aperture)] transition-[width] duration-200"
            style={{ width: `${Math.max(0, Math.min(100, progress ?? 0))}%` }}
          />
        </div>
      )}

      {/* Release notes (markdown body) when an update is available or downloaded */}
      {releaseNotes && (state === "update-available" || state === "downloading" || state === "downloaded") && (
        <div className="mb-3 max-h-32 overflow-y-auto rounded-md border border-[var(--chassis)] bg-black/20 p-2 text-xs text-[var(--etch)] whitespace-pre-wrap">
          {releaseNotes}
        </div>
      )}

      {/* Action buttons — every transition requires an explicit click */}
      <div className="flex flex-wrap items-center gap-2">
        {(state === "idle" || state === "up-to-date" || state === "error") && (
          <Button variant="outline" size="sm" onClick={check} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            Check for updates
          </Button>
        )}
        {state === "unsupported" && (
          <Button variant="outline" size="sm" onClick={() => window.laralens.openExternal("https://github.com/RyderAsKing/LaraLens/releases")}>
            <ExternalLink />
            Open GitHub Releases
          </Button>
        )}
        {state === "update-available" && (
          <>
            <Button size="sm" onClick={download} disabled={busy}>
              {busy ? <Loader2 className="animate-spin" /> : <Download />}
              Download {updateLabel}
            </Button>
            <Button variant="outline" size="sm" onClick={check} disabled={busy}>
              Check again
            </Button>
          </>
        )}
        {state === "downloading" && (
          <Button size="sm" disabled>
            <Loader2 className="animate-spin" />
            Downloading {progress ?? 0}%
          </Button>
        )}
        {state === "downloaded" && (
          <Button size="sm" onClick={install} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : <RotateCcw />}
            Install &amp; restart
          </Button>
        )}
      </div>
    </div>
  );
}
