/**
 * ConsoleAnalyzer â€” discovers Artisan commands (class-based + closures) and
 * scheduled tasks from app/Console/Kernel.php.
 */
import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import { existsSync } from "node:fs";
import {
  parsePhp,
  extractUseMap,
  extractClasses,
  walkAst,
  callName,
  stringValue,
  isCall,
  callKind,
  callMethod,
  callReceiver,
  callArgs,
  classConstName,
} from "./php";
import { resolveFqcn } from "./psr4";
import type { ConsoleCommandDefinition, ScheduleEntry, Psr4Map } from "./types";

export async function analyzeConsole(
  projectRoot: string,
  psr4: Psr4Map
): Promise<{ commands: ConsoleCommandDefinition[]; schedules: ScheduleEntry[] }> {
  const commands: ConsoleCommandDefinition[] = [];
  const schedules: ScheduleEntry[] = [];

  // 1) Class-based commands in app/Console/Commands/**/*.php
  const cmdFiles = await fg(["app/Console/Commands/**/*.php"], {
    cwd: projectRoot,
    absolute: true,
    onlyFiles: true,
    ignore: ["**/vendor/**"],
  });

  for (const file of cmdFiles) {
    const source = await fs.readFile(file, "utf8").catch(() => "");
    if (!source) continue;
    const ast = parsePhp(source, file);
    if (!ast) continue;
    const classes = extractClasses(ast, file);
    for (const cls of classes) {
      const sigProp = cls.properties.find((p) => p.name === "signature");
      const descProp = cls.properties.find((p) => p.name === "description");
      const signature = stringValue(sigProp?.value) ?? "";
      const description = stringValue(descProp?.value) ?? undefined;
      if (!signature && !cls.extends) continue;
      commands.push({
        signature: signature || cls.name,
        description,
        class: cls.fqcn,
        file,
        source: "class",
      });
    }
  }

  // 2) Closure commands in routes/console.php (or console.php) via Artisan::command()
  const consoleRouteFiles = await fg(["routes/console.php", "console.php"], {
    cwd: projectRoot,
    absolute: true,
    onlyFiles: true,
  });
  for (const file of consoleRouteFiles) {
    const source = await fs.readFile(file, "utf8").catch(() => "");
    if (!source) continue;
    const ast = parsePhp(source, file);
    if (!ast) continue;
    const useMap = extractUseMap(ast);
    const namespace = getNs(ast);
    walkAst(ast.root, (node) => {
      if (!isCall(node)) return;
      if (callKind(node) !== "static") return;
      if (callReceiver(node) !== "Artisan") return;
      if (callMethod(node) !== "command") return;
      const args = callArgs(node);
      const signature = stringValue(args[0]);
      if (!signature) return;
      commands.push({
        signature,
        class: undefined,
        file,
        source: "closure",
      });
      void useMap;
      void namespace;
    });
  }

  // 3) Scheduled tasks in app/Console/Kernel.php schedule() method
  const kernelPath = path.join(projectRoot, "app/Console/Kernel.php");
  if (existsSync(kernelPath)) {
    await parseKernelSchedule(kernelPath, schedules, psr4);
  }

  return { commands, schedules };
}

async function parseKernelSchedule(
  file: string,
  schedules: ScheduleEntry[],
  psr4: Psr4Map
): Promise<void> {
  const source = await fs.readFile(file, "utf8").catch(() => "");
  if (!source) return;
  const ast = parsePhp(source, file);
  if (!ast) return;
  const classes = extractClasses(ast, file);
  for (const cls of classes) {
    const scheduleMethod = cls.methods.find((m) => m.name === "schedule" && m.body);
    if (!scheduleMethod?.body) continue;
    walkAst(scheduleMethod.body, (node) => {
      if (!isCall(node)) return;
      const kind = callKind(node);
      if (kind !== "method" && kind !== "static") return;
      const offsetName = callMethod(node);
      const args = callArgs(node);

      if (offsetName === "command") {
        const target = stringValue(args[0]) ?? classConstName(args[0]) ?? "";
        if (target) {
          const frequency = collectFrequency(node);
          schedules.push({ type: "command", target, frequency, file });
        }
      } else if (offsetName === "call") {
        const frequency = collectFrequency(node);
        schedules.push({ type: "closure", target: "closure", frequency, file });
      }
    });
  }
  void psr4;
}

/** Walk the chain of a $schedule->command()->...()->daily() call to find the frequency method. */
function collectFrequency(node: unknown): string {
  const offsetName = callMethod(node);
  const frequencyMethods = new Set([
    "everyMinute", "everyTwoMinutes", "everyThreeMinutes", "everyFiveMinutes",
    "everyTenMinutes", "everyFifteenMinutes", "everyThirtyMinutes", "hourly",
    "hourlyAt", "daily", "dailyAt", "twiceDaily", "weekly", "weeklyOn",
    "monthly", "monthlyOn", "twiceMonthly", "quarterly", "yearly", "cron",
  ]);
  if (frequencyMethods.has(offsetName)) return offsetName;
  let found = "";
  walkAst(node, (n) => {
    if (found) return;
    const name = callMethod(n);
    if (frequencyMethods.has(name)) found = name;
  });
  return found || "custom";
}

function getNs(ast: { root: unknown }): string {
  const children = (ast.root as { children?: unknown[] })?.children;
  if (!Array.isArray(children)) return "";
  for (const child of children) {
    if ((child as { kind?: string }).kind === "namespace") {
      const nameNode = (child as { name?: unknown }).name;
      if (typeof nameNode === "string") return nameNode;
      return callName(nameNode);
    }
  }
  return "";
}

// Re-export for index use.
export { resolveFqcn };
