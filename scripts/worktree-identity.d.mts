export declare const DEV_PRODUCT_NAME: string;
export declare function git(rootDir: string, ...args: string[]): string;
export declare function worktreeSlug(name: string): string;
export declare function worktreeIdentity(rootDir: string): {
  branch: string;
  label: string;
  devBundleId: string;
};
export declare function prependToPath(env: Record<string, string | undefined>, dir: string): Record<string, string | undefined>;
export declare function isStableBuild(options: {
  command: string | undefined;
  branch: string;
  env: Record<string, string | undefined>;
}): boolean;
export declare function worktreeLabelFor(options: {
  command: string | undefined;
  identity: { branch: string; label: string };
  env: Record<string, string | undefined>;
}): string;
export declare function labelFromEnv(env: Record<string, string | undefined>): string | undefined;
