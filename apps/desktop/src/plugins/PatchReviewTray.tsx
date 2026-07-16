import { useMemo, useState } from "react";
import type { PluginHost, QueuedProposedPatch } from "@chemdraft/plugin-host";

/**
 * Review affordance for the proposePatch flow. Plugins queue document changes; the user
 * accepts or rejects them here. Plugins never mutate the document directly — this tray is
 * the only path from a proposal into document history.
 */
export function PatchReviewTray({
  host,
  queueVersion,
  onAccept,
  onReject
}: {
  host: PluginHost;
  /** Bumped by the host's onProposedPatchesChanged callback so the pending list recomputes. */
  queueVersion: number;
  onAccept(proposal: QueuedProposedPatch): void;
  onReject(proposal: QueuedProposedPatch): void;
}) {
  const [open, setOpen] = useState(false);
  const pending = useMemo(
    () => host.listProposedPatches("pending"),
    // queueVersion is the change signal; the host itself is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [host, queueVersion]
  );

  if (pending.length === 0) {
    return null;
  }

  return (
    <div className="patch-review-tray" data-patch-review-tray="true">
      {open ? (
        <div className="patch-review-popover" role="dialog" aria-label="Plugin proposals awaiting review">
          {pending.map((proposal) => {
            const plugin = host.getPlugin(proposal.pluginId);
            return (
              <div className="patch-review-item" key={proposal.id} data-proposal-id={proposal.id}>
                <div className="patch-review-item-header">
                  <span className="patch-review-plugin">{plugin?.manifest.name ?? proposal.pluginId}</span>
                </div>
                <p className="patch-review-reason">{proposal.proposal.reason}</p>
                {proposal.proposal.warnings.length > 0 ? (
                  <ul className="patch-review-warnings">
                    {proposal.proposal.warnings.map((warning) => (
                      <li key={warning.code}>{warning.message}</li>
                    ))}
                  </ul>
                ) : null}
                <div className="patch-review-actions">
                  <button type="button" onClick={() => onAccept(proposal)}>
                    Accept
                  </button>
                  <button type="button" onClick={() => onReject(proposal)}>
                    Reject
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
      <button
        type="button"
        className="patch-review-badge"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {pending.length === 1 ? "1 plugin proposal" : `${pending.length} plugin proposals`}
      </button>
    </div>
  );
}
