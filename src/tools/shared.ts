import { z } from "zod";

export const PACKAGE_NAME_PARAM = z.string().describe("Exact name of the internal NuGet package (e.g. 'MyCompany.Core')");

export const FILE_CHAR_LIMIT = 1_000_000;

export interface ToolResult {
  text: string;
  isError: boolean;
}

export function toolSuccess(text: string): ToolResult {
  return { text, isError: false };
}

export function toolError(text: string): ToolResult {
  return { text, isError: true };
}

export function toCallToolResult(result: ToolResult) {
  return {
    content: [{ type: "text" as const, text: result.text }],
    ...(result.isError && { isError: true }),
  };
}

export const TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;
