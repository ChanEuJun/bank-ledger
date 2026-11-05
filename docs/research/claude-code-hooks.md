# Claude Code hook mechanics for the harness

Research for #13. Question: how to write (a) a PreToolUse guard that stops Claude editing `tests/invariants/` and already-applied migrations, (b) a PostToolUse step that runs Biome format and `tsc --noEmit` on the changed package and reports errors to Claude, and (c) a Stop hook that runs the fast test suite without looping. Also: which settings file to commit.

Checked against Claude Code **v2.1.318** and the docs as published on 2026-11-05. Primary sources:

- Hooks reference: https://code.claude.com/docs/en/hooks (the older `docs.claude.com/en/docs/claude-code/hooks` URL redirects here)
- Hooks guide: https://code.claude.com/docs/en/hooks-guide
- Settings: https://code.claude.com/docs/en/settings
- Permissions: https://code.claude.com/docs/en/permissions
- Tools reference: https://code.claude.com/docs/en/tools-reference
- Sandboxing: https://code.claude.com/docs/en/sandboxing
- Drizzle migrator source: https://github.com/drizzle-team/drizzle-orm/blob/main/drizzle-orm/src/migrator.ts and `pg-core/dialect.ts`

## TL;DR

- Commit hooks in **`.claude/settings.json`**, with scripts in `.claude/hooks/`. `.claude/settings.local.json` is for personal overrides and stays out of git.
- **PreToolUse guard**: match `Edit|Write|MultiEdit|NotebookEdit`, read `tool_input.file_path` (or `notebook_path`), and **exit 2** with a reason on stderr to block. Set `"onFailure": "block"` so a broken script fails closed. The hook alone can't stop Bash writes, so pair it with an `Edit(...)` **permission deny rule** and a **CI check**, which is the only hard guarantee.
- **"Already applied" = tracked on `origin/main`** (`git cat-file -e origin/main:<path>`). The Drizzle journal only records migrations that were *generated*, not *applied*. Drizzle's migrator never re-checks old files, so an edited applied migration is silently ignored. That's why the guard is needed.
- **PostToolUse**: the tool has already run, so this hook can't undo anything. It can only report. Exit 2 with errors on stderr (or exit 0 with `{"decision":"block","reason":...}`) and Claude sees them next to the tool result.
- **Stop**: run the tests. If they fail and `stop_hook_active` is false, block with `{"decision":"block","reason":<failures>}`. If `stop_hook_active` is true, exit 0 so Claude can stop. Claude Code also forces a stop after 8 blocks in a row with no tool call in between.

## 1. Which settings file

| File | Scope | Commit? |
|---|---|---|
| `.claude/settings.json` | everyone using this project | yes: "commit it so teammates get it" (settings) |
| `.claude/settings.local.json` | you, this project | no: Claude Code adds it to your global git excludes the first time it writes the file |
| `~/.claude/settings.json` | you, all projects | n/a |

Hooks from every level are **merged, not replaced**, and an identical handler defined twice runs once (hooks reference, "Hook locations" and "Hook handler fields").

Gotchas that matter here:

- **Workspace trust**: an interactive session holds back all settings-file hooks until the folder is trusted. A `-p`/SDK session treats the folder as trusted, so committed hooks run immediately (hooks reference, "Workspace trust").
- **Primary working directory**: Claude Code reads `.claude/settings.json` from the session's primary working directory, so start sessions at the repo root (settings).
- **Changes reload automatically**; if not, restart. Check `/hooks` to confirm a hook is registered (hooks guide, troubleshooting).

## 2. Configuration shape and matchers

```json
{
  "hooks": {
    "<Event>": [
      { "matcher": "<tool-name filter>", "hooks": [ { "type": "command", "command": "...", "args": ["..."], "timeout": 60 } ] }
    ]
  }
}
```

Matcher rules (hooks reference, "Matcher patterns"):

- `"*"`, `""`, or omitted: match everything.
- Only letters, digits, `_`, `-`, spaces, `,` and `|`: **exact** names. `Edit|Write` and `Edit, Write` both match exactly those two tools.
- Any other character: an **unanchored JS regex**, so `Edit.*` also matches `NotebookEdit`. Use `^Edit$` for an exact match.
- The `Stop` event has **no matcher support**; a matcher there is silently ignored.
- Per-handler `if` (permission-rule syntax, for example `"Edit(**/tests/invariants/**)"`) narrows tool events further. The `if` match on Bash is best effort, and the docs say to use permissions, not hooks, to enforce a hard allow or deny.

Tool names: `Edit`, `Write` and `NotebookEdit` are current built-ins (tools reference). **`MultiEdit` is legacy**: the permissions page calls it "legacy `MultiEdit`" and it is missing from the current tools table. Keeping it in an exact-match list costs nothing and covers older clients.

### Paths, `$CLAUDE_PROJECT_DIR`, and spaces

- `${CLAUDE_PROJECT_DIR}` is the project root where the session started. It is substituted into `command`/`args` and also exported as an env var to the hook process (hooks reference, "Reference scripts by path").
- **Prefer exec form** (`command` + `args`) for anything that uses a path placeholder: each `args` element is passed through as one argument with no shell quoting. This matters for us: the local checkout path contains a space (`gh projects`). In shell form, wrap the placeholder in double quotes: `"\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/x.sh"`.
- **Worktrees**: `${CLAUDE_PROJECT_DIR}` stays at the root where the session started, while the input's `cwd` follows Claude into a worktree. This repo uses agent worktrees, so scripts should find the repo from the *edited file* (`git -C "$(dirname file)" rev-parse --show-toplevel`) or from `cwd`, not from `CLAUDE_PROJECT_DIR`.
- Scripts must be executable (`chmod +x`), or be run via an interpreter in exec form (`"command": "node", "args": [...]`).

## 3. Hook input (stdin JSON)

Common fields: `session_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name`, plus `agent_id`/`agent_type` when the hook fires inside a subagent. PreToolUse and PostToolUse add `tool_name`, `tool_input` and `tool_use_id`. PostToolUse also adds `tool_response` and `duration_ms`. Stop adds `stop_hook_active`, `last_assistant_message`, `background_tasks` and `session_crons` (hooks reference, "Common input fields", "PreToolUse input", "PostToolUse input", "Stop input").

`tool_input` per tool:

| Tool | Path field | Other fields |
|---|---|---|
| `Write` | `file_path` | `content` |
| `Edit` | `file_path` | `old_string`, `new_string`, `replace_all` |
| `NotebookEdit` | `notebook_path` (permissions page names it as NotebookEdit's primary field) | cell fields |
| `Bash` | none | `command`, `description`, `timeout`, `run_in_background` |

For `Write`, `Edit` and `Read`, **`file_path` is always absolute**. Claude Code expands `~` and relative paths before the hook runs, so a path match can't be bypassed with a relative spelling. On Windows the separators are backslashes, so normalise them, then match a path segment (`/tests/invariants/`) rather than anchoring with `^`.

Hooks also fire for subagents' tool calls (hooks reference, "Hook locations"), so the guard covers delegated work too.

## 4. Exit codes and JSON output

From hooks reference, "Exit code output", "Exit code 2 behavior per event" and "JSON output":

| Outcome | How |
|---|---|
| Success, no opinion | exit 0, no stdout |
| **Block / feed back** | **exit 2**; stderr becomes the message Claude sees. Exit 2 blocks even if the JSON on stdout says allow |
| Structured control | exit 0 and print **exactly one JSON object** on stdout (any other text, such as shell-profile echo, breaks parsing) |
| Non-blocking error | any other exit code (including **1**!). The action goes ahead. "If your hook is meant to enforce a policy, use `exit 2`." |

What exit 2 does per event:

- `PreToolUse`: blocks the tool call. Claude receives stderr as the tool error.
- `PostToolUse`: can't block (the tool already ran). Shows stderr to Claude.
- `Stop`: stops Claude from stopping; stderr is the reason it should continue.

JSON equivalents:

- PreToolUse: `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"..."}}`. The top-level `decision`/`reason` form is deprecated for PreToolUse. Precedence across hooks: deny > defer > ask > allow.
- PostToolUse / Stop: top-level `{"decision":"block","reason":"..."}`. Both also accept `hookSpecificOutput.additionalContext`. For Stop, `additionalContext` keeps the conversation going but is labelled "Stop hook feedback" rather than an error.
- Universal: `continue:false` + `stopReason` halts Claude entirely. `systemMessage` shows a warning to the **user**, not to Claude.
- Each `reason`/`additionalContext`/stdout string is **capped at 10,000 characters**. Longer output is saved to a file, and Claude only gets a 2,000-character preview plus the path. So **truncate tsc/test output** to the first N errors.

### Timeouts and failure

- Default `timeout` is **600 s** for command hooks, set per handler in seconds.
- A timed-out PreToolUse hook **does not block**: the call goes through the normal permission flow.
- **`"onFailure": "block"`** (v2.1.295+, we have v2.1.318) makes a failure fail closed: script missing, crash, exit code other than 0 or 2, timeout, or invalid JSON. Use it on the guard. It has no effect on Stop hooks.
- Matching hooks for one event run **in parallel**. Two PostToolUse handlers would not run in order, so put "format then typecheck" in **one** script.

## 5. Hook (a): the PreToolUse guard

### What counts as "already applied"

- **The Drizzle journal tells you a migration was generated, not applied.** In drizzle-orm 0.x (`latest` on npm is 0.45.4; drizzle-kit 0.31.11), `readMigrationFiles` reads `<out>/meta/_journal.json` and hashes each `.sql` file. At migrate time, Postgres reads only the **latest** row of `__drizzle_migrations` (`order by created_at desc limit 1`) and applies entries whose journal `when` is newer. **It never compares the hashes of old migrations**, so editing an applied migration is silently ignored and the schema drifts. Nothing in the journal says which migrations a given database has applied.
- **The database itself** (`__drizzle_migrations`) is the true record, but it differs per environment and would need a live DB connection inside a hook that runs before every edit. Too slow and too fragile.
- **Git is the right proxy: "the file exists on `origin/main`".** Anything merged to main may already have run somewhere and is immutable. A migration generated on the current branch and not yet merged stays editable (for example, regenerated after a schema tweak). Check with `git cat-file -e origin/main:<repo-relative-path>`. That reads a local ref, so it's fast and offline, but only as fresh as the last `git fetch`. Fall back to `main` if `origin/main` doesn't exist.
- Also block hand edits to `packages/db/**/meta/*` (journal and snapshots). `drizzle-kit generate` rewrites these through Bash, which this hook doesn't intercept.
- **Uncertain**: Drizzle 1.0 (currently `rc`) switches to a folder per migration (`<out>/<timestamp>_<name>/migration.sql` + `snapshot.json`, per https://orm.drizzle.team/docs/migrations) with no `_journal.json`. The git rule works the same way for either layout. Only the path glob changes.

### `tests/invariants/`

Block every Edit, Write and NotebookEdit on any path containing `/tests/invariants/`. Whether creating a *new* invariant file should be allowed is a policy choice. The safe default is to block it too: humans add invariants, and Claude asks.

### Sketch

`.claude/settings.json` excerpt:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit|NotebookEdit",
        "hooks": [
          {
            "type": "command",
            "command": "node",
            "args": ["${CLAUDE_PROJECT_DIR}/.claude/hooks/guard-protected.mjs"],
            "timeout": 10,
            "onFailure": "block"
          }
        ]
      }
    ]
  }
}
```

`.claude/hooks/guard-protected.mjs` (mechanism only):

```js
import { execFileSync } from "node:child_process";
import path from "node:path";

const input = JSON.parse(await new Response(process.stdin).text());
const raw = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
if (!raw) process.exit(0);
const file = raw.replaceAll("\\", "/");

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const block = (msg) => { process.stderr.write(msg); process.exit(2); };

if (file.includes("/tests/invariants/")) {
  block(`Blocked: ${raw} is an invariant test. Fix the code, not the test. Ask the user if the invariant itself is wrong.`);
}

if (/\/packages\/db\/.*(migrations|drizzle)\//.test(file)) {
  if (file.includes("/meta/")) block(`Blocked: ${raw} is drizzle-kit metadata; regenerate it with drizzle-kit instead of editing it.`);
  const root = git(path.dirname(raw), "rev-parse", "--show-toplevel");
  const rel = path.relative(root, raw).replaceAll("\\", "/");
  for (const ref of ["origin/main", "main"]) {
    try { git(root, "cat-file", "-e", `${ref}:${rel}`); }
    catch { continue; }
    block(`Blocked: ${rel} is already on ${ref}, so it may have been applied. Add a new migration instead.`);
  }
}
process.exit(0);
```

(Assumes the new migration folder sits next to the parent directory of the edited file when you call `rev-parse`. If it doesn't exist yet, walk up to the nearest existing directory.)

### Bash writes: defence in depth

A PreToolUse hook on Edit|Write never sees `sed -i`, `cat > file`, `git checkout -- file` and similar. Parsing Bash in the hook is best effort at most, and the docs say so. Layer these instead:

1. **Permission deny rules** in the committed settings:
   `"permissions": { "deny": ["Edit(tests/invariants/**)", "Edit(packages/db/**/meta/**)"] }`.
   Edit rules cover every built-in file-editing tool (Edit, Write, NotebookEdit), plus Bash file commands Claude Code recognises (`sed`, `tee`, …) and redirect targets (`> file`). They do **not** cover arbitrary subprocesses, such as a Node script that writes files. Use `Edit(...)`, not `Write(...)`: Write, NotebookEdit and MultiEdit path rules "never match" (permissions). Deny rules can't express the git-based "applied" test, so migrations still need the hook.
2. **Sandbox** `sandbox.filesystem.denyWrite` for OS-level blocking of every process (sandboxing). Optional; it may be heavy for the MVP.
3. **CI gate (the hard guarantee)**: fail the PR if `git diff --name-only origin/main...HEAD` touches `tests/invariants/**` or modifies (rather than adds) any migration file already on main. That check runs whatever tool did the write.
4. Optional extra: a PostToolUse hook on `Bash` can read `tool_response.bashEditDiff.changedFiles` (v2.1.269+) to warn after the fact. That list is documented as best effort and public beta: "use the list to find what to review, not to enforce a policy."

## 6. Hook (b): PostToolUse format + typecheck

- Match `Edit|Write|MultiEdit` (add `NotebookEdit` only if notebooks ever show up). PostToolUse fires **only on success** and **not** for files changed through Bash (hooks reference, "PostToolUse").
- Take `tool_input.file_path`, skip anything that isn't `.ts/.tsx/.js/.json`, then walk up to the nearest `package.json` to find the package.
- Run **one script, in sequence**: `pnpm exec biome format --write <file>` (or `biome check --write` to apply safe lint fixes too), then `pnpm exec tsc --noEmit -p <pkg>/tsconfig.json`.
- When either fails, write the **first ~50 lines** of output to stderr and **exit 2**. Claude sees it next to the tool result and fixes it on the next turn. Exit 0 when clean, with no output. Equivalent JSON: exit 0 with `{"decision":"block","reason":"<errors>"}`.
- Formatting rewrites the file after Claude's edit. That's fine: Edit still applies when `old_string` matches the current content, and the result tells Claude the file carries other changes, so it re-reads it (tools reference, "Edit tool behavior").
- Set `timeout` to about 120 s. A cold `tsc` across a large package can be slow, and per-edit typechecking adds latency to every edit.
  - **Uncertain**: whether per-edit `tsc` on `apps/web` is fast enough in practice. Measure it. If it's slow, consider `tsc --incremental` with a `.tsbuildinfo`, or moving the typecheck to the Stop hook.
- Biome can error on files outside its `files.includes`. Pass `--no-errors-on-unmatched` so the format step doesn't fail on ignored paths.

```json
{ "matcher": "Edit|Write|MultiEdit",
  "hooks": [ { "type": "command", "command": "node", "args": ["${CLAUDE_PROJECT_DIR}/.claude/hooks/format-typecheck.mjs"], "timeout": 120 } ] }
```

## 7. Hook (c): Stop runs the fast suite

Facts (hooks reference, "Stop", "Stop decision control"; hooks guide, "Stop hook hits the block cap"):

- Stop fires when the main agent finishes responding. It doesn't fire on a user interrupt, and API errors fire `StopFailure` instead. Subagents fire `SubagentStop`, not `Stop`.
- `stop_hook_active` is `true` when Claude is already continuing because of a Stop hook. The docs' guidance is to exit 0 early when it's true.
- There's a built-in cap: after **8 consecutive** Stop-hook continuations with no tool call in between, Claude Code overrides the block and ends the turn. Any tool call resets the count. The cap can be changed with `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`.
- Block with `{"decision":"block","reason":"..."}` (`reason` is required) or with exit 2 + stderr.

Recommended behaviour:

```js
// .claude/hooks/stop-fast-tests.mjs (mechanism only)
import { spawnSync } from "node:child_process";
const input = JSON.parse(await new Response(process.stdin).text());
const r = spawnSync("pnpm", ["turbo", "run", "test:fast", "--output-logs=errors-only"], { cwd: input.cwd, encoding: "utf8" });
if (r.status === 0) process.exit(0);
const tail = (r.stdout + r.stderr).split("\n").slice(-80).join("\n");
if (input.stop_hook_active) {
  // Already sent back once; let Claude stop, but tell the human.
  console.log(JSON.stringify({ systemMessage: "Fast tests still failing after a retry." }));
  process.exit(0);
}
console.log(JSON.stringify({ decision: "block", reason: `Fast test suite failed. Fix before finishing:\n${tail}` }));
```

Notes:

- Allowing the stop on `stop_hook_active` gives Claude **one** forced retry per stop. If the team wants Claude to keep going until green, drop that check and rely on the 8-cap. Because tool calls reset the count, a Claude that keeps editing can loop for a long time. That's the endless-loop risk the ticket mentions.
- Use `input.cwd` (it follows worktrees), not `CLAUDE_PROJECT_DIR`.
- Set `timeout` comfortably above the suite's runtime (for example 300). A Stop hook that times out renders no decision, so Claude stops.
- `onFailure` has no effect on Stop hooks.
- Optional: skip the run when `git status --porcelain` shows no changes since the last green run, so chat-only turns don't pay for the test suite.

## 8. Open questions / flagged uncertainty

1. Exact migrations path in `packages/db` (for example `packages/db/drizzle/` or `packages/db/migrations/`) and whether we pin drizzle-kit 0.x or 1.0. This changes the guard's glob, not the approach.
2. Whether blocking *creation* of new files under `tests/invariants/` is wanted.
3. Per-edit `tsc` latency on `apps/web` (measure it once the code exists).
4. `MultiEdit`'s status: documented only as "legacy". Harmless in the matcher.
5. These are 2.1.x docs, and the hooks surface changes often. Recheck `/hooks` and the reference when upgrading Claude Code.
