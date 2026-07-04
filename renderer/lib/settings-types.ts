export interface ModelSelection {
  providerID: string;
  modelID: string;
}

export interface LaraLensSettings {
  defaultAgent: string | null;
  defaultModel: ModelSelection | null;
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

export interface SettingsOptionsResult {
  ok: boolean;
  settings: LaraLensSettings;
  providers: SettingsProvider[];
  agents: SettingsAgent[];
  error?: string;
}
