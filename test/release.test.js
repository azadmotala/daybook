import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Static checks on the release script.
 *
 * **Why a test and not just care.** This script runs `rm -rf` on a shared host that also serves a
 * live website. The blast radius of a wrong constant is somebody else's site, and the mistake would
 * be found by them, not by us. None of this can run the deploy — it reads the script and asserts
 * the properties that make a wrong constant harmless.
 *
 * What it cannot check is whether the URL actually maps to the path. Only the server knows that,
 * which is what `-Preflight` is for.
 */

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SRC = readFileSync(ROOT + 'tools/release.ps1', 'utf8');

/**
 * The three target constants live in tools/release.local.ps1, which is git-ignored and absent on
 * any machine but the owner's. The committed example carries the same three names with placeholder
 * values. The guards below are about the *shape* of a target, so they run against whichever file
 * exists and prove the shape either way.
 */
const LOCAL = ROOT + 'tools/release.local.ps1';
const TARGET = readFileSync(existsSync(LOCAL) ? LOCAL : ROOT + 'tools/release.local.example.ps1', 'utf8');

function constant(name) {
  // A regex literal: a string-built pattern here lost its backslashes once to the JS string and
  // once to the tool that wrote it, and quietly matched nothing.
  const m = TARGET.match(new RegExp(String.raw`\$${name}\s*=\s*'([^']*)'`));
  assert.ok(m, `the deploy target file no longer declares $${name}`);
  return m[1];
}

test('-Pages publishes the same staged set as the private host, and nothing more', () => {
  const i = SRC.indexOf('if ($Pages) {');
  assert.ok(i > -1, 'release.ps1 has no -Pages path');
  const block = SRC.slice(i, SRC.indexOf('Pages rebuilds in about a minute', i));
  // After the forbid-list and after staging, so it inherits both rather than restating them.
  assert.ok(i > SRC.indexOf('Refusing to publish'), '-Pages runs before the forbid-list and could publish test/ or tools/');
  assert.ok(i > SRC.indexOf('Copy-Item (Join-Path $Root $f) $dst'), '-Pages runs before staging is filled');
  // Must match the file WRITE, not the word. A first version matched /\.nojekyll/ and stayed green
  // with the write deleted, because the Write-Host line below it mentions the name.
  assert.match(block, /WriteAllText\([^)]*'\.nojekyll'/, 'must actually write .nojekyll; Pages runs Jekyll unless told not to, and Jekyll drops files');
  assert.match(block, /HEAD:gh-pages/, 'must push to the gh-pages branch, which is what Pages serves');
  assert.match(block, /github\.com\/azadmotala\/daybook\.git/, 'must target the public mirror');
  assert.doesNotMatch(block, /\$SshHost|\$RemoteBase|ssh |scp /, 'the Pages path must never touch the private host');
});

test('-Pages does not require the private deploy target', () => {
  // The refusal stays for every other path; under -Pages there is nothing to refuse about.
  const guard = SRC.indexOf('if (-not (Test-Path $Local))');
  const wrap = SRC.lastIndexOf('if (-not $Pages)', guard);
  assert.ok(guard > -1, 'the local-target refusal is gone');
  assert.ok(wrap > -1 && wrap < guard, 'the local-target refusal must be skipped under -Pages');
});

test('release.ps1 carries no target of its own', () => {
  // A default is a target. The script must read the three from the local file and nothing else.
  for (const name of ['SshHost', 'RemoteBase', 'SiteUrl']) {
    assert.doesNotMatch(SRC, new RegExp(String.raw`^\$${name}\s*=\s*'`, 'm'),
      `release.ps1 declares $${name} itself; it must come from tools/release.local.ps1`);
  }
  assert.match(SRC, /release\.local\.ps1/, 'release.ps1 must read the local target file');
  assert.match(SRC, /if \(-not \(Test-Path \$Local\)\)/, 'and refuse to run when it is missing');
});

test('the deploy target is a dedicated folder, not a document root', () => {
  const base = constant('RemoteBase');
  const segments = base.split('/').filter(Boolean);
  assert.ok(
    segments.length >= 2,
    `RemoteBase is '${base}'. One segment is a document root, and this script deletes from it.`,
  );
  assert.notEqual(segments[segments.length - 1], 'public_html');
});

test('every rm -rf is scoped underneath the remote base', () => {
  const removals = [...SRC.matchAll(/rm -rf\s+'?([^\s;'"]+)/g)].map((m) => m[1]);
  assert.ok(removals.length > 0, 'expected the script to remove things');
  for (const path of removals) {
    // `~/…upload.tgz` is our own upload in the home directory, not on the site.
    if (path.startsWith('~/')) continue;
    assert.ok(
      path.startsWith('$RemoteBase/'),
      `unscoped removal: rm -rf ${path} — everything removed must sit under $RemoteBase`,
    );
  }
});

test('nothing removed can escape the remote base', () => {
  for (const entry of [...SRC.matchAll(/\$LiveEntries = @\(([^)]*)\)/g)][0][1].split(',')) {
    const value = entry.trim().replace(/^'|'$/g, '');
    if (!value) continue;
    assert.doesNotMatch(value, /[*?]/, `LiveEntries '${value}' contains a glob`);
    assert.doesNotMatch(value, /\.\./, `LiveEntries '${value}' can climb out of the folder`);
    assert.doesNotMatch(value, /^[/~]/, `LiveEntries '${value}' is an absolute path`);
    assert.notEqual(value, '.', 'LiveEntries contains "." which would clear the whole folder');
  }
});

test('the swap creates the base rather than assuming it exists', () => {
  const swap = /\$clear; cp -a/.exec(SRC);
  assert.ok(swap, 'could not find the swap command');
  const line = SRC.slice(SRC.lastIndexOf('ssh', swap.index), swap.index + 200);
  assert.match(line, /mkdir -p \$RemoteBase/,
    'the swap copies into $RemoteBase without creating it, so a first deploy fails half-done');
});

test('the ownership guard runs on deploy, not only under -Preflight', () => {
  const calls = [...SRC.matchAll(/Assert-TargetIsOurs/g)];
  assert.ok(calls.length >= 3,
    'expected the guard to be defined, called by -Preflight, and called again on the deploy path');

  // It must run before anything is uploaded or swapped.
  const guardOnDeploy = SRC.lastIndexOf('Assert-TargetIsOurs');
  assert.ok(guardOnDeploy < SRC.indexOf('scp $tgz'),
    'the guard runs after the upload has already started');
});

test('the guard refuses a folder holding anything it did not put there', () => {
  assert.match(SRC, /\$foreign\s*=/, 'no check for unrecognised entries');
  assert.match(SRC, /Refusing to touch it/, 'the guard does not stop on foreign content');
});

test('-Preflight writes nothing to the live site', () => {
  const start = SRC.indexOf('if ($Preflight)');
  const end = SRC.indexOf('# ------', start);
  const block = SRC.slice(start, end);
  assert.ok(start > -1 && end > start, 'could not isolate the preflight block');

  // The one write it does is a probe file it removes again, inside our own folder.
  const writes = [...block.matchAll(/(rm -rf|cp -a|tar -xzf|scp )/g)].map((m) => m[1]);
  assert.deepEqual(writes, [], `preflight performs a destructive operation: ${writes.join(', ')}`);
  assert.match(block, /rm -f '\$RemoteBase\/\$probe'/, 'preflight leaves its probe file behind');
  assert.match(block, /\$probe = "[^"]*\$token[^"]*"/,
    'the probe filename must carry the token, so two runs cannot collide');
  assert.doesNotMatch(block, /\$probe = "\./,
    'a dotfile probe can be denied by server config, which reads as a mapping failure that never happened');
});

test('the probe distinguishes a failed fetch from a real mismatch', () => {
  const start = SRC.indexOf('if ($Preflight)');
  const block = SRC.slice(start, SRC.indexOf('# ------', start));
  assert.match(block, /byte\[\]/,
    'Windows PowerShell returns .Content as bytes for untyped responses; without handling that, '
    + 'every probe reports a mismatch that did not happen');
  assert.match(block, /COULD NOT CHECK THE MAPPING/,
    'a network failure must not be reported as proof the URL points elsewhere');
});

test('the URL and the remote path are declared together, so a mismatch is visible', () => {
  const url = constant('SiteUrl');
  const base = constant('RemoteBase');
  assert.match(url, /^https:\/\//, 'the site must be HTTPS or the service worker will not run');
  assert.ok(url.endsWith('/'), 'SiteUrl must end in a slash or the probe URL is malformed');

  // Not a claim that they match — only the server knows that. This asserts the
  // folder name appears in the URL path, which catches the obvious slip.
  const folder = base.split('/').filter(Boolean).pop();
  assert.ok(url.includes('/' + folder + '/'),
    `SiteUrl '${url}' does not contain the folder '${folder}'. Run -Preflight to confirm the mapping.`);
});

test('nothing outside the app can be published', () => {
  assert.match(SRC, /\$forbidden = \$files \| Where-Object/,
    'the allowlist that keeps test/, tools/ and the spec off a public URL is gone');
});

/** The -Mirror block, from its switch to its success line. */
function mirrorBlock() {
  const start = SRC.indexOf('if ($Mirror) {');
  const end = SRC.indexOf('verified from a fresh clone)', start);
  assert.ok(start > -1 && end > start, 'release.ps1 has no -Mirror path');
  return SRC.slice(start, end);
}

function fnBody(name) {
  const start = SRC.indexOf(`function ${name}(`);
  assert.ok(start > -1, `release.ps1 no longer defines ${name}`);
  return SRC.slice(start, SRC.indexOf('\n}', start));
}

test('-Mirror publishes HEAD without the workspace, and never touches the private host', () => {
  const block = mirrorBlock();
  assert.match(block, /git -C \$Root archive [^\n]*HEAD/,
    'must export HEAD with git archive; the working tree is not what was committed');
  assert.match(block, /\$workspace = Join-Path \$export '\.claude'/, 'must name .claude/ in the export');
  assert.match(block, /Remove-Item \$workspace -Recurse -Force/, 'must drop .claude/ from the export');
  const counted = block.indexOf('if ($have -ne $expected)');
  assert.ok(counted > -1 && counted < block.indexOf('Find-Private $export'),
    'must count what the unpack produced before checking it; every check passes on an empty folder');
  assert.match(block, /push -q --force \$MirrorRepo HEAD:main/, 'must replace main with the one commit');
  assert.match(block, /'https:\/\/github\.com\/azadmotala\/daybook\.git'/, 'must default to the public mirror');
  assert.doesNotMatch(block, /\bssh |\bscp |Assert-TargetIsOurs/, 'the mirror must never touch the private host');
});

test('-Mirror looks for the target and the specification before it pushes', () => {
  const block = mirrorBlock();
  const check = block.indexOf('Find-Private $export');
  assert.ok(check > -1 && check < block.indexOf('push -q --force'),
    'the leak check must run on the export before anything is pushed');
  const fn = fnBody('Find-Private');
  for (const v of ['$SshHost', '$RemoteBase', '$SiteUrl']) {
    assert.ok(fn.includes(v), `the leak check does not look for ${v}`);
  }
  assert.ok(fn.includes(String.raw`-cmatch '\bSPEC\b'`), 'the leak check must look for the specification');
  assert.match(fn, /Join-Path \$base '\.claude'/, 'the leak check must refuse the workspace');
  assert.match(fn, /\$needles\.Count -ne 3/, 'a missing target value must refuse, not check for nothing');
  assert.match(fn, /if \(\$scanned -eq 0\) \{ Fail/, 'a leak check over zero files must refuse, not report clean');
});

test('-Mirror tests what ships: the export before pushing, a fresh clone after', () => {
  const block = mirrorBlock();
  const push = block.indexOf('push -q --force');
  const onExport = block.indexOf('Invoke-Suite $export');
  const clone = block.indexOf('git clone');
  assert.ok(onExport > -1 && onExport < push, 'the suite must run on the export before the push');
  assert.ok(clone > push, 'verification must clone after the push, not trust its output');
  assert.ok(block.indexOf('Invoke-Suite $clone') > clone, 'the fresh clone must be tested');
  assert.ok(block.indexOf('Find-Private $clone') > clone, 'the fresh clone must be checked for leaks');
  assert.match(block, /rev-list --count HEAD/, 'must check the public repository holds one commit');
  assert.match(block, /\$cloneTree -ne \$tree/, 'must check the public tree is the one that was built');
  assert.match(block, /\$want -join "`n"\) -ne \(\$got -join/, 'must check the commit is HEAD minus .claude/');
});

test('-Mirror needs the target file, because the check cannot look for what it does not know', () => {
  const guard = SRC.indexOf('if (-not (Test-Path $Local))');
  const before = SRC.slice(0, guard).trimEnd().split('\n').pop().trim();
  assert.equal(before, 'if (-not $Pages) {',
    'only -Pages may skip the target file; -Mirror reads it to know what must not be published');
});

test('the committed example shares no value with the real target', (t) => {
  if (!existsSync(LOCAL)) return t.skip('no local target on this machine, so nothing to compare');
  const example = readFileSync(ROOT + 'tools/release.local.example.ps1', 'utf8').toLowerCase();
  const values = {
    SshHost: constant('SshHost'),
    RemoteBase: constant('RemoteBase'),
    SiteUrl: constant('SiteUrl'),
    'host of SiteUrl': new URL(constant('SiteUrl')).hostname,
  };
  // Names only in the message: the values are the thing that must not be printed anywhere.
  for (const [name, value] of Object.entries(values)) {
    assert.ok(!example.includes(value.toLowerCase()), `the committed example contains the real ${name}`);
  }
});

test('tar is Windows\' own, by full path, wherever it is called', () => {
  // Git's GNU tar reads C:\... as host:path and fails; which one a bare `tar` finds depends on PATH.
  assert.match(SRC, /\$TarExe = Join-Path \$env:SystemRoot 'System32\\tar\.exe'/, 'tar must be pinned to System32');
  const bare = SRC.split('\n').filter((l) => /^\s*tar\s/.test(l));
  assert.deepEqual(bare, [], 'a bare tar call resolves through PATH');
  assert.ok((SRC.match(/& \$TarExe /g) || []).length >= 2, 'both the mirror and the deploy must call the pinned tar');
});

test('the suite gate reads a count that survives any console encoding', () => {
  const fn = fnBody('Invoke-Suite');
  assert.match(fn, /node --test --test-reporter=tap /,
    'the default reporter puts a non-ASCII glyph before the count, which some consoles mangle');
  assert.match(fn, /'\(\?m\)\^# tests \(\\d\+\)'/, 'the count must be read from the ASCII TAP summary');
  assert.match(fn, /'\(\?m\)\^# fail \(\\d\+\)'/, 'the failure count must be read from the ASCII TAP summary');
  assert.match(fn, /\$ran -eq 0/, 'zero tests must still refuse');
});

test('no two variables in release.ps1 differ only by case', () => {
  // PowerShell variable names ignore case, so $Tar and $tar are one variable. That pair emptied the
  // mirror's export in rehearsal: the archive path overwrote the tar executable, the extract step
  // opened the archive with its file association, and everything after it ran over nothing.
  // Code only: a comment explaining the clash has to be able to name both spellings.
  const code = SRC.replace(/<#[\s\S]*?#>/g, '').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  const spellings = new Map();
  for (const [, name] of code.matchAll(/\$(?:script:|global:)?([A-Za-z_][A-Za-z0-9_]*)/g)) {
    const key = name.toLowerCase();
    if (!spellings.has(key)) spellings.set(key, new Set());
    spellings.get(key).add(name);
  }
  const clashes = [...spellings.values()].filter((s) => s.size > 1).map((s) => [...s].join(' / '));
  assert.deepEqual(clashes, [], `variables that are one variable to PowerShell: ${clashes.join('; ')}`);
});
