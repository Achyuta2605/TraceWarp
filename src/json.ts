/**
 * JSON helpers shared by recording, replay matching and diffing.
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Stable JSON: object keys sorted, so two equal values always serialise the same way. */
export function canonical(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

/** Flattens a value into path → leaf pairs, e.g. {a: {b: [1]}} → {"a.b[0]": 1}. */
export function flatten(value: unknown, prefix = "", out: Map<string, unknown> = new Map()): Map<string, unknown> {
  if (Array.isArray(value)) {
    if (value.length === 0) out.set(prefix, []);
    value.forEach((v, i) => {
      flatten(v, `${prefix}[${i}]`, out);
    });
  } else if (value && typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length === 0) out.set(prefix, {});
    for (const key of keys) flatten((value as Record<string, unknown>)[key], prefix ? `${prefix}.${key}` : key, out);
  } else {
    out.set(prefix, value);
  }
  return out;
}

export interface PathChange {
  path: string;
  before?: unknown;
  after?: unknown;
}

/** Leaf-level differences between two values. Paths present on only one side have one of before/after missing. */
export function jsonChanges(before: unknown, after: unknown): PathChange[] {
  const a = flatten(before);
  const b = flatten(after);
  const changes: PathChange[] = [];
  for (const [path, v] of a) {
    if (!b.has(path)) changes.push({ path, before: v });
    else if (!deepEqual(v, b.get(path))) changes.push({ path, before: v, after: b.get(path) });
  }
  for (const [path, v] of b) if (!a.has(path)) changes.push({ path, after: v });
  return changes;
}

/** Similarity of two strings in [0, 1]: edit distance for short strings, word overlap for long ones. */
export function textSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  if (x === y) return 1;
  if (!x.length || !y.length) return 0;
  if (x.length <= 400 && y.length <= 400) {
    return 1 - levenshtein(x, y) / Math.max(x.length, y.length);
  }
  return jaccard(words(x), words(y));
}

function words(s: string): Set<string> {
  return new Set(s.split(/[^\p{L}\p{N}_./-]+/u).filter(Boolean));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 1;
  let both = 0;
  for (const w of a) if (b.has(w)) both++;
  return both / (a.size + b.size - both);
}

function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min((prev[j] as number) + 1, (cur[j - 1] as number) + 1, (prev[j - 1] as number) + cost);
    }
    prev = cur;
  }
  return prev[b.length] as number;
}

/**
 * How alike two tool inputs are, in [0, 1]. Every leaf path counts once; a path on one side only scores 0.
 * Prose strings score by text similarity; numbers and identifier-like strings (ids, codes, paths) must match
 * exactly, because "order 1001" and "order 1002" are different calls however alike they look.
 */
export function inputSimilarity(a: unknown, b: unknown): number {
  const x = flatten(a);
  const y = flatten(b);
  const paths = new Set([...x.keys(), ...y.keys()]);
  if (paths.size === 0) return 1;
  let total = 0;
  for (const path of paths) {
    if (!x.has(path) || !y.has(path)) continue;
    total += leafSimilarity(x.get(path), y.get(path));
  }
  return total / paths.size;
}

function leafSimilarity(a: unknown, b: unknown): number {
  if (deepEqual(a, b)) return 1;
  if (typeof a === "string" && typeof b === "string") {
    if (isIdentifier(a) || isIdentifier(b)) return sameIdentifier(a, b) ? 1 : 0;
    return textSimilarity(a, b);
  }
  return 0;
}

/** Identifiers compare exactly, apart from the spelling of a relative path ("./src/a.ts" = "src/a.ts"). */
function sameIdentifier(a: string, b: string): boolean {
  const norm = (s: string) =>
    s
      .trim()
      .replace(/^(\.\/)+/, "")
      .replace(/\/+$/, "");
  return norm(a) === norm(b);
}

/** One token with a digit or a path/URL separator in it: R-500, 2026-11-24, ord_8f2a, runbooks/high-latency.md. */
export function isIdentifier(s: string): boolean {
  const t = s.trim();
  return t.length > 0 && !/\s/.test(t) && (/\d/.test(t) || /[/\\:]/.test(t) || /\.[a-z0-9]+$/i.test(t));
}

/**
 * The checkable details in an answer: numbers, codes and names with separators (R-500, checkout-api,
 * policies/retry-policy.md). Two answers that agree on these usually agree in substance even when the wording
 * differs, which plain text similarity cannot tell.
 */
export function keyFacts(text: string): Set<string> {
  const found = text.toLowerCase().match(/[a-z0-9]+(?:[-_./:][a-z0-9]+)+|\d+(?:[.,]\d+)?/g) ?? [];
  return new Set(found.map((f) => f.replace(/\.(md|txt|json|ya?ml)$/, "").replace(/,/g, "")));
}

/** Share of key facts the two sets have in common (1 when neither has any). */
export function overlap(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 1;
  let both = 0;
  for (const x of a) if (b.has(x)) both++;
  return both / (a.size + b.size - both);
}
