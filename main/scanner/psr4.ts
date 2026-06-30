/**
 * Composer analyzer + PSR-4 resolver.
 * Reads composer.json to build the autoload map, and resolves FQCNs to file paths.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import type { ComposerInfo, Psr4Map } from "./types";

export async function readComposer(projectRoot: string): Promise<ComposerInfo | null> {
  const composerPath = path.join(projectRoot, "composer.json");
  try {
    const raw = await fs.readFile(composerPath, "utf8");
    const json = JSON.parse(raw) as {
      name?: string;
      autoload?: { "psr-4"?: Psr4Map };
      "autoload-dev"?: { "psr-4"?: Psr4Map };
      require?: Record<string, string>;
      "require-dev"?: Record<string, string>;
    };
    const normalize = (map?: Psr4Map): Psr4Map => {
      const result: Psr4Map = {};
      if (!map) return result;
      for (const [prefix, dirs] of Object.entries(map)) {
        const arr = Array.isArray(dirs) ? dirs : [dirs as unknown as string];
        result[prefix] = arr
          .map((d) => path.resolve(projectRoot, d))
          .filter((d) => existsSync(d));
      }
      return result;
    };
    return {
      name: json.name ?? path.basename(projectRoot),
      psr4: normalize(json.autoload?.["psr-4"]),
      devPsr4: normalize(json["autoload-dev"]?.["psr-4"]),
      require: json.require ?? {},
      requireDev: json["require-dev"] ?? {},
    };
  } catch {
    return null;
  }
}

/** Resolve a FQCN to a candidate absolute file path using the PSR-4 map. */
export function resolveFqcn(
  fqcn: string,
  psr4: Psr4Map,
  devPsr4: Psr4Map = {}
): string | null {
  if (!fqcn) return null;
  const all = { ...psr4, ...devPsr4 };
  // Match the longest namespace prefix.
  const prefixes = Object.keys(all).sort((a, b) => b.length - a.length);
  for (const prefix of prefixes) {
    if (fqcn.startsWith(prefix)) {
      const rest = fqcn.slice(prefix.length);
      const rel = rest.replace(/\\/g, "/") + ".php";
      for (const dir of all[prefix]!) {
        const candidate = path.join(dir, rel);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
}
