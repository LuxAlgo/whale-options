/*
  Config loading: whale.config.{ts,mts,js,mjs,json} in the working directory
  (or --config <path>). TS/JS configs load through jiti so users get typed
  configs via defineConfig without a build step; secrets stay in env vars.
*/
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { resolveConfig, type WhaleConfig } from "@luxalgo/whale-core";
import { createJiti } from "jiti";

const CANDIDATES = [
  "whale.config.ts",
  "whale.config.mts",
  "whale.config.js",
  "whale.config.mjs",
  "whale.config.json",
];

export interface LoadedConfig {
  config: WhaleConfig;
  /** Path the config was loaded from; null when running on pure defaults. */
  path: string | null;
}

export async function loadConfig(
  explicitPath?: string,
  cwd = process.cwd(),
): Promise<LoadedConfig> {
  let path: string | null = null;
  if (explicitPath) {
    path = isAbsolute(explicitPath) ? explicitPath : resolve(cwd, explicitPath);
    if (!existsSync(path)) throw new Error(`config file not found: ${path}`);
  } else {
    for (const candidate of CANDIDATES) {
      const full = resolve(cwd, candidate);
      if (existsSync(full)) {
        path = full;
        break;
      }
    }
  }

  if (path === null) return { config: resolveConfig({}), path: null };

  if (path.endsWith(".json")) {
    return { config: resolveConfig(JSON.parse(readFileSync(path, "utf8"))), path };
  }

  const jiti = createJiti(import.meta.url);
  const mod = (await jiti.import(path)) as { default?: unknown } | unknown;
  const input = (mod as { default?: unknown }).default ?? mod;
  return { config: resolveConfig(input), path };
}

export interface CommonFlags {
  config?: string;
  feed?: string;
  tickers?: string;
  db?: string;
  minPremium?: string;
  seed?: string;
  regime?: string;
  port?: string;
}

/** Apply CLI flag overrides on top of a resolved config (flags win). */
export function applyOverrides(config: WhaleConfig, flags: CommonFlags): WhaleConfig {
  if (flags.feed) config.feed.id = flags.feed as WhaleConfig["feed"]["id"];
  if (flags.tickers) {
    config.universe.underlyings = flags.tickers
      .split(",")
      .map((t) => t.trim().toUpperCase())
      .filter(Boolean);
  }
  if (flags.db) config.store.path = flags.db;
  if (flags.minPremium !== undefined) {
    const n = Number(flags.minPremium);
    if (Number.isFinite(n) && n >= 0) config.engine.emit.minPremium = n;
  }
  if (flags.seed !== undefined) {
    const n = Number(flags.seed);
    if (Number.isInteger(n)) config.feed.synthetic.seed = n;
  }
  if (flags.regime) {
    config.feed.synthetic.regime = flags.regime as WhaleConfig["feed"]["synthetic"]["regime"];
  }
  if (flags.port !== undefined) {
    const n = Number(flags.port);
    if (Number.isInteger(n) && n > 0 && n < 65536) config.server.port = n;
  }
  return config;
}
