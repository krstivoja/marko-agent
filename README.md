# marko-agent

Local multi-agent WordPress plugin builder. A single CLI that turns a one-line request into a scaffolded WP plugin, reviewed and lint-clean, ready to push to GitHub.

Three roles, all running on your Mac via [Ollama](https://ollama.com):

| Role     | Default model       | Job                                                    |
| -------- | ------------------- | ------------------------------------------------------ |
| Planner  | `qwen3:8b`          | Triages the request, asks clarifying Qs, emits a plan. |
| Coder    | `qwen3-coder:30b`   | Writes each file from the plan.                        |
| Reviewer | `qwen3-coder:30b`   | Reviews each file for security/correctness/standards.  |

No API keys. No cloud calls. Everything stays on the machine.

---

## Requirements

- macOS (tested on M1 Max) — Linux likely works too.
- **Node.js** ≥ 20.18
- **PHP** (any 7.4+, used for `php -l` syntax checks)
- **git**
- **Ollama** running locally (`ollama serve` or the Mac app)
- **GitHub CLI** (`gh`) — only needed if you use `marko-agent push`

Pull the models:

```bash
ollama pull qwen3:8b
ollama pull qwen3-coder:30b
```

> The 30B coder needs roughly 19 GB of RAM while running. On a 64 GB M1 Max that's comfortable; on 16 GB you'll want a smaller coder model and to bump it via `marko-agent config set coder_model <name>`.

---

## Install

```bash
git clone <this repo> marko-agent
cd marko-agent
npm install
chmod +x marko-agent.mjs
npm link
```

`npm link` symlinks `marko-agent` into your global `bin`, so the command works from any directory. To uninstall: `npm unlink -g marko-agent`.

First-run check:

```bash
marko-agent doctor
marko-agent setup
```

`setup` writes `~/.marko-agent/config.json`. You can also edit that file directly.

---

## Commands

### `doctor`

Verifies node/php/git/gh are installed, Ollama is reachable, and the three configured models are pulled. Run this any time something looks off.

### `setup`

Interactive config. Picks the Ollama host, the three role models (from a list of pulled models if Ollama is reachable), the output directory, max review rounds, and the GitHub owner used by `push`.

### `models`

Lists models pulled in Ollama with their currently assigned roles.

### `plan <request>`

Triages and plans without writing any files. Useful for iterating on a request before committing to a build.

```bash
marko-agent plan "Block that renders a customer testimonial carousel"
```

### `build <request>`

Plans, asks any clarifying questions, shows the plan, asks for confirmation, then generates each file. Each file goes through:

1. Coder writes the file.
2. `php -l` syntax check (PHP files only). On failure, the error is fed back to the coder as a blocker.
3. Reviewer LLM checks for security/correctness/WP standards. If it flags major/blocker issues, the coder rewrites with the notes.
4. Repeat up to `max_review_rounds` (default 3). Last draft is written even if not approved.

After all files are written:

- Initialises a local git repo in `<out_dir>/<plugin-slug>/`.
- Commits the scaffold to `main`.
- Creates a feature branch `feat/<slug>-<timestamp>`.
- Prints the path and tells you how to push.

```bash
marko-agent build "Settings page under Tools → Word Counter with a textarea and live word count"
```

### `list`

Lists every plugin built so far in the configured `out_dir`.

### `push <slug>`

Pushes the plugin to GitHub under the configured owner, creates a PR, and enables auto-merge (squash, delete branch). Only works if `gh auth status` is authenticated and `github_owner` is set in config.

```bash
marko-agent push word-counter
```

If the repo already exists on GitHub, it falls back to a plain `git push -u origin HEAD`.

### `config`

Show or change config:

```bash
marko-agent config                              # print current config
marko-agent config set max_review_rounds 5
marko-agent config set coder_model qwen3-coder:14b
marko-agent config set github_owner dplugins
```

Valid keys: `ollama_host`, `planner_model`, `coder_model`, `reviewer_model`, `out_dir`, `max_review_rounds`, `github_owner`.

---

## Typical workflow

```bash
# one-time
marko-agent setup

# iterate on the idea
marko-agent plan "Add a CPT for FAQs with a Gutenberg block to render them"

# happy with the plan? build it
marko-agent build "Add a CPT for FAQs with a Gutenberg block to render them"

# inspect locally, then ship
cd "$(marko-agent config | jq -r .out_dir)/wp-faq"
git status
marko-agent push wp-faq
```

---

## How it works

```
                                   ┌────────────┐
   user request ───────────────►   │  Planner   │  qwen3:8b
                                   │ (triage +  │
                                   │  plan)     │
                                   └─────┬──────┘
                                         │  blueprint
                                         ▼
                  ┌──────────────────────────────────────────┐
                  │  for each file in blueprint              │
                  │   ┌──────────┐    ┌──────────┐           │
                  │   │  Coder   │ ─► │ php -l   │           │
                  │   └──────────┘    └────┬─────┘           │
                  │        ▲               │ ok              │
                  │        │ fix notes     ▼                 │
                  │   ┌──────────┐                           │
                  │   │ Reviewer │ ─► approved? write file   │
                  │   └──────────┘                           │
                  └──────────────────────────────────────────┘
                                         │
                                         ▼
                              local git repo + branch
                                         │
                                         ▼
                          marko-agent push <slug>  ───►  GitHub PR
```

- **Stateless models.** Every LLM call is a fresh chat; the plan + previous draft + reviewer notes are passed in the prompt. No memory needed.
- **Structured outputs.** Planner and reviewer use Ollama's `format: 'json'` mode, plus a defensive parser that strips `<think>` tags and code fences before `JSON.parse`.
- **Lint loop.** `php -l` runs on each PHP file before review. A syntax error is queued as a blocker issue so the coder fixes it on the next round.

---

## Configuration file

`~/.marko-agent/config.json`:

```json
{
  "ollama_host": "http://localhost:11434",
  "planner_model": "qwen3:8b",
  "coder_model": "qwen3-coder:30b",
  "reviewer_model": "qwen3-coder:30b",
  "out_dir": "/Users/you/Local Sites/marko-agent/out",
  "max_review_rounds": 3,
  "github_owner": "dplugins"
}
```

Edit by hand or via `marko-agent config set`.

---

## Distribute it

A few options, in order of effort:

### 1. Share the git repo

Easiest. Anyone with Node + Ollama can:

```bash
git clone <your repo>
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
# one-time
npm login

# every release
npm version patch          # or minor/major — bumps version + tags
npm publish --access public
```

Before publishing, add a `files` whitelist to `package.json` so you don't ship dev junk:

```json
{
  "files": ["marko-agent.mjs", "README.md", "LICENSE"],
  "engines": { "node": ">=20.18" }
}
```

If the name `marko-agent` is taken on npm, scope it: rename to `@yourname/marko-agent` in `package.json` and publish that instead.

### 4. Homebrew tap

For a `brew install marko-agent` experience, write a Formula and host a tap repo. More effort, only worth it if you're distributing widely.

---

## Troubleshooting

**`ollama unreachable`**
Start Ollama: `ollama serve` in another terminal, or open the Ollama Mac app.

**`<model> not pulled`**
`ollama pull <model>` — match the name exactly as shown by `ollama list`.

**Reviewer keeps rejecting forever**
Up `max_review_rounds`, or look at the issues being flagged — the reviewer is sometimes pedantic. The last draft is still written to disk. You can also run `marko-agent config set reviewer_model qwen3:8b` for a faster, less strict reviewer.

**First run after reboot is slow (~30s)**
That's Ollama loading the model into memory. Subsequent calls are fast. Pre-warm with `ollama run qwen3-coder:30b "ready"`.

**Generated PHP fails `php -l` repeatedly**
Usually the coder is mixing template literals with PHP heredocs. The lint loop should catch and retry; if it loops three times, inspect the file by hand. Often a smaller, more focused request fixes it.

**`gh: command not found` on `push`**
`brew install gh && gh auth login`. Or skip `push` and use `git remote add origin … && git push` manually.

**`zsh: command not found: marko-agent`**
`npm link` didn't run, or your global `bin` isn't on `PATH`. Check with `npm config get prefix` — that path's `/bin` directory needs to be on your `PATH`.

---

## Roadmap

- `phpcs` (WordPress ruleset) and `wp plugin check` as additional gates between lint and reviewer.
- `marko-agent logs` — show last N runs with timing, token counts, approval rates.
- Optional Claude API planner for harder tasks (`marko-agent config set planner_provider anthropic`).
- A v2 mode that boots the plugin in WP Playground and runs smoke tests before approval.

---

## License

MIT. Use, fork, modify, ship.
