/*
 * Peeky i18n layer (zh / ja / en, default = system locale).
 *
 * Contract (per the frontend CONTRACT):
 *   - initI18n(): Promise<void>   resolve the active language and load its JSON.
 *   - t(key, vars?): string       lookup + {var} interpolation, fallback en -> key.
 *   - setLanguage(lang): Promise   persist + re-render (Config.language).
 *   - getLang(): string           current resolved code ("en" | "zh" | "ja").
 *
 * Language resolution:
 *   Config.language === "auto"  -> invoke("get_system_locale") -> "zh"|"ja"|"en"
 *   otherwise use the configured language directly.
 *
 * All three JSON files share an identical key set; `en` is the fallback table so
 * a missing key in zh/ja degrades gracefully instead of showing nothing.
 */

import { invoke } from "@tauri-apps/api/core";

import en from "./en.json";
import zh from "./zh.json";
import ja from "./ja.json";

export type ResolvedLang = "en" | "zh" | "ja";
export type LangSetting = "auto" | ResolvedLang;

type Dict = Record<string, string>;

const TABLES: Record<ResolvedLang, Dict> = {
  en: en as Dict,
  zh: zh as Dict,
  ja: ja as Dict,
};

// English is the universal fallback table.
const FALLBACK: Dict = en as Dict;

/** Current resolved language code; defaults to English until initI18n runs. */
let current: ResolvedLang = "en";

/** Subscribers notified whenever the language changes (e.g. settings re-render). */
const listeners = new Set<() => void>();

/** Normalize anything (locale string / setting) to a concrete table key. */
function normalize(code: string): ResolvedLang {
  const lc = code.toLowerCase();
  if (lc.startsWith("zh")) return "zh";
  if (lc.startsWith("ja")) return "ja";
  return "en";
}

/**
 * Resolve the active language:
 *  - read Config.language via get_config;
 *  - if "auto" (or anything unexpected), ask the backend for the system locale.
 * Never throws — falls back to English on any IPC failure.
 */
async function resolveLanguage(): Promise<ResolvedLang> {
  let setting: LangSetting = "auto";
  try {
    const cfg = await invoke<{ language?: LangSetting }>("get_config");
    if (cfg && typeof cfg.language === "string") {
      setting = cfg.language;
    }
  } catch {
    // Config not available yet — fall through to locale detection.
  }

  if (setting === "en" || setting === "zh" || setting === "ja") {
    return setting;
  }

  // "auto": resolve from system locale.
  try {
    const locale = await invoke<string>("get_system_locale");
    if (typeof locale === "string" && locale.length > 0) {
      return normalize(locale);
    }
  } catch {
    // ignore — default below
  }
  return "en";
}

/** Resolve + activate the language. Call once at startup, before rendering UI. */
export async function initI18n(): Promise<void> {
  current = await resolveLanguage();
}

/**
 * Translate `key`, interpolating `{name}` placeholders from `vars`.
 * Lookup order: active table -> English fallback -> the key itself.
 */
export function t(key: string, vars?: Record<string, string>): string {
  const table = TABLES[current] ?? FALLBACK;
  let str = table[key];
  if (str === undefined) str = FALLBACK[key];
  if (str === undefined) return key;

  if (vars) {
    str = str.replace(/\{(\w+)\}/g, (_m, name: string) =>
      Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : `{${name}}`,
    );
  }
  return str;
}

/** The current resolved language code. */
export function getLang(): ResolvedLang {
  return current;
}

/**
 * Persist a new language choice into Config and re-activate it.
 * `"auto"` re-resolves from the system locale. Notifies listeners so open UI
 * (e.g. the settings panel) can re-render labels.
 */
export async function setLanguage(lang: LangSetting): Promise<void> {
  // Persist into Config (best-effort: read-modify-write).
  try {
    const cfg = await invoke<Record<string, unknown>>("get_config");
    cfg.language = lang;
    await invoke("set_config", { config: cfg });
  } catch {
    // If persistence fails we still update the in-memory language so the UI
    // reflects the user's choice immediately.
  }

  if (lang === "en" || lang === "zh" || lang === "ja") {
    current = lang;
  } else {
    try {
      const locale = await invoke<string>("get_system_locale");
      current = normalize(locale ?? "en");
    } catch {
      current = "en";
    }
  }

  for (const fn of listeners) {
    try {
      fn();
    } catch {
      // a misbehaving listener must not break others
    }
  }
}

/** Subscribe to language changes; returns an unsubscribe function. */
export function onLanguageChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
