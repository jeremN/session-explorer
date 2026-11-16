# Eval suite: where each agent is best, and what a config change does

Status: approved in conversation on 2026-11-16. Order of work below.

## Intent

Two questions, one base:

1. **Agent map.** For each kind of task, which agent and model is the best, at which cost. Agents are Claude Code first, then other CLIs (Codex, Gemini CLI, opencode).
2. **Config regression.** When a skill, a `CLAUDE.md` or an `AGENTS.md` changes, did the agent get better or worse on the tasks that the change touches.

The base is a set of tasks, each with a category, run under one or more configurations.

## Goals

- Tasks that look like the real work of the user, mined from past sessions, plus hand-written tasks for the gaps.
- A result that informs. It never blocks a merge.
- A cost that follows the doubt: few runs when the result is clear, more runs only when it is not.
- Outcome metrics that compare across every agent: acceptance, cost, wall time, diff size.

## Non-goals

- A public benchmark score.
- A gate in CI with a pass threshold.
- A transcript parser for every CLI in the first version. Behaviour metrics stay Claude-only until a parser exists.

## Anti-goals

- A mined task where the agent can read the solution. The clone holds no commit after the base, and the hidden tests come in only after the agent stops.
- A difference reported as real when it is inside the noise of the reference runs.
- Private transcript text that leaves the machine. Mining runs locally, like `build.ts`.

## Approaches considered

- **Task source.** Past sessions (picked: matches the real work), hand-written tasks (kept for gaps), public benchmark (dropped: says little about this work).
- **Outcome of a regression.** Report (picked: cheap, 3 to 5 runs per task), gate (dropped: needs 10+ runs per task and a threshold someone maintains).
- **Isolation for other CLIs.** Container (picked for step 3: one layer for every CLI), the sandbox of each CLI (dropped: each one differs, some have none).

## Design

### Step 1: tasks from history

- **History cut.** For every run, the clone keeps only the base commit and its ancestors. The runner deletes every other ref, expires the reflogs and prunes the unreachable objects. A test proves that a commit after the base is not readable in the clone.
- **Mining.** `npm run eval:mine` reads the local session index and lists candidates: a task that was verified with a passing check, in a git repository that still exists, with a commit made during the session (the solution). Each candidate holds the repo, the base (the branch head before the session started), the first prompt of the task, the solution commit, the test files that the solution changed, and the last check command. The candidates go to a local file, never to a network service.
- **Hidden tests.** A task can name `hiddenTests: { commit, paths }`. The runner copies these files from the solution commit into the clone after the agent stops and before the acceptance command. The diff of the agent is recorded before the copy.
- **Curation.** The user accepts a candidate by moving it into a suite directory. A viewer page for this comes later.

### Step 2: cache and `eval diff`

- **Cache.** A result is keyed by task, agent, model, a hash of the configuration files, and the CLI version. A new key means a new run; an old key reuses the result.
- **`eval diff <file>`.** Builds two configurations from git: the file at `HEAD` and the file in the working tree. Runs only the tasks whose tags match the file. Reports the change per task and per category.
- **Noise band.** The reference side runs 3 times. A change is flagged only when it is outside the spread of the reference runs. A borderline task gets more runs, up to 10.
- **Skill trigger rate.** For a skill change, the report shows how often the skill loaded (the `Skill` tool in Claude transcripts), before the pass rate.

### Step 3: agent adapters and container

- An adapter per CLI builds the command, reads the cost, and finds the transcript when a parser exists. Codex first, then Gemini CLI and opencode.
- A container image per CLI. Only the clone is mounted. The network is limited to the model API.

### Step 4: routing table

- Per category: pass rate against cost for each agent and model. The result proposes changes to `~/.claude/model-matrix.md`, with the numbers.
- Tasks that every agent passes, or that every agent fails, are marked as non-discriminating.

## Left to the builder

- The file layout of a suite directory, and how a spec points at it.
- How the miner finds the solution commit when the session made several commits (first proposal: the last commit on the branch before the session ended).
