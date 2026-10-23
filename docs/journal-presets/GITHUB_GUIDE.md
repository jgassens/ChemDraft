# Prepare a separate journal-feature contribution

This guide documents the beginner Git workflow. Actual publication status and the PR link are
recorded in the delivery message and on GitHub. The existing bug-fix PR #151 is separate.
The prepared branch is `codex/journal-formatting-presets`, based on upstream commit
`b1325d561ff273ca1e4c1a6ad6fa19b5665739e6`. Native platform checks remain outstanding;
keep any PR a draft until the repository's required checks pass.

## On this prepared computer

The edited files are already in the `contribution` folder, on the separate feature branch.
Do not apply the patch there again. Do not repeat commit/push/PR creation if the delivery message
already provides the published branch and PR; use these steps as an explanation or on a fresh checkout.
Open Terminal in that folder, then use `git status` and `git diff` to review changes.
The submission package's `FILES_TO_INCLUDE.txt` lists both existing and new contribution files.
The `files/` folder preserves their repository paths. Do not commit the package, screenshots,
local launcher, test logs, `node_modules`, build outputs, temporary Rust tools, or the previous bug-fix checkout.

## On another computer, step by step

1. Install [Git](https://git-scm.com/downloads) and sign in at [GitHub](https://github.com/).
   Git provides the `git` terminal command. GitHub is the website/account that hosts the fork.
   Install Node.js 24 from its official website. In Terminal/PowerShell, run
   `npm install --global pnpm@10.12.1` to install this project's package manager.
   For GitHub sign-in from Terminal, you may install [GitHub CLI](https://cli.github.com/) and run
   `gh auth login`, choosing GitHub.com, HTTPS and browser sign-in. This establishes authentication;
   it does not publish your code. Never paste a password or token into chat.
   Native prerequisites are in the repository README; browser preview does not need Rust.
2. Visit [the original repository](https://github.com/jgassens/ChemDraft) and click **Fork**.
   Your existing fork is [tfairuz38/ChemDraft_tahia](https://github.com/tfairuz38/ChemDraft_tahia).
   Reuse it rather than creating another. Copy its HTTPS address from **Code**.
3. Open Terminal (macOS) or PowerShell (Windows) in a folder where you want the project.
   The verified fork URL is used below; run:

   `git clone https://github.com/tfairuz38/ChemDraft_tahia.git ChemDraft-journals`

   This downloads your fork into a new folder. Then run:

   `cd ChemDraft-journals`

   Every remaining command runs from inside this new folder.
4. `git remote add upstream https://github.com/jgassens/ChemDraft.git`

   This names the original repository so you can retrieve the exact base.
5. `git fetch upstream`

   This downloads the original project's commit history; it does not edit your files.
6. `git switch -c codex/journal-formatting-presets b1325d561ff273ca1e4c1a6ad6fa19b5665739e6`

   This creates the separate feature branch from the audited base, keeping the bug-fix branch separate.
7. `git apply --check "/FULL/PATH/TO/journal-presets.patch"`

   Replace the quoted path with your downloaded patch path (Windows paths can use forward slashes).
   This checks whether the patch fits without changing anything. If it fails, stop and review the
   difference; do not force it over unrelated work.
8. `git apply "/FULL/PATH/TO/journal-presets.patch"`

   This applies the contribution, including new catalog, source and test files.
9. `git status` lists changed and new files. `git diff` shows existing-file edits.
   Open new files in your editor too. Compare against FILES_TO_INCLUDE.txt.
10. Follow MANUAL_TESTING.md and TEST_RESULTS.md. Run the repository's required native checks on both
    macOS and Windows before considering the feature merge-ready. Do not label unrun checks as passed.
11. Configure your commit identity once, using your own values:

    `git config user.name "YOUR NAME"`

    `git config user.email "YOUR GITHUB NOREPLY OR COMMIT EMAIL"`

    These set the author displayed on commits in this checkout. GitHub's Settings > Emails provides
    a noreply address if you prefer not to publish a personal email.
12. `git add --pathspec-from-file="/FULL/PATH/TO/FILES_TO_INCLUDE.txt"`

    Replace the path with the review package manifest. This stages only the listed feature files.
    Use this in the clean checkout just created; check that no
    unrelated edits are included. `git diff --cached --stat` lists staged files, and
    `git diff --cached` shows exactly what the commit would contain, including new files.
13. `git commit -m "Add sourced journal formatting presets"`

    This creates a local commit after your review. It does not publish anything.
14. `git push -u origin codex/journal-formatting-presets`

    This publishes the branch to your fork. Complete GitHub's normal authentication if prompted;
    never paste a token or password into chat.
15. On your fork's GitHub page, click **Compare & pull request**. Base repository:
    `jgassens/ChemDraft`, base branch: `main`. Head: your fork's `codex/journal-formatting-presets`.
    Review **Files changed** and use PR_DESCRIPTION.md as the draft text. Include actual latest
    test results and the pending native checks. Choose **Create draft pull request**.
16. Copy your fork URL and the newly created PR URL into your message to your professor.
    PROFESSOR_NOTE.md explains the contribution and its limits. Do not call the journal presets
    fully compliant or the PR accepted merely because it was submitted.

If upstream has changed, GitHub may show conflicts. Resolve and retest them before marking the PR ready.

## Open the published feature on another computer

After publication, from a parent folder in Terminal/PowerShell:

`git clone --branch codex/journal-formatting-presets https://github.com/tfairuz38/ChemDraft_tahia.git ChemDraft-journals`

This downloads the feature branch into `ChemDraft-journals`. Then `cd ChemDraft-journals` enters it.
`pnpm install --frozen-lockfile` installs the existing dependencies. `pnpm dev:web` starts the browser
preview; open the local address printed in Terminal. Choose Edit > Journal Presets, then load the
fifteen-entry optional pack to see all twenty approved journals. See MANUAL_TESTING.md.

For Windows, use the CI-produced installer for native testing; repository instructions prohibit
building release installers locally. Both native platforms still need the required runtime checks.
