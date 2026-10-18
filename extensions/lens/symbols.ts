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
    regex: /^(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*(\([^)]*\))/m,
    kind: "function" as const,
  },
  // export class / class
  {
    regex: /^(?:export\s+(?:default\s+)?)?class\s+([A-Za-z0-9_$]+)(?:\s+extends|\s+implements|\s*\{)/m,
    kind: "class" as const,
  },
  // export interface
  {
    regex: /^(?:export\s+)?interface\s+([A-Za-z0-9_$]+)(?:<[^>]+>)?(?:\s+extends|\s*\{)/m,
    kind: "interface" as const,
  },
  // export type
  {
    regex: /^(?:export\s+)?type\s+([A-Za-z0-9_$]+)(?:<[^>]+>)?\s*=/m,
    kind: "type" as const,
  },
  // export const/let arrow or declaration
  {
    regex: /^(?:export\s+)(?:const|let|var)\s+([A-Za-z0-9_$]+)(?:\s*:\s*[^=]+)?\s*=/m,
    kind: "variable" as const,
  },
];

const PYTHON_PATTERNS = [
  {
    regex: /^(?:async\s+)?def\s+([A-Za-z0-9_]+)\s*(\([^)]*\))/m,
    kind: "function" as const,
  },
  {
    regex: /^class\s+([A-Za-z0-9_]+)(?:\([^)]*\))?:/m,
    kind: "class" as const,
  },
];

const GO_PATTERNS = [
  {
    regex: /^func\s+(?:\([^)]+\)\s+)?([A-Za-z0-9_]+)\s*(\([^)]*\))/m,
    kind: "function" as const,
  },
  {
    regex: /^type\s+([A-Za-z0-9_]+)\s+struct/m,
    kind: "class" as const,
  },
  {
    regex: /^type\s+([A-Za-z0-9_]+)\s+interface/m,
    kind: "interface" as const,
  },
];

const RUST_PATTERNS = [
  {
    regex: /^(?:pub\s+(?:\([^)]+\)\s+)?)?(?:async\s+)?fn\s+([A-Za-z0-9_]+)\s*(\([^)]*\))/m,
    kind: "function" as const,
  },
  {
    regex: /^(?:pub\s+)?struct\s+([A-Za-z0-9_]+)/m,
    kind: "class" as const,
  },
  {
    regex: /^(?:pub\s+)?trait\s+([A-Za-z0-9_]+)/m,
    kind: "interface" as const,
  },
  {
    regex: /^(?:pub\s+)?enum\s+([A-Za-z0-9_]+)/m,
    kind: "type" as const,
  },
];

export function extractSymbols(sourceText: string, filePath: string): CodeSymbol[] {
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

  return symbols;
}
