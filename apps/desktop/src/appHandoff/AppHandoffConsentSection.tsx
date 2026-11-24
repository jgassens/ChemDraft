import { useEffect, useId, useState } from "react";
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
  const [rows, setRows] = useState<readonly AppHandoffConsent[]>();
  const [revision, setRevision] = useState(0);
  const [revoking, setRevoking] = useState<string>();
  const [readError, setReadError] = useState<string>();
  const [revokeError, setRevokeError] = useState<string>();
  useEffect(() => {
    let active = true;
    void consents.list().then(rows => {
      if (!active) return;
      setRows(rows);
      setReadError(undefined);
    }, (error: unknown) => {
      if (active) setReadError(`Could not list app handoff consents: ${errorMessage(error)}`);
    });
    return () => { active = false; };
  }, [catalogKey, consents, revision]);
  useEffect(() => {
    const refresh = () => setRevision(value => value + 1);
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);

  const revoke = async (row: AppHandoffConsent) => {
    setRevoking(row.appId);
    setRevokeError(undefined);
    try {
      await consents.revoke(row.pluginId, row.appId);
      setRows(current => current?.map(item => item.pluginId === row.pluginId && item.appId === row.appId
        ? { ...item, granted: false } : item));
      setRevision(value => value + 1);
    } catch (error) {
      setRevokeError(`Could not revoke app handoff to ${row.appName}: ${errorMessage(error)}`);
    } finally {
      setRevoking(undefined);
    }
  };

  return <section className="plugin-manager-available" aria-labelledby={titleId}>
    <h3 id={titleId}>App handoff consents</h3>
    {readError && <p role="alert">{readError}</p>}
    {revokeError && <p role="alert">{revokeError}</p>}
    {!rows && !readError && <p role="status">Loading app handoff consents…</p>}
    {rows?.length === 0 && <p className="plugin-manager-available-empty">No app handoff consents.</p>}
    {rows && rows.length > 0 && <ul className="plugin-manager-list">
      {rows.map(row => {
        const pluginName = pluginNames.get(row.pluginId);
        return <li className="plugin-manager-item" key={`${row.pluginId}/${row.appId}`}>
          <div className="plugin-manager-details">
            <div className="plugin-manager-name">{row.appName}</div>
            <p>{pluginName ? `${pluginName} (${row.pluginId})` : row.pluginId} · {row.pipeline ? `Pipeline ${row.pipeline}` : "File handoff"} · {row.granted ? "Allowed" : "Revoked"}</p>
            <p className="plugin-manager-id">{row.appPath}</p>
          </div>
          {row.granted && <button type="button" className="plugin-manager-button" disabled={disabled || revoking !== undefined}
            aria-label={`Revoke app handoff from ${pluginName ?? row.pluginId} to ${row.appName}`} onClick={() => void revoke(row)}>
            {revoking === row.appId ? "Revoking…" : "Revoke"}
          </button>}
        </li>;
      })}
    </ul>}
  </section>;
}
