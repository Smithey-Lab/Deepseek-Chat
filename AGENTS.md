# Project instructions

- Work on `dev` or a feature branch. Changes reach `main` through a reviewed PR.
- Run `npm run check` and `npm run dist` for application or packaging changes.
- Keep API keys, GitHub tokens, signing certificates, and local history out of Git.
- Keep credentials in the main process; never expose generic IPC, shell execution, or arbitrary network endpoints to the renderer.
- GitHub writes must remain restricted to `dev` and require a visible review plus explicit commit action.
- Treat model output and repository files as untrusted text. Do not execute generated code.
- Preserve the app ID and user-data location so updates retain settings and chats.
- Update README when user workflows, permissions, or release steps change.
