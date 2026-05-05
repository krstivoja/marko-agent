#!/usr/bin/env node
import { Command } from 'commander';
import { Ollama } from 'ollama';
import { input, select, confirm } from '@inquirer/prompts';
import { simpleGit } from 'simple-git';
import { execSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOME = homedir();
const CONFIG_DIR = join(HOME, '.marko-agent');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
const DEFAULT_OUT = '';

const DEFAULT_LOCAL_MODEL = 'qwen3-coder-30b-a3b-instruct-mlx@4bit';

const DEFAULTS = {
  ollama_host: 'http://localhost:11434',
  inference_provider: 'lmstudio', // 'ollama' or 'lmstudio' (OpenAI-compatible)
  lmstudio_host: 'http://localhost:1234',
  planner_provider: 'ollama',
  final_review_provider: 'claude',
  planner_model: DEFAULT_LOCAL_MODEL,
  coder_model_php: DEFAULT_LOCAL_MODEL,
  coder_model_js: DEFAULT_LOCAL_MODEL,
  reviewer_model: DEFAULT_LOCAL_MODEL,
  out_dir: DEFAULT_OUT,
  max_review_rounds: 3,
  max_final_review_rounds: 2,
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

const VERBOSE = process.env.MARKO_VERBOSE === '1' || process.argv.includes('--verbose');

function agentStart(role, provider, model) {
  const tag = `[${role}→${provider}${model ? `:${model}` : ''}]`;
  process.stdout.write(`   ${c.dim}${tag} thinking…${c.reset}`);
  return Date.now();
}
function agentDone(t0, extra = '') {
  const ms = Date.now() - t0;
  process.stdout.write(`\r${' '.repeat(80)}\r`);
  console.log(`   ${c.dim}└─ done in ${(ms / 1000).toFixed(1)}s${extra ? '  ' + extra : ''}${c.reset}`);
}

function loadConfig() {
  if (!existsSync(CONFIG_FILE)) return { ...DEFAULTS };
  try {
    const stored = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
    // Backward compat: legacy single coder_model → use it as both PHP and JS coders
    if (stored.coder_model && !stored.coder_model_php) stored.coder_model_php = stored.coder_model;
    if (stored.coder_model && !stored.coder_model_js) stored.coder_model_js = stored.coder_model;
    delete stored.coder_model;
    // Backward compat: pre-split configs (no final_review_provider key) inherit from planner_provider
    // so existing behavior is preserved on upgrade.
    if (!('final_review_provider' in stored) && 'planner_provider' in stored) {
      stored.final_review_provider = stored.planner_provider;
    }
    return { ...DEFAULTS, ...stored };
  } catch { return { ...DEFAULTS }; }
}

function pickCoderModel(filePath, cfg) {
  const ext = (filePath.split('.').pop() || '').toLowerCase();
  const frontend = new Set(['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'css', 'scss', 'html', 'json']);
  return frontend.has(ext) ? cfg.coder_model_js : cfg.coder_model_php;
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

async function lmstudioModels(host) {
  const r = await fetch(`${host}/v1/models`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const d = await r.json();
  return (d.data || []).map(m => m.id);
}

async function listInferenceModels(cfg) {
  if (cfg.inference_provider === 'lmstudio') return lmstudioModels(cfg.lmstudio_host);
  return ollamaTags(cfg.ollama_host);
}

function inferenceLabel(cfg) {
  return cfg.inference_provider === 'lmstudio' ? `lmstudio (${cfg.lmstudio_host})` : `ollama (${cfg.ollama_host})`;
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

function claudeAvailable() {
  return tryExec('command -v claude') !== null;
}

function claudeChat(system, user) {
  const r = spawnSync(
    'claude',
    ['-p', user, '--output-format', 'json', '--append-system-prompt', system],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }
  );
  if (r.status !== 0) {
    throw new Error(`claude exited ${r.status}: ${(r.stderr || r.stdout || '').slice(0, 400)}`);
  }
  let wrapper;
  try { wrapper = JSON.parse(r.stdout); }
  catch (e) { throw new Error(`claude returned non-JSON: ${r.stdout.slice(0, 400)}`); }
  if (wrapper.is_error) throw new Error(`claude error: ${wrapper.result || 'unknown'}`);
  return wrapper.result;
}

async function chatOllama(cfg, model, system, user, jsonMode) {
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

async function chatLMStudio(cfg, model, system, user, jsonMode) {
  const body = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0.2,
    stream: false,
  };
  // LM Studio rejects `json_object`; only `json_schema` or `text` are accepted.
  // Use a permissive any-object schema when jsonMode is on so the runtime
  // enforces structure without us pre-declaring fields.
  if (jsonMode) {
    body.response_format = {
      type: 'json_schema',
      json_schema: {
        name: 'response',
        strict: false,
        schema: { type: 'object', additionalProperties: true },
      },
    };
  }
  const r = await fetch(`${cfg.lmstudio_host}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`lmstudio HTTP ${r.status}: ${txt.slice(0, 400)}`);
  }
  const d = await r.json();
  return d.choices?.[0]?.message?.content ?? '';
}

async function chat(cfg, model, system, user, jsonMode = false) {
  if (cfg.inference_provider === 'lmstudio') {
    return chatLMStudio(cfg, model, system, user, jsonMode);
  }
  return chatOllama(cfg, model, system, user, jsonMode);
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
- Modern JS by default — do NOT plan an admin.js with jQuery dependency unless the plugin must integrate with classic widgets/Customizer
- Only include uninstall.php when the plugin actually creates persistent data (options, transients, post meta, custom tables). Don't add it just for symmetry.
- ORDER FILES BY DEPENDENCY: files later in the list are generated with full visibility into earlier files. Put files that DEFINE shared identifiers (IDs, hook names, localized object keys, nonce actions, AJAX action names, class signatures) BEFORE files that CONSUME them. Recommended order:
  1. Main plugin .php file (defines constants, instantiates classes)
  2. PHP class/include files (define hooks, render HTML with IDs, register AJAX, call wp_localize_script)
  3. JS files (consume DOM IDs, localized object keys, AJAX action names from above)
  4. CSS files
  5. uninstall.php (only if needed)
  6. readme.txt
- Output ONLY JSON, no prose.`;

const CODER_SYS = `You are a senior WordPress developer. Write production-ready code following WordPress Coding Standards (WPCS).

PHP — security and standards:
- ABSPATH guard at top of every PHP file: \`if ( ! defined( 'ABSPATH' ) ) { exit; }\`
- Plugin header in main file: Plugin Name, Description, Version, Author, License (GPLv2+), License URI, Text Domain, Domain Path, Requires at least, Requires PHP
- Escape ALL output: esc_html, esc_attr, esc_url, esc_textarea, wp_kses_post — including translated strings (esc_html__, esc_html_e, esc_attr__)
- Sanitize ALL input from \$_GET/\$_POST/\$_REQUEST/\$_COOKIE/\$_SERVER. Always use this idiom for $_POST/$_GET reads:
    isset( \$_POST['key'] ) ? sanitize_text_field( wp_unslash( \$_POST['key'] ) ) : ''
  Use \`sanitize_textarea_field\` for multi-line, \`sanitize_key\` for slugs/keys/nonces, \`absint\` for ints, \`esc_url_raw\` for URLs.
- Nonce verification idiom:
    if ( ! isset( \$_POST['nonce'] ) || ! wp_verify_nonce( sanitize_key( wp_unslash( \$_POST['nonce'] ) ), 'action_name' ) ) { wp_send_json_error( ..., 403 ); }
- Capability check on state-changing endpoints AND on settings page render
- All user-facing strings translatable with text domain matching plugin slug
- Use prepared statements (\$wpdb->prepare) — never interpolate $_POST into SQL
- No \`extract()\`, no \`eval()\`, no \`include\` of user input
- Type-hint method signatures where reasonable (PHP 7.4+): \`public function foo( string \$bar ): void\`
- Use early returns for guard clauses, not nested ifs

JavaScript — modern, no jQuery:
- Use VANILLA JS. Do NOT use jQuery, do NOT add \`jquery\` as enqueue dependency unless the plugin truly integrates with jQuery-only WP areas (Customizer, classic widgets).
- Use \`document.querySelector\`, \`addEventListener('input', ...)\`, \`fetch()\` with FormData for AJAX.
- Wrap in IIFE \`(function() { 'use strict'; ... })();\`. No globals beyond the wp_localize_script object.
- Bind only when target elements exist (\`if ( ! el ) return;\`).
- All user-facing strings come from the localized object (e.g. \`test3Data.i18n.error\`) — do NOT hardcode "Error" in JS.
- Debounce expensive AJAX with a small \`debounce()\` helper.

Enqueueing assets:
- Use \`plugins_url( 'assets/js/admin.js', \$main_plugin_file )\` or define a \`PLUGIN_URL\` constant in the main file. Do NOT use \`plugin_dir_url(__FILE__) . '../assets/...'\` — the \`..\` segment is ugly and brittle.
- Always pass a version (use the plugin version constant, not 'false') to bust caches on update.
- Pass \`true\` for \`in_footer\` on JS unless there's a reason not to.
- Bail early in enqueue callbacks if hook suffix doesn't match the plugin's page.

readme.txt:
- Standard WP.org format: === Plugin Name ===, Contributors, Tags, Requires at least, Tested up to, Stable tag, License, License URI, then == Description ==, == Installation ==, == Frequently Asked Questions ==, == Changelog ==.

uninstall.php:
- Only delete options/transients/post_meta/CPT data the plugin actually creates. Do NOT include placeholder cleanup for data that's never written.
- Multisite: use \`get_sites()\` and \`switch_to_blog()\`. Do NOT use deprecated \`wp_get_sites()\`.

CROSS-FILE CONSISTENCY (CRITICAL):
When already-generated files are provided as context, you MUST reuse their EXACT identifiers. Do NOT invent new ones. Specifically:
- DOM IDs/classes (must match between PHP-rendered HTML and JS selectors)
- wp_localize_script object names (the JS-side variable must match)
- Localized property keys (ajax_url vs ajaxurl — pick whatever the prior file used)
- AJAX action names (wp_ajax_<action> hook = action field in JS POST)
- Nonce action strings (wp_create_nonce / wp_verify_nonce must use the same literal)
- POST field names (JS keys = $_POST reads)
- Class names, constructor signatures, instantiation arity
- Hook callback method names
- Constants defined in the main file (TEST_3_AJAX_ACTION, etc.) — reference them, don't redeclare
- Capability strings (e.g. 'manage_options') agree between add_*_page and current_user_can
- If a class exposes init() or define_admin_hooks(), the bootstrap MUST call it

Output ONLY the file contents. No markdown fences. No prose. No explanation.`;

const REVIEWER_SYS = `You are a strict WordPress code reviewer.

Per-file checks:
- Security: nonces, capability checks, sanitization, escaping, SQL injection
- $_POST/$_GET reads MUST use \`wp_unslash()\` AND an appropriate sanitizer (sanitize_key for nonces/keys, sanitize_text_field for short text, sanitize_textarea_field for multi-line, absint for ints, esc_url_raw for URLs). Reading \`\$_POST['nonce']\` directly without wp_unslash + sanitize_key is a MAJOR issue.
- Correctness: hook signatures, syntax, name collisions, deprecated functions (wp_get_sites, get_currentuserinfo, get_userdatabylogin, etc.)
- Standards: text domain, ABSPATH guard, plugin header completeness (Author, License, License URI, Text Domain, Requires at least, Requires PHP)

JavaScript checks:
- Flag jQuery usage (e.g. \`(function($) { ... })(jQuery);\`, \`$.post\`, \`$()\`) as MAJOR unless the plugin explicitly integrates with a jQuery-only WP area. Modern plugins should use vanilla JS (\`document.querySelector\`, \`addEventListener\`, \`fetch\`).
- Flag hardcoded user-facing strings in JS (e.g. \`textContent = 'Error'\`) — they should come from the localized i18n object.
- Flag missing element existence guards before binding listeners.

Enqueue checks:
- Flag \`plugin_dir_url(__FILE__) . '../...'\` as MINOR — should use \`plugins_url('asset', \$main_plugin_file)\` or a defined PLUGIN_URL constant.
- Flag missing version argument (or \`false\`) — caches won't bust on update.

uninstall.php checks:
- Flag delete_option/delete_transient calls for keys the plugin never actually sets — that's dead code.
- Flag use of deprecated \`wp_get_sites()\` — should be \`get_sites()\`.

CROSS-FILE consistency checks (when already-generated files are provided):
- Do DOM IDs/classes referenced in this file exist in the rendered HTML of sibling files?
- Does any wp_localize_script object name in a sibling file match the global this file reads?
- Do localized property keys agree (ajax_url vs ajaxurl, nonce key, etc.)?
- Do AJAX action names match between JS sender and PHP wp_ajax_ hook?
- Do nonce action strings agree across wp_create_nonce / wp_verify_nonce calls?
- Do POST field names sent by JS match what PHP reads from $_POST?
- Do class instantiations pass the right number of constructor arguments?
- Are referenced methods actually called (e.g. init() defined but never invoked)?

Mark cross-file mismatches as severity "blocker" — they break the plugin at runtime.

Output ONLY JSON:
{
  "approved": true|false,
  "issues": [
    { "severity": "blocker|major|minor", "category": "security|correctness|standards|integration", "message": "..." }
  ]
}
approved=true means zero blocker/major issues.`;

const FINAL_REVIEW_SYS = `You are a senior WordPress code auditor performing a final, holistic review of a complete plugin. You see ALL files at once and your job is to catch issues a per-file reviewer would miss.

Audit for:
- Cross-file consistency: hook names, AJAX action names, nonce action strings, wp_localize_script object names, localized property keys, DOM IDs/classes, POST field names, class names + constructor arity, callback method names, capability strings, constants. Mismatches between siblings = "blocker".
- Security: escaping (esc_html/esc_attr/esc_url/wp_kses_post on ALL output incl. translated strings), sanitization with wp_unslash + appropriate sanitizer for every \$_POST/\$_GET/\$_REQUEST/\$_COOKIE/\$_SERVER read, nonce verification on state-changing endpoints, capability checks on settings pages and AJAX handlers, prepared statements for SQL.
- WordPress Coding Standards: ABSPATH guard at top of every PHP file, complete plugin header (Plugin Name, Description, Version, Author, License GPLv2+, License URI, Text Domain, Domain Path, Requires at least, Requires PHP), text domain matching plugin slug, all user-facing strings translatable.
- Modern JavaScript: flag jQuery usage and the \`jquery\` enqueue dependency unless the plugin truly integrates with a jQuery-only WP area; flag hardcoded user-facing strings (must come from localized i18n object); flag missing element existence guards.
- Enqueueing: version argument present (not \`false\`), uses plugins_url(asset, \$main_plugin_file) or a defined PLUGIN_URL constant — flag any \`plugin_dir_url(__FILE__) . '../...'\`.
- uninstall.php: only deletes options/transients/post_meta/CPT data the plugin actually creates — flag dead cleanup for keys never written; flag deprecated wp_get_sites() (must be get_sites()).
- i18n: text domain literal matches plugin slug everywhere; no variable text domains.

Severity vocabulary (must match these exact strings):
- "blocker" — runtime breakage, security hole, or cross-file mismatch that breaks the plugin
- "major" — clear standards violation or correctness issue that should block release
- "minor" — style/convention nit
- "info" — informational only

Output ONLY JSON, no prose, no markdown:
{
  "approved": true|false,
  "summary": "one-sentence overall assessment",
  "files": [
    { "path": "exact/file/path.php", "issues": [
      { "severity": "blocker|major|minor|info", "category": "security|consistency|wpcs|correctness|i18n", "message": "specific, actionable description" }
    ]}
  ]
}

approved=true means zero blocker AND zero major issues across all files. Only include files that have at least one issue in the "files" array.`;

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

  console.log('\nPlanner:');
  if (cfg.planner_provider === 'claude') {
    if (claudeAvailable()) {
      const v = tryExec('claude --version') || 'claude';
      ok(`claude CLI  ${v}  (uses your Claude subscription)`);
    } else {
      bad(`planner_provider=claude but \`claude\` CLI not on PATH — install Claude Code or run \`marko-agent config set planner_provider ollama\``);
    }
  } else {
    ok(`provider: ollama (model: ${cfg.planner_model})`);
  }

  console.log('\nFinal review:');
  if (cfg.final_review_provider === 'claude') {
    if (claudeAvailable()) {
      ok('claude CLI  (holistic cross-file audit after Ollama codes the plugin)');
    } else {
      warn(`final_review_provider=claude but \`claude\` CLI not on PATH — final review will be skipped`);
    }
  } else {
    warn('final_review_provider=ollama — Claude final audit disabled (cross-file bugs may slip through)');
  }

  const providerLabel = cfg.inference_provider === 'lmstudio' ? 'LM Studio' : 'Ollama';
  console.log(`\nInference (${providerLabel}):`);
  let models = [];
  try {
    models = await listInferenceModels(cfg);
    ok(`${cfg.inference_provider} running  ${inferenceLabel(cfg).split(' ')[1].slice(1, -1)}`);
  } catch (e) {
    if (cfg.inference_provider === 'lmstudio') {
      bad(`LM Studio unreachable at ${cfg.lmstudio_host} — open LM Studio → Developer tab → load a model → Start Server`);
    } else {
      bad(`ollama unreachable at ${cfg.ollama_host} — start it with \`ollama serve\` or the Mac app`);
    }
  }
  const pullHint = cfg.inference_provider === 'lmstudio'
    ? `not loaded in LM Studio — load it via the Developer tab`
    : (m) => `not pulled — \`ollama pull ${m}\``;
  const rolesToCheck = cfg.planner_provider === 'claude'
    ? [['coder (php)', 'coder_model_php'], ['coder (js)', 'coder_model_js'], ['reviewer', 'reviewer_model']]
    : [['planner', 'planner_model'], ['coder (php)', 'coder_model_php'], ['coder (js)', 'coder_model_js'], ['reviewer', 'reviewer_model']];
  for (const [label, key] of rolesToCheck) {
    const m = cfg[key];
    if (models.includes(m)) {
      ok(`${label}: ${m}`);
    } else {
      const hint = typeof pullHint === 'function' ? pullHint(m) : pullHint;
      bad(`${label}: ${m} ${hint}`);
    }
  }
  if (cfg.planner_provider === 'claude') {
    const m = cfg.planner_model;
    models.includes(m) ? ok(`planner fallback: ${m}`) : warn(`planner fallback ${m} not loaded (only matters if claude CLI fails)`);
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

  const claudeOk = claudeAvailable();
  cfg.planner_provider = await select({
    message: 'Planner (the "thinking" model that triages and plans)',
    choices: [
      { name: 'ollama  — fully local, uses an Ollama model (recommended; saves Claude tokens)', value: 'ollama' },
      { name: `claude  — uses your Claude subscription via \`claude\` CLI${claudeOk ? '' : '  (CLI not detected!)'}`, value: 'claude' },
    ],
    default: cfg.planner_provider,
  });

  cfg.final_review_provider = await select({
    message: 'Final review (holistic audit of the whole plugin after Ollama codes it)',
    choices: [
      { name: `claude  — uses your Claude subscription via \`claude\` CLI${claudeOk ? '' : '  (CLI not detected!)'}  (recommended; catches cross-file bugs Ollama misses)`, value: 'claude' },
      { name: 'ollama  — skip Claude entirely; rely on per-file Ollama reviewer only', value: 'ollama' },
    ],
    default: cfg.final_review_provider,
  });

  cfg.inference_provider = await select({
    message: 'Local inference provider (where coder/reviewer/planner-fallback models run)',
    choices: [
      { name: 'ollama  — Ollama daemon, GGUF format, broadest model selection', value: 'ollama' },
      { name: 'lmstudio  — LM Studio server, OpenAI-compatible, MLX format on Apple Silicon (faster)', value: 'lmstudio' },
    ],
    default: cfg.inference_provider,
  });

  if (cfg.inference_provider === 'lmstudio') {
    cfg.lmstudio_host = await input({ message: 'LM Studio host URL', default: cfg.lmstudio_host });
  } else {
    cfg.ollama_host = await input({ message: 'Ollama host URL', default: cfg.ollama_host });
  }

  let models = [];
  try { models = await listInferenceModels(cfg); }
  catch { console.log(`  (${cfg.inference_provider} unreachable — manual entry)`); }

  const ask = async (label, key) => {
    if (models.length) {
      const choices = models.map(m => ({ name: m, value: m }));
      if (!models.includes(cfg[key])) choices.push({ name: `(keep custom: ${cfg[key]})`, value: cfg[key] });
      cfg[key] = await select({ message: label, choices, default: cfg[key] });
    } else {
      cfg[key] = await input({ message: label, default: cfg[key] });
    }
  };

  const plannerLabel = cfg.planner_provider === 'claude'
    ? 'Planner fallback model (used if claude CLI fails)'
    : 'Planner model';
  await ask(plannerLabel, 'planner_model');
  await ask('Coder model — PHP (and readme.txt)', 'coder_model_php');
  await ask('Coder model — JS / CSS / frontend', 'coder_model_js');
  await ask('Reviewer model', 'reviewer_model');

  cfg.out_dir = await input({
    message: 'Default output directory (blank = current folder when build runs)',
    default: cfg.out_dir,
  });
  const rounds = await input({ message: 'Max review rounds per file', default: String(cfg.max_review_rounds) });
  cfg.max_review_rounds = parseInt(rounds) || 3;
  cfg.github_owner = await input({ message: 'GitHub owner/org for `push` (blank to skip)', default: cfg.github_owner });

  saveConfig(cfg);
  console.log(`\n  ${c.green}✓${c.reset} saved to ${CONFIG_FILE}\n`);
}

async function modelsCmd() {
  const cfg = loadConfig();
  head('🤖 Models');
  console.log(`\nPlanner provider: ${c.bold}${cfg.planner_provider}${c.reset}${cfg.planner_provider === 'claude' ? `  ${c.dim}(fallback: ${cfg.planner_model})${c.reset}` : ''}`);
  console.log(`Inference provider: ${c.bold}${cfg.inference_provider}${c.reset}  ${c.dim}(${inferenceLabel(cfg)})${c.reset}`);
  let list = [];
  try { list = await listInferenceModels(cfg); }
  catch (e) { bad(`\n${cfg.inference_provider} unreachable: ${e.message}`); return; }
  console.log(`\n${cfg.inference_provider === 'lmstudio' ? 'LM Studio' : 'Ollama'} models:`);
  for (const m of list) {
    const roles = [];
    if (m === cfg.planner_model) roles.push(cfg.planner_provider === 'claude' ? 'planner-fallback' : 'planner');
    if (m === cfg.coder_model_php) roles.push('coder:php');
    if (m === cfg.coder_model_js) roles.push('coder:js');
    if (m === cfg.reviewer_model) roles.push('reviewer');
    console.log(`  ${m}${roles.length ? `  ${c.dim}[${roles.join(', ')}]${c.reset}` : ''}`);
  }
  console.log();
}

async function planChat(cfg, system, user, role = 'planner') {
  if (cfg.planner_provider === 'claude') {
    if (!claudeAvailable()) {
      console.log(`   ${c.yellow}claude CLI not found, falling back to ${cfg.planner_model}${c.reset}`);
    } else {
      const t0 = agentStart(role, 'claude');
      try {
        const out = claudeChat(system, user);
        agentDone(t0, `${c.dim}(${out.length} chars)${c.reset}`);
        return out;
      } catch (e) {
        agentDone(t0, `${c.red}failed${c.reset}`);
        console.log(`   ${c.yellow}claude failed (${e.message.split('\n')[0]}), falling back to ${cfg.planner_model}${c.reset}`);
      }
    }
  }
  const t0 = agentStart(role, cfg.inference_provider, cfg.planner_model);
  const out = await chat(cfg, cfg.planner_model, system, user, true);
  agentDone(t0, `${c.dim}(${out.length} chars)${c.reset}`);
  return out;
}

async function triage(cfg, request) {
  const raw = await planChat(cfg, TRIAGE_SYS, request, 'triage');
  return parseJson(raw);
}

async function planRequest(cfg, request) {
  const raw = await planChat(cfg, PLAN_SYS, request, 'planner');
  return parseJson(raw);
}

function formatPriorFiles(generatedFiles) {
  if (!generatedFiles || generatedFiles.size === 0) return '';
  const blocks = [];
  for (const [path, content] of generatedFiles) {
    blocks.push(`=== ${path} ===\n${content}`);
  }
  return `\n\nALREADY-GENERATED FILES IN THIS PLUGIN (you must be consistent with their identifiers — do not invent new IDs, hook names, object keys, nonce actions, or POST field names):\n\n${blocks.join('\n\n')}`;
}

async function generateFile(cfg, blueprint, file, prev, notes, generatedFiles) {
  let prompt = `Plugin: ${blueprint.plugin_name} (slug: ${blueprint.plugin_slug})
Description: ${blueprint.description}

File path: ${file.path}
Purpose: ${file.purpose}

All files in plugin:
${blueprint.files.map(f => `  - ${f.path}: ${f.purpose}`).join('\n')}`;

  prompt += formatPriorFiles(generatedFiles);

  if (prev && notes?.length) {
    prompt += `\n\nReviewer flagged the previous draft. Fix these:\n${notes.map(i => `- [${i.severity}/${i.category}] ${i.message}`).join('\n')}\n\nPrevious draft:\n${prev}`;
  }
  prompt += `\n\nWrite the complete contents of ${file.path}.`;

  const coderModel = pickCoderModel(file.path, cfg);
  const t0 = agentStart('coder', cfg.inference_provider, coderModel);
  let content = await chat(cfg, coderModel, CODER_SYS, prompt);
  agentDone(t0, `${c.dim}(${content.length} chars)${c.reset}`);
  return stripFences(content);
}

async function reviewFile(cfg, blueprint, file, content, generatedFiles) {
  let prompt = `Plugin: ${blueprint.plugin_name} (slug: ${blueprint.plugin_slug})
File under review: ${file.path}
Purpose: ${file.purpose}`;

  prompt += formatPriorFiles(generatedFiles);

  prompt += `\n\nContents of ${file.path}:
${'```'}
${content}
${'```'}

Review this file for both per-file issues AND cross-file consistency with the already-generated siblings above. Output JSON only.`;

  const t0 = agentStart('reviewer', cfg.inference_provider, cfg.reviewer_model);
  const raw = await chat(cfg, cfg.reviewer_model, REVIEWER_SYS, prompt, true);
  agentDone(t0);
  return parseJson(raw);
}

function phpLint(content, path) {
  if (!path.endsWith('.php')) return { ok: true };
  const r = spawnSync('php', ['-l'], { input: content, encoding: 'utf8' });
  if (r.status === 0) return { ok: true };
  return { ok: false, error: (r.stderr || r.stdout || '').trim() };
}

function compressForReview(content) {
  return content
    .split('\n')
    .map(l => l.replace(/[ \t]+$/, ''))
    .filter((l, i, arr) => !(l === '' && arr[i - 1] === ''))
    .join('\n')
    .trim();
}

function shouldAuditPath(filePath) {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('readme.txt')) return false;
  return true;
}

function formatAuditedFiles(generatedFiles, changedPaths) {
  const audited = [];
  const unchanged = [];
  const excluded = [];
  for (const [path, content] of generatedFiles) {
    if (!shouldAuditPath(path)) {
      excluded.push(path);
      continue;
    }
    if (changedPaths && !changedPaths.has(path)) {
      unchanged.push(path);
    } else {
      audited.push(`=== ${path} ===\n${compressForReview(content)}`);
    }
  }
  let out = audited.join('\n\n');
  if (unchanged.length) {
    out += `\n\n=== UNCHANGED FROM YOUR PRIOR APPROVAL ===\nThe following files have identical content to what you reviewed last round. Re-check only that the regenerated files above remain consistent with their cross-file references into these:\n${unchanged.map(p => `  - ${p}`).join('\n')}`;
  }
  if (excluded.length) {
    out += `\n\n=== INTENTIONALLY EXCLUDED FROM AUDIT ===\nThese files exist in the plugin but are deliberately omitted from this audit (metadata / WP.org docs only, no cross-file dependencies). Do NOT flag them as missing or unauditable:\n${excluded.map(p => `  - ${p}`).join('\n')}`;
  }
  return out;
}

function claudeFinalReview(cfg, blueprint, generatedFiles, changedPaths) {
  const isFirstPass = !changedPaths;
  const header = isFirstPass
    ? 'ALL GENERATED FILES (audit holistically — flag cross-file mismatches, security gaps, WPCS violations):'
    : 'REGENERATED FILES from this round (re-audit these; siblings listed at the bottom are unchanged from your prior approval):';

  const prompt = `Plugin: ${blueprint.plugin_name} (slug: ${blueprint.plugin_slug})
Description: ${blueprint.description}

File manifest:
${blueprint.files.map(f => `  - ${f.path}: ${f.purpose}`).join('\n')}

${header}

${formatAuditedFiles(generatedFiles, changedPaths)}

Return your audit as JSON only.`;

  const t0 = agentStart('final-review', 'claude');
  let raw;
  try {
    raw = claudeChat(FINAL_REVIEW_SYS, prompt);
  } catch (e) {
    agentDone(t0, `${c.red}failed${c.reset}`);
    throw e;
  }
  agentDone(t0, `${c.dim}(${raw.length} chars)${c.reset}`);
  return parseJson(raw);
}

async function runFinalReviewLoop(cfg, blueprint, repoDir, generatedFiles) {
  if (cfg.final_review_provider !== 'claude') return;
  if (!claudeAvailable()) {
    warn(`claude CLI not found — skipping final review`);
    return;
  }

  const fileByPath = new Map(blueprint.files.map(f => [f.path, f]));
  const maxRounds = cfg.max_final_review_rounds ?? 2;
  let lastReport = null;
  let changedPaths = null; // null = first pass, send everything

  for (let round = 1; round <= maxRounds; round++) {
    let report;
    try {
      report = claudeFinalReview(cfg, blueprint, generatedFiles, changedPaths);
    } catch (e) {
      console.log(`   ${c.yellow}final review failed (${e.message.split('\n')[0]}) — skipping remaining rounds${c.reset}`);
      return;
    }
    lastReport = report;

    if (report.approved) {
      console.log(`   ${c.green}✅ Claude final review: approved (round ${round})${c.reset}`);
      if (report.summary) console.log(`   ${c.dim}${report.summary}${c.reset}`);
      return;
    }

    const fileReports = (report.files || []).filter(f =>
      (f.issues || []).some(i => i.severity === 'blocker' || i.severity === 'major')
    );

    console.log(`   ${c.yellow}🔁 round ${round}: ${fileReports.length} file(s) need fixes${c.reset}`);
    if (report.summary) console.log(`   ${c.dim}${report.summary}${c.reset}`);
    for (const fr of fileReports) {
      console.log(`   ${c.bold}${fr.path}${c.reset}`);
      for (const i of fr.issues || []) {
        if (i.severity === 'blocker' || i.severity === 'major') {
          console.log(`      [${i.severity}/${i.category}] ${i.message}`);
        }
      }
    }

    if (round === maxRounds) break;

    const regenerated = new Set();
    for (const fr of fileReports) {
      const file = fileByPath.get(fr.path);
      if (!file) {
        console.log(`   ${c.yellow}skip ${fr.path} — not in blueprint${c.reset}`);
        continue;
      }
      const blockingIssues = (fr.issues || []).filter(i => i.severity === 'blocker' || i.severity === 'major');
      const prev = generatedFiles.get(fr.path) || '';

      const fixed = await generateFile(cfg, blueprint, file, prev, blockingIssues, generatedFiles);

      const lint = phpLint(fixed, fr.path);
      if (!lint.ok) {
        const firstLine = lint.error.split('\n')[0];
        console.log(`   ${c.yellow}php -l failed on regenerated ${fr.path} — keeping previous draft this round${c.reset}`);
        console.log(`      ${c.dim}${firstLine}${c.reset}`);
        continue;
      }

      const dest = join(repoDir, fr.path);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, fixed);
      generatedFiles.set(fr.path, fixed);
      regenerated.add(fr.path);
    }
    changedPaths = regenerated;
  }

  if (lastReport && !lastReport.approved) {
    const reportPath = join(repoDir, 'claude-final-review.json');
    writeFileSync(reportPath, JSON.stringify(lastReport, null, 2));
    warn(`final review unresolved after ${maxRounds} rounds — residual issues in ${reportPath}`);
  }
}

async function planCmd(request, opts = {}) {
  const cfg = loadConfig();
  console.log(`${c.cyan}🧠 Triaging...${c.reset}\n`);
  const t = await triage(cfg, request);
  let finalReq = request;
  if (t.need_clarification && t.questions?.length) {
    if (opts.yes) {
      console.log(`${c.dim}(--yes) skipping ${t.questions.length} triage question(s); proceeding with original request${c.reset}\n`);
    } else {
      console.log('Need to clarify before planning:\n');
      for (const q of t.questions) {
        const a = await input({ message: q });
        finalReq += `\n\nQ: ${q}\nA: ${a}`;
      }
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

async function buildCmd(request, opts = {}) {
  const cfg = loadConfig();

  // Decide where to build:
  // - --out flag       → <out>/<slug>/   (nested)
  // - cfg.out_dir set  → <out_dir>/<slug>/   (nested)
  // - neither          → cwd IS the plugin folder (no nesting), slug = basename(cwd)
  let baseDir, cwdMode, augmentedRequest = request, forcedSlug = null;
  if (opts.out) {
    baseDir = opts.out;
    cwdMode = false;
  } else if (cfg.out_dir && cfg.out_dir.trim()) {
    baseDir = cfg.out_dir;
    cwdMode = false;
  } else {
    baseDir = process.cwd();
    cwdMode = true;
    forcedSlug = basename(baseDir).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!forcedSlug || forcedSlug.length < 2) {
      bad(`current folder name "${basename(baseDir)}" can't be a plugin slug. cd into a properly-named folder, or use --out <dir>.`);
      return;
    }
    augmentedRequest = `${request}\n\nCONSTRAINT: The plugin slug MUST be exactly "${forcedSlug}". The main PHP file MUST be named "${forcedSlug}.php". Use this slug as the text domain.`;
  }

  const { blueprint } = await planCmd(augmentedRequest, opts);

  // Belt-and-suspenders: force the slug + main filename even if planner ignored the constraint
  if (forcedSlug && blueprint.plugin_slug !== forcedSlug) {
    const oldSlug = blueprint.plugin_slug;
    blueprint.plugin_slug = forcedSlug;
    for (const f of blueprint.files) {
      if (f.path === `${oldSlug}.php`) f.path = `${forcedSlug}.php`;
    }
  }


  const repoDir = cwdMode ? baseDir : join(baseDir, blueprint.plugin_slug);
  console.log(`\n   ${c.dim}→ ${repoDir}${c.reset}`);

  if (cwdMode) {
    const conflicts = readdirSync(repoDir).filter(f => !f.startsWith('.') && f !== 'node_modules');
    if (conflicts.length) {
      if (opts.yes) {
        console.log(`${c.dim}(--yes) overwriting non-empty ${repoDir} (${conflicts.slice(0, 5).join(', ')}${conflicts.length > 5 ? '…' : ''})${c.reset}`);
      } else {
        const overwrite = await confirm({
          message: `${repoDir} is not empty (${conflicts.slice(0, 5).join(', ')}${conflicts.length > 5 ? '…' : ''}). Existing files may be overwritten. Continue?`,
          default: false,
        });
        if (!overwrite) return;
      }
    }
  } else if (existsSync(repoDir)) {
    if (opts.yes) {
      console.log(`${c.dim}(--yes) overwriting ${repoDir}${c.reset}`);
    } else {
      const overwrite = await confirm({ message: `${repoDir} exists. Overwrite?`, default: false });
      if (!overwrite) return;
    }
  }
  mkdirSync(repoDir, { recursive: true });

  console.log();
  const generatedFiles = new Map();
  for (const file of blueprint.files) {
    console.log(`${c.bold}📝 ${file.path}${c.reset}`);
    let content = '';
    let notes = [];
    let approved = false;
    for (let round = 1; round <= cfg.max_review_rounds; round++) {
      content = await generateFile(cfg, blueprint, file, content || null, notes, generatedFiles);

      const lint = phpLint(content, file.path);
      if (!lint.ok) {
        const firstLine = lint.error.split('\n')[0];
        console.log(`   ${c.red}php -l failed:${c.reset} ${firstLine}`);
        notes = [{ severity: 'blocker', category: 'correctness', message: `php -l failed: ${firstLine}` }];
        continue;
      }

      let review;
      try { review = await reviewFile(cfg, blueprint, file, content, generatedFiles); }
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
    generatedFiles.set(file.path, content);
  }

  if (cfg.final_review_provider === 'claude') {
    console.log(`\n${c.cyan}🔎 Final Claude review...${c.reset}`);
    await runFinalReviewLoop(cfg, blueprint, repoDir, generatedFiles);
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
  const dir = (cfg.out_dir && cfg.out_dir.trim()) || process.cwd();
  if (!existsSync(dir)) { console.log('(no builds yet)'); return; }
  const dirs = readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isDirectory() && existsSync(join(dir, d.name, '.git')))
    .map(d => d.name);
  if (!dirs.length) { console.log(`(no builds in ${dir})`); return; }
  head(`📚 Builds in ${dir} (${dirs.length})`);
  console.log();
  for (const d of dirs) console.log(`  ${d}  ${c.dim}${join(dir, d)}${c.reset}`);
  console.log();
}

async function pushCmd(slug) {
  const cfg = loadConfig();
  if (!cfg.github_owner) return bad('github owner not set — run `marko-agent setup`');
  const baseDir = (cfg.out_dir && cfg.out_dir.trim()) || process.cwd();
  const repoDir = join(baseDir, slug);
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
const invokedAs = basename(process.argv[1] || 'marko-agent');
program.name(invokedAs).description('Local multi-agent WordPress plugin builder').version('1.0.0');

program.command('doctor').description('Verify environment').action(doctor);
program.command('ping').description('Send a tiny request to each agent and report timing').action(async () => {
  const cfg = loadConfig();
  head('🏓 Pinging agents');
  console.log();

  console.log(`${c.bold}1. planner${c.reset}`);
  try {
    const t0 = Date.now();
    const raw = await planChat(cfg, 'Reply with the JSON {"ok":true} and nothing else.', 'ping', 'planner');
    const parsed = parseJson(raw);
    parsed.ok ? ok(`planner replied in ${((Date.now() - t0) / 1000).toFixed(1)}s`) : bad(`unexpected reply: ${raw.slice(0, 100)}`);
  } catch (e) { bad(`planner failed: ${e.message}`); }

  const coderTargets = cfg.coder_model_php === cfg.coder_model_js
    ? [['coder (php+js)', cfg.coder_model_php]]
    : [['coder (php)', cfg.coder_model_php], ['coder (js)', cfg.coder_model_js]];
  for (let i = 0; i < coderTargets.length; i++) {
    const [label, model] = coderTargets[i];
    console.log(`\n${c.bold}${2 + i}. ${label}${c.reset}`);
    try {
      const t0 = agentStart(label, cfg.inference_provider, model);
      const out = await chat(cfg, model, 'Reply with exactly: PONG', 'ping');
      agentDone(t0);
      /pong/i.test(out) ? ok(`${label} replied`) : warn(`${label} replied: ${out.slice(0, 80)}`);
    } catch (e) { bad(`${label} failed: ${e.message}`); }
  }

  console.log(`\n${c.bold}${2 + coderTargets.length}. reviewer${c.reset}`);
  try {
    const t0 = agentStart('reviewer', cfg.inference_provider, cfg.reviewer_model);
    const raw = await chat(cfg, cfg.reviewer_model, 'Reply with the JSON {"ok":true} and nothing else.', 'ping', true);
    agentDone(t0);
    const parsed = parseJson(raw);
    parsed.ok ? ok(`reviewer replied`) : bad(`unexpected reply: ${raw.slice(0, 100)}`);
  } catch (e) { bad(`reviewer failed: ${e.message}`); }

  console.log();
});
program.command('setup').description('Interactive config').action(setup);
program.command('models').description('List Ollama models and roles').action(modelsCmd);
program.command('plan <request...>').description('Plan only, do not build').action((req) => planCmd(req.join(' ')));
program.command('build <request...>')
  .option('-y, --yes', 'auto-confirm remaining prompts (skip triage clarifications, overwrite existing files without asking)')
  .description('Plan and build (drops plugin in current folder by default)')
  .option('--out <dir>', 'output to a specific directory (overrides config)')
  .action((req, opts) => buildCmd(req.join(' '), opts));
program.command('list').description('List built plugins').action(listCmd);
program.command('push <slug>').description('Push to GitHub and open PR').action(pushCmd);
program.command('config [action] [key] [value]').description('Show or set config').action(configCmd);
program.command('prompts').description('Print the current system prompts (to fine-tune, edit them in marko-agent.mjs)').action(() => {
  const file = fileURLToPath(import.meta.url);
  console.log(`${c.bold}Edit prompts in:${c.reset} ${file}\n`);
  console.log(`${c.bold}${c.cyan}── TRIAGE_SYS ──${c.reset}\n${TRIAGE_SYS}\n`);
  console.log(`${c.bold}${c.cyan}── PLAN_SYS ──${c.reset}\n${PLAN_SYS}\n`);
  console.log(`${c.bold}${c.cyan}── CODER_SYS ──${c.reset}\n${CODER_SYS}\n`);
  console.log(`${c.bold}${c.cyan}── REVIEWER_SYS ──${c.reset}\n${REVIEWER_SYS}\n`);
});

program.parseAsync(process.argv).catch((err) => {
  console.error(`\n${c.red}✗${c.reset} ${err.message}`);
  process.exit(1);
});
