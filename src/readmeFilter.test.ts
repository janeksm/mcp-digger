import { describe, expect, it } from "vitest";
import { filterReadmeSections } from "./readmeFilter.js";

// ── Heading blocklist ──

describe("filterReadmeSections — heading blocklist", () => {
  it("removes Installation section", () => {
    const readme = "## Architecture\n\nGood stuff.\n\n## Installation\n\n```\ndotnet add package Foo\n```\n";
    const result = filterReadmeSections(readme);
    expect(result).toContain("## Architecture");
    expect(result).not.toContain("## Installation");
  });

  it("removes Getting Started section", () => {
    const readme = "## Overview\n\nIntro.\n\n## Getting Started\n\nStep 1...\n";
    const result = filterReadmeSections(readme);
    expect(result).toContain("## Overview");
    expect(result).not.toContain("## Getting Started");
  });

  it("removes CI/CD section with various formats", () => {
    for (const heading of ["## CI/CD", "## CI / CD", "## CI CD"]) {
      const readme = `## Design\n\nArchitecture.\n\n${heading}\n\nPipeline config.\n`;
      const result = filterReadmeSections(readme);
      expect(result).toContain("## Design");
      expect(result).not.toContain(heading);
    }
  });

  it("removes License section", () => {
    const readme = "## Design\n\nContent.\n\n## License\n\nMIT\n";
    const result = filterReadmeSections(readme);
    expect(result).not.toContain("## License");
  });

  it("removes Licence (British spelling)", () => {
    const readme = "## Design\n\nContent.\n\n## Licence\n\nMIT\n";
    const result = filterReadmeSections(readme);
    expect(result).not.toContain("## Licence");
  });

  it("removes Badge section", () => {
    const readme = "## Design\n\nContent.\n\n## Badges\n\n![badge](http://example.com)\n";
    const result = filterReadmeSections(readme);
    expect(result).not.toContain("## Badges");
  });

  it("removes Versioning section", () => {
    const readme = "## Design\n\nContent.\n\n## Versioning\n\nSemVer.\n";
    const result = filterReadmeSections(readme);
    expect(result).not.toContain("## Versioning");
  });

  it("removes Contributing section", () => {
    const readme = "## Design\n\nContent.\n\n## Contributing\n\nPRs welcome.\n";
    const result = filterReadmeSections(readme);
    expect(result).not.toContain("## Contributing");
  });

  it("removes NuGet section", () => {
    const readme = "## Design\n\nContent.\n\n## NuGet Packages\n\n| Package | Version |\n";
    const result = filterReadmeSections(readme);
    expect(result).not.toContain("## NuGet Packages");
  });

  it("removes Quick Start section", () => {
    const readme = "## Design\n\nContent.\n\n## Quick Start\n\nRun this...\n";
    const result = filterReadmeSections(readme);
    expect(result).not.toContain("## Quick Start");
  });

  it("removes Prerequisites section", () => {
    const readme = "## Design\n\nContent.\n\n## Prerequisites\n\n.NET 8 SDK\n";
    const result = filterReadmeSections(readme);
    expect(result).not.toContain("## Prerequisites");
  });

  it("removes Usage section", () => {
    const readme = "## Design\n\nContent.\n\n## Usage\n\nCall the API.\n";
    const result = filterReadmeSections(readme);
    expect(result).not.toContain("## Usage");
  });

  it("removes Release Notes section", () => {
    const readme = "## Design\n\nContent.\n\n## Release Notes\n\nv1.0...\n";
    const result = filterReadmeSections(readme);
    expect(result).not.toContain("## Release Notes");
  });

  it("removes H3 sections matching blocklist", () => {
    const readme = "## Architecture\n\nGood.\n\n### Installation\n\nBad.\n";
    const result = filterReadmeSections(readme);
    expect(result).toContain("## Architecture");
    expect(result).not.toContain("### Installation");
  });
});

// ── Content-shape filtering ──

describe("filterReadmeSections — content-shape check", () => {
  it("removes section dominated by dotnet add commands", () => {
    const readme = [
      "## Architecture",
      "",
      "Good content.",
      "",
      "## Setup",
      "",
      "```bash",
      "dotnet add package Foo",
      "dotnet add package Bar",
      "dotnet add package Baz",
      "```",
    ].join("\n");
    const result = filterReadmeSections(readme);
    expect(result).toContain("## Architecture");
    expect(result).not.toContain("## Setup");
  });

  it("removes section dominated by shields.io badges", () => {
    const readme = [
      "## Architecture",
      "",
      "Good content.",
      "",
      "## Status",
      "",
      "[![Build](https://img.shields.io/badge/build-passing-green)](link)",
      "[![Coverage](https://shields.io/badge/cov-90-blue)](link)",
    ].join("\n");
    const result = filterReadmeSections(readme);
    expect(result).toContain("## Architecture");
    expect(result).not.toContain("## Status");
  });

  it("removes section dominated by nuget.org links", () => {
    const readme = [
      "## Architecture",
      "",
      "Good content.",
      "",
      "## Available Packages",
      "",
      "| Package | Version |",
      "| --- | --- |",
      "| Foo | [1.0](https://nuget.org/packages/Foo) |",
      "| Bar | [2.0](https://nuget.org/packages/Bar) |",
      "| Baz | [3.0](https://nuget.org/packages/Baz) |",
    ].join("\n");
    const result = filterReadmeSections(readme);
    expect(result).not.toContain("## Available Packages");
  });

  it("keeps section with minority noise lines", () => {
    const readme = [
      "## Setup Guide",
      "",
      "This project uses a layered architecture.",
      "The core domain has no external dependencies.",
      "Infrastructure adapters implement the port interfaces.",
      "",
      "```bash",
      "dotnet add package Foo",
      "```",
    ].join("\n");
    const result = filterReadmeSections(readme);
    expect(result).toContain("## Setup Guide");
    expect(result).toContain("layered architecture");
  });
});

// ── Keep-by-default behavior ──

describe("filterReadmeSections — keep-by-default", () => {
  it("keeps Architecture section", () => {
    const readme = "## Architecture\n\nDomain-driven design with CQRS.\n\n## License\n\nMIT\n";
    const result = filterReadmeSections(readme);
    expect(result).toContain("## Architecture");
    expect(result).toContain("Domain-driven design");
  });

  it("keeps Design section", () => {
    const readme = "## Design\n\nEvent sourcing.\n\n## License\n\nMIT\n";
    const result = filterReadmeSections(readme);
    expect(result).toContain("## Design");
  });

  it("keeps Packages section (without NuGet keyword)", () => {
    const readme = "## Packages\n\n- Core\n- Infrastructure\n\n## License\n\nMIT\n";
    const result = filterReadmeSections(readme);
    expect(result).toContain("## Packages");
  });

  it("keeps unrecognized heading", () => {
    const readme = "## Deployment Topology\n\nThree-tier architecture.\n\n## License\n\nMIT\n";
    const result = filterReadmeSections(readme);
    expect(result).toContain("## Deployment Topology");
  });
});

// ── Edge cases ──

describe("filterReadmeSections — edge cases", () => {
  it("returns unchanged when no H2/H3 headings exist", () => {
    const readme = "# My Project\n\nJust a description with no subsections.\n";
    expect(filterReadmeSections(readme)).toBe(readme);
  });

  it("returns unchanged for empty string", () => {
    expect(filterReadmeSections("")).toBe("");
  });

  it("preserves preamble before first heading", () => {
    const readme = "# My Repo\n\nA framework for building services.\n\n## Installation\n\nSteps.\n\n## Architecture\n\nLayers.\n";
    const result = filterReadmeSections(readme);
    expect(result).toContain("A framework for building services.");
    expect(result).toContain("## Architecture");
    expect(result).not.toContain("## Installation");
  });

  it("keeps section with empty body", () => {
    const readme = "## Overview\n\n## Details\n\nSome details.\n\n## License\n\nMIT\n";
    const result = filterReadmeSections(readme);
    expect(result).toContain("## Overview");
    expect(result).toContain("## Details");
  });

  it("returns unchanged when no sections are filtered", () => {
    const readme = "## Architecture\n\nLayers.\n\n## Design\n\nPatterns.\n";
    expect(filterReadmeSections(readme)).toBe(readme);
  });

  it("treats H4+ as body content, not section boundaries", () => {
    const readme = "## Architecture\n\n#### Subsection\n\nDetail.\n\n## License\n\nMIT\n";
    const result = filterReadmeSections(readme);
    expect(result).toContain("## Architecture");
    expect(result).toContain("#### Subsection");
    expect(result).toContain("Detail.");
    expect(result).not.toContain("## License");
  });

  it("filters realistic .NET README preserving architecture", () => {
    const readme = [
      "# MyProject",
      "",
      "A framework for building domain-driven services.",
      "",
      "## Architecture",
      "",
      "The system is split into three layers:",
      "- Core domain",
      "- Application services",
      "- Infrastructure",
      "",
      "## Installation",
      "",
      "```",
      "dotnet add package MyProject",
      "```",
      "",
      "## CI/CD",
      "",
      "This project uses GitHub Actions.",
      "",
      "## Packages",
      "",
      "- **MyProject.Core** — Domain primitives",
      "- **MyProject.App** — Application layer",
      "",
      "## License",
      "",
      "MIT",
    ].join("\n");

    const result = filterReadmeSections(readme);

    expect(result).toContain("## Architecture");
    expect(result).toContain("three layers");
    expect(result).toContain("## Packages");
    expect(result).toContain("MyProject.Core");
    expect(result).toContain("A framework for building domain-driven services.");
    expect(result).not.toContain("## Installation");
    expect(result).not.toContain("dotnet add package");
    expect(result).not.toContain("## CI/CD");
    expect(result).not.toContain("## License");
  });
});
