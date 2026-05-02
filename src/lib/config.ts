import fs from "fs";
import path from "path";
import type {
  ProjectConfig,
  PillarsConfig,
  VoiceConfig,
  ImagePromptsConfig,
  AccountsConfig,
  TokenConfig,
} from "@/types";

// ============================================================
// PROJECT CONFIG LOADER
// ============================================================
// Reads /config/${PROJECT}/* once at first call and caches.
// PROJECT env var defaults to "spurdo" — set differently per deployment
// to host other character projects from this codebase.
// ============================================================

let _cached: ProjectConfig | null = null;

function readJson<T>(filepath: string): T {
  const raw = fs.readFileSync(filepath, "utf-8");
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new Error(`Failed to parse JSON config at ${filepath}: ${err}`);
  }
}

function readMarkdown(filepath: string): string {
  return fs.readFileSync(filepath, "utf-8");
}

export function loadConfig(): ProjectConfig {
  if (_cached) return _cached;

  const projectId = process.env.PROJECT || "spurdo";
  const configRoot = path.join(process.cwd(), "config", projectId);

  if (!fs.existsSync(configRoot)) {
    throw new Error(
      `Config directory not found: ${configRoot}. Set the PROJECT env var to a folder name under /config.`
    );
  }

  const character = readMarkdown(path.join(configRoot, "character.md"));
  const pillars = readJson<PillarsConfig>(path.join(configRoot, "pillars.json"));
  const voice = readJson<VoiceConfig>(path.join(configRoot, "voice.json"));
  const imagePrompts = readJson<ImagePromptsConfig>(
    path.join(configRoot, "image-prompts.json")
  );
  const accounts = readJson<AccountsConfig>(path.join(configRoot, "accounts.json"));
  const token = readJson<TokenConfig>(path.join(configRoot, "token.json"));

  _cached = {
    projectId,
    character,
    pillars,
    voice,
    imagePrompts,
    accounts,
    token,
  };

  return _cached;
}

/** KV namespace prefix — all KV keys are prefixed with `${PROJECT}:` */
export function kvKey(suffix: string): string {
  const projectId = process.env.PROJECT || "spurdo";
  return `${projectId}:${suffix}`;
}

/** Reset the cache. Useful in tests or for hot-reloading config in dev. */
export function resetConfigCache(): void {
  _cached = null;
}
