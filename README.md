# DeepSeek Workspace

A Windows desktop workspace for DeepSeek conversations and a deliberate GitHub coding workflow: edit on `dev`, review with Codex, then merge into `main`.

## First milestone

- Chat using your own DeepSeek API key; refresh available models from your account.
- Local conversation history, cancellation, and copyable code responses.
- Browse UTF-8 files on a GitHub repository's `dev` branch.
- Attach editor contents to a chat draft; review before/after contents and explicitly commit a file to `dev`.
- Windows NSIS installer and in-app update checks, download, and restart/install.
- Sandboxed renderer, narrow validated IPC, fixed API hosts, and Windows-encrypted credentials.

The assistant does not execute commands or commit autonomously. This first milestone supports single-file edits, not local repository cloning, multi-file agent plans, terminal execution, or automatic Codex review. These are future milestones.

## Development

Install Node.js 24 LTS and Git, then:

```powershell
npm ci
npm start
npm run check
npm run dist
```

The installer is written to `dist/`. Install it once for normal use. Development runs cannot install updates.

In **Settings & updates**, save a DeepSeek API key and a GitHub fine-grained token scoped to selected repositories with **Contents: read and write**. Editing GitHub workflow files may require additional workflow permissions. Refresh models in the chat toolbar to discover the model IDs available to your account.

## Branches and review

- `dev`: integration branch; direct app commits allowed; force-push and deletion blocked.
- `feature/*`: optional feature branches; submit a pull request into `dev`.
- `main`: release branch; pull request, passing Quality and Windows installer checks, resolved conversations, and linear history required, including administrators.
- Open a `dev` → `main` pull request and have Codex review it before merging. Codex review is a documented human step, not an automatically enforced integration. Required approval count is zero so a single-owner repository is not blocked by GitHub's self-approval restriction.

CI runs lint, formatting, behavioral tests, production dependency audit, and installer packaging. Dependabot updates target `dev`. Reapply repository settings with `npm run repo:setup` when authenticated through `gh auth login`.

## Publish an update

After reviewed changes land on `main`, run:

```powershell
# First release or explicit version:
powershell -File scripts/release.ps1 -Version 0.1.0
# Subsequent patch release, based on the latest published version:
npm run release:patch
```

You can also run **Release Windows app** from GitHub Actions and enter a stable version. The workflow only runs from `main`, validates a strictly newer release version, runs checks, builds the installer, and uploads the `.exe`, blockmap, and `latest.yml` to GitHub Releases. The release version is injected into the build; the release tag records the reviewed source commit. There is no release-version commit to protected `main`.

In the installed app, use **Settings & updates → Check for updates → Download update → Restart & install**. Your app data persists across updates. Initial builds are unsigned and may trigger Windows SmartScreen; add a trusted Windows signing certificate before wider distribution. Do not put signing keys in the repository.

## Data and boundaries

Credentials are encrypted using Electron `safeStorage` (Windows DPAPI) and are never returned to the renderer. Conversations are readable JSON in `%APPDATA%/DeepSeek Workspace` (development may use the package name). Deleting a conversation removes it from local history. Removing credentials does not revoke them at their providers. Messages and explicitly attached files are sent to DeepSeek; GitHub operations go directly to GitHub. Editor drafts are not persisted: save or commit before closing. Remote content is displayed as text and never executed. Commits use GitHub file SHAs so concurrent changes fail instead of being silently overwritten.

## Roadmap

1. Streaming responses, richer Markdown/code rendering, and conversation export.
2. Repository selection, local clones, multi-file proposals, and patch review.
3. Explicitly approved tools, sandboxed execution, and test feedback.
4. Signed releases and end-to-end update testing across two published versions.
