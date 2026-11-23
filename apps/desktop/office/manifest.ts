export function renderOfficeManifest(template: string, appVersion: string) {
  const version = /^\d+\.\d+\.\d+/.exec(appVersion)?.[0];
  if (!version) throw new Error("Invalid ChemDraft app version.");
  return template.replaceAll("{{AppVersion}}", appVersion).replaceAll("{{ManifestVersion}}", version + ".0");
}
