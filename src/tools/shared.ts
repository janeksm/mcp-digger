import { z } from "zod";

export const PACKAGE_NAME_PARAM = z.string().describe("Exact name of the internal NuGet package (e.g. 'MyCompany.Core')");

export const FILE_CHAR_LIMIT = 1_000_000;

export const TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;
