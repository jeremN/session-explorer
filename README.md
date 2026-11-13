# Session Explorer

Read your Claude Code transcripts and answer three questions:

- **Where did the tokens go?** Cold cache resumes, error loops, retry streaks and subagent cost, in dollars.
- **What did the sessions ship?** The GitLab merge requests and GitHub pull requests each session created.
- **Did the agent read the docs before it edited?** One verdict per task: knowledge base searched before the first edit, after it, or never.

Everything runs on your machine. The tool reads `~/.claude/projects`, writes its output next to the code, and serves a viewer on `127.0.0.1` only. It has no dependencies and makes no network calls.

## Requirements

- Node.js 23.6 or later. The tool runs TypeScript directly with Node's type stripping. Tested on Node 24.
- Claude Code transcripts in `~/.claude/projects`.

## Quick start

```sh
git clone https://github.com/jeremN/session-explorer
cd session-explorer
node session-explorer/build.ts --days 30 --waste    # waste table in the terminal
node session-explorer/build.ts --days 30 --serve    # viewer on http://127.0.0.1:4173
```

The `--waste` table looks like this (illustrative numbers):

```
Waste in the last 30 days, total cost 1000 dollars
signal                                                    count  dollars  share
cold resume: cost over a warm cache (upper limit)           100   140.00   14 %
  of which after a user prompt (reach of a prompt hook)      90   125.00   13 %
cache invalidation (pause under 5 min)                       10    10.00    1 %
error loop, at least (15 sessions, 100 errors)               20     3.00    0 %
  of which permission                                        10     1.20    0 %
retry streak, at least (40 sessions, 240 attempts, ...)     110     7.00    1 %
subagent runs, raw cost, no verdict                          80   110.00   11 %
Merge requests created: 40 in 15 sessions. These sessions cost 350 dollars (35 % of the total).
```

## Commands

| Command | What it does |
|---|---|
| `node session-explorer/build.ts` | Parse the sessions and write `session-explorer/out/` |
| `... --waste` | Also print the waste table |
| `... --serve [--port 4173]` | Also serve the viewer |
| `node context-tracer/tracer.ts [--json]` | Print the knowledge-base verdicts per week |
| `node hook-heartbeat/heartbeat.ts [--json]` | Tell, for each configured hook, when it last fired and whether it looks dead |
| `node --test` | Run the test suite |

All three scripts take `--days N` (default 30, 14 for the heartbeat) and `--projects <regex>`. The regex filters the folder names under `~/.claude/projects`. For example, `--projects 'my-app'` keeps the sessions of every working directory whose path contains `my-app`, worktrees included.

## Configuration

The configuration file is optional. The tool reads `$SESSION_EXPLORER_CONFIG`, or else `~/.config/session-explorer/config.json`.

```json
{
  "projects": "-Code-my-app(--.*)?$",
  "brain": {
    "paths": ["team-wiki/docs", "notes/vault"],
    "repositories": ["/team-wiki", "/notes"],
    "collections": ["wiki"],
    "wikiDirectories": ["decisions", "playbooks"]
  },
  "memory": { "collections": ["agent-memory"] }
}
```

| Key | Meaning |
|---|---|
| `projects` | Default for `--projects`. Without it, every project is read. |
| `brain.paths` | Regular expressions for the paths of your knowledge base. A `Read`, `Grep`, `cat` or `grep` on one of them is a knowledge-base search. |
| `brain.repositories` | Regular expressions for the repositories that hold the knowledge base. An edit inside them maintains the knowledge base, so it is not a task. Default: `brain.paths`. |
| `brain.collections` | [qmd](https://github.com/tobi/qmd) collections that hold the knowledge base. |
| `brain.wikiDirectories` | First directories of a qmd path given without its collection. |
| `memory.collections` | qmd collections that hold agent memory. A read of `~/.claude/projects/*/memory/` always counts as memory. |

Without a `brain` section, only an unscoped qmd search counts as a knowledge-base search.

## What the signals mean

All thresholds are choices, not measured optima. They are constants at the top of `waste.ts`.

- **Cold resume.** A request rewrites more than half of a context larger than 20,000 tokens after a pause of 5 minutes or more. The cost shown is the extra cost over the same request with a warm cache, so it is an upper limit: after one hour the cache is gone whatever you do.
- **Cache invalidation.** The same rewrite after a pause shorter than 5 minutes. Usually a model or settings change.
- **Error loop.** The same failure 3 times or more: same agent, tool and message. Each loop gets a class: `exit_code`, `permission`, `blocked`, `stale_file`, `not_found`, `timeout` or `other`. The cost counts only the requests that launched the repeats, so it is a lower limit.
- **Retry streak.** The same call (agent, tool, target) after a failure of that call, within the last 8 calls of the agent. It overlaps with error loops: do not add the two rows.
- **Subagent runs.** Raw cost of each subagent. No verdict on whether it was worth it.
- **Verified task.** A test, build, lint or typecheck command ran after the last edit of the task: `npm|pnpm|yarn|bun test|build|lint|check|typecheck`, `tsc`, `vitest`, `jest`, `eslint`, `svelte-check`, `playwright test`, `node --test`, `pytest`, `mypy`, `ruff`, `cargo test|check|build|clippy`, `go test|build|vet`. An edit after the check cancels it. `check` gives the result of that last command: `failed` when it exits with an error, or when its output holds a failure line (`FAIL `, `2 failed`, `3 errors`, `error TS2304`), because `| tail` hides the exit code; `passed` otherwise; `unknown` when it has no result (interrupted, still running).
- **Interruption.** You stopped the agent (`[Request interrupted by user]`).
- **Refusal.** You refused a tool call (`refusals`), or the permission system denied it (`denials`: auto mode classifier, safety check, permission rule).
- **Created merge request or pull request.** The first mention of a merge request, over all sessions in the window, comes from a creating command:
  - GitLab: a `remote:` line after `git push -o merge_request.create`. The line counts even when a later command of the same call failed;
  - GitHub: a line that starts with the pull request URL after `gh pr create`. A failed call creates nothing: it prints the URL of the pull request that already exists.

  The rule uses the first mention because GitLab prints the same `remote:` line for a merge request that already exists.

## Hook heartbeat

A hook can die without a sound: a renamed script, a broken `jq` pipe, a timeout. Claude Code goes on, and nothing tells you that the gate stopped. `hook-heartbeat/heartbeat.ts` reads the configured hooks and the transcripts, and gives one verdict per hook.

```sh
node hook-heartbeat/heartbeat.ts --days 14 --project /path/to/my-app
```

| Option | Meaning |
|---|---|
| `--days N` | Window of the report. Default 14. |
| `--baseline-days N` | Period before the window that gives the usual trace rate of each hook. Default 60. |
| `--project <dir>` | Also read `<dir>/.claude/settings.json` and `settings.local.json`. Repeat it for several projects. A project hook counts only the sessions whose working directory is inside `<dir>`. |
| `--json` | Print the `harness/v1` result. |

The tool reads the hooks of `~/.claude/settings.json`, `~/.claude/settings.local.json`, the project files, and the enabled plugins (`hooks/hooks.json`, or `hooks` in `.claude-plugin/plugin.json`, of the installed version). The configuration key `heartbeat.projects` holds default project directories.

| Verdict | Meaning |
|---|---|
| `alive` | The hook left a trace in the window, and its last traces are not all errors. |
| `erroring` | Its last 3 traces (or fewer, if it has fewer) are errors: a timeout, a non-blocking error, or an exit code other than 0 and 2. |
| `silent` | No trace in the window, while its event occurred and at least 5 traces were expected. |
| `unknown` | The transcripts cannot tell. The `reason` field says why. |

### How a hook leaves a trace

Observed in Claude Code 2.1 transcripts:

| Row | Written when | Names the command |
|---|---|---|
| `attachment.type: hook_success` | The hook printed something on stdout or stderr | Yes, or its `statusMessage` when it has one |
| `hook_cancelled` | The hook timed out (`timedOut: true`) or was cancelled | Yes |
| `hook_non_blocking_error` | The hook failed without blocking | Yes |
| `async_hook_response` | An async hook answered | Since mid-October 2026, with `pluginId` for a plugin hook; before, often empty |
| `hook_additional_context`, `hook_system_message`, `hook_blocking_error` | The hook added context, showed a message, or blocked | No |
| `system`, `subtype: stop_hook_summary` | A Stop event ran its hooks | Yes, every Stop hook in `hookInfos`, quiet or not, with its duration |

A trace that names no command goes to the only hook that could have left it. With several candidates, it counts as `shared` for each of them, and in `unattributed` per event.

A quiet hook that succeeds leaves no trace. So `silent` compares the window with the usual trace rate of the hook: traces per event during the baseline period. A Stop hook has a rate of 1, because the stop summary lists it every time. The events come from the transcripts: tool calls for `PreToolUse`, successful tool results for `PostToolUse`, user prompts for `UserPromptSubmit`, stop summaries for `Stop`, compactions for `PreCompact`, and the traces of all `SessionStart` hooks for `SessionStart`. Other events have no count.

### Limitations

- A hook that never prints anything gets `unknown`, unless it is a Stop hook. The tool cannot tell a quiet hook from a hook that never ran.
- When several hooks share an event and leave anonymous traces (`UserPromptSubmit` often), none of them can be called silent.
- A hook with an `if` condition gets no event count: the transcript does not evaluate the condition.
- A hook added during the window has events counted from the start of the window.
- The trace formats are not a documented contract. A Claude Code update can change them.

## Optional hook: cache-warn

`cache-warn/hook.ts` is a `UserPromptSubmit` hook. It warns you when your prompt meets a cold cache on a large context. It never blocks the prompt.

The hook warns when two conditions are true:

- the last request of the session is older than the cache lifetime (1 hour, or 5 minutes after a 5-minute cache write);
- that request had a context of 100,000 tokens or more.

The warning gives the pause, the context size and the extra cost over a warm cache. It shows once per pause. The hook also appends one line to `~/.claude/logs/cache-warn.jsonl`, with numbers and ids only, never prompt text.

To install it, add this entry to `~/.claude/settings.json`. Replace the path with the path of your clone.

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "node /path/to/session-explorer/cache-warn/hook.ts", "timeout": 5 }] }
    ]
  }
}
```

The hook prices the request with `session-explorer/price.ts`. Any failure ends with exit code 0 and no output. A child process started with `CC_HANDOFF_LLM` set skips the hook.

## Output

| File | Content |
|---|---|
| `out/index.json` | One row per session: cost, tokens, errors, `interrupts`, `refusals`, `denials`, task verdicts with `tasks.verified` and `tasks.failed`, `mrs`. Totals of the waste signals. |
| `out/sessions/<id>.json` | The event list of one session, for the viewer. |
| `out/waste.json` | One row per finding. |

> **Warning:** `out/` holds excerpts of your transcripts: prompts, commands, file paths and error messages. Do not commit or share it. The repository ignores it.

## Limitations

- Claude Code only. Codex, Cursor and other agents are not read.
- Prices come from the table in `price.ts`, at public list prices. A model that is missing gets no cost, and the build prints its name.
- A merge request created before the window, then pushed again with `-o merge_request.create`, counts as created. A merge request created in a web UI is not seen. GitHub Enterprise hosts are not recognized.
- The retry key of an MCP call has no arguments, so two different calls to the same MCP tool after a failure count as a retry.
- The viewer text and the cache-warn message are in French.

## Credits

- [agentplay](https://github.com/Entelligence-AI/agentplay) (Apache-2.0) gave the idea of error classes and of the retry window. No code is copied.
- [D3](https://d3js.org) v7.9.0 (ISC) is bundled in `session-explorer/viewer/d3.min.js`.

## License

MIT. See [LICENSE](LICENSE).
