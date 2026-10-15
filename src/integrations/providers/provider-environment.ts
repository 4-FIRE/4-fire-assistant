import type { Provider } from "../../model/provider.js";
import { json, object, type Json } from "../../common/json.js";
import { requireThat } from "../../common/validation.js";

export function expand(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    const found = process.env[name]; requireThat(found !== undefined, "能力提供方所需环境变量未设置。"); return found;
  });
}
export function environment(provider: Provider) {
  return Object.fromEntries(Object.entries(provider.env ?? {}).map(([key, value]) => [key, expand(value)]));
}
export function payload(value: unknown): Json {
  if (object(value)) {
    if (value.structuredContent !== undefined) return json(value.structuredContent);
    if (Array.isArray(value.content)) {
      const texts = value.content.filter(p => object(p) && p.type === "text").map(p => p.text);
      if (texts.length === 1) { try { return json(JSON.parse(texts[0])); } catch { /* Retain native content. */ } }
    }
  }
  return json(value);
}
