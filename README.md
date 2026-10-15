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
| `node --test` | Run the test suite |

Both scripts take `--days N` (default 30) and `--projects <regex>`. The regex filters the folder names under `~/.claude/projects`. For example, `--projects 'my-app'` keeps the sessions of every working directory whose path contains `my-app`, worktrees included.

## Configuration

The configuration file is optional. The tool reads `$SESSION_EXPLORER_CONFIG`, or else `~/.config/session-explorer/config.json`.

```json
{
  "projects": "-Code-my-app(--.*)?$",
  "brain": {
    "paths": ["team-wiki/docs", "notes/vault"],
    "collections": ["wiki"],
    "wikiDirectories": ["decisions", "playbooks"]
  },
  "memory": { "collections": ["agent-memory"] }
}
```

| Key | Meaning |
|---|---|
| `projects` | Default for `--projects`. Without it, every project is read. |
| `brain.paths` | Regular expressions for the paths of your knowledge base. A `Read`, `Grep`, `cat` or `grep` on one of them is a knowledge-base search. An edit inside them is not a task. |
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
- **Created merge request or pull request.** The first mention of a merge request, over all sessions in the window, comes from a creating command:
  - GitLab: a `remote:` line after `git push -o merge_request.create`;
  - GitHub: a line that starts with the pull request URL after `gh pr create`.

  The rule uses the first mention because GitLab prints the same `remote:` line for a merge request that already exists. A command that failed creates nothing.

## Output

| File | Content |
|---|---|
| `out/index.json` | One row per session: cost, tokens, errors, task verdicts, `mrs`. Totals of the waste signals. |
| `out/sessions/<id>.json` | The event list of one session, for the viewer. |
| `out/waste.json` | One row per finding. |

> **Warning:** `out/` holds excerpts of your transcripts: prompts, commands, file paths and error messages. Do not commit or share it. The repository ignores it.

## Limitations

- Claude Code only. Codex, Cursor and other agents are not read.
- Prices come from the table in `price.ts`, at public list prices. A model that is missing gets no cost, and the build prints its name.
- A merge request created before the window, then pushed again with `-o merge_request.create`, counts as created. A merge request created in a web UI is not seen. GitHub Enterprise hosts are not recognized.
- The retry key of an MCP call has no arguments, so two different calls to the same MCP tool after a failure count as a retry.
- The viewer text is in French.

## Credits

- [agentplay](https://github.com/Entelligence-AI/agentplay) (Apache-2.0) gave the idea of error classes and of the retry window. No code is copied.
- [D3](https://d3js.org) v7.9.0 (ISC) is bundled in `session-explorer/viewer/d3.min.js`.

## License

MIT. See [LICENSE](LICENSE).
