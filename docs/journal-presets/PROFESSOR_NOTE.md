# Explanation for my professor

I used an AI coding assistant to develop a journal-formatting feature for the open-source ChemDraft
project. It adds Edit > Journal Presets, with twenty journal-specific entries, including ACS, RSC,
Nature Portfolio and Cell journals. The user can search, review source links and proposed changes,
choose selection or document scope, and apply the settings in one undoable operation.

Journal identities came from Crossref; formatting facts came from official journal/publisher
instructions. Every profile states partial coverage and preserves unknown settings. Journals whose
instructions could not be verified were omitted. No proprietary style sheets were copied.

The work includes chemistry-preservation, scope, cancellation, history, save/reopen and export checks.
The testing report distinguishes actual passes, failed attempts and untested native platform behavior.
The draft pull request is a contribution for review, not a claim that the feature has been accepted
or that every journal requirement is automated. I am responsible for reviewing and explaining the
AI-assisted work, including its limitations. The earlier bug-fix PR is separate.
