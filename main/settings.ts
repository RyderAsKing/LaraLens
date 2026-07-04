import Store from "electron-store";

export interface ModelSelection {
  providerID: string;
  modelID: string;
}

export interface SettingsModel {
  id: string;
  providerID: string;
  name: string;
  status: string;
  contextLimit: number;
  outputLimit: number;
  supportsTools: boolean;
  supportsReasoning: boolean;
}

export interface SettingsProvider {
  id: string;
  name: string;
  source: string;
  models: SettingsModel[];
}

export interface SettingsAgent {
  name: string;
  description?: string;
  mode: string;
  builtIn: boolean;
  color?: string;
  model?: ModelSelection;
}

export interface LaraLensSettings {
  /** Null means let OpenCode use its own configured/default agent. */
  defaultAgent: string | null;
  /** Null means auto-pick an available model when OpenCode requires one. */
  defaultModel: ModelSelection | null;
}

type SettingsStore = {
  defaultAgent: string | null;
  defaultModel: ModelSelection | null;
  /** Last successfully fetched provider/model catalog (may be empty offline). */
  cachedProviders: SettingsProvider[];
  /** Last successfully fetched agent catalog (subagents already filtered out). */
  cachedAgents: SettingsAgent[];
};

const store = new Store<SettingsStore>({
  name: "settings",
  defaults: {
    defaultAgent: null,
    defaultModel: null,
    cachedProviders: [],
    cachedAgents: [],
  },
});

export function getSettings(): LaraLensSettings {
  return {
    defaultAgent: normalizeAgent(store.get("defaultAgent")),
    defaultModel: normalizeModel(store.get("defaultModel")),
  };
}

export function updateSettings(patch: Partial<LaraLensSettings>): LaraLensSettings {
  if ("defaultAgent" in patch) {
    store.set("defaultAgent", normalizeAgent(patch.defaultAgent));
  }
  if ("defaultModel" in patch) {
    store.set("defaultModel", normalizeModel(patch.defaultModel));
  }
  return getSettings();
}

/** Persist the last fetched provider/agent catalog so settings can be shown
 *  even when OpenCode is not connected yet. Subagents should already be
 *  filtered out of `agents` before this is called. */
export function cacheCatalog(
  providers: SettingsProvider[],
  agents: SettingsAgent[]
): void {
  store.set("cachedProviders", providers);
  store.set("cachedAgents", agents);
}

export function getCachedCatalog(): {
  providers: SettingsProvider[];
  agents: SettingsAgent[];
} {
  return {
    providers: store.get("cachedProviders") ?? [],
    agents: store.get("cachedAgents") ?? [],
  };
}

/**
 * If the saved defaultAgent is no longer in the cached selectable agent list
 * (e.g. it's a subagent that was filtered out, or it was removed server-side),
 * clear it so chat sends don't pass a stale/invalid agent name. Returns the
 * normalized settings (and persists the change if a reset happened).
 */
export function reconcileSavedAgentAgainstCatalog(
  selectableAgentNames: Set<string>
): LaraLensSettings {
  const current = getSettings();
  if (
    current.defaultAgent &&
    selectableAgentNames.size > 0 &&
    !selectableAgentNames.has(current.defaultAgent)
  ) {
    store.set("defaultAgent", null);
    return { ...current, defaultAgent: null };
  }
  return current;
}

function normalizeAgent(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeModel(value: unknown): ModelSelection | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<ModelSelection>;
  if (typeof candidate.providerID !== "string" || typeof candidate.modelID !== "string") {
    return null;
  }
  const providerID = candidate.providerID.trim();
  const modelID = candidate.modelID.trim();
  if (!providerID || !modelID) return null;
  return { providerID, modelID };
}