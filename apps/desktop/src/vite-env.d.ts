/// <reference types="vite/client" />

declare module "node:fs" {
  export function readFileSync(path: URL | string, encoding: string): string;
}

declare module "raphael" {
  const Raphael: unknown;
  export default Raphael;
}
