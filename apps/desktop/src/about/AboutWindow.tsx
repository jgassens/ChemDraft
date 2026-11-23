import { useEffect, useState, type ReactNode } from "react";
import packageInfo from "../../package.json";
import contributorData from "./contributors.json";
import testerData from "./testers.json";
import { componentsForPlatform } from "./aboutPlatforms";
import type { AboutContributor, AboutPlatform, AboutProvenance, AboutTesters } from "./provenanceTypes";
import "./about.css";

declare const __ABOUT_PROVENANCE__: AboutProvenance;

const contributors: AboutContributor[] = contributorData;
const testers: AboutTesters = testerData;
const repository = "https://github.com/jgassens/ChemDraft";
const sections = ["ChemDraft", "Contributors", "Open-source components and provenance"] as const;

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
}

interface AboutWindowProps {
  version: string;
  buildStamp: string;
  error?: string;
  /** Whose components to list. Defaults to the running platform; tests pass each one. */
  platform?: AboutPlatform;
  onReady?: () => void;
  onCopy: () => Promise<void>;
  onClose?: () => void;
}

export function AboutWindow({ version, buildStamp, error, platform, onReady, onCopy, onClose }: AboutWindowProps) {
  const [copyMessage, setCopyMessage] = useState("");
  const [copying, setCopying] = useState(false);
  const [license, setLicense] = useState<{ path: string; heading: string }>();
  const { licenseTexts } = __ABOUT_PROVENANCE__;
  const components = componentsForPlatform(__ABOUT_PROVENANCE__.components, platform);
  useEffect(() => { onReady?.(); }, [onReady]);

  function showLicense(path: string, heading: string) {
    setLicense({ path, heading });
  }

  async function copyVersion() {
    setCopying(true);
    try {
      await onCopy();
      setCopyMessage("Version copied.");
    } catch {
      setCopyMessage("Could not copy the version.");
    } finally {
      setCopying(false);
    }
  }

  return <main className="about-window" aria-label="About ChemDraft" onKeyDown={event => {
    if (event.key === "Escape") {
      if (license) setLicense(undefined);
      else onClose?.();
    }
  }}>
    {license ? <section className="about-license">
      <button autoFocus type="button" onClick={() => setLicense(undefined)}>Back to About ChemDraft</button>
      <h1>{license.heading}</h1>
      <pre tabIndex={0}>{licenseTexts[license.path]}</pre>
    </section> : <>
      <nav aria-label="About sections">
        {sections.map((title, index) => <a key={title} href={"#about-section-" + index}>{title}</a>)}
      </nav>
      <div className="about-sections">
        <section aria-labelledby="about-section-0">
          <h1 id="about-section-0" tabIndex={-1}>ChemDraft</h1>
          <p className="about-version">Version {version} <span>Build {buildStamp}</span></p>
          <p><button type="button" disabled={copying} onClick={() => void copyVersion()}>Copy Version</button>{" "}
            <span role="status">{copyMessage}</span>
          </p>
          <p>Free and open source under the Apache License 2.0.</p>
          <p className="about-links">
            <ExternalLink href="https://chemdraft.ai">ChemDraft website</ExternalLink>
            <ExternalLink href={repository}>GitHub repository</ExternalLink>
            <button type="button" onClick={() => showLicense("LICENSE", "Apache License 2.0")}>Read the license</button>
          </p>
        </section>
        <section aria-labelledby="about-section-1">
          <h2 id="about-section-1" tabIndex={-1}>Contributors</h2>
          <ul className="about-credits">
            {contributors.map(({ name, handle, contribution }) => <li key={name}>
              <strong>{name}</strong>{handle && <>{" "}<ExternalLink href={"https://github.com/" + handle}>@{handle}</ExternalLink></>}
              <p>{contribution}</p>
            </li>)}
          </ul>
          <details className="about-group">
            <summary>Bug reports and testing ({testers.handles.length})</summary>
            <p>Thank you to everyone who reported problems or commented on the project's GitHub issues and pull requests.</p>
            <ul className="about-handles">
              {testers.handles.map(handle => <li key={handle}>
                <ExternalLink href={"https://github.com/" + handle}>@{handle}</ExternalLink>
              </li>)}
            </ul>
          </details>
          <p>ChemDraft was developed with AI coding assistants.</p>
        </section>
        <section aria-labelledby="about-section-2">
          <h2 id="about-section-2" tabIndex={-1}>Open-source components and provenance</h2>
          <p className="about-links">
            <ExternalLink href={repository + "/blob/main/NOTICE"}>Full notices and license texts</ExternalLink>
            <ExternalLink href={repository + "/blob/main/docs/architecture/dependency-inventory.md"}>Dependency inventory</ExternalLink>
          </p>
          <details className="about-group">
            <summary>Packages, versions, licenses and copyright holders ({components.length})</summary>
            <ul className="about-credits">
              {components.map(component => <li key={component.name}>
                <h3><ExternalLink href={component.sourceUrl}>{component.name}</ExternalLink></h3>
                <p className="about-version">{component.version} · {component.license}</p>
                <p className="about-holders">Authors and copyright holders: {component.holders.join("; ")}</p>
                <p>{component.purpose}</p>
                {component.licenseText && <button type="button" onClick={() => showLicense(component.licenseText!, component.name + " license")}>Read the license</button>}
              </li>)}
            </ul>
          </details>
        </section>
      </div>
    </>}
    {onClose && <footer>{error && <p role="alert">{error}</p>}<button type="button" onClick={onClose}>Close</button></footer>}
  </main>;
}

export function BrowserAboutWindow() {
  const version = packageInfo.version;
  const buildStamp = new URLSearchParams(window.location.search).get("buildStamp")?.slice(0, 128) || __BUILD_STAMP__;
  useEffect(() => { document.title = "About ChemDraft"; }, []);
  return <AboutWindow version={version} buildStamp={buildStamp}
    onCopy={() => navigator.clipboard.writeText("ChemDraft " + version + " (build " + buildStamp + ")")} />;
}
