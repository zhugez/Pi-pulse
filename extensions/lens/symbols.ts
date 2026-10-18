import { createHash } from "node:crypto";

export interface CodeSymbol {
  name: string;
  kind: "function" | "class" | "interface" | "type" | "variable" | "method";
  line: number;
  signature: string;
  isExported: boolean;
}

const TS_JS_PATTERNS = [
  // export function / function
  {
    regex: /^(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*(\([^)]*\))/,
    kind: "function" as const,
  },
  // export class / class
  {
    regex: /^(?:export\s+(?:default\s+)?)?class\s+([A-Za-z0-9_$]+)(?:\s+extends|\s+implements|\s*\{)/,
    kind: "class" as const,
  },
  // export interface
  {
    regex: /^(?:export\s+)?interface\s+([A-Za-z0-9_$]+)(?:<[^>]+>)?(?:\s+extends|\s*\{)/,
    kind: "interface" as const,
  },
  // export type
  {
    regex: /^(?:export\s+)?type\s+([A-Za-z0-9_$]+)(?:<[^>]+>)?\s*=/,
    kind: "type" as const,
  },
  // export const/let arrow or declaration
  {
    regex: /^(?:export\s+)(?:const|let|var)\s+([A-Za-z0-9_$]+)(?:\s*:\s*[^=]+)?\s*=/,
    kind: "variable" as const,
  },
];

const PYTHON_PATTERNS = [
  {
    regex: /^(?:async\s+)?def\s+([A-Za-z0-9_]+)\s*(\([^)]*\))/,
    kind: "function" as const,
  },
  {
    regex: /^class\s+([A-Za-z0-9_]+)(?:\([^)]*\))?:/,
    kind: "class" as const,
  },
];

const GO_PATTERNS = [
  {
    regex: /^func\s+(?:\([^)]+\)\s+)?([A-Za-z0-9_]+)\s*(\([^)]*\))/,
    kind: "function" as const,
  },
  {
    regex: /^type\s+([A-Za-z0-9_]+)\s+struct/,
    kind: "class" as const,
  },
  {
    regex: /^type\s+([A-Za-z0-9_]+)\s+interface/,
    kind: "interface" as const,
  },
];

const RUST_PATTERNS = [
  {
    regex: /^(?:pub\s+(?:\([^)]+\)\s+)?)?(?:async\s+)?fn\s+([A-Za-z0-9_]+)\s*(\([^)]*\))/,
    kind: "function" as const,
  },
  {
    regex: /^(?:pub\s+)?struct\s+([A-Za-z0-9_]+)/,
    kind: "class" as const,
  },
  {
    regex: /^(?:pub\s+)?trait\s+([A-Za-z0-9_]+)/,
    kind: "interface" as const,
  },
  {
    regex: /^(?:pub\s+)?enum\s+([A-Za-z0-9_]+)/,
    kind: "type" as const,
  },
];

// Bounded LRU cache for symbols (max 128 items)
const SYMBOLS_CACHE_LIMIT = 128;
const symbolsCache = new Map<string, CodeSymbol[]>();

function contentHash(filePath: string, content: string): string {
  return createHash("sha256").update(filePath).update("\0").update(content).digest("hex");
}

export function extractSymbols(sourceText: string, filePath: string): CodeSymbol[] {
  const hash = contentHash(filePath, sourceText);
  const cached = symbolsCache.get(hash);
  if (cached !== undefined) {
    // True LRU promotion: refresh position on hit
    symbolsCache.delete(hash);
    symbolsCache.set(hash, cached);
    return cached;
  }

  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  const lines = sourceText.split(/\r?\n/);
  const symbols: CodeSymbol[] = [];

  let patterns = TS_JS_PATTERNS;
  if (ext === ".py") patterns = PYTHON_PATTERNS;
  else if (ext === ".go") patterns = GO_PATTERNS;
  else if (ext === ".rs") patterns = RUST_PATTERNS;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("/*") || trimmed.startsWith("*")) {
      continue;
    }

    const isExported = rawLine.startsWith("export ") || rawLine.startsWith("pub ");

    for (const pattern of patterns) {
      const match = pattern.regex.exec(rawLine);
      if (match && match[1]) {
        const name = match[1];
        symbols.push({
          name,
          kind: pattern.kind,
          line: i + 1,
          signature: trimmed.slice(0, 100),
          isExported,
        });
        break;
      }
    }
  }

  if (symbolsCache.size >= SYMBOLS_CACHE_LIMIT) {
    const oldestKey = symbolsCache.keys().next().value;
    if (oldestKey) symbolsCache.delete(oldestKey);
  }
  symbolsCache.set(hash, symbols);

  return symbols;
}
