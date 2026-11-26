import { useEffect, useId, useRef, useState } from "react";
import type { AppHandoffConsent, AppHandoffConsents } from "./consents";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function AppHandoffConsentSection({ consents, pluginNames, catalogKey, disabled }: {
  consents: AppHandoffConsents;
  pluginNames: ReadonlyMap<string, string>;
  catalogKey: string;
  disabled: boolean;
}) {
  const titleId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const listGeneration = useRef(0);
  const [rows, setRows] = useState<readonly AppHandoffConsent[]>();
  const [revision, setRevision] = useState(0);
  const [revoking, setRevoking] = useState<string>();
  const [readError, setReadError] = useState<string>();
  const [revokeError, setRevokeError] = useState<string>();
  useEffect(() => {
    let active = true;
    const generation = listGeneration.current;
    const current = () => active && generation === listGeneration.current;
    void consents.list().then(rows => {
      if (!current()) return;
      setRows(rows);
      setReadError(undefined);
    }, (error: unknown) => {
      if (current()) setReadError(`Could not list app handoff consents: ${errorMessage(error)}`);
    });
    return () => { active = false; };
  }, [catalogKey, consents, revision]);
  useEffect(() => {
    const refresh = () => setRevision(value => value + 1);
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);

  const revoke = async (row: AppHandoffConsent, button: HTMLButtonElement) => {
    setRevoking(row.consentId);
    setRevokeError(undefined);
    try {
      await consents.revoke(row.pluginId, row.consentId);
      listGeneration.current += 1;
      const { activeElement, body } = button.ownerDocument;
      if (activeElement === button || activeElement === body) heading.current?.focus();
      const matches = (item: AppHandoffConsent) => item.pluginId === row.pluginId && item.consentId === row.consentId;
      setRows(current => row.status === "conflict"
        ? current?.filter(item => !matches(item))
        : current?.map(item => matches(item) ? { ...item, status: "revoked" } : item));
      setRevision(value => value + 1);
    } catch (error) {
      setRevokeError(`Could not revoke app handoff to ${row.appName}: ${errorMessage(error)}`);
    } finally {
      setRevoking(undefined);
    }
  };

  return <section className="plugin-manager-available" aria-labelledby={titleId}>
    <h3 ref={heading} id={titleId} tabIndex={-1}>App handoff consents</h3>
    {readError && <p role="alert">{readError}</p>}
    {revokeError && <p role="alert">{revokeError}</p>}
    {!rows && !readError && <p role="status">Loading app handoff consents…</p>}
    {rows?.length === 0 && <p className="plugin-manager-available-empty">No app handoff consents.</p>}
    {rows && rows.length > 0 && <ul className="plugin-manager-list">
      {rows.map(row => {
        const pluginName = pluginNames.get(row.pluginId);
        const conflict = row.status === "conflict";
        const operation = row.pipeline ? `Pipeline ${row.pipeline}` : "File handoff";
        return <li className="plugin-manager-item" key={`${row.pluginId}/${row.consentId}`}>
          <div className="plugin-manager-details">
            <div className="plugin-manager-name">{row.appName}</div>
            <p>{pluginName ? `${pluginName} (${row.pluginId})` : row.pluginId} · {conflict ? "All operations" : operation} · {
              { allowed: "Allowed", inactive: "Inactive", revoked: "Revoked", conflict: "Conflicting consents" }[row.status]
            }</p>
            <p className="plugin-manager-id">{row.appPath}</p>
          </div>
          {row.status !== "revoked" && <button type="button" className="plugin-manager-button" disabled={disabled || revoking !== undefined}
            aria-label={`Revoke app handoff from ${pluginName ?? row.pluginId} to ${row.appName} (${conflict ? "all operations" : operation})`} onClick={event => void revoke(row, event.currentTarget)}>
            {revoking === row.consentId ? "Revoking…" : "Revoke"}
          </button>}
        </li>;
      })}
    </ul>}
  </section>;
}
