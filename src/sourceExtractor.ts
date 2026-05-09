import type { PackageConfig } from "./config.js";
import { GitError, listFiles, readFile } from "./gitClient.js";

// ── Constants ──

const GENERATED_SUFFIXES = [".g.cs", ".generated.cs", ".Designer.cs"];
const DOC_FILES = ["README.md", "CONVENTIONS.md", "ARCHITECTURE.md"];

// ── Regex patterns ──

const TYPE_KEYWORDS_RE = /\b(?:namespace|class|struct|interface|enum|record)\b/;
const AUTO_PROP_RE =
  /\{\s*(?:(?:(?:private|protected|internal|public)\s+)?(?:get|set|init)\s*;\s*)+\}/;
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
  "lock", "default", "checked", "unchecked", "fixed", "when",
]);
const VALID_KINDS = new Set(["class", "interface", "struct", "enum", "record", "method"]);

// ── Public types ──

export interface IndexEntry {
  symbol: string;
  kind: "class" | "interface" | "struct" | "enum" | "record" | "method";
  parentType?: string;
  baseTypes?: string[];
  generics?: string;
  modifiers?: string;
  filePath: string;
}

export interface FileReference {
  filePath: string;
  count: number;
}

// ── Public API ──

/**
 * Generate overview markdown for a package.
 * Reads doc files and scans .cs files for key types (interfaces, abstract classes).
 */
export async function extractOverview(
  repoDir: string,
  pkg: PackageConfig,
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

  sections.push(
    csFiles.length === 0
      ? "*No source files.*"
      : `*${csFiles.length} source file${csFiles.length === 1 ? "" : "s"} — use dig_lookup to find specific types.*`,
  );

  return sections.join("\n").trimEnd() + "\n";
}

/**
 * Generate stripped .cs signature files for a package.
 * Returns array of { filePath, content } sorted by path.
 * File paths are relative to the package directory.
 */
export async function extractSignatures(
  repoDir: string,
  pkg: PackageConfig,
): Promise<Array<{ filePath: string; content: string }>> {
  const allFiles = await listFiles(repoDir, pkg.pathInRepo + "/");
  const csFiles = filterCsFiles(allFiles);

  const contents = await Promise.all(
    csFiles.map((p) => tryReadFile(repoDir, p)),
  );

  const results: Array<{ filePath: string; content: string }> = [];

  for (let i = 0; i < csFiles.length; i++) {
    const source = contents[i];
    if (source === undefined) continue;

    const filePath = csFiles[i]!;
    const relPath = filePath.slice(pkg.pathInRepo.length + 1);
    const stripped = cleanSignatureOutput(stripCsBody(source));

    results.push({ filePath: relPath, content: stripped });
  }

  results.sort((a, b) => a.filePath.localeCompare(b.filePath));
  return results;
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

const PKG_DESC_RE = /<PackageDescription>(.*?)<\/PackageDescription>/s;
const PKG_TAGS_RE = /<PackageTags>(.*?)<\/PackageTags>/s;

/**
 * Extract a one-line summary from a package's .csproj metadata.
 * Returns `<PackageDescription>` + `(tags: <PackageTags>)` if present.
 */
export async function extractPackageSummary(
  repoDir: string,
  pkg: PackageConfig,
): Promise<string | undefined> {
  // Try conventional path first (PackageName/PackageName.csproj) to avoid listFiles
  let content = await tryReadFile(repoDir, `${pkg.pathInRepo}/${pkg.name}.csproj`);
  if (content === undefined) {
    const allFiles = await listFiles(repoDir, pkg.pathInRepo + "/");
    const csproj = allFiles.find((f) => f.endsWith(".csproj"));
    if (!csproj) return undefined;
    content = await tryReadFile(repoDir, csproj);
    if (content === undefined) return undefined;
  }

  const descMatch = PKG_DESC_RE.exec(content);
  const tagsMatch = PKG_TAGS_RE.exec(content);

  const desc = descMatch?.[1]?.trim().replace(/\s+/g, " ");
  const tags = tagsMatch?.[1]?.trim().replace(/\s+/g, " ");

  if (!desc && !tags) return undefined;
  if (!desc) return `(tags: ${tags})`;
  if (!tags) return desc;
  return `${desc} (tags: ${tags})`;
}

/**
 * Serialize index entries to flat pipe-delimited format.
 * Types: `symbol|kind|filePath[|bases[|generics[|modifiers]]]`
 * Methods: `symbol|method|parentType|filePath`
 */
export function serializeIndex(entries: IndexEntry[]): string {
  return entries
    .map((e) => {
      if (e.kind === "method") {
        return `${e.symbol}|method|${e.parentType}|${e.filePath}`;
      }
      const basePart = e.baseTypes?.length ? e.baseTypes.join(",") : "";
      if (e.generics || e.modifiers) {
        return `${e.symbol}|${e.kind}|${e.filePath}|${basePart}|${e.generics ?? ""}|${e.modifiers ?? ""}`;
      }
      const bases = basePart ? `|${basePart}` : "";
      return `${e.symbol}|${e.kind}|${e.filePath}${bases}`;
    })
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
      const entry: IndexEntry = {
        symbol: parts[0]!,
        kind: parts[1] as IndexEntry["kind"],
        filePath: parts[2]!,
      };
      if (parts.length >= 4 && parts[3]) {
        entry.baseTypes = parts[3].split(",");
      }
      if (parts.length >= 5 && parts[4]) {
        entry.generics = parts[4];
      }
      if (parts.length >= 6 && parts[5]) {
        entry.modifiers = parts[5];
      }
      return entry;
    });
}

// ── Signature cleanup ──

const NAMESPACE_RE = /^\s*namespace\s/;
const USING_RE = /^\s*using\s/;
const PRIVATE_START_RE = /^\s*private\s/;
const BOILERPLATE_RE = /\boverride\b[^;{]*\b(?:Equals|GetHashCode|ToString)\b/;
const COMPARETO_RE = /\bCompareTo\s*\(/;
const OPERATOR_RE = /\bstatic\b[^;{]*\boperator\b/;
const PUBLIC_START_RE = /^(\s*)public\s+/;

function endsDeclaration(trimmed: string): boolean {
  return trimmed.endsWith(";") || trimmed.endsWith("}");
}

export function cleanSignatureOutput(stripped: string): string {
  const lines = stripped.split("\n");
  const result: string[] = [];
  let skipping = false;
  let lastWasBlank = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (skipping) {
      if (endsDeclaration(trimmed)) skipping = false;
      continue;
    }

    if (trimmed.startsWith("///")) continue;
    if (NAMESPACE_RE.test(line)) continue;
    if (USING_RE.test(line)) continue;

    if (PRIVATE_START_RE.test(line)) {
      if (!endsDeclaration(trimmed)) skipping = true;
      continue;
    }

    if (BOILERPLATE_RE.test(trimmed) || COMPARETO_RE.test(trimmed) || OPERATOR_RE.test(trimmed)) {
      if (!endsDeclaration(trimmed)) skipping = true;
      continue;
    }

    const cleaned = line.replace(PUBLIC_START_RE, "$1");

    if (cleaned.trim() === "") {
      if (lastWasBlank) continue;
      lastWasBlank = true;
    } else {
      lastWasBlank = false;
    }

    result.push(cleaned);
  }

  return result.join("\n");
}

// ── Body stripping ──

export function stripCsBody(source: string): string {
  const lines = source.split("\n");
  const result: string[] = [];

  let depth = 0;
  let inBlockComment = false;
  let skipToDepth = -1;
  let declContext = "";

  for (const line of lines) {
    const trimmed = line.trim();
    const indent = line.substring(0, line.length - line.trimStart().length);

    const analysis = analyzeLine(trimmed, inBlockComment);
    inBlockComment = analysis.endsInComment;

    if (skipToDepth >= 0) {
      depth += analysis.opens - analysis.closes;
      if (depth <= skipToDepth) {
        skipToDepth = -1;
      }
      continue;
    }

    if (analysis.opens > 0 && analysis.closes >= analysis.opens) {
      if (isAutoProperty(trimmed)) {
        result.push(line);
      } else {
        const sigPart = trimmed
          .substring(0, analysis.firstOpenIdx)
          .trimEnd();
        result.push(formatPlaceholder(indent, sigPart));
      }
      declContext = "";
    } else if (analysis.opens > 0) {
      const textBeforeBrace = trimmed.substring(0, analysis.firstOpenIdx);
      const fullContext = declContext + " " + textBeforeBrace;

      if (isTypeDecl(fullContext)) {
        result.push(line);
        depth += analysis.opens - analysis.closes;
      } else {
        skipToDepth = depth;
        depth += analysis.opens - analysis.closes;

        result.push(formatPlaceholder(indent, textBeforeBrace.trimEnd()));
      }
      declContext = "";
    } else if (analysis.closes > 0) {
      depth += analysis.opens - analysis.closes;
      result.push(line);
      declContext = "";
    } else {
      result.push(line);

      if (
        trimmed &&
        !trimmed.startsWith("//") &&
        !trimmed.startsWith("*") &&
        !trimmed.startsWith("/*") &&
        !trimmed.startsWith("[")
      ) {
        declContext += " " + trimmed;
      } else if (trimmed === "") {
        declContext = "";
      }
    }
  }

  return result.join("\n");
}

// ── Internal helpers ──

interface LineAnalysis {
  opens: number;
  closes: number;
  firstOpenIdx: number;
  endsInComment: boolean;
}

function analyzeLine(
  line: string,
  startsInBlockComment: boolean,
): LineAnalysis {
  let opens = 0;
  let closes = 0;
  let firstOpenIdx = -1;
  let inBC = startsInBlockComment;
  let inStr = false;
  let inChar = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    const next = i + 1 < line.length ? line[i + 1] : "";

    if (inBC) {
      if (ch === "*" && next === "/") {
        inBC = false;
        i++;
      }
      continue;
    }
    if (inStr) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === '"') inStr = false;
      continue;
    }
    if (inChar) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === "'") inChar = false;
      continue;
    }

    if (ch === "/" && next === "/") break;
    if (ch === "/" && next === "*") {
      inBC = true;
      i++;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === "'") {
      inChar = true;
      continue;
    }

    if (ch === "{") {
      if (firstOpenIdx < 0) firstOpenIdx = i;
      opens++;
    } else if (ch === "}") {
      closes++;
    }
  }

  return { opens, closes, firstOpenIdx, endsInComment: inBC };
}

function isTypeDecl(context: string): boolean {
  return TYPE_KEYWORDS_RE.test(context);
}

function isAutoProperty(line: string): boolean {
  return AUTO_PROP_RE.test(line);
}

function formatPlaceholder(indent: string, sigPart: string): string {
  return sigPart
    ? `${indent}${sigPart} { /* ... */ }`
    : `${indent}{ /* ... */ }`;
}

function isNonCodeLine(
  line: string,
  wasInComment: boolean,
  endsInComment: boolean,
): boolean {
  return (
    !line ||
    (wasInComment && endsInComment) ||
    (!wasInComment && (line.startsWith("//") || line.startsWith("/*")))
  );
}

function scanFileForIndex(source: string, relPath: string): IndexEntry[] {
  const lines = source.split("\n");
  const entries: IndexEntry[] = [];
  const typeStack: string[] = [];
  let depth = 0;
  const typeDepths: number[] = [];
  let pendingType: string | null = null;
  let inBlockComment = false;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (!trimmed && !inBlockComment) continue;

    const analysis = analyzeLine(trimmed, inBlockComment);
    const wasInBlockComment = inBlockComment;
    inBlockComment = analysis.endsInComment;

    if (isNonCodeLine(trimmed, wasInBlockComment, analysis.endsInComment)) continue;

    const opens = analysis.opens;
    const closes = analysis.closes;

    const typeMatch = TYPE_DECL_RE.exec(trimmed);
    if (typeMatch) {
      const typeKind = typeMatch[1] as IndexEntry["kind"];
      const name = typeMatch[2]!;

      let fullDecl = trimmed.slice(typeMatch.index + typeMatch[0].length);
      if (opens === 0 && !trimmed.includes(";")) {
        let fwdInBC = analysis.endsInComment;
        for (let j = i + 1; j < lines.length && j <= i + 5; j++) {
          const next = lines[j]!.trim();
          const fwdAnalysis = analyzeLine(next, fwdInBC);
          const wasFwdInBC = fwdInBC;
          fwdInBC = fwdAnalysis.endsInComment;
          if (isNonCodeLine(next, wasFwdInBC, fwdAnalysis.endsInComment)) continue;
          fullDecl += " " + next;
          if (fwdAnalysis.opens > 0 || next.includes(";")) break;
        }
      }

      const afterName = trimmed.slice(typeMatch.index + typeMatch[0].length);
      const generics = extractGenerics(afterName);

      const beforeKeyword = trimmed.slice(0, typeMatch.index + typeMatch[0].indexOf(typeKind));
      const modifiers = extractModifiers(beforeKeyword);

      const baseTypes = parseBaseTypes(fullDecl.replace(/\/\*.*?\*\//g, ""));
      const entry: IndexEntry = { symbol: name, kind: typeKind, filePath: relPath };
      if (baseTypes.length > 0) entry.baseTypes = baseTypes;
      if (generics) entry.generics = generics;
      if (modifiers) entry.modifiers = modifiers;
      entries.push(entry);

      if (opens > closes) {
        typeStack.push(name);
        typeDepths.push(depth + opens);
      } else if (opens === 0) {
        pendingType = name;
      }
    } else if (pendingType && opens > closes) {
      typeStack.push(pendingType);
      typeDepths.push(depth + opens);
      pendingType = null;
    } else {
      if (!wasInBlockComment) pendingType = null;
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

function parseBaseTypes(declarationText: string): string[] {
  const whereIdx = declarationText.search(/\bwhere\b/);
  const text = whereIdx >= 0 ? declarationText.slice(0, whereIdx) : declarationText;

  let colonIdx = -1;
  let angleDepth = 0;
  let parenDepth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "<") angleDepth++;
    else if (ch === ">") angleDepth--;
    else if (ch === "(") parenDepth++;
    else if (ch === ")") parenDepth--;
    else if (ch === ":" && angleDepth === 0 && parenDepth === 0) {
      colonIdx = i;
      break;
    }
    if (ch === "{") return [];
  }

  if (colonIdx < 0) return [];

  let baseText = text.slice(colonIdx + 1);
  const braceIdx = baseText.indexOf("{");
  if (braceIdx >= 0) baseText = baseText.slice(0, braceIdx);
  const semiIdx = baseText.indexOf(";");
  if (semiIdx >= 0) baseText = baseText.slice(0, semiIdx);

  return splitRespectingGenerics(baseText)
    .map((p) => stripGenerics(p.trim()))
    .filter((p) => p.length > 0 && /^\w+$/.test(p));
}

function splitRespectingGenerics(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if (ch === "<") depth++;
    else if (ch === ">") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

function stripGenerics(name: string): string {
  const idx = name.indexOf("<");
  return idx >= 0 ? name.slice(0, idx).trim() : name;
}

function extractGenerics(text: string): string | undefined {
  if (!text.startsWith("<")) return undefined;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "<") depth++;
    else if (text[i] === ">") {
      depth--;
      if (depth === 0) return text.slice(0, i + 1);
    }
  }
  return undefined;
}

const TYPE_MODIFIERS = ["abstract", "sealed", "static"] as const;
const TYPE_MODIFIER_RES = TYPE_MODIFIERS.map((mod) => new RegExp(`\\b${mod}\\b`));

function extractModifiers(prefixText: string): string | undefined {
  const found = TYPE_MODIFIERS.filter((_, i) =>
    TYPE_MODIFIER_RES[i]!.test(prefixText),
  );
  return found.length > 0 ? found.join(" ") : undefined;
}

export function formatEntryDisplay(e: IndexEntry): { displayName: string; kindLabel: string } {
  const displayName = e.generics ? `${e.symbol}${e.generics}` : e.symbol;
  const kindLabel = e.modifiers ? `${e.modifiers} ${e.kind}` : e.kind;
  return { displayName, kindLabel };
}

export function filterCsFiles(files: string[]): string[] {
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

// ── Reference search ──

export function countReferences(source: string, keyword: string): number {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp("\\b" + escaped + "\\b", "g");
  const matches = source.match(re);
  return matches ? matches.length : 0;
}

export async function searchReferences(
  repoDir: string,
  pkg: PackageConfig,
  keyword: string,
  maxFiles = 50,
): Promise<FileReference[]> {
  const allFiles = await listFiles(repoDir, pkg.pathInRepo + "/");
  const csFiles = filterCsFiles(allFiles);

  const contents = await Promise.all(
    csFiles.map(async (f) => ({ filePath: f, content: await tryReadFile(repoDir, f) })),
  );

  const results: FileReference[] = [];
  for (const { filePath, content } of contents) {
    if (content === undefined) continue;
    const count = countReferences(content, keyword);
    if (count > 0) {
      const relPath = filePath.slice(pkg.pathInRepo.length + 1);
      results.push({ filePath: relPath, count });
    }
  }

  results.sort((a, b) => b.count - a.count);
  return results.slice(0, maxFiles);
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
