# marko-agent

Local multi-agent WordPress plugin builder. A single CLI that turns a one-line request into a scaffolded WP plugin — planned by Claude, written and reviewed by local Ollama models, lint-clean, ready to push to GitHub.

Three roles:

| Role     | Default                                | Job                                                    |
| -------- | -------------------------------------- | ------------------------------------------------------ |
| Planner  | **Claude** (via `claude` CLI, your subscription) | Triages the request, asks clarifying Qs, emits a plan. |
| Coder    | `qwen3-coder:30b` on Ollama            | Writes each file from the plan.                        |
| Reviewer | `qwen3-coder:30b` on Ollama            | Reviews each file for security / correctness / standards. |

The planner uses Claude because high-quality planning matters most and is the smallest token footprint. The coder/reviewer stay local because that's where token volume lives. If `claude` CLI is missing or fails, the planner auto-falls-back to a local Ollama model — nothing blocks.

> No API keys. The Claude planner uses your Pro/Max subscription via Claude Code CLI; coder/reviewer are fully local. Everything else stays on the machine.

---

## Requirements

- macOS (tested on M1 Max) — Linux likely works too.
- **Node.js** ≥ 20.18
- **PHP** (any 7.4+, used for `php -l` syntax checks)
- **git**
- **Ollama** running locally (`ollama serve` or the Mac app)
- **Claude Code CLI** (`claude`) — recommended; uses your Pro/Max subscription. Optional if you want fully local.
- **GitHub CLI** (`gh`) — only needed if you use `mka push`

Pull the local models:

```bash
ollama pull qwen3:8b           # planner fallback
ollama pull qwen3-coder:30b    # coder + reviewer
```

> The 30B coder uses ~19 GB of RAM while loaded. Comfortable on 64 GB; on 16 GB use a smaller model: `mka config set coder_model qwen3-coder:14b`.

---

## Install

```bash
git clone https://github.com/krstivoja/marko-agent.git
cd marko-agent
npm install
chmod +x marko-agent.mjs
npm link
```

`npm link` installs **two** global commands:

- `marko-agent` — full name
- `mka` — short alias

Use whichever you like, they're identical. To uninstall: `npm unlink -g marko-agent`.

If `npm link` fails with `EACCES`, you have permission issues with `/usr/local`. Move npm's global prefix to a user-owned folder:

```bash
mkdir -p "$HOME/.npm-global"
npm config set prefix "$HOME/.npm-global"
echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

Then `npm link` again.

First-run check:

```bash
mka doctor
mka setup
```

`setup` writes `~/.marko-agent/config.json`. You can also edit that file directly.

---

## Commands

### `mka doctor`

Verifies node/php/git/gh are installed, the `claude` CLI is on PATH, Ollama is reachable, and configured models are pulled. Run this any time something looks off.

### `mka ping`

Sends a one-line request to each agent and reports timing. The fastest way to confirm the whole stack is alive without burning a real build.

```
🏓 Pinging agents

1. planner
   [planner→claude] thinking…
   └─ done in 2.3s  (15 chars)
  ✓ planner replied in 2.4s

2. coder
   [coder→ollama:qwen3-coder:30b] thinking…
   └─ done in 4.1s
  ✓ coder replied

3. reviewer
   [reviewer→ollama:qwen3-coder:30b] thinking…
   └─ done in 3.8s
  ✓ reviewer replied
```

### `mka setup`

Interactive config. Picks the planner provider (Claude or Ollama), Ollama host, role models, output directory, max review rounds, and the GitHub owner used by `push`.

### `mka models`

Lists models pulled in Ollama and which role each is assigned to. Also shows the planner provider.

### `mka plan <request>`

Triages and plans without writing any files. Useful for iterating on a request before committing to a build.

```bash
mka plan "Block that renders a customer testimonial carousel"
```

### `mka build <request>`

Plans, asks any clarifying questions, shows the plan, asks for confirmation, then generates each file. Each file goes through:

1. **Coder** writes the file.
2. **`php -l`** syntax check (PHP files only). On failure, the error is fed back to the coder as a blocker.
3. **Reviewer** LLM checks for security/correctness/WP standards. If it flags major/blocker issues, the coder rewrites with the notes.
4. Repeat up to `max_review_rounds` (default 3). Last draft is written even if not approved.

After all files are written:

- Initialises a local git repo in the plugin folder.
- Commits the scaffold to `main`.
- Creates a feature branch `feat/<slug>-<timestamp>`.

#### Where the plugin lands

| Command                          | Output goes to                                         | Slug                       |
| -------------------------------- | ------------------------------------------------------ | -------------------------- |
| `mka build "..."` (cwd default)  | **The current folder.** Files written directly into it. | Derived from folder name   |
| `mka build --out <dir> "..."`    | `<dir>/<slug>/` (nested)                                | Picked by planner          |
| `mka build "..."` with `out_dir` set in config | `<out_dir>/<slug>/` (nested)              | Picked by planner          |

The cwd-default behavior is like `git init` — you're already in the folder you want, so don't nest. Example:

```bash
mkdir ~/Desktop/word-counter && cd ~/Desktop/word-counter
mka build "Settings page under Tools that counts words in a textarea"
# → files land in ~/Desktop/word-counter/  with slug "word-counter"
# → main file is word-counter.php
```

If the cwd already has files (other than dotfiles or `node_modules`), you'll be asked to confirm before anything writes.

### `mka list`

Lists every plugin found in the configured `out_dir` (or current folder if none configured).

### `mka push <slug>`

Pushes the plugin to GitHub under the configured owner, creates a PR, and enables auto-merge (squash, delete branch). Requires `gh auth status` authenticated and `github_owner` set in config.

```bash
mka push word-counter
```

### `mka config`

Show or change config:

```bash
mka config                              # print current config
mka config set max_review_rounds 5
mka config set coder_model qwen3-coder:14b
mka config set planner_provider ollama  # disable Claude, go fully local
mka config set github_owner krstivoja
mka config set out_dir ""               # blank = use current folder
```

Valid keys: `ollama_host`, `planner_provider`, `planner_model`, `coder_model`, `reviewer_model`, `out_dir`, `max_review_rounds`, `github_owner`.

---

## Typical workflow

```bash
# one-time
mka setup
mka doctor    # verify everything's wired up

# new plugin in a fresh folder
mkdir ~/Desktop/wp-faq && cd ~/Desktop/wp-faq

# preview the plan first (optional)
mka plan "Add a CPT for FAQs with a Gutenberg block to render them"

# happy with it? build
mka build "Add a CPT for FAQs with a Gutenberg block to render them"

# inspect, then ship
git status
mka push wp-faq
```

---

## How it works

```
                      ┌────────────┐
   request ────────►  │  Planner   │  Claude (via claude CLI)
                      │ triage +   │  fallback: qwen3:8b on Ollama
                      │ plan       │
                      └─────┬──────┘
                            │  blueprint (file list)
                            ▼
   ┌──────────────────────────────────────────────┐
   │  for each file in blueprint                  │
   │   ┌──────────┐    ┌──────────┐               │
   │   │  Coder   │ ─► │ php -l   │               │
   │   └──────────┘    └────┬─────┘               │
   │        ▲               │ ok                  │
   │        │ fix notes     ▼                     │
   │   ┌──────────┐                               │
   │   │ Reviewer │ ─► approved? → write file     │
   │   └──────────┘                               │
   │   coder + reviewer: qwen3-coder:30b on Ollama│
   └──────────────────────────────────────────────┘
                            │
                            ▼
                   local git repo + branch
                            │
                            ▼
              mka push <slug>  ───►  GitHub PR
```

- **Stateless models.** Every LLM call is a fresh chat; the plan + previous draft + reviewer notes are passed in the prompt. No memory needed.
- **Structured outputs.** Planner and reviewer return JSON; a defensive parser strips `<think>` tags and code fences before `JSON.parse`.
- **Lint loop.** `php -l` runs on each PHP file before review. A syntax error is queued as a blocker issue so the coder fixes it on the next round.
- **Auto-fallback.** If `claude` CLI is missing or fails mid-run, the planner falls back to the configured Ollama model and prints a yellow warning. The build keeps going.
- **Live observability.** Every LLM call prints `[role→provider:model] thinking…` and reports duration when done.

---

## Configuration file

`~/.marko-agent/config.json`:

```json
{
  "ollama_host": "http://localhost:11434",
  "planner_provider": "claude",
  "planner_model": "qwen3:8b",
  "coder_model": "qwen3-coder:30b",
  "reviewer_model": "qwen3-coder:30b",
  "out_dir": "",
  "max_review_rounds": 3,
  "github_owner": "krstivoja"
}
```

Notes:

- `planner_provider`: `"claude"` (default, uses `claude` CLI subscription) or `"ollama"` (fully local).
- `planner_model`: the Ollama model used as planner **fallback** when provider is `claude`, or the primary planner when provider is `ollama`.
- `out_dir`: `""` (blank) means "build into the current working directory." Set a path to always nest under it.

Edit the file directly or via `mka config set <key> <value>`.

---

## Distribute it

### 1. Share the git repo

Easiest. Anyone with Node + Ollama can:

```bash
git clone https://github.com/krstivoja/marko-agent.git
cd marko-agent
npm install
npm link
```

### 2. `npm pack` for a tarball

For sharing a pinned snapshot without a registry:

```bash
npm pack
# produces marko-agent-1.0.0.tgz

# on another machine:
npm install -g ./marko-agent-1.0.0.tgz
```

### 3. Publish to npm

If you want `npm install -g marko-agent` to Just Work:

```bash
npm login                  # one-time
npm version patch          # bumps version + tags
npm publish --access public
```

Before publishing, add a `files` whitelist to `package.json` so you don't ship dev junk:

```json
{
  "files": ["marko-agent.mjs", "README.md", "LICENSE"],
  "engines": { "node": ">=20.18" }
}
```

If the name `marko-agent` is taken on npm, scope it: `@krstivoja/marko-agent` in `package.json`.

---

## Troubleshooting

**`zsh: command not found: mka`**
`npm link` didn't run, or your npm global `bin` isn't on `PATH`. Check with `npm config get prefix` — that path's `/bin` directory needs to be on `PATH`.

**`ollama unreachable`**
Start Ollama: `ollama serve` in another terminal, or open the Ollama Mac app.

**`<model> not pulled`**
`ollama pull <model>` — match the name exactly as shown by `ollama list`.

**`planner_provider=claude but claude CLI not on PATH`**
Install Claude Code (https://docs.claude.com/claude-code/) or switch to local: `mka config set planner_provider ollama`.

**Claude planner fails mid-run**
Auto-falls-back to the configured Ollama planner model. Verify the fallback is pulled with `mka doctor`.

**Reviewer keeps rejecting forever**
Up `max_review_rounds`, or look at the issues — the reviewer can be pedantic. The last draft is still written. You can also run `mka config set reviewer_model qwen3:8b` for a faster, less strict reviewer.

**First run after reboot is slow (~30s)**
That's Ollama loading the model into memory. Subsequent calls are fast. Pre-warm with `ollama run qwen3-coder:30b "ready"`.

**Generated PHP fails `php -l` repeatedly**
The lint loop catches and retries. If it loops three times, inspect the file by hand — usually a smaller, more focused request fixes it.

**`gh: command not found` on `push`**
`brew install gh && gh auth login`. Or skip `push` and use `git remote add origin … && git push` manually.

---

## Roadmap

- `phpcs` (WordPress ruleset) and `wp plugin check` as additional gates between lint and reviewer.
- `mka logs` — last N runs with timing, token counts, approval rates.
- Optional Claude API planner mode (instead of CLI), for users without a subscription.
- A v2 that boots the plugin in WP Playground and runs smoke tests before approval.

---

## License

MIT. Use, fork, modify, ship.
