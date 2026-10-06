# RP4 evidence-faithful citations verified

- Scope audit found the planned behavior already implemented: `ChatMessageView.citations: Citation[]`, version-specific download links, version labels, mismatch warnings, and optional `getDownloadUrl` version validation.
- Existing tests cover resume citation preservation, turn-record citation preservation, versioned citation rendering, mismatch warning, and source-service version validation.
- Unit regression: assistant message-model + message-list + assistant-view: 3 files, 44 tests passed.
- Contract/source regression: contracts, conversation-resume, and source-service: 3 files, 42 tests passed.
- Static: apps/web and packages/contracts typechecks passed; targeted ESLint passed.
- No source changes were required for this slice; no push, hosted CI, or browser acceptance performed.
