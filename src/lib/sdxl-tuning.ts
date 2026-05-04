import { Redis } from "@upstash/redis";
import { kvKey } from "./config";

// ============================================================
// SDXL RUNTIME TUNING
// ============================================================
// After running the calibration sweep, the operator picks winning
// values for `loraScale` and `guidanceScale`. Those values get saved
// here in KV — the SDXL gen path checks this store first and falls
// back to image-prompts.json defaults if nothing's set.
//
// This avoids needing to redeploy after every calibration. Operators
// can re-calibrate later (e.g. after re-training the LoRA) by re-
// running the sweep and overwriting these values.
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

const KEY = () => kvKey("sdxl:tuning");

export interface SdxlTuning {
  loraScale: number;
  guidanceScale: number;
  /** When this tuning was saved (ISO string) */
  setAt: string;
  /** Optional notes from the calibration run (seed, sample prompt, etc) */
  notes?: string;
}

export async function getSdxlTuning(): Promise<SdxlTuning | null> {
  try {
    const value = await r().get<SdxlTuning>(KEY());
    return value ?? null;
  } catch {
    return null;
  }
}

export async function setSdxlTuning(tuning: SdxlTuning): Promise<void> {
  await r().set(KEY(), tuning);
}

export async function clearSdxlTuning(): Promise<void> {
  await r().del(KEY());
}
