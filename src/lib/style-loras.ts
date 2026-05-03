import { Redis } from "@upstash/redis";
import { kvKey, loadConfig } from "./config";
import type { StackedLora } from "@/types";

// ============================================================
// STYLE LORA RUNTIME REGISTRY
// ============================================================
// Style LoRAs (the ones that define visual aesthetic, like MS Paint
// or doodle, as distinct from identity LoRAs that define a character)
// have two sources:
//
//   1. CONFIG DEFAULTS — listed in image-prompts.json under
//      stackConfig.defaultStyleLoras. Set at deploy time. Required
//      for projects that haven't been touched in /bot.
//
//   2. RUNTIME OVERRIDES — managed via /bot Style LoRA panel. Stored
//      in KV under ${PROJECT}:style-loras:active. When set, REPLACES
//      the config defaults entirely (not merged) — this lets operators
//      experiment with different style LoRAs without redeploying and
//      without losing the "what's my known-good baseline" property of
//      the config.
//
// To revert to config defaults: clear the KV value via the dashboard
// "revert to config defaults" button.
// ============================================================

let _redis: Redis | null = null;
function r(): Redis {
  if (_redis) return _redis;
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("KV not configured");
  _redis = new Redis({ url, token });
  return _redis;
}

const KEY = () => kvKey("style-loras:active");

/**
 * Get the runtime override list, or null if no override is set
 * (caller should fall back to config defaults).
 */
export async function getRuntimeStyleLoras(): Promise<StackedLora[] | null> {
  try {
    const raw = await r().get<string | StackedLora[]>(KEY());
    if (!raw) return null;
    if (typeof raw === "string") {
      try {
        return JSON.parse(raw) as StackedLora[];
      } catch {
        return null;
      }
    }
    return raw;
  } catch {
    return null;
  }
}

/**
 * Set the runtime override list. Pass an empty array to disable all
 * style LoRAs at runtime (different from null — null means "use config
 * defaults," empty array means "use no style LoRAs").
 */
export async function setRuntimeStyleLoras(loras: StackedLora[]): Promise<void> {
  // Validate: all entries must have a non-empty https URL
  const validated = loras.filter((l) => typeof l.url === "string" && /^https?:\/\//.test(l.url));
  await r().set(KEY(), JSON.stringify(validated));
}

/** Clear the runtime override entirely. Caller falls back to config defaults. */
export async function clearRuntimeStyleLoras(): Promise<void> {
  await r().del(KEY());
}

/**
 * Resolve the style LoRAs to actually use, applying override-or-defaults logic.
 * Used by the image-gen dispatcher.
 */
export async function resolveStyleLoras(): Promise<{ loras: StackedLora[]; source: "runtime" | "config" }> {
  const runtime = await getRuntimeStyleLoras();
  if (runtime !== null) {
    return { loras: runtime, source: "runtime" };
  }
  const cfg = loadConfig();
  const sc = cfg.imagePrompts.stackConfig;
  if (sc?.stack === "sdxl-stylized" && sc.defaultStyleLoras) {
    return { loras: sc.defaultStyleLoras, source: "config" };
  }
  return { loras: [], source: "config" };
}
