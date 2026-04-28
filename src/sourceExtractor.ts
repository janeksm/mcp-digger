import type { PackageConfig } from "./config.js";
import { GitError, listFiles, readFile } from "./gitClient.js";

// ── Constants ──

const GENERATED_SUFFIXES = [".g.cs", ".generated.cs", ".Designer.cs"];
const DOC_FILES = ["README.md", "CONVENTIONS.md", "ARCHITECTURE.md"];

// ── Regex patterns ──

const INTERFACE_RE =
  /\b(?:public|protected|internal)\b[^;]*\binterface\s+(\S+)/;
const ABSTRACT_CLASS_RE =
  /\b(?:public|protected|internal)\b[^;]*\babstract\b[^;]*\bclass\s+(\S+)/;

// Index extraction patterns (broader than scanForKeyTypes — captures all type kinds)
const TYPE_DECL_RE =
  /\b(?:public|protected|internal)\b[^;{]*\b(class|interface|struct|enum|record)\s+(\w+)/;
const METHOD_DECL_RE =
  /\b(?:public|protected|internal|override)\b[^;{]*?\b(\w+)\s*\(/;
// Exclude these "method" matches — they're type keywords, not method names
const NOT_METHOD = new Set([
  "class", "interface", "struct", "enum", "record",
  "namespace", "if", "else", "while", "for", "foreach",
  "switch", "catch", "using", "delegate", "event", "new",
  "return", "throw", "typeof", "sizeof", "nameof", "where",
]);
const VALID_KINDS = new Set(["class", "interface", "struct", "enum", "record", "method"]);

// ── Public types ──

export interface IndexEntry {
  symbol: string;
  kind: "class" | "interface" | "struct" | "enum" | "record" | "method";
  parentType?: string;
  filePath: string;
}

// ── Public API ──

/**
 * Generate overview markdown for a package.
 * Reads doc files and scans .cs files for key types (interfaces, abstract classes).
 */
export async function extractOverview(
  repoDir: string,
  pkg: PackageConfig,
  _commitHash: string,
): Promise<string> {
  const allFiles = await listFiles(repoDir, pkg.pathInRepo + "/");

  const csFiles = filterCsFiles(allFiles);
  const docPaths = [
    ...DOC_FILES.map((d) => `${pkg.pathInRepo}/${d}`),
    ...allFiles
      .filter(
        (f) => f.startsWith(`${pkg.pathInRepo}/docs/`) && f.endsWith(".md"),
      )
      .sort(),
  ];

  const [docContents, csContents] = await Promise.all([
    Promise.all(docPaths.map((p) => tryReadFile(repoDir, p))),
    Promise.all(csFiles.map((p) => tryReadFile(repoDir, p))),
  ]);

  const sections: string[] = [];

  // Header
  sections.push(`# ${pkg.name}\n`);

  // Doc file contents
  for (const content of docContents) {
    if (content !== undefined) {
      sections.push(content.trim());
      sections.push("");
    }
  }

  // Scan .cs files for key types
  const interfaces: TypeInfo[] = [];
  const abstractClasses: TypeInfo[] = [];

  for (const content of csContents) {
    if (content === undefined) continue;
    const types = scanForKeyTypes(content);
    interfaces.push(...types.interfaces);
    abstractClasses.push(...types.abstractClasses);
  }

  if (interfaces.length > 0) {
    sections.push("## Key Interfaces\n");
    for (const t of interfaces.sort((a, b) => a.name.localeCompare(b.name))) {
      const desc = t.summary ? ` — ${t.summary}` : "";
      sections.push(`- **${t.name}**${desc}`);
    }
    sections.push("");
  }

  if (abstractClasses.length > 0) {
    sections.push("## Abstract Classes\n");
    for (const t of abstractClasses.sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const desc = t.summary ? ` — ${t.summary}` : "";
      sections.push(`- **${t.name}**${desc}`);
    }
    sections.push("");
  }

  // Source file listing
  if (csFiles.length > 0) {
    sections.push("## Source Files\n");
    for (const f of csFiles.sort()) {
      const relPath = f.slice(pkg.pathInRepo.length + 1);
      sections.push(`- ${relPath}`);
    }
    sections.push("");
  }

  return sections.join("\n").trimEnd() + "\n";
}

/**
 * Build a symbol index for a package: all type and method declarations.
 * Returns entries sorted by symbol name.
 */
export async function extractIndex(
  repoDir: string,
  pkg: PackageConfig,
): Promise<IndexEntry[]> {
  const allFiles = await listFiles(repoDir, pkg.pathInRepo + "/");
  const csFiles = filterCsFiles(allFiles);

  const contents = await Promise.all(
    csFiles.map((p) => tryReadFile(repoDir, p)),
  );

  const entries: IndexEntry[] = [];

  for (let i = 0; i < csFiles.length; i++) {
    const source = contents[i];
    if (source === undefined) continue;

    const filePath = csFiles[i]!;
    const relPath = filePath.slice(pkg.pathInRepo.length + 1);

    entries.push(...scanFileForIndex(source, relPath));
  }

  entries.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return entries;
}

/**
 * Serialize index entries to flat pipe-delimited format.
 * Types: `symbol|kind|filePath`
 * Methods: `symbol|method|parentType|filePath`
 */
export function serializeIndex(entries: IndexEntry[]): string {
  return entries
    .map((e) =>
      e.kind === "method"
        ? `${e.symbol}|method|${e.parentType}|${e.filePath}`
        : `${e.symbol}|${e.kind}|${e.filePath}`,
    )
    .join("\n");
}

/**
 * Parse flat pipe-delimited index back into entries.
 */
export function parseIndex(raw: string): IndexEntry[] {
  if (!raw.trim()) return [];
  return raw
    .trim()
    .split("\n")
    .filter((line) => {
      const kind = line.split("|")[1];
      return kind !== undefined && VALID_KINDS.has(kind);
    })
    .map((line) => {
      const parts = line.split("|");
      if (parts[1] === "method") {
        return {
          symbol: parts[0]!,
          kind: "method" as const,
          parentType: parts[2]!,
          filePath: parts[3]!,
        };
      }
      return {
        symbol: parts[0]!,
        kind: parts[1] as IndexEntry["kind"],
        filePath: parts[2]!,
      };
    });
}

// ── Internal helpers ──

function scanFileForIndex(source: string, relPath: string): IndexEntry[] {
  const lines = source.split("\n");
  const entries: IndexEntry[] = [];
  const typeStack: string[] = [];
  let depth = 0;
  const typeDepths: number[] = [];
  let pendingType: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) {
      continue;
    }

    const opens = countChar(trimmed, "{");
    const closes = countChar(trimmed, "}");

    const typeMatch = TYPE_DECL_RE.exec(trimmed);
    if (typeMatch) {
      const typeKind = typeMatch[1] as IndexEntry["kind"];
      const name = typeMatch[2]!;
      entries.push({ symbol: name, kind: typeKind, filePath: relPath });
      if (opens > closes) {
        typeStack.push(name);
        typeDepths.push(depth + opens);
      } else if (opens === 0) {
        // Allman style: opening brace comes on the next line
        pendingType = name;
      }
    } else if (pendingType && opens > closes) {
      typeStack.push(pendingType);
      typeDepths.push(depth + opens);
      pendingType = null;
    } else {
      pendingType = null;
      if (typeStack.length > 0) {
        const methodMatch = METHOD_DECL_RE.exec(trimmed);
        if (methodMatch && !NOT_METHOD.has(methodMatch[1]!)) {
          entries.push({
            symbol: methodMatch[1]!,
            kind: "method",
            parentType: typeStack[typeStack.length - 1],
            filePath: relPath,
          });
        }
      }
    }

    depth += opens - closes;

    while (typeDepths.length > 0 && depth < typeDepths[typeDepths.length - 1]!) {
      typeStack.pop();
      typeDepths.pop();
    }
  }

  return entries;
}

function countChar(s: string, ch: string): number {
  let count = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === ch) count++;
  }
  return count;
}

function filterCsFiles(files: string[]): string[] {
  return files.filter((f) => f.endsWith(".cs") && !isGenerated(f));
}

function isGenerated(filePath: string): boolean {
  return GENERATED_SUFFIXES.some((s) => filePath.endsWith(s));
}

async function tryReadFile(
  repoDir: string,
  filePath: string,
): Promise<string | undefined> {
  try {
    return await readFile(repoDir, filePath);
  } catch (err) {
    if (err instanceof GitError) return undefined;
    throw err;
  }
}

interface TypeInfo {
  name: string;
  summary: string;
}

/** Scan C# source for public interfaces and abstract classes. */
function scanForKeyTypes(source: string): {
  interfaces: TypeInfo[];
  abstractClasses: TypeInfo[];
} {
  const lines = source.split("\n");
  const interfaces: TypeInfo[] = [];
  const abstractClasses: TypeInfo[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();

    const ifaceMatch = INTERFACE_RE.exec(line);
    if (ifaceMatch) {
      interfaces.push({
        name: ifaceMatch[1]!,
        summary: extractXmlSummary(lines, i),
      });
      continue;
    }

    const absMatch = ABSTRACT_CLASS_RE.exec(line);
    if (absMatch) {
      abstractClasses.push({
        name: absMatch[1]!,
        summary: extractXmlSummary(lines, i),
      });
    }
  }

  return { interfaces, abstractClasses };
}

/**
 * Extract XML `<summary>` text from XML doc comments preceding a declaration.
 * Searches backwards from `declLineIdx`, skipping attributes and blank lines.
 */
function extractXmlSummary(lines: string[], declLineIdx: number): string {
  const xmlLines: string[] = [];

  for (let i = declLineIdx - 1; i >= 0; i--) {
    const trimmed = lines[i]!.trim();
    if (trimmed.startsWith("///")) {
      xmlLines.unshift(trimmed);
    } else if (trimmed.startsWith("[") || trimmed === "") {
      // Skip attributes and blank lines between docs and declaration
      continue;
    } else {
      break;
    }
  }

  if (xmlLines.length === 0) return "";

  const xmlText = xmlLines.map((l) => l.replace(/^\/\/\/\s?/, "")).join(" ");
  const summaryMatch = /<summary>(.*?)<\/summary>/s.exec(xmlText);
  if (!summaryMatch) return "";

  return summaryMatch[1]!.replace(/\s+/g, " ").trim();
}
