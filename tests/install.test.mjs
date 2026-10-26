import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));

test('both isolated skill installs load the same source, conflicts fail and uninstall preserves others', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'simops-install-'));
  try {
    const env = { ...process.env, CLAUDE_CONFIG_DIR: path.join(dir, 'claude'), CODEX_SKILLS_DIR: path.join(dir, 'agents skills'), CODEX_HOME: path.join(dir, 'legacy') };
    const run = (script, ...args) => spawnSync('sh', [path.join(root, script), ...args], { env, encoding: 'utf8' });
    for (let i = 0; i < 2; i++) assert.equal(run('install.sh').status, 0);
    const claude = path.join(env.CLAUDE_CONFIG_DIR, 'skills', 'browser-sim-ops');
    const codex = path.join(env.CODEX_SKILLS_DIR, 'browser-sim-ops');
    for (const link of [claude, codex]) assert.equal(fs.realpathSync(link), fs.realpathSync(root));
    assert.match(fs.readFileSync(path.join(codex, 'SKILL.md'), 'utf8'), /name: browser-sim-ops/);
    fs.unlinkSync(codex); fs.mkdirSync(codex);
    fs.writeFileSync(path.join(codex, 'keep'), 'owned by someone else');
    assert.equal(run('install.sh', 'all').status, 1);
    assert.equal(run('uninstall.sh').status, 0);
    assert.equal(fs.existsSync(claude), false);
    assert.equal(fs.readFileSync(path.join(codex, 'keep'), 'utf8'), 'owned by someone else');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
