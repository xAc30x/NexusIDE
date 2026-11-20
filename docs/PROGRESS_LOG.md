# NexusIDE Progress Log

Each session appends one section. Keep the headings below so later entries stay comparable.

## 2026-11-20 01:23 ET — Cursor-shaped Agent Host

Merged in https://github.com/xAc30x/NexusIDE/pull/13.

### Accomplishments

- New chats in a local folder open on Agent Host Claude. Copilot and Codex stay in the picker.
- Cmd+K uses the existing inline chat zone through Agent Host. `chat.inlineChat.agentHost.enabled` defaults to true and still applies on startup.
- The mode picker has Plan. It is a builtin mode of kind Agent, with id and name `plan`. Selecting it sets the Claude permission mode to `plan`. Switching back to Agent, Ask, or Edit restores `default`. Accepting the existing plan card is what allows file edits.
- The NexusIDE Chat sidebar view and its test are unregistered. The main window uses the Agent Host chat panel.
- `Isolate Chat in Worktree` calls `createDetachedWorktree` when the host can create one. Otherwise it records worktree isolation so the host creates the checkout on the next send of a chat that has not started. A normal send still edits the open folder.
- `pnpm run typecheck-client` passed. Session-default, mode, plan-permission, and worktree tests passed (87). Inline-chat resolver and Agents editor tests passed (22).

### Architectural decisions

- Agent Host in the utility process is the only new-chat orchestrator. The workbench stays the client. No renderer-owned Claude service, no second edit UI, and no new `ChatModeKind`.
- Claude is the computed default only when the host is on, the workspace is a local folder, the Claude provider is enabled and registered, and no managed policy, enforced sandbox, or temporary Local escape hatch says otherwise. Remembered picker choices still win.
- Plan permission changes apply only to Agent Host Claude sessions in the main window. The Agents window keeps its own approvals picker.
- The caller check kept the Claude CLI channel. The Agents window that landed on main still sends through `IAIService`, so `src/vs/platform/ai` and the workbench proxy stay. Only the sidebar registration was removed.
- Isolation stays explicit. `createDetachedWorktree` succeeds only for a creating session that is already pending a worktree. Recording isolation on that success would create a second checkout, so the command does one or the other.

### Fixes

- Remembered Claude selections are stored with `storeUserSelectedSessionType`. `recordUserSelectedSessionType` clears storage when the choice equals the new Claude default.
- Edit stays in the picker with Ask, Agent, and Plan. Plan is hidden when the user turns the tools agent off.

### Blockers

- None for this slice.
- A chat that has already been sent does not move when isolation is recorded. Claude workspace conversion is off, and `createDetachedWorktree` refuses a session that is no longer being created.

### Next steps

- Local tree-sitter and embedding index, as a later Agent Host utility-process worker, with ignore-file rules and trust gating.
- Tab autocomplete, cloud agents, and Debug mode.
- Leave the current Chat panel chrome in place: no shadow window, no new editor zone, and no new status-bar badge.
