// Automatic reclaim of another owner's abandoned lease, through the real CLI.
// The host is faked (process.kill(pid, 0), ps, xcrun, fetch); no simulator,
// helper or real state directory is touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/simops.mjs', import.meta.url));
const udid = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';
const OTHER = '11111111-2222-3333-4444-555555555555';
const ago = min => new Date(Date.now() - min * 60000).toISOString();
const START = 'Thu Jan  1 00:00:00 2026';

function fixture(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'simops-reclaim-'));
  try {
    const state = path.join(dir, 'state');
    fs.mkdirSync(path.join(state, 'leases'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'serve-sim'));
    const leaseFile = path.join(state, 'leases', `${udid}.json`);
    const helperFile = path.join(dir, 'serve-sim', `server-${udid}.json`);
    const runsFile = path.join(state, 'runs.jsonl');
    const preload = path.join(dir, 'fake-host.mjs');
    fs.writeFileSync(preload, `
      import assert from 'node:assert/strict';
      import cp from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      const cfg = JSON.parse(process.env.FAKE_CFG);
      const realKill = process.kill.bind(process);
      process.kill = (pid, signal) => {
        if (pid === process.pid) return realKill(pid, signal);
        assert.equal(signal, 0, 'must not send a real signal');
        if (cfg.alive.includes(pid)) return true;
        throw Object.assign(new Error('fake exited'), { code: 'ESRCH' });
      };
      cp.execFileSync = (command, args) => {
        if (command === 'ps') {
          const pid = Number(args[1]);
          if (!cfg.alive.includes(pid)) throw new Error('no such process');
          if (args[3] === 'lstart=') return (cfg.lstart ?? {})[pid] ?? '${START}';
          return 'node /fixture/serve-sim/dist/serve-sim.js --detach';
        }
        assert.equal(command, 'xcrun');
        return JSON.stringify({ devices: { fixture: [{ udid: '${udid}', state: 'Booted' }] } });
      };
      cp.spawnSync = () => assert.fail('must not launch or discover another helper');
      syncBuiltinESMExports();
      globalThis.fetch = async () => ({ ok: true });
    `);
    const run = ({ lease, helper = { device: udid, pid: 456, wsUrl: 'ws://127.0.0.1:12345/ws', url: 'http://127.0.0.1:12345' },
      alive = [456], lstart, runs = [], locks = [], env = {}, command = 'start', owner = 'new' }) => {
      fs.writeFileSync(leaseFile, JSON.stringify(lease));
      if (helper) fs.writeFileSync(helperFile, JSON.stringify(helper)); else fs.rmSync(helperFile, { force: true });
      fs.writeFileSync(runsFile, runs.map(r => JSON.stringify(r) + '\n').join(''));
      fs.rmSync(path.join(state, 'locks'), { recursive: true, force: true });
      for (const l of locks) {
        fs.mkdirSync(path.join(state, 'locks', l.udid), { recursive: true });
        if (l.holder) fs.writeFileSync(path.join(state, 'locks', l.udid, 'holder.json'), JSON.stringify(l.holder));
      }
      const before = fs.readFileSync(leaseFile, 'utf8');
      const plan = path.join(dir, 'plan.json');
      fs.writeFileSync(plan, JSON.stringify({ steps: [{ assert: { label: 'Ready' } }] }));
      const extra = command === 'run' ? ['--plan', plan] : [];
      const result = spawnSync(process.execPath, ['--import', preload, script, command, '--udid', udid, '--owner', owner, ...extra], {
        env: { ...process.env, SIMOPS_RECLAIM_IDLE_MIN: '', ...env, TMPDIR: dir, TMP: dir, TEMP: dir, SIMOPS_STATE_DIR: state,
          FAKE_CFG: JSON.stringify({ alive, lstart }) },
        encoding: 'utf8', timeout: 5000,
      });
      assert.equal(result.error, undefined);
      assert.equal(fs.existsSync(path.join(state, 'locks', udid)), false, 'command lock must be released');
      const log = fs.readFileSync(runsFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
      return { ...result, out: JSON.parse(result.stdout), before, after: fs.readFileSync(leaseFile, 'utf8'), log: log.slice(runs.length) };
    };
    fn(run);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const dead = { owner: 'old', udid, acquired_at: ago(3 * 24 * 60), started_helper: true, helper_pid: 123, start_pending: false,
  helper_started: START, start_clock: 'ps-lstart/C/UTC0', helper_command: '/fixture/serve-sim/dist/serve-sim.js' };

test('start reclaims an abandoned lease, reports whose and why, and logs it', () => fixture(run => {
  const r = run({ lease: dead, runs: [{ at: ago(2 * 24 * 60), udid, owner: 'old', status: 'ok' }] });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.out.reclaimed.from_owner, 'old');
  assert.equal(r.out.reclaimed.helper_pid, 123);
  assert.ok(r.out.reclaimed.reasons.some(x => /pid 123 has exited/.test(x)));
  assert.ok(r.out.reclaimed.reasons.some(x => /no command lock/.test(x)));
  const now = JSON.parse(r.after);
  assert.equal(now.owner, 'new');
  assert.equal(now.started_helper, false, 'a borrowed helper is never claimed');
  assert.equal(r.log.length, 1);
  assert.equal(r.log[0].event, 'reclaim');
  assert.equal(r.log[0].owner, 'new');
  assert.equal(r.log[0].from_owner, 'old');
  assert.deepEqual(r.log[0].previous_lease, dead);
}));

test('a recycled helper PID (same PID, different start time) counts as gone', () => fixture(run => {
  const r = run({ lease: dead, alive: [123, 456], lstart: { 123: 'Fri Nov 20 00:00:00 2026' } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(r.out.reclaimed.reasons.some(x => /newer process/.test(x)));
}));

test('start refuses and keeps the lease when any check fails, naming the failed check', () => fixture(run => {
  const cases = [
    [{ lease: dead, alive: [123, 456] }, /pid 123 is still running/],
    [{ lease: { ...dead, helper_started: null }, alive: [123, 456] }, /cannot be compared/],
    [{ lease: { owner: 'old', udid, acquired_at: ago(3 * 24 * 60) } }, /no helper_pid/],
    [{ lease: { ...dead, started_helper: false, helper_pid: null } }, /no helper_pid/],
    [{ lease: { ...dead, start_pending: true } }, /start_pending/],
    [{ lease: dead, runs: [{ at: ago(5), udid: OTHER, owner: 'old', status: 'ok' }] }, /less than 30 min ago/],
    [{ lease: { ...dead, acquired_at: ago(5) } }, /lease acquired at .* \(less than 30 min/],
    [{ lease: { ...dead, acquired_at: 'fixture' } }, /acquired_at is missing or unreadable/],
    [{ lease: dead, locks: [{ udid: OTHER, holder: { owner: 'old', command: 'run', pid: 77 } }] }, /command lock present: .*\(run\)/],
    [{ lease: dead, locks: [{ udid: OTHER }] }, /unreadable holder/],
    [{ lease: dead, env: { SIMOPS_RECLAIM_IDLE_MIN: 'soon' } }, /idle window is invalid/],
  ];
  for (const [input, why] of cases) {
    const r = run(input);
    assert.equal(r.status, 4, r.stdout + r.stderr);
    assert.match(r.out.error, /not reclaimed because/);
    assert.ok(r.out.reclaim.refused.some(x => why.test(x)), `${why}: ${r.stdout}`);
    assert.equal(r.after, r.before, 'lease must be untouched');
    assert.equal(r.log.length, 0, 'nothing logged when refused');
  }
}));

test('another owner\'s activity, and a lock of another owner, do not block the reclaim', () => fixture(run => {
  const r = run({ lease: dead, runs: [{ at: ago(1), udid, owner: 'someone-else', status: 'ok' }],
    locks: [{ udid: OTHER, holder: { owner: 'someone-else', command: 'run', pid: 77 } }] });
  assert.equal(r.status, 0, r.stdout + r.stderr);
}));

test('SIMOPS_RECLAIM_IDLE_MIN changes the idle window', () => fixture(run => {
  const lease = { ...dead, acquired_at: ago(10) };
  assert.equal(run({ lease }).status, 4);
  const r = run({ lease, env: { SIMOPS_RECLAIM_IDLE_MIN: '5' } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(r.out.reclaimed.reasons.some(x => /more than 5 min ago/.test(x)));
}));

test('run reclaims the same way and then holds the lease itself', () => fixture(run => {
  const refused = run({ lease: dead, alive: [123, 456], command: 'run' });
  assert.equal(refused.status, 4, refused.stdout + refused.stderr);
  assert.equal(refused.after, refused.before);
  const r = run({ lease: dead, helper: null, command: 'run' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.out.error, /run start again \(lease reclaimed from "old"/);
  assert.equal(r.out.reclaimed.from_owner, 'old');
  assert.equal(JSON.parse(r.after).owner, 'new');
  assert.equal(r.log[0].event, 'reclaim');
  assert.equal(r.log[0].command, 'run');
}));
