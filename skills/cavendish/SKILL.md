---
name: cavendish
description: >-
  Query ChatGPT Pro and Deep Research from the shell via the Cavendish CLI.
  Run prompts, attach files (including a repo tar.gz + git diff for an
  architecture-level code review with full repo context), and wait for the
  result through detached jobs.
  EXPLICIT TRIGGER: "ask ChatGPT", "ask GPT", "run Deep Research",
  "get GPT's opinion", "send the repo to ChatGPT", or equivalent wording.
  DEFAULT — `ask` is the right default for almost any non-trivial question
  where ChatGPT Pro's perspective would add value: design decisions,
  architecture-level code review with full repo context, low-confidence
  technical claims, second-opinion checks, or whenever a second LLM view
  is useful. Attach tar.gz / diff / individual files as the question warrants.
  USE deep-research INSTEAD when the task is a broad, multi-source
  investigation — comparing 3+ vendors / technologies with possibly stale
  training data, gathering current market / pricing / regulatory data, or
  whenever the user asks for a thorough or comprehensive investigation
  across many sources.
  AVOID for: fast / line-level code review (use a faster code-review tool
  — Cavendish is minutes-slow) and pure single-fact lookups the assistant
  can answer in one step. Anything else is fair game.
---

# Cavendish

Cavendish is a Playwright-based CLI that gives shell-level access to
ChatGPT Pro and Deep Research. It is slow (minutes per response) but
delivers Pro-quality output and Deep Research's autonomous multi-source
investigation.

## TL;DR — the one rule that matters

**Always run via the detached job + `jobs wait` pattern. Do NOT use `--sync`.**

`ask` / `deep-research` are detached by default: they immediately return a
job id and a worker drives the browser in the background. Wait for the
result with `cavendish jobs wait <id>`. Pro responses can stall silently
for 5–10 minutes while the model is thinking; synchronous mode hits the
response-stall watchdog long before that.

```bash
ID=$(cavendish ask "question" --format json | jq -r .jobId)
cavendish jobs wait "$ID" --format text
```

For long jobs, run the wait inside a **sub-agent** so the main context is
not blocked.

## Do NOT set `--timeout` (read once)

The default timeout is **unlimited** for both `ask` / `deep-research` and
`jobs wait` — leave `--timeout` unset so any-length response is captured
without re-runs.

If you DO pass `--timeout N`, Cavendish enforces a response-stall check
on top of it: `stall_window = max(15s, N / 4)`. A short `--timeout` like
`--timeout 300` cuts off a Pro response at the first 75-second silence,
which is what every "Response stalled for ..." failure looks like. The
fix is almost always **drop `--timeout`** rather than raise it.

Set `--timeout` only when you genuinely need a deadline (e.g. CI cell
must finish within an hour). In that case set it generously and remember
the `/4` stall rule.

## When to Use (Decision Guide)

**Default: `ask` (Pro) is the right tool for almost any non-trivial question.** Switch to `deep-research` only when the task is a broad, multi-source investigation. For fast, line-level code review, reach for a tool optimized for that workflow — Cavendish's minutes-per-response latency is the wrong shape.

| Situation | Action |
|-----------|--------|
| Default — any non-trivial question where Pro's perspective adds value | `ask` |
| Design decision, low-confidence technical claim, second-opinion check | `ask` (add tar.gz if codebase context matters) |
| **Architecture-level code review with full repo context** | `ask` with **tar.gz + git diff** attached |
| Reasoning-heavy question | `ask --model Thinking` |
| Broad, multi-source investigation (5+ sources, current data) | `deep-research` |
| Comparing 3+ technologies / vendors with possibly stale training data | `deep-research` |
| Both — broad research AND repo-specific judgment | Two-phase: see "Combining Deep Research with repo-context `ask`" |
| Fast / incremental / line-level code review | **Use a faster code-review tool** — Cavendish is minutes-slow |
| Pure single-fact lookup answerable in one step | Skip Cavendish |

## ask — Query ChatGPT

```bash
# Standard ask (detached + jobs wait, unlimited timeout)
ID=$(cavendish ask "question" --format json | jq -r .jobId)
cavendish jobs wait "$ID" --format text

# Thinking model (reasoning-heavy)
cavendish ask --model Thinking "question"

# Pipe stdin
cat file.ts | cavendish ask "Review this code"
```

Run `cavendish ask --help` for all flags.

## deep-research — Comprehensive Research

Takes minutes, not seconds — use only when the depth justifies the wait.

```bash
ID=$(cavendish deep-research "topic" --format json | jq -r .jobId)
cavendish jobs wait "$ID" --format text

cavendish deep-research --export pdf --exportPath ./report.pdf "topic"
cavendish deep-research --chat <chat-id> "Follow up"
```

`--export` accepts `markdown`, `word`, or `pdf`, and is set on the `deep-research` submission (not on `jobs wait`). Run `cavendish deep-research --help` for all flags.

## Integration Patterns

### Send a repository for a design / architecture opinion

Use this when the question is **prospective** (no in-flight change to review yet) — e.g. comparing two architectures, picking a library, asking how to refactor. For an in-flight PR or branch, use the next section instead.

```bash
tmpdir=$(mktemp -d "${TMPDIR:-/tmp}/cavendish.XXXXXX")
trap 'rm -rf "$tmpdir"' EXIT

git archive --format=tar.gz --prefix=repo/ HEAD -o "$tmpdir/repo.tar.gz"

ID=$(cavendish ask --file "$tmpdir/repo.tar.gz" \
  "Review the architecture and suggest improvements for the error handling layer." \
  --format json | jq -r .jobId)
cavendish jobs wait "$ID" --format text
```

`git archive` snapshots **tracked files** at the given ref from the Git tree — NOT the working directory. Implications:
- Untracked / `.gitignore`-ignored files are not in the archive; uncommitted changes (staged or working-tree) are not either. For WIP reviews, commit / stash first, or use a worktree snapshot.
- Archive exclusions are controlled by `.gitattributes` `export-ignore`, not `.gitignore`.

Run `git archive` from the repo root, or pass `git -C <repo-path> archive ...`. The `mktemp -d` + `trap … EXIT` pattern keeps the temp files unique and cleans up even if a step fails.

### Architecture-level code review (tar.gz + git diff)

Use this when reviewing an **in-flight** branch or PR. The diff alone often lacks context (cross-cutting refactors, hidden coupling, test-coverage tradeoffs); attaching the repo alongside lets Pro relate the diff to the surrounding code. For prospective design questions without a diff, use the previous section instead.

```bash
# Replace BASE with the PR's actual base ref (e.g. origin/main, origin/develop, upstream/release-1.x).
BASE=origin/main

tmpdir=$(mktemp -d "${TMPDIR:-/tmp}/cavendish-review.XXXXXX")
trap 'rm -rf "$tmpdir"' EXIT

# Snapshot the committed HEAD of the feature branch
git archive --format=tar.gz --prefix=repo/ HEAD -o "$tmpdir/repo.tar.gz"

# Diff against the chosen base ref (three-dot form gives changes since the merge-base)
git diff "$BASE"...HEAD > "$tmpdir/changes.diff"

ID=$(cavendish ask \
  --file "$tmpdir/repo.tar.gz" \
  --file "$tmpdir/changes.diff" \
  "Attached: (1) repo.tar.gz — the committed HEAD snapshot of the feature branch as a tar.gz, (2) changes.diff — the proposed changes vs the PR base as a unified diff. Review the diff against the repo for: architectural impact, hidden coupling that the diff might break, and test-coverage gaps. Reference specific files and line numbers in the diff." \
  --format json | jq -r .jobId)
cavendish jobs wait "$ID" --format text
```

Notes:
- `BASE` must match the **actual PR base** — `origin/main` is just a placeholder. For forked / non-fetched bases, run `git fetch <remote> <branch>` first.
- `git archive HEAD` captures the **committed** state. Uncommitted (staged or working-tree) changes are not included — commit / stash before running for a WIP review, or snapshot from a worktree.

Variants:
- **Two `--file` flags** (the example above) is the safest default — Pro sees both artifacts as named files.
- **Pipe the diff via stdin** when the diff is small (≲100 lines / a few KB) and you want to keep the file count down: `git diff "$BASE"...HEAD | cavendish ask --file "$tmpdir/repo.tar.gz" "..."`.
- For a single-PR review, also include the PR title + body in the prompt so Pro understands the author's intent.

### Combining Deep Research with repo-context `ask`

Use this when a task needs **both** current multi-source research **and** repo-specific design judgment — e.g. "compare 3+ ORMs/vendors and recommend the fit for this codebase." Run the two phases sequentially (jobs serialize via the process lock anyway):

1. Run `deep-research` first for the external / current facts. Capture the result text.
2. Then run `ask` with the repo `tar.gz` attached, and include the Deep Research result as background in the prompt.

Do NOT attach the repo to `deep-research` (it is for autonomous web investigation, not codebase reasoning); use `ask` for the repo-aware second pass. If the Deep Research output is large, write it to a file and pass it as an additional `--file` instead of inlining it via shell-variable expansion.

### As a sub-agent task (recommended for long jobs)

Spawn a sub-agent so the main context is not blocked while waiting:

```
Agent prompt:
  "Run:
     tmpdir=$(mktemp -d \"${TMPDIR:-/tmp}/cavendish.XXXXXX\")
     trap 'rm -rf \"$tmpdir\"' EXIT
     git archive --format=tar.gz --prefix=repo/ HEAD -o \"$tmpdir/repo.tar.gz\"
     ID=$(cavendish ask --file \"$tmpdir/repo.tar.gz\" '<question>' --format json | jq -r .jobId)
     cavendish jobs wait \"$ID\" --format text
   Return the result text verbatim."
```

### Piping project context

```bash
git diff HEAD~5 | cavendish ask "Review these changes for potential issues"
cat src/schema.ts | cavendish ask "Suggest improvements"
```

### Structured output

Use `--format json` for machine-readable output (`chatId`, `url`, `model`, `timeoutSec`, etc.).

## Chat Management

Batch supported — pass multiple IDs or use `--stdin`:

```bash
cavendish delete id1 id2 id3
cavendish list --format json | jq -r '.[].id' | cavendish delete --stdin
```

Always clean up test conversations after live testing.

## Error Handling

Most common exit codes (full table: `references/commands.md`):

- **2** `cdp_unavailable` → `cavendish init`
- **4** `auth_expired` → re-login in Chrome
- **5** `cloudflare_blocked` → solve in Chrome tab
- **7** `timeout` (incl. stall) → drop `--timeout` (or raise it) and resubmit

With `--format json`, errors are written to stderr as structured JSON:

```json
{"error": true, "category": "timeout", "message": "...", "exitCode": 7, "action": "..."}
```

## Process Lock

Only one Cavendish command interacts with the browser at a time. The
detached job runner serialises queued jobs, so you can submit several
`ask` / `deep-research` jobs back-to-back; they run sequentially. Do
not invoke Cavendish in parallel from a script — the lock will reject
all but one.

## Best Practices

- **Detach + `jobs wait`** is the default workflow. Use `--sync` only for
  sub-30-second smoke tests.
- **Leave `--timeout` unset** so any-length response is captured. Setting
  it shortens the stall window to `--timeout / 4` and is the #1 cause of
  premature `category: timeout` failures.
- Prefer `git archive` over manual `tar` for committed snapshots; exclusions
  come from `.gitattributes` `export-ignore`, not `.gitignore`.
- For broad, multi-source/current research tasks, prefer `deep-research`
  over `ask` — it autonomously searches multiple sources.
- For architecture-level code review, attach **tar.gz + diff together**;
  the diff alone often lacks context.
- Present ChatGPT results as "ChatGPT's perspective", not as a definitive
  answer. Note Deep Research provenance when citing.
- Use batch delete / archive to clean up test conversations efficiently.
