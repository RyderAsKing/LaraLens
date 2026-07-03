/**
 * Prompt presets for the chat composer — quick-start prompts tailored for
 * Laravel project analysis via OpenCode. Each preset has a short label and
 * a full prompt that gets inserted into the composer input.
 */

export interface ChatPreset {
  /** Short label shown on the quick-action button. */
  label: string;
  /** Full prompt text inserted into the composer. */
  prompt: string;
}

export const CHAT_PRESETS: readonly ChatPreset[] = [
  {
    label: "Explain project",
    prompt:
      "Give me a high-level overview of this Laravel project. What is its purpose, what are the main domain areas, and how is the codebase organized?",
  },
  {
    label: "Routes summary",
    prompt:
      "List all the API and web routes in this project, grouped by middleware group. For each group, summarize the main controllers and methods involved.",
  },
  {
    label: "Models & relations",
    prompt:
      "List every Eloquent model in this project and describe the relationships (hasMany, belongsTo, etc.) between them. Output as a structured list.",
  },
  {
    label: "Find entry points",
    prompt:
      "What are the main entry points of this application? Identify the service providers, the route bootstrap, and any console kernels or scheduled commands.",
  },
  {
    label: "Audit config",
    prompt:
      "Review the configuration files (config/*.php) and env example. Point out any security concerns, deprecated settings, or unusual configurations.",
  },
  {
    label: "Code quality",
    prompt:
      "Do a quick code quality pass: identify any obvious anti-patterns, N+1 query risks in controllers, missing validation, or inconsistencies in naming conventions.",
  },
] as const;
