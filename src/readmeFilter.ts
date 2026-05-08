// ── Types ──

interface ReadmeSection {
  heading: string;
  headingLevel: number;
  raw: string;
}

// ── Heading blocklist (Layer 1) ──

const HEADING_BLOCKLIST: RegExp[] = [
  /\binstall(?:ation|ing)?\b/i,
  /\bgetting\s+started\b/i,
  /\busage\b/i,
  /\bci(?:\s*\/\s*|\s+)cd\b/i,
  /\bpipeline\b/i,
  /\bbuild\s+status\b/i,
  /\bversion(?:ing)?\b/i,
  /\brelease(?:\s+notes?)?\b/i,
  /\bchangelog\b/i,
  /\blicen[sc]e\b/i,
  /\bcontribut(?:ing|ors?)\b/i,
  /\bbadge/i,
  /\bprerequisites?\b/i,
  /\bquick\s+start\b/i,
  /\bhow\s+to\s+(?:install|use|run)\b/i,
  /\bnuget\b/i,
];

// ── Content-shape noise patterns (Layer 2) ──

const NOISE_LINE_PATTERNS: RegExp[] = [
  /^\s*(?:```\s*)?(?:dotnet\s+add|Install-Package|nuget\s+install)\b/i,
  /shields\.io/i,
  /img\.shields/i,
  /\[!\[.*?\]\(https?:\/\/.*?badge/i,
  /nuget\.org\/packages\//i,
  /^\s*```\s*\w*\s*$/,
];

const HEADING_RE = /^(#{2,3})\s+(.+)$/;

// ── Public API ──

export function filterReadmeSections(readme: string): string {
  const { preamble, sections } = splitIntoSections(readme);

  if (sections.length === 0) return readme;

  const kept = sections.filter((s) => {
    if (HEADING_BLOCKLIST.some((re) => re.test(s.heading))) return false;
    const bodyLines = s.raw.split("\n").slice(1);
    if (isNoiseDominatedBody(bodyLines)) return false;
    return true;
  });

  if (kept.length === sections.length) return readme;

  const parts: string[] = [];
  if (preamble.trim()) parts.push(preamble.trimEnd());
  for (const s of kept) parts.push(s.raw.trimEnd());

  return parts.join("\n\n") + "\n";
}

// ── Internal helpers ──

function splitIntoSections(readme: string): { preamble: string; sections: ReadmeSection[] } {
  const lines = readme.split("\n");
  const preambleLines: string[] = [];
  const sections: ReadmeSection[] = [];
  let current: { heading: string; headingLevel: number; lines: string[] } | null = null;

  for (const line of lines) {
    const match = HEADING_RE.exec(line);
    if (match) {
      if (current) {
        sections.push({ heading: current.heading, headingLevel: current.headingLevel, raw: current.lines.join("\n") });
      }
      current = { heading: match[2]!, headingLevel: match[1]!.length, lines: [line] };
    } else if (current) {
      current.lines.push(line);
    } else {
      preambleLines.push(line);
    }
  }

  if (current) {
    sections.push({ heading: current.heading, headingLevel: current.headingLevel, raw: current.lines.join("\n") });
  }

  return { preamble: preambleLines.join("\n"), sections };
}

function isNoiseDominatedBody(bodyLines: string[]): boolean {
  const nonBlank = bodyLines.filter((l) => l.trim().length > 0);
  if (nonBlank.length === 0) return false;
  const noiseCount = nonBlank.filter((l) => NOISE_LINE_PATTERNS.some((p) => p.test(l))).length;
  return noiseCount / nonBlank.length > 0.5;
}
