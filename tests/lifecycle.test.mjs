import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withDeviceLock, stopOwnedHelper } from '../scripts/lib/lifecycle.mjs';

async function temp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'simops-test-'));
  try { return await fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('same owner cannot overlap run, stop or start; lock is removed on normal and failed exits', async () => temp(async dir => {
  let release; const pending = new Promise(r => { release = r; });
  const first = withDeviceLock(dir, 'U', 'run', 'same', () => pending);
  for (const cmd of ['run', 'stop', 'start'])
    await assert.rejects(withDeviceLock(dir, 'U', cmd, 'same', () => assert.fail('must not enter')), e => e.exit === 4);
  release(); await first;
  await assert.rejects(withDeviceLock(dir, 'U', 'run', 'other', () => { throw new Error('failure'); }), /failure/);
  await withDeviceLock(dir, 'U', 'run', 'other', async () => {});
  assert.equal(fs.existsSync(path.join(dir, 'locks', 'U')), false);
}));

test('stale or incomplete lock is never stolen', async () => temp(async dir => {
  fs.mkdirSync(path.join(dir, 'locks', 'U'), { recursive: true });
  await assert.rejects(withDeviceLock(dir, 'U', 'run', 'same', () => {}), e => e.exit === 4);
}));

const lease = { udid: 'U', started_helper: true, helper_pid: 123 };
const base = { readState: () => ({ device: 'U', pid: 123 }), sleep: async () => {} };

test('owned unhealthy but alive helper must actually exit before release', async () => {
  let living = true; let killed = null;
  const result = await stopOwnedHelper(lease, { ...base, alive: () => living, terminate: pid => { killed = pid; living = false; } });
  assert.equal(killed, 123);
  assert.match(result, /verified exited/);
  await assert.rejects(stopOwnedHelper(lease, { ...base, alive: () => true, terminate: () => {} }), /still running/);
});

test('changed helper identity, unknown startup and malformed PID do not release or kill', async () => {
  const deps = { ...base, alive: () => true, terminate: () => assert.fail('must not kill') };
  await assert.rejects(stopOwnedHelper(lease, { ...deps, readState: () => ({ device: 'U', pid: 456 }) }), /identity changed/);
  await assert.rejects(stopOwnedHelper({ ...lease, start_pending: true }, deps), /unknown/);
  await assert.rejects(stopOwnedHelper({ ...lease, helper_pid: 0 }, deps), /invalid/);
});

test('borrowed helper is kept and an exited owned PID needs no health request', async () => {
  const deps = { ...base, alive: () => false, readState: () => assert.fail('no metadata needed'), terminate: () => assert.fail('must not kill') };
  assert.match(await stopOwnedHelper({ started_helper: false }, deps), /kept/);
  assert.match(await stopOwnedHelper(lease, deps), /already exited/);
});
