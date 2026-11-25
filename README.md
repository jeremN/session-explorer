# Session Explorer

Read your Claude Code transcripts and answer three questions:

- **Where did the tokens go?** Cold cache resumes, error loops, retry streaks and subagent cost, in dollars.
- **What did the sessions ship?** The GitLab merge requests and GitHub pull requests each session created.
- **Did the agent read the docs before it edited?** One verdict per task: knowledge base searched before the first edit, after it, or never.

Everything runs on your machine. The tool reads `~/.claude/projects`, writes its output next to the code, and serves a viewer on `127.0.0.1` only. It has no dependencies. It makes no network calls, except through `eval-runner`, which starts the `claude` CLI. The `claude` CLI is the only network user.

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
| `node eval-runner/run.ts <spec.json> [--dry-run]` | Run one task under several configurations (see [Eval runner](#eval-runner)) |
| `node eval-runner/grade.ts <evalDir>` | Grade the diff of each run of an eval (see [Grade the diffs](#grade-the-diffs)) |
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

## Eval runner

`eval-runner/` runs one task under several agent configurations, N times each: Claude Code, Codex or opencode. It scores every run with the same pipeline as the viewer, and it runs an acceptance command of your choice. The "Évaluations" view of the viewer shows the result. It shows the pass rate, the share of tests that passed (a 27/28 run is not a 0/28 run), the checks that failed for an infra reason, the runs checked again, the hosts the network filter blocked, and the last verdict of each file that `pnpm eval:watch` follows.

```sh
node eval-runner/run.ts eval-runner/examples/format-dollars.json --dry-run   # print the plan and the maximum spend
node eval-runner/run.ts eval-runner/examples/format-dollars.json             # real run: it starts `claude` and costs money
node session-explorer/build.ts --serve                                        # then open the "Évaluations" view
```

Options: `[--dry-run] [--runs N] [--only <config>[,<config>]] [--keep] [--no-cache] [--no-grade] [--claude <path>] [--codex <path>] [--opencode <path>] [--docker <path>] [--out <dir>]`. Exit codes: 0 done, 1 a run failed to start or an I/O error, 2 invalid spec or arguments.

The runner makes no network call. The agent CLIs are the only network users, and the only things that spend money. A command grader is the exception: it is your own command, and it can call a model too (see [Grade the diffs](#grade-the-diffs)).

### Spec

One JSON file per eval. Paths in it resolve against the spec directory.

| Field | Meaning |
|---|---|
| `name` | Slug, `[a-z0-9-]+`. |
| `task.repo` | A git repository. Only committed content is cloned. |
| `task.base` | A commit-ish. The runner records its SHA. Default `HEAD`. |
| `task.prompt` or `task.promptFile` | The prompt. Set exactly one. |
| `task.timeoutSec` | Time limit of the agent. Default 900. |
| `task.acceptance.command` | Required. It runs in the clone after the agent stops, with `EVAL_SPEC_DIR` set. Exit code 0 means passed. Keep the check script next to the spec, outside the clone. |
| `task.acceptance.timeoutSec` | Default 300. |
| `task.hiddenTests` | Optional `{ commit, paths }`. The runner copies these files from `commit` in `task.repo` into the clone after the agent stops and after the diff, then runs the acceptance command. Use it for a task mined from a past session: `commit` is the solution, `paths` are its tests. |
| `budget.perRunUsd`, `budget.perEvalUsd` | Both required. |
| `budget.gradersUsd` | Optional. The budget of the command graders, apart from the budget of the agents. See [Grade the diffs](#grade-the-diffs). |
| `runs` | Runs per configuration, 1 to 20. Default 3. |
| `configs` | 1 to 8 configurations with unique names. |
| `graders` | Optional. The graders of every run of the eval. See [Grade the diffs](#grade-the-diffs). |

### Cache

A finished run (`ok`, `timeout` or `budget`) goes to `eval-runner/out/cache/`. The next eval reuses it when the agent would get the same thing again: the same base commit, prompt, acceptance command, spec folder (`EVAL_SPEC_DIR`), hidden tests and time limit, the same config, and the same CLI version. The config name and the repository path do not count. A file of the config (`claudeMd.file`, `settings`, `mcpConfig`, `skills`, `plugins`) counts by its content, so a change to a skill or a CLAUDE.md runs again. A reused run costs nothing and has a `cached` field that names the eval that holds its files. The script that the acceptance command runs does not count: after you change it, pass `--no-cache`.

A grade goes to `eval-runner/out/cache/grades/`. See [Grade the diffs](#grade-the-diffs).

### Check a run again

`node eval-runner/recheck.ts <evalDir> [--runs <id>[,<id>]] [--spec <spec.json>]` runs the acceptance check again on the saved `diff.patch` of each run, without the agent. Use it when a check failed for a reason outside the agent (a port in use, a database that did not start), or when a hidden test was wrong.

- Each run gets a new clone at the base, the setup command, its `diff.patch`, the hidden tests and the acceptance command. The applied diff must have the counts of the run (`record.diff`), or the run is not rechecked. The saved patch holds no binary content.
- The record keeps the acceptance it replaced in `rechecked.previous`. The first log stays as `acceptance.original.log`.
- `--spec` takes the acceptance command, the hidden tests and the category of that spec. It must name the same task (same repo, base and prompt). The cached copies of the rechecked runs then go: they belong to the old cache key. Without `--spec`, the cached copies get the new acceptance.

`task.acceptance.infraExitCode` (2 to 255) names the exit code by which the acceptance command says that it failed before it judged the agent, for example a database that did not start. Such a run gets `acceptance.infra`, and the routing table leaves it out.

### Grade the diffs

The acceptance check tells pass from fail. When every config passes, it does not tell the configs apart. A grader judges the diff of each run: it gives findings, such as a review comment or a broken team rule. After the runs, the runner grades every run with the `graders` of the spec. `--no-grade` skips this step.

`node eval-runner/grade.ts <evalDir> [--graders <name>[,<name>]] [--runs <id>[,<id>]] [--spec <spec.json>] [--force]` (or `pnpm eval:grade`) grades the runs of a saved eval.

- `--graders` and `--runs` limit the pass to these graders and runs. The other grades stay.
- `--spec` takes the graders and `budget.gradersUsd` of that spec. It must name the same task (same repo, base and prompt). Use it on an eval that ran before its spec had graders. `eval.json` keeps the graders of that spec, by name.
- `--force` runs every grader again, even when the grade cache holds its result.
- Exit codes: 0 done, 1 a grade has the status `error`, 2 invalid arguments.

```json
"graders": [
  { "name": "review", "kind": "command", "command": "node \"$EVAL_SPEC_DIR/graders/review.mjs\"", "timeoutSec": 1800 },
  { "name": "rules", "kind": "pattern",
    "rules": [{ "name": "no-as-cast", "pattern": "\\bas [A-Z]\\w+", "paths": "\\.ts$", "severity": "minor" }],
    "require": [{ "name": "changeset", "paths": "^\\.changeset/.+\\.md$", "severity": "important" }] }
]
```

| Field | Meaning |
|---|---|
| `name` | Slug, `[a-z0-9-]+`, unique in the spec. The grade of the run goes to `grades.<name>`. |
| `kind` | `command` or `pattern`. |
| `command` | A command grader: the shell command. It runs in the clone, so keep the script next to the spec and name it with `$EVAL_SPEC_DIR`. |
| `timeoutSec` | A command grader: the time limit. Default 1800. |
| `blind` | A command grader: default `true`. See below. |
| `rules` | A pattern grader: `{ name, pattern, paths?, severity }`. `pattern` and `paths` are regular expressions. |
| `require` | A pattern grader: `{ name, paths, severity }`. |

The runner grades a run with the status `ok` or `timeout` and a diff that is not empty. The other runs get a grade with the status `skipped`. The grades go in a shuffled order, so a grader meets the configs interleaved. A progress line names the grade id and the grader, never the config. The summary at the end gives, per config and grader, the runs with findings out of the graded runs.

**Command grader.** For each run, the runner makes a new clone at the base: the setup files of the config, the setup command, then `diff.patch`. The hidden tests do not enter. The command runs in the clone with these variables:

| Variable | Value |
|---|---|
| `EVAL_GRADE_ID` | A random id of 8 hex characters. The grade keeps it as `id`, so a report of the grader links back to the run. |
| `EVAL_BASE` | The SHA of the base commit. |
| `EVAL_DIFF` | The absolute path of a copy of `diff.patch`, named by the grade id. |
| `EVAL_SPEC_DIR` | The spec folder. |

The command prints one JSON object on stdout: `{ "findings": [{ "severity": "...", "summary": "...", "file"?: "...", "line"?: 12, "rule"?: "..." }], "costUsd"?: 0.42 }`. Invalid JSON or a non-zero exit code gives the status `error` and a `note`. A command over its time limit gives the status `timeout`. The stdout and the stderr go to `runs/<runId>/grade-<name>.log`. The runner removes the clone and the copy of the patch after the grade.

**Blind mode.** A blind grader never gets the config name or the run id: not in its working directory, the path of the patch or the environment. With `"blind": false`, it also gets `EVAL_CONFIG` and `EVAL_RUN_ID`. The clone of a blind grader holds the base commit and the task setup, never the files of the config (its CLAUDE.md, its skills, `remove`, `files`). Every diff is then judged against the same instruction files. A diff that changes a file of the config setup does not apply on the base: its grade has the status `error`. A grader with `"blind": false` gets the clone of the config.

**Pattern grader.** No clone and no process. The runner reads the added lines of `diff.patch`. Each `rules` entry gives one finding per added line that its `pattern` matches, in a file that its `paths` matches (default: every file). The finding names the file, the line number in the new file and the trimmed line, 200 characters at most. Each `require` entry gives one finding when no changed file matches its `paths`. A deleted file does not count.

**Budget.** `budget.gradersUsd` caps the cost of the command graders in one pass. The cost of a grade is the `costUsd` that its command prints, 0 when it prints none. When the sum of the costs reaches the cap, the remaining command grades get the status `budget`. Pattern graders cost nothing.

**Cache.** An `ok` command grade goes to `eval-runner/out/cache/grades/`. A later pass reuses it when the diff, the grader, the base commit and the spec folder are the same (and the config, for a grader that is not blind). A reused grade has `cached: true` and costs nothing. The script of the command does not count: after you change it, pass `--force`.

Each grade has `status` (`ok`, `error`, `timeout`, `budget` or `skipped`), `findings`, and when known `id`, `costUsd`, `durationMs`, `note` and `cached`. Per config, `eval.json` adds `grades.<name>`: `graded` (the runs with an `ok` grade), `withFindings`, `findings` and `bySeverity`. The "Comparaison" panel of the viewer shows one row per grader: the runs with findings out of the graded runs.

### Measure a change to a CLAUDE.md, an AGENTS.md or a skill

`pnpm eval:diff <spec.json> --file <path> [--config <name>] [--runs 3] [--max-runs 10]` runs the task of the spec twice per round: `before` gets the file as it is at `HEAD`, `after` gets the working tree. Both start from the first config of the spec (or `--config`).

- A file (`CLAUDE.md`, `AGENTS.md`) of the task repository becomes the CLAUDE.md of the clone. A CLAUDE.md from outside the task repository (`~/.claude/CLAUDE.md`) is a user CLAUDE.md: for a Claude config it becomes `userClaudeMd` and keeps the CLAUDE.md of the project, as in a real session. A directory is a skill: it replaces the skill of the config with the same directory name.
- Verdict: `same` when the pass counts are equal, `better` or `worse` when the gap is half the runs or more, `borderline` otherwise. A borderline result gets more runs (3, then 6, then 10). The cache reuses the earlier runs, so a round pays only for the new ones.
- A metric is flagged when its median after the change is outside the range of the `before` runs and the gap is more than 10 % of the `before` median (and more than 0.01 $ for a cost, 0.02 for a share, 1 s for a duration).
- For a skill, the report also lists how many times the skill loaded in each run. A skill that never loads cannot help.
- The report goes to `diff.json` in the eval directory. It informs; it does not block anything.

`--before <path>` replaces the version at `HEAD` with a saved copy: of the file, or of the skill directory under the same directory name. Use it for a file outside git, such as `~/.claude/CLAUDE.md`.

### Watch your instruction files

`pnpm eval:watch` lists the watched instruction files that changed since their last measure, and the most that each measure can cost. It spends nothing. `~/.claude` is no git repository, so the version before a change is the copy that the last measure kept, not `HEAD`.

The list is `eval-runner/out/watch.json` (gitignored, `--watch` names another). Each entry names the file and the spec of a task that measures it:

```json
{ "watch": [{ "file": "~/.claude/skills/tidy", "spec": "suites/tidy.json", "config": "sonnet", "runs": 3, "maxRuns": 6 }] }
```

- `file`: a CLAUDE.md, an AGENTS.md or a skill directory. `~` is your home. A relative path starts from the folder of the list, as `spec` does.
- `config`, `runs` (default 3) and `maxRuns` (default 10) go to `eval:diff`. The most a measure costs is both sides at `maxRuns` runs, at the `perRunUsd` of the spec.
- `--run` measures each change with `eval:diff --before <copy>`. Then the new version becomes the copy, with the verdict. A measure that does not finish keeps the old copy. A file that was never measured gets its first copy, with no measure and no spend. `--only <name>` limits the run to the names that the list prints.
- `--status-line` prints one line when a watched file changed, and nothing otherwise, never an error. It is made for a `SessionStart` hook. The plain output of a `SessionStart` hook goes to the model, not to you: wrap the line in a `systemMessage` to see it.

  ```json
  { "matcher": "startup|resume", "hooks": [{ "type": "command", "timeout": 10, "command": "node <repo>/eval-runner/watch.ts --status-line 2>/dev/null | jq -Rsc 'select(length > 0) | {systemMessage: rtrimstr(\"\\n\")}' 2>/dev/null || true" }] }
  ```
- The copies and the verdicts are in `eval-runner/out/watch/`.
- A measure says something only when the task needs the skill. For a skill, the report lists how many times the skill loaded in each run.

### Mine tasks from your sessions

`pnpm eval:mine [--days 30] [--projects <regex>] [--out <file>]` reads your local Claude Code sessions and writes candidate tasks to `eval-runner/out/candidates.json` (gitignored). A task is a candidate when:

- its last check after the last edit passed;
- its working directory is a git repository that still exists;
- a commit was made between the prompt and 10 minutes after the next prompt (the solution);
- the hidden tests are the test files of the solution that the check names, by path or by file name. When the check names none, the task must be one commit with at most 5 test files, and they all become hidden tests.

Each candidate holds a spec draft: the base is the parent of the first commit of the task, the prompt is the prompt of the task, `hiddenTests` are the test files of the solution, and the acceptance command is the last check, with the repository path replaced by `.`. `review: true` means the command still names an absolute path. To accept a candidate, copy its `spec` into a spec file, set the configs, and read the prompt and the command. The file holds your prompts: it stays on your machine. Runs of the eval runner are skipped.

### Configuration fields

A field that is absent keeps the CLI default.

| Field | Maps to |
|---|---|
| `model` | `--model <value>` |
| `effort` | `--effort <level>`: `low`, `medium`, `high`, `xhigh` or `max`. Unset: Claude Code in print mode sends `medium` (see `output_config.effort` in the transcript). Codex takes `-c model_reasoning_effort="<level>"`, from `low` to `xhigh`. opencode has no flag: name a variant in the model, `provider/model#variant`. The effort is part of the route of the routing table: `claude/sonnet@high` |
| `claudeMd` (`{ "text" }` or `{ "file" }`) | `CLAUDE.md` of the clone, committed in the setup commit |
| `userClaudeMd` (`{ "text" }` or `{ "file" }`) | plays your `~/.claude/CLAUDE.md`. The runs read no user memory (`--setting-sources project,local`), so it becomes `CLAUDE.local.md` in the clone: Claude Code reads it with the `CLAUDE.md` of the project. Claude Code only |
| `remove` (paths) | paths of the task repository deleted from the clone before the setup commit, for every agent: `["AGENTS.md", ".claude"]` measures a repository without the harness its team commits. A relative path inside the clone, outside `.git` |
| `files` (path → `{ "text" }` or `{ "file" }`) | files written into the clone before the setup commit, for every agent: `{ "AGENTS.md": { "file": "AGENTS.lite.md" } }` measures a variant of a committed instruction file. The file keeps its path, so it does not mask the instruction files of other directories as a `claudeMd` would. Same path rule as `remove` |
| `appendSystemPrompt` | `--append-system-prompt <value>` |
| `settings` (object or file) | `<run>/settings.json`, passed as `--settings`. Put hooks here. |
| `skills` (directories) | Copied to `.claude/skills/<name>/` in the clone, committed in the setup commit |
| `plugins` (directories) | `--plugin-dir <path>`, one per entry |
| `permissionMode` | `--permission-mode`. One of `acceptEdits`, `auto`, `dontAsk`, `plan`. Default `auto`. `bypassPermissions` is refused. |
| `allowedTools`, `disallowedTools` | `--allowedTools`, `--disallowedTools` |
| `mcpConfig` (object or file) | `--mcp-config <path> --strict-mcp-config`. Without it, the runner passes an empty strict config. |
| `bare` | `--bare`. It needs `ANTHROPIC_API_KEY`. Default false. |
| `sandbox` | Turns on the Bash sandbox of Claude Code. The runner merges `sandbox.enabled`, `failIfUnavailable: true`, `allowUnsandboxedCommands: false` and an empty `excludedCommands` into `<run>/settings.json`, over the `settings` of the config. Default false. |

The runner always adds `-p` (prompt on stdin), `--output-format json`, `--session-id`, `--max-budget-usd`, `--permission-prompts none`, `--setting-sources project,local` and `--disallowedTools "Bash(git push:*)"`. The `--setting-sources` flag keeps your user hooks and plugins out of every configuration.

### Other agents: Codex and opencode

Set `agent` in a config: `claude` (the default), `codex` or `opencode`. The other agents print JSON events. The runner turns them into a transcript in the Claude Code format, so the same pipeline scores every agent. The run folder keeps the raw events in `events.jsonl`.

| | Codex | opencode |
|---|---|---|
| Command | `codex exec --json --sandbox workspace-write --ephemeral --ignore-rules --skip-git-repo-check -`, prompt on stdin | opencode 1: `opencode run --format json --auto --pure --dir <clone> --model <model> -- <prompt>`. opencode 2 has no `--pure` and no `--dir`: `opencode --standalone run --format json --auto --model <model> -- <prompt>`, in the clone. `--standalone` gives the run a private server: without it, the run goes to a shared background service, which another config folder may have started. The runner picks the form from `opencode --version`. `model` is required: without it, opencode takes your last model from `~/.local/state/opencode/model.json`. |
| `claudeMd` | written as `AGENTS.md` | written as `AGENTS.md` |
| User config kept out | A new `CODEX_HOME` (mode 0700) that holds only a copy of `auth.json`. Without it, Codex reads `~/.codex/AGENTS.md` and what it points to. | An empty `XDG_CONFIG_HOME`, `OPENCODE_DISABLE_CLAUDE_CODE=1` (no `~/.claude/CLAUDE.md`, no Claude Code skills) and `--pure` (no plugins) on opencode 1. On opencode 2, the empty config folder holds no plugin. |
| Sandbox | Always `workspace-write`: the shell writes only in the clone, with no network. `sandbox: false` is refused. | None. Set `container: true`, or `sandbox: false` to accept it. |
| Cost | Codex prints tokens, not dollars. Set `price` in the config (`{ "input", "output", "cacheRead" }`, dollars for one million tokens, `cacheRead` a multiple of `input`). Without it, the run has no cost and a note. | The sum of the `cost` of each step. opencode 2 reports 0 for an `opencode-go` model, though the steps bill tokens: the run then has no cost and a note, and the eval budget counts `perRunUsd` for it. |
| Budget | No dollar cap per run: only `task.timeoutSec` bounds a run. | Same. |

The Claude Code fields (`appendSystemPrompt`, `settings`, `skills`, `plugins`, `permissionMode`, `allowedTools`, `disallowedTools`, `mcpConfig`, `bare`) are refused for the other agents.

> **Warning:** opencode outside a container has no sandbox. Its shell runs as your user and can write anywhere. The runner checks `git status` of the source repository after each run and stops the eval when it changed. Use `container: true`, or use opencode only on a task you trust.

opencode works in `$PWD`, not in the working directory of its process. A first trial without `--dir` sent it into the source repository, where it edited two files. The runner now passes `--dir <clone>` and sets `PWD` to the clone for every agent.

### Container

With `container: true`, a Codex or opencode config runs its agent in Docker. Build the image first:

```sh
pnpm eval:image   # docker build -t eval-runner-agents:<hash of the Dockerfile> eval-runner/container
pnpm eval:image --latest   # first write the last published codex and opencode versions in the Dockerfile
```

The Dockerfile names the CLI versions, because they are part of the cache key: a new version gives a new tag, so the runs of the old version are never reused. `--latest` reads them with `pnpm view` (`@openai/codex`, and `@opencode/cli`, where opencode 2 is published; `opencode-ai` stops at 1.x). The runner picks the options of opencode from `OPENCODE_VERSION`. pnpm stays at the `packageManager` version of the task repos: another version would fetch that one at start, and the proxy refuses the registry.

The image (`eval-runner/container/Dockerfile`) pins Node and the CLI versions. Its tag is the hash of the Dockerfile, and it is the CLI version in the cache key. The runner refuses to start when the image is missing.

Each run gets:

- `docker run --rm --init --user <your uid>:<your gid> --cap-drop ALL --security-opt no-new-privileges --pids-limit 512 --memory 4g --cpus 2`.
- Two mounts and nothing else from the host: the clone at `/work`, and a new private home at `/home/agent` that holds only a copy of the `auth.json` of the agent.
- A network filter. The agent container joins an `--internal` Docker network, with no route out. A proxy container (`container/proxy.ts`, from the same image) joins that network and the default one. It opens a `CONNECT` tunnel to port 443 of an allowed host, and refuses everything else: other hosts, other ports, IP addresses, plain HTTP. The agent gets `HTTPS_PROXY`. A CLI that ignores it gets no network at all.
- The allowed hosts: the defaults of the agent in `container/allow.json` (codex: `chatgpt.com`, `api.openai.com`, `auth.openai.com`; opencode: `opencode.ai`, `models.opencode.ai`), and the `containerAllow` hosts of the config (a name, or `*.domain`). The npm registry is not in the defaults: the setup command installs the dependencies on the host.
- `network.log` in the run folder: one JSON line per decision of the proxy. The record lists the refused targets in `blockedHosts`.
- The variables of the agent, passed by name (`-e NAME`): no value shows in the argv or the process list. `containerEnv` adds host variables by name, for a login that the auth file does not hold.
- Codex runs with `--sandbox danger-full-access`: the container is the boundary. Its own sandbox (bwrap) cannot create a namespace in an unprivileged container, and every command failed with it.
- After the run, `docker rm --force <name>`: a killed `docker run` client leaves its container running.

A probe checked the boundary: in the container, `touch /escape-test` fails with "permission denied" and `/Users` does not exist.

Limits:

- The filter reads the host name of the `CONNECT` request, not the TLS stream: domain fronting through an allowed host stays possible.
- The gateway of the internal network is the Docker VM: from the agent container, a port that another container publishes (`docker run -p`) is reachable. Services of the Mac itself are not.
- Claude Code does not run in the container: its login is in the macOS keychain. Use `sandbox: true` for Claude Code.
- opencode keeps its valid key in its background service, and `auth.json` can hold an expired key (`401 This API key has expired` in the container). Export `OPENCODE_GO_API_KEY` or `OPENCODE_API_KEY` on the host (the first that is set wins): the container then gets an `opencode.json` that reads the key from this variable, the variable by name, and no `auth.json`.
- The acceptance command still runs on the host, in the clone.

Gemini CLI is not supported: a personal Google account gets `IneligibleTierError` in headless mode, and it needs a paid API key.

### Setup command

`task.setup` (`{ "command", "timeoutSec" }`, default 600 s) runs in the clone after the setup commit and before the agent, for example `pnpm install --frozen-lockfile`. Its output goes to `setup.log`. A failed setup makes the run an error. The diff uses the git dir of the runner, which has no `info/exclude`: only a committed `.gitignore` keeps the installed files out of the diff. In a container, the agent sees dependencies that were installed on the host: a native module built for macOS does not load in the Linux container. With pnpm, install the binaries of both platforms: `pnpm install --frozen-lockfile --os current --os linux --cpu current --cpu arm64 --libc current --libc glibc` (on a new clone; an existing `node_modules` stays as it is). The image has `pnpm`, because the proxy lets no package registry through. The setup command is part of the cache key.

### Services

`task.services` lists the containers that run while the agent works, for example the database of the tests. Each run gets its own, after the setup and before the agent. They go before the diff and the acceptance check, so the check keeps its own environment.

```json
"services": [{
	"name": "db",
	"image": "postgres:17",
	"port": 5432,
	"env": { "POSTGRES_PASSWORD": "test", "POSTGRES_DB": "app_test" },
	"tmpfs": ["/var/lib/postgresql/data", "/var/run/postgresql", "/tmp"],
	"capAdd": ["CHOWN", "SETUID", "SETGID", "FOWNER", "DAC_OVERRIDE"],
	"ready": ["pg_isready", "-h", "127.0.0.1", "-U", "postgres"],
	"agentEnv": { "TEST_DATABASE_URL": "postgres://postgres:test@${host}:${port}/app_test" }
}]
```

- The agent can run commands in a service: a Postgres superuser can, with `COPY ... FROM PROGRAM`. So the service container gets the limits of the proxy: no capability but those of `capAdd`, `no-new-privileges`, a read-only root (`tmpfs` lists where it writes), and, on the run network, no DNS (the Docker daemon resolves names on the host). `capAdd` refuses `ALL`, `SYS_ADMIN` and `NET_ADMIN`. The official `postgres` image needs `["CHOWN", "SETUID", "SETGID", "FOWNER", "DAC_OVERRIDE"]` and the tmpfs `/var/lib/postgresql/data`, `/var/run/postgresql` and `/tmp`.
- A host agent reaches the service on `127.0.0.1`, at a port that Docker picks. Nothing listens on another address of the host.
- A container agent reaches it on the internal network of the run, by its `name`, at its own `port`. The name is in `NO_PROXY`, and nothing is published on the host.
- `ready` runs in the service container (`docker exec`) once a second, for 60 s at most. A service that does not answer makes the run an error before the agent starts, and the routing table leaves it out.
- `agentEnv` cannot set a variable of the runner (`PATH`, `HOME`, the proxy variables and others). `${host}` and `${port}` are the address of the service as the agent reaches it.
- A Codex agent on the host cannot reach a service: its sandbox has no network, `localhost` included. Use `container: true`.
- The services are part of the cache key.

### Routing table

`pnpm eval:matrix` reads every `eval.json` of the output folder and prints, per task category, the pass rate, the median cost and the median time of each route (agent and model). It writes `matrix.json` and `matrix.md` next to the evals.

```sh
pnpm eval:matrix --exclude <evalId>,<evalId>/<runId>   # leave out an eval, or one run known to be wrong
```

- **Category.** `task.category` in the spec, free text. Use the classes of `~/.claude/model-matrix.md` (`fast`, `implementation`, `strong`): the report then prints the route that the matrix gives to that class next to the proposal. The category is not part of the cache key.
- **Task.** The base commit, the prompt and the acceptance command. A spec with `base: HEAD` gives a new task each time the branch moves: pin the base of a suite task to a commit.
- **Route.** `agent/model`. A config that changes what the agent is told (`claudeMd`, `userClaudeMd`, `remove`, `files`, `appendSystemPrompt`, `skills`, `plugins`) is an experiment, not a route: it is left out. A run with status `error` and no billed token is left out too: the runner or the CLI start failed, and the agent never worked. An `error` after the agent worked (it stopped partway) and a `timeout` count as failures, even when the check passes. A run reused from the cache counts once.
- **Tests passed.** When the acceptance command is a test run (vitest, node:test or jest), the runner records how many tests passed in `acceptance.tests`. The column gives the mean share per task, then the mean of the tasks, so each task weighs the same. It tells a near miss (19 tests of 21) from a run that missed the task (10 of 21), where the pass rate sees two failures. It does not change the proposal.
- **Proposal.** Among the routes with 3 runs or more, the cheapest one whose pass rate is within one run of the best. A route with no cost (Codex without `price`) comes last.
- **Tasks that tell no route apart.** Two routes or more ran the task, and all pass or all fail. Such a task costs runs and moves no proposal. When no task of a category tells the routes apart, the report says that the cost decides alone.

The report never edits `~/.claude/model-matrix.md`.

### Budget

- Each run gets `--max-budget-usd <perRunUsd>`.
- The runner starts a run only when `spent + perRunUsd <= perEvalUsd`. The other runs get the status `skipped`, and they do not count in `n`.
- The CLI can go a little over its cap on the last request.
- Runs go in round-robin order over the configurations, one at a time.
- A run over `task.timeoutSec` gets SIGTERM, then SIGKILL after 10 s. Its status is `timeout`. It is still scored and checked.

### Isolation

Each run works in a throwaway local clone under `os.tmpdir()`. The clone has no remote, so a push has nowhere to go. The runner reads the source repository with `git clone`, `git rev-parse` and `git status` only. It never pushes, merges or rebases. It prints a warning if `git status` of the source repository changed during the eval. The runner removes each clone, unless you pass `--keep`.

Guards against an agent that tries to leave its clone:

- The clone uses `--no-hardlinks`, so no object file is shared with the source repository.
- The clone has a `pre-push` hook that fails. The agent process gets `GIT_CONFIG_COUNT=1`, `GIT_CONFIG_KEY_0=protocol.allow` and `GIT_CONFIG_VALUE_0=never`, which turns off every git transport, a local path included. `Bash(git push:*)` stays disallowed, but it is a prefix rule, so `git -C . push` bypasses it.
- After the setup commit and before the agent starts, the runner copies `.git` of the clone to a new `eval-runner-git-*` directory under `os.tmpdir()`, with mode 0700. The agent never gets its path: not in the argv, the environment, the working directory or a generated file. After the agent stops, the runner never reads or writes `.git` of the clone: the agent can make it a symlink, a `gitdir:` file, or fill it with its own config, hooks and attributes. Right before the diff, the runner writes the config of its copy from memory and deletes its `hooks` and `info` directories. It refuses a copy that has a `commondir` file. The diff runs as `git --git-dir=<runner copy> --work-tree=<clone>`, with `core.fsmonitor`, `core.hooksPath`, `core.attributesFile` and the system and global config turned off, and `--no-ext-diff --no-textconv`. The runner removes the copy after the diff, and after an error too.
- On a timeout, the runner sends SIGTERM to the process group of the agent, then SIGKILL after 10 seconds. It waits until the group is gone before the acceptance command starts, for 5 seconds at most after the SIGKILL. Then it closes the output pipes and records the timeout.
- The runner does not follow a symlink of the base commit when it writes `CLAUDE.md` or a skill. It refuses a skill path whose parent directory is a symlink, and it removes an existing skill directory before the copy.

Residual risk: a process that the agent detaches into its own session leaves the process group, so the timeout does not kill it. It can outlive the run and overlap the acceptance command of the run and the next runs. The runner cannot contain it without an OS boundary. For an untrusted task, run the eval in a container, in a VM or as a dedicated user.

With `sandbox: true`, the Bash commands of the agent and their child processes write only in the clone and have no network (macOS Seatbelt). A probe on Claude Code 2.1.325 checked it: a script that writes to `~/.cache` succeeds without the sandbox and fails with `EPERM` with it, and a write to the `$TMPDIR` of the runner fails too. A detached process stays in the sandbox, so it cannot reach the runner files or the source repository. A second probe checked that a `sandbox.excludedCommands` in the `.claude/settings.json` of the clone does not open the sandbox, and that Claude Code refuses a Write of `.claude/settings.local.json` by the agent. Limits: Read, Edit and Write are not sandboxed (the permission rules guard them), and the `claude` process itself runs as your user.

Known limit: the runner cleans the process group when the output of the agent closes, not when the agent exits. If the agent leaves a child in its group that keeps the output open, the runner waits until the timeout. The run then shows `timedOut: true` with an exit code of 0, and it counts as a timeout. The timeout still kills the group, so no child survives into the diff.

Residual risk: an agent with shell access can unset the environment variables and delete the hook. It can also use absolute paths to reach files outside the clone; the permission system of the CLI is the guard for that, not the runner. The acceptance command runs code from the clone by design. The isolation of the clone (no remote, no shared objects, a git dir that the runner owns) is the main guard.

The clone keeps only the base commit and its ancestors. The runner makes an empty repository and fetches the base commit only, so a later commit (the solution of a task mined from a past session) is not in the clone: no ref, no object. The fetch writes a new pack, so no object file is shared with the source repository.

Codex and opencode configs can run in a container (`container: true`, see above). Claude Code runs on the host.

### Output

Under `eval-runner/out/<evalId>/`, which git ignores. `evalId` is the UTC date, then the spec name.

| Path | Content |
|---|---|
| `eval.json` | Spec, base SHA, CLI version, runs with their metrics and grades, and the median, min, max, pass rate and grade counts per configuration. |
| `runs/<runId>/claude.json` | The CLI result (Claude Code). |
| `runs/<runId>/events.jsonl` | The raw JSON events (Codex, opencode). |
| `runs/<runId>/transcript.jsonl`, `subagents/` | Copy of the transcript. For Codex and opencode, the transcript built from the events. |
| `runs/<runId>/session.json` | The session file of the viewer. |
| `runs/<runId>/diff.patch` | The final diff against the setup commit. |
| `runs/<runId>/acceptance.log` | The last 64 KB of the acceptance output. |
| `runs/<runId>/grade-<name>.log` | The stdout and the stderr of the command grader `<name>`. |
| `eval-runner/out/index.json` | The list of evals. |

> **Warning:** the output holds your transcripts and the agent diffs. Do not commit or share it.

### Known leaks

- Without `bare`, the `~/.claude/CLAUDE.md` of the user and the user skills can still load into every configuration. The result records `claude --version`.
- Only committed content is cloned. Uncommitted changes in the source repository are not part of the task.
- The "→ session" link opens only if the build indexed that transcript, so the run must be inside the `--days` window.
- In print mode, `interrupts` and `refusals` stay at 0, and the view hides a metric row where every run has 0.

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
- **Classifier outage.** The auto mode classifier gave no verdict, so the call never ran (`outages`). An outage is not an error of the agent. A check that an outage blocked does not verify the task.
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
| `out/index.json` | One row per session: cost, tokens, errors, `interrupts`, `refusals`, `denials`, `outages`, task verdicts with `tasks.verified` and `tasks.failed`, `mrs`. Totals of the waste signals. |
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
