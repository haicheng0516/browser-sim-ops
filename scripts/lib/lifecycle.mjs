import fs from 'node:fs';
import path from 'node:path';

// Cooperative lock for every mutating CLI command, including the same owner.
// A crash leaves a visible lock: never infer permission to take over from age.
export async function withDeviceLock(base, udid, command, owner, fn) {
  const dir = path.join(base, 'locks');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = path.join(dir, udid);
  try { fs.mkdirSync(lock, { mode: 0o700 }); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    throw Object.assign(new Error(`device command in progress or stale lock: ${lock}; inspect holder.json and confirm the old process has exited before removing this lock`), { exit: 4 });
  }
  try {
    fs.writeFileSync(path.join(lock, 'holder.json'), JSON.stringify({ pid: process.pid, command, owner, at: new Date().toISOString() }), { mode: 0o600 });
    return await fn();
  } finally { fs.rmSync(lock, { recursive: true, force: true }); }
}

// A failed health request is not process-exit evidence. Terminate only the
// recorded PID with matching device metadata, never a replacement by UDID.
export async function stopOwnedHelper(lease, { alive, readState, terminate, sleep }) {
  if (lease.start_pending) throw new Error('previous helper start outcome is unknown; inspect helper state/process before releasing the lease');
  if (!lease.started_helper) return 'kept (not started by this owner)';
  const pid = lease.helper_pid;
  if (!Number.isInteger(pid) || pid <= 1) throw new Error('invalid owned helper PID; lease retained');
  if (!alive(pid)) return `already exited; pid ${pid}`;
  const current = readState();
  if (current?.pid !== pid || current?.device !== lease.udid)
    throw new Error('owned PID is still alive but helper identity changed or metadata is missing; lease retained');
  terminate(pid);
  for (let i = 0; i < 50; i++) {
    if (!alive(pid)) return `stopped; pid ${pid} verified exited`;
    await sleep(100);
  }
  throw new Error(`helper pid ${pid} is still running; lease retained`);
}
