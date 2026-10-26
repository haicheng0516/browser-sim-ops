// Observation reliability: cold-start AX, stable results, commit verification
// strength and summary ordering. Fake transport, no simulator needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runPlan, validatePlan, flattenAx, summarize } from '../scripts/lib/engine.mjs';

const el = (label, o = {}) => ({ AXLabel: label, AXUniqueId: o.id ?? null, AXValue: o.value ?? null, type: o.type ?? 'Button',
  enabled: true, frame: o.frame ?? { x: 0, y: o.y ?? 100, width: 100, height: 40 }, children: [] });
const tree = (...kids) => [{ AXLabel: 'App', type: 'Application', frame: { x: 0, y: 0, width: 400, height: 800 }, children: kids }];
const INVALID = [{ AXLabel: 'App', type: 'Application', children: [] }]; // no screen frame yet

/** screenAt(n, clock) returns the tree for the n-th AX read (0-based). */
function device(screenAt, { fg = 'com.test.app', paused = () => false, onTap } = {}) {
  let clock = 0, reads = 0;
  const log = [];
  const d = {
    log,
    get reads() { return reads; },
    readAx: async () => { clock += 5; return screenAt(reads++, clock); },
    foreground: async () => fg,
    tap: async (x, y) => { log.push(['tap', Math.round(x * 400), Math.round(y * 800)]); onTap?.(); },
    swipe: async () => log.push(['swipe']),
    typeText: async s => log.push(['type', s]),
    key: async k => log.push(['key', k]),
    button: async b => log.push(['button', b]),
    paused: () => paused(d),
    now: () => clock,
    sleep: async ms => { clock += ms; },
  };
  return d;
}

const home = tree(el('Submit', { id: 'submit', y: 200 }));

test('1. cold start: transient invalid AX is waited out, then the tap happens exactly once', async () => {
  const d = device(n => (n < 3 ? INVALID : home));
  const r = await runPlan({ udid: 'U', steps: [{ tap: { id: 'submit' }, expect: { id: 'submit' } }] }, d);
  assert.equal(r.status, 'ok', JSON.stringify(r.error));
  assert.equal(r.ax_invalid_reads, 3);
  assert.equal(d.log.filter(x => x[0] === 'tap').length, 1);
});

test('2. persistent invalid AX: bounded failure, no tap, and gone is never proven', async () => {
  const d = device(() => INVALID);
  const r = await runPlan({ udid: 'U', ax_ready_ms: 500, steps: [{ tap: { id: 'submit' }, expect: { id: 'x' } }] }, d);
  assert.equal(r.status, 'failed');
  assert.equal(r.error.code, 'bad_snapshot');
  assert.equal(d.log.length, 0);
  assert.ok(r.total_ms < 2000, `bounded: ${r.total_ms}`);

  const g = device(() => INVALID);
  const w = await runPlan({ udid: 'U', ax_ready_ms: 300, steps: [{ wait: { label: 'Loading', gone: true }, timeout_ms: 400 }] }, g);
  assert.equal(w.status, 'failed');
  assert.equal(w.error.code, 'bad_snapshot');
});

test('2b. pause is honoured while waiting for a valid AX snapshot', async () => {
  const d = device(() => INVALID, { paused: dev => dev.reads >= 2 });
  const r = await runPlan({ udid: 'U', steps: [{ tap: { id: 'submit' }, expect: { id: 'x' } }] }, d);
  assert.equal(r.status, 'paused');
  assert.equal(r.stopped_before, 0);
  assert.equal(d.log.length, 0);
});

test('3. commit then AX failure or a broken connection stays unknown and is not resent', async () => {
  let tapped = false;
  const d = device(() => { if (tapped) throw new Error('HTTP 502'); return home; }, { onTap: () => { tapped = true; } });
  const r = await runPlan({ udid: 'U', steps: [{ tap: { id: 'submit' }, expect: { label: 'Done' }, commit: true }] }, d);
  assert.equal(r.status, 'unknown');
  assert.equal(r.commit.verification, 'unknown');
  assert.equal(d.log.length, 1);

  const c = device(() => home);
  c.tap = async () => { c.log.push(['tap']); throw Object.assign(new Error('closed'), { code: 'connection_lost' }); };
  const r2 = await runPlan({ udid: 'U', steps: [{ tap: { id: 'submit' }, expect: { label: 'Done' }, commit: true }] }, c);
  assert.equal(r2.status, 'unknown');
  assert.equal(c.log.length, 1);

  const v = device(n => (n < 2 ? home : INVALID));
  const r3 = await runPlan({ udid: 'U', steps: [{ tap: { id: 'submit' }, expect: { label: 'Done' }, commit: true, timeout_ms: 300 }] }, v);
  assert.equal(r3.status, 'unknown');
  assert.match(r3.error.message, /bad_snapshot/);
});

test('4. a result that flashes during a transition is not accepted as the stable end state', async () => {
  // read 2: result flashes; reads 3-5: gone again; read 6+: settles.
  const done = tree(el('Done', { type: 'StaticText' }));
  const seq = n => (n < 2 ? home : n === 2 ? done : n < 6 ? home : done);
  const d = device(seq);
  const r = await runPlan({ udid: 'U', steps: [{ tap: { id: 'submit' }, expect: { label: 'Done' }, stable_ms: 200, timeout_ms: 3000 }] }, d);
  assert.equal(r.status, 'ok');
  assert.ok(d.reads > 7, `kept observing after the flash (reads=${d.reads})`);
  assert.ok(r.steps[0].observed.stable_ms >= 200);

  // Never holds: flashes every other read -> unstable, and as a commit -> unknown, one tap.
  const f = device(n => (n < 2 ? home : n % 2 ? done : home));
  const r2 = await runPlan({ udid: 'U', steps: [{ tap: { id: 'submit' }, expect: { label: 'Done' }, stable_ms: 200, timeout_ms: 800 }] }, f);
  assert.equal(r2.error.code, 'unstable_result');
  const g = device(n => (n < 2 ? home : n % 2 ? done : home));
  const r3 = await runPlan({ udid: 'U', steps: [{ tap: { id: 'submit' }, expect: { label: 'Done' }, commit: true, stable_ms: 200, timeout_ms: 800 }] }, g);
  assert.equal(r3.status, 'unknown');
  assert.equal(g.log.length, 1);
});

test('5. target present and named mask gone returns promptly, without extra fixed waiting', async () => {
  const loading = tree(el('Done', { type: 'StaticText' }), el('Loading', { type: 'ActivityIndicator', y: 300 }));
  const done = tree(el('Done', { type: 'StaticText' }));
  const d = device(n => (n < 2 ? home : n < 4 ? loading : done));
  const r = await runPlan({ udid: 'U', steps: [{ tap: { id: 'submit' }, expect: [{ label: 'Done' }, { label: 'Loading', gone: true }] }] }, d);
  assert.equal(r.status, 'ok');
  assert.equal(d.reads, 5); // 2 to locate + 2 while loading + 1 settled; the final summary reuses it
  assert.ok(r.total_ms < 300, `no fixed sleep: ${r.total_ms}`);
});

test('6. a ticking clock or unrelated animation does not block the relevant condition', async () => {
  const d = device((n, clock) => (n < 2 ? home
    : tree(el(`12:${String(n).padStart(2, '0')}`, { type: 'StaticText', y: 20 }), el('Spinner', { type: 'Image', y: 400 + n }), el('Done', { type: 'StaticText' }))));
  const r = await runPlan({ udid: 'U', steps: [{ tap: { id: 'submit' }, expect: { label: 'Done' }, stable_ms: 150 }] }, d);
  assert.equal(r.status, 'ok');
  assert.ok(r.total_ms < 1000);
});

test('7. foreground-only commit: default warns and reports weak verification; strict mode rejects before input', async () => {
  const d = device(() => home);
  const r = await runPlan({ udid: 'U', steps: [{ tap: { id: 'submit' }, expect: { foreground: 'com.test.app' }, commit: true }] }, d);
  assert.equal(r.status, 'ok'); // the condition was observed; compatibility kept
  assert.equal(r.commit.verification, 'foreground_only');
  assert.match(r.warnings[0], /business outcome is NOT verified/);

  const s = device(() => home);
  await assert.rejects(runPlan({ udid: 'U', strict_commit: true, steps: [{ tap: { id: 'submit' }, expect: { foreground: 'com.test.app' }, commit: true }] }, s),
    e => e.code === 'bad_plan');
  assert.equal(s.log.length, 0);
  assert.throws(() => validatePlan({ udid: 'U', strict_commit: true, steps: [{ tap: { id: 'submit' }, expect: { label: 'Submit', gone: true }, commit: true }] }), /strict_commit/);
  assert.doesNotThrow(() => validatePlan({ udid: 'U', strict_commit: true, steps: [{ tap: { id: 'submit' }, expect: [{ label: 'Done' }, { foreground: 'com.test.app' }], commit: true }] }));

  const ok = await runPlan({ udid: 'U', steps: [{ tap: { id: 'submit' }, expect: { id: 'submit' }, commit: true }] }, device(() => home));
  assert.equal(ok.commit.verification, 'presence');
  assert.equal(ok.warnings, undefined);
});

test('8. pause during a wait after a non-commit action reports the action as sent', async () => {
  let tapped = false;
  const d = device(() => home, { onTap: () => { tapped = true; }, paused: () => tapped });
  const r = await runPlan({ udid: 'U', steps: [{ tap: { id: 'submit' }, expect: { label: 'Never' } }, { tap: { id: 'submit' }, expect: { id: 'submit' } }] }, d);
  assert.equal(r.status, 'paused');
  assert.equal(r.error.action_sent, true);
  assert.equal(r.stopped_before, 1);
  assert.equal(d.log.length, 1);
});

test('8b. stable_ms and condition lists are validated', () => {
  const base = { udid: 'U' };
  assert.throws(() => validatePlan({ ...base, steps: [{ type: 'a', stable_ms: 100 }] }), /stable_ms needs/);
  assert.throws(() => validatePlan({ ...base, steps: [{ wait: { label: 'a' }, stable_ms: 6000 }] }), /exceed timeout_ms/);
  assert.throws(() => validatePlan({ ...base, steps: [{ wait: [] }] }), /1–8/);
  assert.throws(() => validatePlan({ ...base, steps: [{ wait: [{ lable: 'a' }] }] }), /unknown key/);
  assert.throws(() => validatePlan({ ...base, ax_ready_ms: -1, steps: [{ wait: { label: 'a' } }] }), /ax_ready_ms/);
});

test('9. a key result at the end of a long AX tree is still shown, with truncation reported', () => {
  const filler = Array.from({ length: 60 }, (_, i) => el(`Row ${i}`, { type: 'StaticText', y: 100 + i * 50 })); // most off screen
  const snap = flattenAx(tree(...filler, el('Payment result: success', { id: 'result', type: 'StaticText', y: 50 })));
  const s = summarize(snap, 5, [{ id: 'result' }]);
  assert.equal(s.elements[0].split('|')[1], 'Payment result: success');
  assert.deepEqual(s.matched.length, 1);
  assert.equal(s.truncated, true);
  assert.ok(s.omitted > 0);
  assert.ok(s.offscreen.count > 0);
  assert.equal(s.count, 61);

  const alert = flattenAx(tree(...filler.slice(0, 10), el('Session expired', { type: 'Alert', y: 400 })));
  assert.equal(summarize(alert, 3).elements[0].split('|')[1], 'Session expired');
});


test('summary preserves nth evidence even when an earlier match has no display text', () => {
  const snap = flattenAx(tree(el('Result', { value: 'first' }), el('Result', { value: 'second' })));
  const s = summarize(snap, 1, [{ label: 'Result', nth: 1 }]);
  assert.equal(s.matched.length, 1);
  assert.match(s.elements[0], /value=second/);
  assert.match(s.matched[0], /value=second/);
  const empty = flattenAx(tree(el('', { value: '' }), el('Visible', { value: '' })));
  assert.deepEqual(summarize(empty, 1, [{ value: '', nth: 0 }]).matched, []);
});

test('summary bounds broad matched evidence and reports its omissions', () => {
  const snap = flattenAx(tree(...Array.from({ length: 2000 }, (_, i) => el('Result', { value: String(i) }))));
  const s = summarize(snap, 1, [{ label: 'Result' }]);
  assert.equal(s.elements.length, 1);
  assert.equal(s.matched.length, 1);
  assert.equal(s.matched_count, 2000);
  assert.equal(s.matched_omitted, 1999);
  assert.equal(s.omitted, 1999);
  assert.ok(JSON.stringify(s).length < 1000);
});

test('explicit offscreen limit can reveal rows beyond the default ten', () => {
  const snap = flattenAx(tree(...Array.from({ length: 20 }, (_, i) => el(`Row ${i}`, { y: 900 + i * 50 }))));
  assert.equal(summarize(snap, 200).offscreen.elements.length, 10);
  const expanded = summarize(snap, 200, null, 200);
  assert.equal(expanded.offscreen.elements.length, 20);
  assert.equal(expanded.truncated, false);
});
