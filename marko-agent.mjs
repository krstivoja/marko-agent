#!/usr/bin/env node
import { Command } from 'commander';
import { Ollama } from 'ollama';
import { input, select, confirm } from '@inquirer/prompts';
import { simpleGit } from 'simple-git';
import { execSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

const HOME = homedir();
const CONFIG_DIR = join(HOME, '.marko-agent');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
const DEFAULT_OUT = join(HOME, 'Local Sites', 'marko-agent', 'out');

const DEFAULTS = {
  ollama_host: 'http://localhost:11434',
  planner_model: 'qwen3:8b',
  coder_model: 'qwen3-coder:30b',
  reviewer_model: 'qwen3-coder:30b',
  out_dir: DEFAULT_OUT,
  max_review_rounds: 3,
  github_owner: '',
};

const c = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m',
};

const ok = (m) => console.log(`  ${c.green}✓${c.reset} ${m}`);
const bad = (m) => console.log(`  ${c.red}✗${c.reset} ${m}`);
const warn = (m) => console.log(`  ${c.yellow}!${c.reset} ${m}`);
const head = (m) => console.log(`\n${c.bold}${m}${c.reset}`);

function loadConfig() {
  if (!existsSync(CONFIG_FILE)) return { ...DEFAULTS };
  try { return { ...DEFAULTS, ...JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) }; }
  catch { return { ...DEFAULTS }; }
}

function saveConfig(cfg) {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

function tryExec(cmd) {
  try { return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
}

async function ollamaTags(host) {
  const r = await fetch(`${host}/api/tags`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const d = await r.json();
  return d.models.map(m => m.name);
}

function stripFences(t) {
  let s = t.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const m = s.match(/```(?:[a-z]+)?\s*([\s\S]*?)\s*```/);
  return m ? m[1] : s;
}

function parseJson(t) {
  let s = stripFences(t);
  const i = s.indexOf('{'), j = s.lastIndexOf('}');
  if (i >= 0 && j > i) s = s.slice(i, j + 1);
  return JSON.parse(s);
}

async function chat(cfg, model, system, user, jsonMode = false) {
  const ollama = new Ollama({ host: cfg.ollama_host });
  const opts = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    stream: false,
    options: { temperature: 0.2 },
    think: false,
  };
  if (jsonMode) opts.format = 'json';
  const r = await ollama.chat(opts);
  return r.message.content;
}

// ── prompts ─────────────────────────────────────────────────────────
const TRIAGE_SYS = `You are a senior WordPress plugin architect. Decide if the user's request has enough detail to plan a plugin.
Output ONLY JSON, no prose, no markdown:
{"need_clarification": true, "questions": ["q1", "q2"]}
or
{"need_clarification": false}
Ask at most 3 questions. Only ask when truly necessary.`;

const PLAN_SYS = `You are a senior WordPress plugin architect. Output a build plan as JSON only:
{
  "plugin_name": "Human Name",
  "plugin_slug": "kebab-slug",
  "description": "one sentence",
  "files": [
    { "path": "plugin-slug.php", "purpose": "main file: header, ABSPATH guard, bootstrap hooks" },
    { "path": "includes/class-foo.php", "purpose": "..." },
    { "path": "readme.txt", "purpose": "WP.org readme" }
  ]
}
Rules:
- Slug matches main PHP filename
- Always include readme.txt
- 3–8 files unless complexity demands more
- All user-facing strings translatable
- Output ONLY JSON, no prose.`;

const CODER_SYS = `You are a senior WordPress developer. Write production-ready code following WordPress Coding Standards.
Required:
- ABSPATH guard at top of every PHP file
- Escape all output (esc_html, esc_attr, esc_url, wp_kses_post)
- Sanitize all input (sanitize_text_field, etc.)
- Verify nonces on state-changing actions
- Check capabilities (current_user_can)
- Translatable strings with text domain matching plugin slug
- Proper plugin header in main file

Output ONLY the file contents. No markdown fences. No prose. No explanation.`;

const REVIEWER_SYS = `You are a strict WordPress code reviewer. Check for:
- Security: nonces, capability checks, sanitization, escaping, SQL injection
- Correctness: hook signatures, syntax, name collisions
- Standards: text domain, ABSPATH guard, WP API usage

Output ONLY JSON:
{
  "approved": true|false,
  "issues": [
    { "severity": "blocker|major|minor", "category": "security|correctness|standards", "message": "..." }
  ]
}
approved=true means zero blocker/major issues.`;

// ── commands ────────────────────────────────────────────────────────
async function doctor() {
  const cfg = loadConfig();
  head('🩺 Doctor');

  console.log('\nSystem:');
  const node = tryExec('node -v');
  node && parseInt(node.slice(1)) >= 20 ? ok(`node ≥ 20  ${node}`) : bad(`node  ${node || 'missing'}`);
  const php = tryExec('php -v');
  php ? ok(`php  ${php.split('\n')[0]}`) : bad('php missing');
  const git = tryExec('git --version');
  git ? ok(`git  ${git}`) : bad('git missing');
  const gh = tryExec('gh --version');
  gh ? ok(`gh  ${gh.split('\n')[0]}`) : warn('gh missing (only needed for `push`)');

  console.log('\nOllama:');
  let models = [];
  try {
    models = await ollamaTags(cfg.ollama_host);
    ok(`ollama running  ${cfg.ollama_host}`);
  } catch (e) {
    bad(`ollama unreachable at ${cfg.ollama_host} — start it with \`ollama serve\` or the Mac app`);
  }
  for (const role of ['planner', 'coder', 'reviewer']) {
    const m = cfg[`${role}_model`];
    models.includes(m) ? ok(`${role}: ${m}`) : bad(`${role}: ${m} not pulled — \`ollama pull ${m}\``);
  }

  console.log('\nGitHub:');
  const auth = tryExec('gh auth status 2>&1');
  if (auth && /Logged in/i.test(auth)) ok('gh authenticated');
  else warn('gh not authenticated — `gh auth login` (only for `push`)');

  console.log('\nConfig:');
  existsSync(CONFIG_FILE) ? ok(`config  ${CONFIG_FILE}`) : warn('no config — run `marko-agent setup`');
  cfg.github_owner ? ok(`github owner: ${cfg.github_owner}`) : warn('no github owner (only for `push`)');
  console.log();
}

async function setup() {
  const cfg = loadConfig();
  head('⚙️  Setup');

  cfg.ollama_host = await input({ message: 'Ollama host URL', default: cfg.ollama_host });

  let models = [];
  try { models = await ollamaTags(cfg.ollama_host); }
  catch { console.log('  (Ollama unreachable — manual entry)'); }

  const ask = async (label, key) => {
    if (models.length) {
      const choices = models.map(m => ({ name: m, value: m }));
      if (!models.includes(cfg[key])) choices.push({ name: `(keep custom: ${cfg[key]})`, value: cfg[key] });
      cfg[key] = await select({ message: label, choices, default: cfg[key] });
    } else {
      cfg[key] = await input({ message: label, default: cfg[key] });
    }
  };

  await ask('Planner model', 'planner_model');
  await ask('Coder model', 'coder_model');
  await ask('Reviewer model', 'reviewer_model');

  cfg.out_dir = await input({ message: 'Output directory', default: cfg.out_dir });
  const rounds = await input({ message: 'Max review rounds per file', default: String(cfg.max_review_rounds) });
  cfg.max_review_rounds = parseInt(rounds) || 3;
  cfg.github_owner = await input({ message: 'GitHub owner/org for `push` (blank to skip)', default: cfg.github_owner });

  saveConfig(cfg);
  console.log(`\n  ${c.green}✓${c.reset} saved to ${CONFIG_FILE}\n`);
}

async function modelsCmd() {
  const cfg = loadConfig();
  head('🤖 Models');
  let list = [];
  try { list = await ollamaTags(cfg.ollama_host); }
  catch (e) { bad(`ollama unreachable: ${e.message}`); return; }
  console.log();
  for (const m of list) {
    const roles = [];
    if (m === cfg.planner_model) roles.push('planner');
    if (m === cfg.coder_model) roles.push('coder');
    if (m === cfg.reviewer_model) roles.push('reviewer');
    console.log(`  ${m}${roles.length ? `  ${c.dim}[${roles.join(', ')}]${c.reset}` : ''}`);
  }
  console.log();
}

async function triage(cfg, request) {
  const raw = await chat(cfg, cfg.planner_model, TRIAGE_SYS, request, true);
  return parseJson(raw);
}

async function planRequest(cfg, request) {
  const raw = await chat(cfg, cfg.planner_model, PLAN_SYS, request, true);
  return parseJson(raw);
}

async function generateFile(cfg, blueprint, file, prev, notes) {
  let prompt = `Plugin: ${blueprint.plugin_name} (slug: ${blueprint.plugin_slug})
Description: ${blueprint.description}

File path: ${file.path}
Purpose: ${file.purpose}

All files in plugin:
${blueprint.files.map(f => `  - ${f.path}: ${f.purpose}`).join('\n')}`;

  if (prev && notes?.length) {
    prompt += `\n\nReviewer flagged the previous draft. Fix these:\n${notes.map(i => `- [${i.severity}/${i.category}] ${i.message}`).join('\n')}\n\nPrevious draft:\n${prev}`;
  }
  prompt += `\n\nWrite the complete contents of ${file.path}.`;

  let content = await chat(cfg, cfg.coder_model, CODER_SYS, prompt);
  return stripFences(content);
}

async function reviewFile(cfg, blueprint, file, content) {
  const prompt = `Plugin: ${blueprint.plugin_name} (slug: ${blueprint.plugin_slug})
File: ${file.path}
Purpose: ${file.purpose}

Contents:
${'```'}
${content}
${'```'}

Review. Output JSON only.`;
  const raw = await chat(cfg, cfg.reviewer_model, REVIEWER_SYS, prompt, true);
  return parseJson(raw);
}

function phpLint(content, path) {
  if (!path.endsWith('.php')) return { ok: true };
  const r = spawnSync('php', ['-l'], { input: content, encoding: 'utf8' });
  if (r.status === 0) return { ok: true };
  return { ok: false, error: (r.stderr || r.stdout || '').trim() };
}

async function planCmd(request) {
  const cfg = loadConfig();
  console.log(`${c.cyan}🧠 Triaging...${c.reset}\n`);
  const t = await triage(cfg, request);
  let finalReq = request;
  if (t.need_clarification && t.questions?.length) {
    console.log('Need to clarify before planning:\n');
    for (const q of t.questions) {
      const a = await input({ message: q });
      finalReq += `\n\nQ: ${q}\nA: ${a}`;
    }
  }
  console.log(`\n${c.cyan}📐 Planning...${c.reset}\n`);
  const blueprint = await planRequest(cfg, finalReq);
  console.log(`${c.bold}${blueprint.plugin_name}${c.reset} (${blueprint.plugin_slug})`);
  console.log(blueprint.description);
  console.log(`\nFiles (${blueprint.files.length}):`);
  for (const f of blueprint.files) {
    console.log(`  - ${f.path}\n      ${c.dim}${f.purpose}${c.reset}`);
  }
  console.log();
  return { blueprint, finalReq };
}

async function buildCmd(request) {
  const cfg = loadConfig();
  const { blueprint } = await planCmd(request);

  const proceed = await confirm({ message: 'Build this plugin?', default: true });
  if (!proceed) return;

  const repoDir = join(cfg.out_dir, blueprint.plugin_slug);
  if (existsSync(repoDir)) {
    const overwrite = await confirm({ message: `${repoDir} exists. Overwrite?`, default: false });
    if (!overwrite) return;
  }
  mkdirSync(repoDir, { recursive: true });

  console.log();
  for (const file of blueprint.files) {
    console.log(`${c.bold}📝 ${file.path}${c.reset}`);
    let content = '';
    let notes = [];
    let approved = false;
    for (let round = 1; round <= cfg.max_review_rounds; round++) {
      content = await generateFile(cfg, blueprint, file, content || null, notes);

      const lint = phpLint(content, file.path);
      if (!lint.ok) {
        const firstLine = lint.error.split('\n')[0];
        console.log(`   ${c.red}php -l failed:${c.reset} ${firstLine}`);
        notes = [{ severity: 'blocker', category: 'correctness', message: `php -l failed: ${firstLine}` }];
        continue;
      }

      let review;
      try { review = await reviewFile(cfg, blueprint, file, content); }
      catch (e) {
        console.log(`   ${c.yellow}reviewer parse error, accepting draft${c.reset}`);
        approved = true; break;
      }
      if (review.approved) {
        console.log(`   ${c.green}✅ approved (round ${round})${c.reset}`);
        approved = true; break;
      }
      console.log(`   ${c.yellow}🔁 round ${round}: ${review.issues?.length ?? 0} issues${c.reset}`);
      for (const i of review.issues ?? []) {
        console.log(`      [${i.severity}/${i.category}] ${i.message}`);
      }
      notes = review.issues ?? [];
    }
    if (!approved) console.log(`   ${c.yellow}⚠️  max rounds reached, writing last draft${c.reset}`);
    const dest = join(repoDir, file.path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content);
  }

  console.log(`\n${c.cyan}📦 Setting up local git...${c.reset}`);
  const git = simpleGit(repoDir);
  if (!existsSync(join(repoDir, '.git'))) {
    await git.init();
    await git.checkout(['-b', 'main']).catch(() => {});
  }
  await git.add('.');
  try { await git.commit('initial: scaffold plugin via marko-agent'); } catch {}
  const branch = `feat/${blueprint.plugin_slug}-${Date.now()}`;
  await git.checkoutLocalBranch(branch);

  console.log(`\n${c.bold}${c.green}✨ Done.${c.reset}`);
  console.log(`   ${repoDir}`);
  console.log(`   branch: ${branch}\n`);
  if (cfg.github_owner) {
    console.log(`To publish:  marko-agent push ${blueprint.plugin_slug}\n`);
  } else {
    console.log(`Run \`marko-agent setup\` to set a GitHub owner for \`push\`.\n`);
  }
}

function listCmd() {
  const cfg = loadConfig();
  if (!existsSync(cfg.out_dir)) { console.log('(no builds yet)'); return; }
  const dirs = readdirSync(cfg.out_dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
  if (!dirs.length) { console.log('(no builds yet)'); return; }
  head(`📚 Builds (${dirs.length})`);
  console.log();
  for (const d of dirs) console.log(`  ${d}  ${c.dim}${join(cfg.out_dir, d)}${c.reset}`);
  console.log();
}

async function pushCmd(slug) {
  const cfg = loadConfig();
  if (!cfg.github_owner) return bad('github owner not set — run `marko-agent setup`');
  const repoDir = join(cfg.out_dir, slug);
  if (!existsSync(repoDir)) return bad(`${repoDir} does not exist`);

  const opts = { cwd: repoDir, stdio: 'inherit' };
  try {
    execSync(`gh repo create ${cfg.github_owner}/${slug} --private --source=. --remote=origin --push`, opts);
  } catch {
    try { execSync(`git push -u origin HEAD`, opts); } catch (e) { return bad(`push failed: ${e.message}`); }
  }
  try { execSync(`gh pr create --fill --base main`, opts); } catch {}
  try { execSync(`gh pr merge --auto --squash --delete-branch`, opts); } catch {}
}

function configCmd(action, key, value) {
  const cfg = loadConfig();
  if (!action) { console.log(JSON.stringify(cfg, null, 2)); return; }
  if (action === 'set') {
    if (!(key in DEFAULTS)) return bad(`unknown key: ${key}\nvalid: ${Object.keys(DEFAULTS).join(', ')}`);
    const numeric = key === 'max_review_rounds';
    cfg[key] = numeric ? (parseInt(value) || DEFAULTS[key]) : value;
    saveConfig(cfg);
    return ok(`${key} = ${cfg[key]}`);
  }
  bad(`unknown action: ${action}  (use \`config\` or \`config set <key> <value>\`)`);
}

// ── CLI ─────────────────────────────────────────────────────────────
const program = new Command();
program.name('marko-agent').description('Local multi-agent WordPress plugin builder').version('1.0.0');

program.command('doctor').description('Verify environment').action(doctor);
program.command('setup').description('Interactive config').action(setup);
program.command('models').description('List Ollama models and roles').action(modelsCmd);
program.command('plan <request...>').description('Plan only, do not build').action((req) => planCmd(req.join(' ')));
program.command('build <request...>').description('Plan and build').action((req) => buildCmd(req.join(' ')));
program.command('list').description('List built plugins').action(listCmd);
program.command('push <slug>').description('Push to GitHub and open PR').action(pushCmd);
program.command('config [action] [key] [value]').description('Show or set config').action(configCmd);

program.parseAsync(process.argv).catch((err) => {
  console.error(`\n${c.red}✗${c.reset} ${err.message}`);
  process.exit(1);
});
