import type { PackageConfig } from "./config.js";
import { GitError, listFiles, readFile } from "./gitClient.js";

// ── Constants ──

const GENERATED_SUFFIXES = [".g.cs", ".generated.cs", ".Designer.cs"];
const DOC_FILES = ["README.md", "CONVENTIONS.md", "ARCHITECTURE.md"];
const SIGNATURE_HEADER_PREFIX = "// GENERATED — read only —";
const SIGNATURE_HEADER_SUFFIX =
  "// Do not edit. Re-generated automatically when source changes.";

// ── Regex patterns ──

const TYPE_KEYWORDS_RE = /\b(?:namespace|class|struct|interface|enum|record)\b/;
const AUTO_PROP_RE =
  /\{\s*(?:(?:(?:private|protected|internal|public)\s+)?(?:get|set|init)\s*;\s*)+\}/;
const INTERFACE_RE =
  /\b(?:public|protected|internal)\b[^;]*\binterface\s+(\S+)/;
const ABSTRACT_CLASS_RE =
  /\b(?:public|protected|internal)\b[^;]*\babstract\b[^;]*\bclass\s+(\S+)/;

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
 * Generate stripped .cs signature files for a package.
 * Returns array of { filePath, content } sorted by path.
 * File paths are relative to the package directory.
 */
export async function extractSignatures(
  repoDir: string,
  pkg: PackageConfig,
  commitHash: string,
): Promise<Array<{ filePath: string; content: string }>> {
  const allFiles = await listFiles(repoDir, pkg.pathInRepo + "/");
  const csFiles = filterCsFiles(allFiles);

  const contents = await Promise.all(
    csFiles.map((p) => tryReadFile(repoDir, p)),
  );

  const shortHash = commitHash.slice(0, 8);
  const header =
    `${SIGNATURE_HEADER_PREFIX} ${pkg.name} @ commit ${shortHash}\n` +
    `${SIGNATURE_HEADER_SUFFIX}\n\n`;

  const results: Array<{ filePath: string; content: string }> = [];

  for (let i = 0; i < csFiles.length; i++) {
    const source = contents[i];
    if (source === undefined) continue;

    const filePath = csFiles[i]!;
    const relPath = filePath.slice(pkg.pathInRepo.length + 1);
    const stripped = stripCsBody(source);

    results.push({ filePath: relPath, content: header + stripped });
  }

  results.sort((a, b) => a.filePath.localeCompare(b.filePath));
  return results;
}

// ── Body stripping ──

/**
 * Strip method and property bodies from C# source, keeping type declarations,
 * member signatures, XML doc comments, fields, constants, and attributes.
 * Method/constructor/property bodies are replaced with a placeholder comment block.
 *
 * Known limitations:
 * - Multi-line attribute arguments with braces may confuse the parser
 * - Verbatim strings (@"") and raw string literals are not fully handled
 * - Expression-bodied members (=>) pass through as-is (intentional — they're informative)
 */
export function stripCsBody(source: string): string {
  const lines = source.split("\n");
  const result: string[] = [];

  let depth = 0;
  let inBlockComment = false;
  let skipToDepth = -1; // -1 = not skipping
  let declContext = ""; // accumulated declaration text for context detection

  for (const line of lines) {
    const trimmed = line.trim();
    const indent = line.substring(0, line.length - line.trimStart().length);

    const analysis = analyzeLine(trimmed, inBlockComment);
    inBlockComment = analysis.endsInComment;

    if (skipToDepth >= 0) {
      // Currently skipping a member body
      depth += analysis.opens - analysis.closes;
      if (depth <= skipToDepth) {
        skipToDepth = -1;
      }
      continue;
    }

    if (analysis.opens > 0 && analysis.closes >= analysis.opens) {
      // Balanced braces on one line
      if (isAutoProperty(trimmed)) {
        result.push(line);
      } else {
        // Single-line body — replace with placeholder
        const sigPart = trimmed
          .substring(0, analysis.firstOpenIdx)
          .trimEnd();
        result.push(formatPlaceholder(indent, sigPart));
      }
      declContext = "";
    } else if (analysis.opens > 0) {
      // Opening brace(s) without matching close on same line
      const textBeforeBrace = trimmed.substring(0, analysis.firstOpenIdx);
      const fullContext = declContext + " " + textBeforeBrace;

      if (isTypeDecl(fullContext)) {
        // Type or namespace body — keep
        result.push(line);
        depth += analysis.opens - analysis.closes;
      } else {
        // Member body — skip
        skipToDepth = depth;
        depth += analysis.opens - analysis.closes;

        result.push(formatPlaceholder(indent, textBeforeBrace.trimEnd()));
      }
      declContext = "";
    } else if (analysis.closes > 0) {
      // Only closing braces
      depth += analysis.opens - analysis.closes;
      result.push(line);
      declContext = "";
    } else {
      // No braces — output line
      result.push(line);

      // Accumulate declaration context (skip comments and attributes)
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
  firstOpenIdx: number; // -1 if no structural open brace
  endsInComment: boolean;
}

/** Count structural braces on a line, ignoring those in strings/comments. */
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

function filterCsFiles(files: string[]): string[] {
  return files.filter((f) => f.endsWith(".cs") && !isGenerated(f));
}

function isGenerated(filePath: string): boolean {
  return GENERATED_SUFFIXES.some((s) => filePath.endsWith(s));
}

function formatPlaceholder(indent: string, sigPart: string): string {
  return sigPart
    ? `${indent}${sigPart} { /* ... */ }`
    : `${indent}{ /* ... */ }`;
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
