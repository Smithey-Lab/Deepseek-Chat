# DeepSeek Workspace

A Windows desktop workspace for DeepSeek conversations and a deliberate GitHub coding workflow: edit on `dev`, review with Codex, then merge into `main`.

## v0.3 agent workspace

In **Agent tasks**, load repositories (or use the editor's repository), select a model, and enter up to 30 tasks, one per line. Click **Start work on dev** and approve the task list once. The agent reads the existing project, follows applicable `AGENTS.md` files, and stages coordinated additions, edits, and deletions. On completion it publishes one commit to `dev` automatically. The app never merges `main`.

Come back to **Run history** to inspect task results, logs, and before/after file contents. Open GitHub to review `dev` against `main` with Codex and decide whether to merge. Completion is the model's implementation report, not a guarantee of correctness: **the agent does not execute code or tests**. Repository CI remains the validation step before merging.

Keep the app running. It prevents idle sleep during a run and minimizes when closed during work; a shutdown or forced exit interrupts it. Interrupted work is preserved locally, with no automatic retry. Start a new run from the latest `dev`. If publication was interrupted, check the saved commit on GitHub before retrying. A missing `dev` can be created in **GitHub & code** first.

Runs are bounded to 10–80 model steps, 40 changed files, 100 KB per UTF-8 file, 1 MB of staged output, and a bounded context. If a task is blocked, the budget is exhausted, the model response is invalid, or `dev` changes concurrently, edits remain local and are not published. Cancellation stops a run before publication; once the ref update begins, wait for its outcome. Large projects and task lists may need to be split into smaller batches. The most recent 20 reports are retained locally. API calls are billed to your DeepSeek account.

- Chat using your own DeepSeek API key; refresh available models from your account.
- Local conversation history, cancellation, and copyable code responses.
- Discover repositories from your GitHub account, search/filter/favorite them, and pick a branch without typing repository names.
- Browse UTF-8 files on any branch; edits and commits stay restricted to `dev`. Create a missing `dev` branch after confirmation.
- Recover editor drafts (including new files) from the Saved editor drafts list, with autosave across restarts.
- Search, rename, pin, archive, import, and export conversations; keep separate message drafts and model selections.
- Inspect recent commits, compare branches, and open pull requests for review.
- Attach editor contents to a chat draft; review before/after contents and explicitly commit a file to `dev`.
- Windows NSIS installer and in-app update checks, download, and restart/install.
- Sandboxed renderer, narrow validated IPC, fixed API hosts, and Windows-encrypted credentials.

The [57-feature acceptance checklist](docs/FEATURES-v0.2.md) documents the previous workspace release. Agent tasks add multi-file automatic dev commits; the manual editor retains its explicit review-and-commit workflow. Local clones, terminal execution, and automatic Codex review are not included.

In **GitHub & code**, click **Load repositories**, choose a repository, then **Open repository**. Choose **dev** for editing. Other branches are read-only. In **Settings**, use the connection tests to check credentials independently. Repository lists reflect the token's access; organization approval and repository permissions still apply.

## Development

Install Node.js 24 LTS and Git, then:

```powershell
npm ci
npm start
npm run check
npm run test:desktop
npm run dist
```

The installer is written to `dist/`. Install it once for normal use. Development runs cannot install updates.

In **Settings & updates**, save a DeepSeek API key and a GitHub fine-grained token scoped to selected repositories with **Contents: read and write**. Editing GitHub workflow files may require additional workflow permissions. Refresh models in the chat toolbar to discover the model IDs available to your account.

## Branches and review

- `dev`: integration branch; direct app commits allowed; force-push and deletion blocked.
- `feature/*`: optional feature branches; submit a pull request into `dev`.
- `main`: release branch; pull request, passing Quality and Windows installer checks, and resolved conversations required, including administrators.
- Promote the long-lived `dev` branch with a merge commit, then fast-forward `dev` to `main`. This preserves shared history for the next update without force-pushing protected branches. Squash is available for short-lived feature branches.
- Open a `dev` → `main` pull request and have Codex review it before merging. Codex review is a documented human step, not an automatically enforced integration. Required approval count is zero so a single-owner repository is not blocked by GitHub's self-approval restriction.

CI runs lint, formatting, behavioral tests, production dependency audit, and installer packaging. Dependabot updates target `dev`. Reapply repository settings with `npm run repo:setup` when authenticated through `gh auth login`.

The desktop smoke test runs the real Electron UI with isolated temporary app data and mocked provider responses. It verifies encrypted credentials, chat persistence, text rendering, repository editing, and the dev-only review gate. It does not spend API credits or modify a real GitHub repository.

## Publish an update

After reviewed changes land on `main`, run:

```powershell
# First release or explicit version:
powershell -File scripts/release.ps1 -Version 0.3.0
# Subsequent patch release, based on the latest published version:
npm run release:patch
```

You can also run **Release Windows app** from GitHub Actions and enter a stable version. The workflow only runs from `main`, validates a strictly newer release version, runs checks, builds the installer, and uploads the `.exe`, blockmap, and `latest.yml` to GitHub Releases. The release version is injected into the build; the release tag records the reviewed source commit. There is no release-version commit to protected `main`.

In the installed app, use **Settings & updates → Check for updates → Download update → Restart & install**. Your app data persists across updates. Initial builds are unsigned and may trigger Windows SmartScreen; add a trusted Windows signing certificate before wider distribution. Do not put signing keys in the repository.

## Data and boundaries

Credentials are encrypted using Electron `safeStorage` (Windows DPAPI) and are never returned to the renderer. Conversations, editor drafts, and agent reports (including file contents) are readable JSON in `%APPDATA%/DeepSeek Workspace` (development may use the package name). Deleting a conversation removes it from local history. Removing credentials does not revoke them at their providers. Messages, attached files, and project files read during an authorized agent run are sent to DeepSeek; GitHub operations go directly to GitHub. Drafts autosave locally; Ctrl+S flushes an editor draft. Closing flushes pending saves. Remote content is displayed as text and never executed. Manual commits use GitHub file SHAs; agent commits use a pinned parent and a non-forced ref update so concurrent changes cannot be silently overwritten. Agent publication errors can be ambiguous, so the report retains the commit ID for inspection. Token estimates and manual line-change counts are approximate.

## Roadmap

1. Streaming responses and richer Markdown rendering.
2. Local clones, resumable runs, and richer patch review.
3. Explicitly approved tools, sandboxed execution, and test feedback.
4. Signed releases and end-to-end update testing across two published versions.
