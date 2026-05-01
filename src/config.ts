import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { FarmConfig } from "./types.js";

export function loadConfig(args: string[]): FarmConfig {
  const configArg = valueAfter(args, "--config") ?? "config.json";
  const configPath = resolve(process.cwd(), configArg);

  if (!existsSync(configPath)) {
    throw new Error(
      `Missing ${configPath}. Copy config.example.json to config.json and edit it.`,
    );
  }

  return JSON.parse(readFileSync(configPath, "utf-8")) as FarmConfig;
}

export function valueAfter(args: string[], name: string): string | undefined {
  const equals = args.find((arg) => arg.startsWith(`${name}=`));
  if (equals) return equals.slice(name.length + 1);

  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1];
}

export function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}
