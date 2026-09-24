import { useMemo, useState } from "react";
import type { PluginHost, QueuedProposedPatch } from "@chemdraft/plugin-host";
import type { PluginProposalReviewItem } from "./panelBridge";
import { recognitionStructurePreview } from "./recognitionPreview";

/**
 * Review affordance for the proposePatch flow. Plugins queue document changes; the user accepts or
 * rejects them here. This tray remains the only path from a proposal into document history;
 * command-scoped `document.write` patches deliberately bypass the proposal queue.
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

  const items = pending.map((proposal) => proposalReviewItem(host, proposal));

  return (
    <div className="patch-review-tray" data-patch-review-tray="true">
      {open ? (
        <div className="patch-review-popover" role="dialog" aria-label="Plugin proposals awaiting review">
          <PatchReviewList
            proposals={items}
            onAccept={(proposalId) => {
              const proposal = pending.find((candidate) => candidate.id === proposalId);
              if (proposal) onAccept(proposal);
            }}
            onReject={(proposalId) => {
              const proposal = pending.find((candidate) => candidate.id === proposalId);
              if (proposal) onReject(proposal);
            }}
          />
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

/** Shared proposal body used by the browser tray and the desktop analysis window. */
export function PatchReviewList({
  proposals,
  onAccept,
  onReject
}: {
  proposals: readonly PluginProposalReviewItem[];
  onAccept(proposalId: string): void;
  onReject(proposalId: string): void;
}) {
  return (
    <div className="patch-review-list" data-testid="patch-review-list">
      {proposals.map((proposal) => (
        <div className="patch-review-item" key={proposal.id} data-proposal-id={proposal.id}>
          <div className="patch-review-item-header">
            <span className="patch-review-plugin">{proposal.pluginName}</span>
          </div>
          <p className="patch-review-reason">{proposal.reason}</p>
          {proposal.recognition ? (
            <div className="patch-review-recognition" data-testid="recognition-proposal-preview">
              <img src={proposal.recognition.sourceImageRef} alt="Source submitted for structure recognition" />
              <div>
                <span className={`patch-review-confidence is-${proposal.recognition.confidenceTier}`}>
                  {capitalize(proposal.recognition.confidenceTier)} confidence
                </span>
                {proposal.structurePreview ? (
                  <img
                    className="patch-review-structure"
                    src={proposal.structurePreview}
                    alt="Recognized structure"
                    data-testid="recognition-structure-preview"
                  />
                ) : null}
                {proposal.recognition.proposedSmiles ? (
                  <p>
                    Recognized structure: <code>{proposal.recognition.proposedSmiles}</code>
                  </p>
                ) : (
                  <p>Recognized structure: MOL structure ready for review</p>
                )}
              </div>
            </div>
          ) : null}
          {proposal.warnings.length > 0 ? (
            <ul className="patch-review-warnings">
              {proposal.warnings.map((warning) => (
                <li key={warning.code}>{warning.message}</li>
              ))}
            </ul>
          ) : null}
          <div className="patch-review-actions">
            <button type="button" onClick={() => onAccept(proposal.id)}>
              Accept
            </button>
            <button type="button" onClick={() => onReject(proposal.id)}>
              Reject
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

export function proposalReviewItem(host: PluginHost, proposal: QueuedProposedPatch): PluginProposalReviewItem {
  return {
    id: proposal.id,
    pluginId: proposal.pluginId,
    pluginName: host.getPlugin(proposal.pluginId)?.manifest.name ?? proposal.pluginId,
    reason: proposal.proposal.reason,
    warnings: proposal.proposal.warnings.map(({ code, message }) => ({ code, message })),
    recognition: proposal.proposal.recognition,
    structurePreview: recognitionStructurePreview(proposal.proposal)
  };
}

function capitalize(value: string): string {
  return value.length === 0 ? value : `${value[0].toUpperCase()}${value.slice(1)}`;
}
