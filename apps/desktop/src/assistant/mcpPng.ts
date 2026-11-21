import { validateBase64Png } from "../pngValidation";
export { checkPngDimensions, checkPngEncodedSize, checkPngRawSize, hasPngSignature } from "../pngValidation";

export const MCP_PNG_MAX_DIMENSION = 2048;

export function validateMcpPng(data: string): void {
  validateBase64Png(data, MCP_PNG_MAX_DIMENSION);
}
