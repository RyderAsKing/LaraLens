"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Bot, Cpu, Loader2, RefreshCw, Save, Settings, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
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
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <div className="flex max-h-[86vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-[var(--chassis)] bg-[var(--void)] shadow-2xl">
        <header className="flex items-start justify-between gap-4 border-b border-[var(--chassis)] px-5 py-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Settings className="h-4 w-4 text-[var(--aperture)]" />
              <h2 id="settings-title" className="text-base font-semibold text-[var(--flare)]">
                LaraLens Settings
              </h2>
            </div>
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

          <div className="grid gap-4 lg:grid-cols-2">
            <section className="rounded-lg border border-[var(--chassis)] bg-[var(--optic)] p-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 text-sm font-semibold text-[var(--flare)]">
                    <Cpu className="h-4 w-4 text-[var(--aperture)]" />
                    Default model
                  </div>
                  <p className="mt-1 text-xs text-[var(--etch)]">
                    {providers.length} providers · {modelCount} models
                  </p>
                </div>
              </div>

              <label className="block text-xs font-semibold uppercase tracking-wide text-[var(--etch)]" htmlFor="default-model">
                Model
              </label>
              <select
                id="default-model"
                value={selectedModel}
                onChange={(event) => setSelectedModel(event.target.value)}
                disabled={loading}
                className="mt-2 w-full rounded-md border border-[var(--chassis)] bg-[var(--void)] px-3 py-2 text-sm text-[var(--flare)] outline-none transition-colors focus:border-[var(--aperture)] focus:ring-2 focus:ring-[var(--aperture)]/30 disabled:opacity-60"
              >
                <option value="">Auto / OpenCode default</option>
                {selectedModel && !knownModelSelected && settings.defaultModel && (
                  <option value={selectedModel}>{modelLabel(settings.defaultModel)} (saved)</option>
                )}
                {providers.map((provider) => (
                  <optgroup key={provider.id} label={`${provider.name} (${provider.source})`}>
                    {provider.models.map((model) => (
                      <option key={`${provider.id}:${model.id}`} value={modelKey(model)}>
                        {model.name} — {model.id}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </section>

            <section className="rounded-lg border border-[var(--chassis)] bg-[var(--optic)] p-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 text-sm font-semibold text-[var(--flare)]">
                    <Bot className="h-4 w-4 text-[var(--aperture)]" />
                    Default agent
                  </div>
                  <p className="mt-1 text-xs text-[var(--etch)]">
                    {selectableAgents.length} agents available
                  </p>
                </div>
              </div>

              <label className="block text-xs font-semibold uppercase tracking-wide text-[var(--etch)]" htmlFor="default-agent">
                Agent
              </label>
              <select
                id="default-agent"
                value={selectedAgent}
                onChange={(event) => setSelectedAgent(event.target.value)}
                disabled={loading}
                className="mt-2 w-full rounded-md border border-[var(--chassis)] bg-[var(--void)] px-3 py-2 text-sm text-[var(--flare)] outline-none transition-colors focus:border-[var(--aperture)] focus:ring-2 focus:ring-[var(--aperture)]/30 disabled:opacity-60"
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
            </section>
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <CatalogPanel title="Providers and models" empty="No providers loaded yet.">
              {providers.map((provider) => (
                <div key={provider.id} className="rounded-md border border-[var(--chassis)]/80 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-[var(--flare)]">{provider.name}</div>
                      <div className="truncate font-mono text-[11px] text-[var(--etch)]">{provider.id}</div>
                    </div>
                    <span className="rounded border border-[var(--chassis)] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[var(--etch)]">
                      {provider.source}
                    </span>
                  </div>
                  <div className="mt-2 space-y-1.5">
                    {provider.models.map((model) => (
                      <div key={model.id} className="rounded bg-[var(--void)]/70 px-2 py-1.5">
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-xs font-medium text-[var(--flare)]">{model.name}</span>
                          <span className="shrink-0 text-[10px] text-[var(--etch)]">{model.status}</span>
                        </div>
                        <div className="mt-0.5 truncate font-mono text-[10px] text-[var(--etch)]">
                          {model.id} · ctx {formatCompact(model.contextLimit)} · out {formatCompact(model.outputLimit)}
                          {model.supportsTools ? " · tools" : ""}{model.supportsReasoning ? " · reasoning" : ""}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </CatalogPanel>

            <CatalogPanel title="Agents" empty="No agents loaded yet.">
              {selectableAgents.map((agent) => (
                <div key={agent.name} className="rounded-md border border-[var(--chassis)]/80 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: agent.color || "var(--aperture)" }}
                      />
                      <span className="truncate text-sm font-medium text-[var(--flare)]">{agent.name}</span>
                    </div>
                    <span className={cn("rounded border border-[var(--chassis)] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[var(--etch)]", agent.builtIn && "text-[var(--aperture)]")}>
                      {agent.mode}
                    </span>
                  </div>
                  {agent.description && (
                    <p className="mt-2 line-clamp-3 text-xs leading-relaxed text-[var(--etch)]">{agent.description}</p>
                  )}
                  {agent.model && (
                    <div className="mt-2 truncate font-mono text-[10px] text-[var(--etch)]">
                      model {agent.model.providerID}/{agent.model.modelID}
                    </div>
                  )}
                </div>
              ))}
            </CatalogPanel>
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

function CatalogPanel({
  title,
  empty,
  children,
}: {
  title: string;
  empty: string;
  children: React.ReactNode;
}) {
  const hasChildren = Array.isArray(children) ? children.length > 0 : Boolean(children);
  return (
    <section className="rounded-lg border border-[var(--chassis)] bg-[var(--optic)] p-4">
      <h3 className="text-sm font-semibold text-[var(--flare)]">{title}</h3>
      <div className="mt-3 max-h-72 space-y-2 overflow-y-auto pr-1">
        {hasChildren ? children : <p className="text-sm text-[var(--etch)]">{empty}</p>}
      </div>
    </section>
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

function formatCompact(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "?";
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`;
  if (value >= 1_000) return `${Math.round(value / 100) / 10}K`;
  return String(value);
}
