// Plan runner for iOS Simulator steps. Pure logic: transport is injected,
// so the same rules are unit-tested without a simulator.
//
// Rules enforced here (not just documented):
// - every step re-checks pause before it starts;
// - first failure stops the run, nothing is retried;
// - a step marked commit (submit/save/send) must be the last action and must
//   declare `expect`; if the expectation times out the result is "unknown",
//   and the caller must verify instead of sending it again.

export const MAX_STEPS = 20;
const ACTIONS = ['tap', 'type', 'key', 'button', 'swipe', 'wait', 'assert'];
const NEEDS_EXPECT = new Set(['tap', 'button', 'swipe', 'key']);
const COND_KEYS = new Set(['id', 'label', 'labelContains', 'value', 'type', 'nth', 'gone', 'foreground']);
const COND_ANCHORS = ['id', 'label', 'labelContains', 'value', 'foreground'];

/** A condition must name something concrete; typos would otherwise match anything. */
function checkCond(cond, where) {
  if (!cond || typeof cond !== 'object' || Array.isArray(cond))
    throw new StepError('bad_plan', `${where}: condition must be an object`);
  const unknown = Object.keys(cond).filter(k => !COND_KEYS.has(k));
  if (unknown.length) throw new StepError('bad_plan', `${where}: unknown key(s) ${unknown.join(', ')}`);
  if (!COND_ANCHORS.some(k => cond[k] != null))
    throw new StepError('bad_plan', `${where}: needs one of ${COND_ANCHORS.join('/')}`);
  for (const k of ['id', 'label', 'labelContains', 'value', 'type', 'foreground']) {
    if (cond[k] !== undefined && (typeof cond[k] !== 'string' || (k !== 'value' && !cond[k].length)))
      throw new StepError('bad_plan', `${where}: ${k} must be a nonempty string (value may be empty)`);
  }
  if (cond.foreground !== undefined && Object.keys(cond).length !== 1)
    throw new StepError('bad_plan', `${where}: foreground must be a separate condition; use an additional assert/wait`);
  if (cond.nth !== undefined && (!Number.isInteger(cond.nth) || cond.nth < 0))
    throw new StepError('bad_plan', `${where}: nth must be a nonnegative integer`);
  if (cond.gone !== undefined && typeof cond.gone !== 'boolean')
    throw new StepError('bad_plan', `${where}: gone must be boolean`);
}

export class StepError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}

// ---------- AX tree helpers ----------

export function flattenAx(raw) {
  const roots = Array.isArray(raw) ? raw : [raw];
  const screen = roots[0]?.frame;
  if (!screen || !['x', 'y', 'width', 'height'].every(k => Number.isFinite(screen[k])) || screen.width <= 0 || screen.height <= 0)
    throw new StepError('bad_snapshot', 'AX response has no valid screen frame; cannot verify presence or absence');
  const out = [];
  const visit = (n, path) => {
    if (!n || typeof n !== 'object') return;
    out.push({
      path,
      id: n.AXUniqueId ?? null,
      label: n.AXLabel ?? '',
      value: n.AXValue ?? '',
      type: n.type ?? n.role_description ?? '',
      enabled: n.enabled !== false,
      frame: n.frame ?? null,
    });
    (n.children ?? []).forEach((c, i) => visit(c, `${path}.${i}`));
  };
  roots.forEach((r, i) => visit(r, String(i)));
  return { screen, elements: out };
}

function textMatch(el, sel) {
  if (sel.id != null && el.id !== sel.id) return false;
  if (sel.label != null && el.label !== sel.label) return false;
  if (sel.labelContains != null && !String(el.label).includes(sel.labelContains)) return false;
  if (sel.value != null && el.value !== sel.value) return false;
  if (sel.type != null && el.type !== sel.type) return false;
  return true;
}

function hasTextKey(sel) {
  return ['id', 'label', 'labelContains', 'value'].some(k => sel[k] != null);
}

export function onScreen(el, screen) {
  const f = el.frame;
  if (!f || f.width <= 0 || f.height <= 0) return false;
  const cx = f.x + f.width / 2, cy = f.y + f.height / 2;
  return cx >= screen.x && cy >= screen.y &&
    cx <= screen.x + screen.width && cy <= screen.y + screen.height;
}

/** Find exactly one element. Zero or several matches is an error, never a guess. */
export function findOne(snapshot, sel) {
  if (!sel || typeof sel !== 'object' || !hasTextKey(sel))
    throw new StepError('bad_selector', 'selector needs id, label, labelContains or value');
  let hits = snapshot.elements.filter(el => textMatch(el, sel) && el.frame);
  // The application root carries the app name; never treat it as a control.
  hits = hits.filter(el => el.path !== '0');
  if (sel.nth != null) hits = hits[sel.nth] ? [hits[sel.nth]] : [];
  if (hits.length === 0) throw new StepError('not_found', `no element matches ${JSON.stringify(sel)}`);
  if (hits.length > 1)
    throw new StepError('ambiguous', `${hits.length} elements match ${JSON.stringify(sel)}; add id/type/nth`,
      { candidates: hits.slice(0, 8).map(brief) });
  return hits[0];
}

export function matches(snapshot, cond) {
  if (cond.foreground != null) return true; // checked by caller with foreground()
  const sel = { ...cond };
  delete sel.gone;
  const n = snapshot.elements.filter(el => el.path !== '0' && textMatch(el, sel)).length;
  const exists = cond.nth !== undefined ? n > cond.nth : n > 0;
  return cond.gone ? !exists : exists;
}

export function brief(el) {
  const f = el.frame ? [el.frame.x, el.frame.y, el.frame.width, el.frame.height].map(v => Math.round(v)) : null;
  const o = { type: el.type, label: el.label };
  if (el.id) o.id = el.id;
  if (el.value) o.value = el.value;
  if (!el.enabled) o.enabled = false;
  if (f) o.frame = f;
  return o;
}

/** Compact, model-friendly view: labelled or identified elements only. */
export function summarize(snapshot, limit = 40) {
  const keep = snapshot.elements.filter(el => el.path !== '0' && (el.label || el.id || el.value));
  return { count: keep.length, elements: keep.slice(0, limit).map(line), truncated: keep.length > limit };
}

/** One element per line: type|label|id=..|value=..|x,y,w,h — cheap for a model to read. */
export function line(el) {
  const b = brief(el);
  return [b.type, b.label, b.id ? `id=${b.id}` : '', b.value && b.value !== b.label ? `value=${b.value}` : '',
    b.enabled === false ? 'disabled' : '', b.frame ? b.frame.join(',') : ''].filter(Boolean).join('|');
}

// ---------- plan validation ----------

export function validatePlan(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new StepError('bad_plan', 'plan must be an object');
  if (!plan.udid) throw new StepError('bad_plan', 'plan.udid is required (use one explicit simulator)');
  const bounded = (v, name, max = 60000) => {
    if (v !== undefined && (!Number.isFinite(v) || v < 0 || v > max))
      throw new StepError('bad_plan', `${name} must be a finite number from 0 to ${max}`);
  };
  bounded(plan.bundle_timeout_ms, 'bundle_timeout_ms');
  if (plan.bundle !== undefined && (typeof plan.bundle !== 'string' || !plan.bundle))
    throw new StepError('bad_plan', 'bundle must be a nonempty string');
  if (plan.summary_limit !== undefined && (!Number.isInteger(plan.summary_limit) || plan.summary_limit < 1 || plan.summary_limit > 200))
    throw new StepError('bad_plan', 'summary_limit must be an integer from 1 to 200');
  const steps = plan.steps;
  if (!Array.isArray(steps) || steps.length === 0 || steps.length > MAX_STEPS)
    throw new StepError('bad_plan', `steps must be 1–${MAX_STEPS} items`);
  let lastAction = -1;
  steps.forEach((s, i) => {
    const kinds = ACTIONS.filter(k => s && s[k] !== undefined);
    if (kinds.length !== 1) throw new StepError('bad_plan', `step ${i}: exactly one of ${ACTIONS.join('/')}`);
    const kind = kinds[0];
    if (Array.isArray(s) || typeof s !== 'object') throw new StepError('bad_plan', `step ${i}: object required`);
    const allowed = [kind, 'expect', 'commit', 'timeout_ms', 'settle_ms', 'label'];
    if (Object.keys(s).some(k => !allowed.includes(k))) throw new StepError('bad_plan', `step ${i}: unknown step key`);
    bounded(s.timeout_ms, `step ${i} timeout_ms`);
    bounded(s.settle_ms, `step ${i} settle_ms`);
    if (s.commit !== undefined && typeof s.commit !== 'boolean') throw new StepError('bad_plan', `step ${i}: commit must be boolean`);
    if (s.commit && ['wait', 'assert'].includes(kind)) throw new StepError('bad_plan', `step ${i}: commit must mark an action`);
    if (kind === 'type' && (typeof s.type !== 'string' || /[^\x20-\x7e\n\t]/.test(s.type) || s.type.length > 2000))
      throw new StepError('bad_plan', `step ${i}: type supports at most 2000 US ASCII characters, newline and tab`);
    if (kind === 'key' && (typeof s.key !== 'string' || !['enter', 'return', 'escape', 'backspace', 'delete', 'tab', 'space'].includes(s.key.toLowerCase())))
      throw new StepError('bad_plan', `step ${i}: unsupported key`);
    if (kind === 'button' && s.button !== 'home') throw new StepError('bad_plan', `step ${i}: only button home is supported`);
    if (kind === 'swipe') {
      const v = s.swipe;
      if (!v || typeof v !== 'object' || Object.keys(v).some(k => !['from', 'to', 'ms'].includes(k)) ||
          ![v.from, v.to].every(p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite)))
        throw new StepError('bad_plan', `step ${i}: swipe requires numeric from/to point pairs`);
      bounded(v.ms, `step ${i} swipe.ms`, 5000);
    }
    if (NEEDS_EXPECT.has(kind) && !s.expect)
      throw new StepError('bad_plan', `step ${i}: ${kind} must declare expect (the state change to wait for)`);
    if (kind !== 'wait' && kind !== 'assert') lastAction = i;
    if (kind === 'wait' || kind === 'assert') checkCond(s[kind], `step ${i} ${kind}`);
    if (s.expect !== undefined) checkCond(s.expect, `step ${i} expect`);
    if (kind === 'tap') {
      const sel = s.tap, hasText = sel && ['id', 'label', 'labelContains', 'value'].some(k => sel[k] != null);
      if (!hasText && !(sel && sel.x != null && sel.y != null))
        throw new StepError('bad_plan', `step ${i}: tap needs id/label/labelContains/value or x+y`);
      if (hasText) {
        checkCond(sel, `step ${i} tap`);
        if ('gone' in sel || 'foreground' in sel) throw new StepError('bad_plan', `step ${i}: tap needs an element selector`);
      } else if (Object.keys(sel).some(k => !['x', 'y'].includes(k)) || !Number.isFinite(sel.x) || !Number.isFinite(sel.y)) {
        throw new StepError('bad_plan', `step ${i}: tap coordinates must be finite x/y numbers`);
      }
    }
  });
  steps.forEach((s, i) => {
    if (!s.commit) return;
    if (!s.expect) throw new StepError('bad_plan', `step ${i}: commit step must declare expect`);
    if (i !== lastAction) throw new StepError('bad_plan', `step ${i}: commit must be the last action in a plan`);
  });
  return steps.map((s, i) => ({ ...s, kind: ACTIONS.find(k => s[k] !== undefined), index: i }));
}

// ---------- runner ----------

/**
 * transport: {
 *   readAx(): Promise<rawTree>,          // one AX snapshot
 *   foreground(): Promise<string|null>,  // bundle id
 *   tap(nx, ny), swipe(from, to, ms), key(name), typeText(text), button(name),
 *   paused(): boolean,                   // pause file / signal
 *   now(): number, sleep(ms)
 * }
 */
export async function runPlan(plan, t) {
  const steps = validatePlan(plan);
  const started = t.now();
  const record = { status: 'ok', steps: [], ax_reads: 0, ax_ms: 0, actions: 0 };
  let snap = null; // latest snapshot, reused until something acts
  let sent = false; // an input event of the current step may have reached the device

  const read = async () => {
    const a = t.now();
    const raw = await t.readAx();
    record.ax_reads++; record.ax_ms += t.now() - a;
    snap = flattenAx(raw);
    return snap;
  };
  const fresh = async () => snap ?? read();

  const waitFor = async (cond, timeoutMs) => {
    const deadline = t.now() + timeoutMs;
    for (;;) {
      if (cond.foreground != null) {
        if ((await t.foreground()) === cond.foreground) return true;
      } else {
        await read();
        if (matches(snap, cond)) return true;
      }
      if (t.now() >= deadline) return false;
      await t.sleep(cond.foreground != null ? 150 : 50);
    }
  };

  try {
    if (plan.bundle) {
      // Wait briefly for the app to come forward (launch animation), then insist.
      const ok = await waitFor({ foreground: plan.bundle }, plan.bundle_timeout_ms ?? 3000);
      const fg = ok ? plan.bundle : await t.foreground();
      if (!ok)
        throw new StepError('wrong_app', `foreground is ${fg ?? 'unknown'}, plan expects ${plan.bundle}`, { step: -1 });
    }
    for (const s of steps) {
      if (t.paused()) { record.status = 'paused'; record.stopped_before = s.index; break; }
      const a = t.now();
      const entry = { i: s.index, kind: s.kind, label: s.label ?? null };
      sent = false;
      try {
        await act(s);
        if (s.expect) {
          const ok = await waitFor(s.expect, s.timeout_ms ?? 5000);
          if (!ok) {
            if (s.commit) throw new StepError('unknown_result',
              'commit sent but expected result not observed; verify the original action, do NOT resend');
            throw new StepError('expect_timeout', `expected ${JSON.stringify(s.expect)} not observed`);
          }
        }
      } catch (e) {
        // Once a commit action may have reached the device, any later error
        // (lost connection, AX read failure) leaves its outcome unknown.
        if (s.commit && sent && e.code !== 'unknown_result') {
          const u = new StepError('unknown_result',
            `commit sent, then ${e.code ?? 'error'}: ${e.message}; verify the original action, do NOT resend`);
          u.step = s.index;
          throw u;
        }
        e.step = s.index;
        throw e;
      } finally {
        entry.ms = Math.round(t.now() - a);
        record.steps.push(entry);
      }
    }
  } catch (e) {
    record.status = e.code === 'unknown_result' ? 'unknown' : e.code === 'paused' ? 'paused' : 'failed';
    if (e.code === 'paused') record.stopped_before = e.step;
    record.error = { code: e.code ?? 'tool_error', message: e.message, step: e.step ?? null };
    if (e.candidates) record.error.candidates = e.candidates;
  }

  // One final observation for the model; reuse the last snapshot if it is current.
  try {
    if (!snap) await read();
    record.final = { foreground: await t.foreground(), ...summarize(snap, plan.summary_limit ?? 40) };
  } catch (e) {
    record.final = { error: e.message };
    if (record.status === 'ok') {
      record.status = 'failed';
      record.error = { code: 'final_observation_failed', message: e.message, step: null };
    }
  }
  record.ax_ms = Math.round(record.ax_ms);
  record.total_ms = Math.round(t.now() - started);
  return record;

  async function act(s) {
    switch (s.kind) {
      case 'tap': {
        let nx, ny;
        if (s.tap.x != null && s.tap.y != null && !hasTextKey(s.tap)) {
          const sc = (await fresh()).screen;
          nx = (s.tap.x - sc.x) / sc.width; ny = (s.tap.y - sc.y) / sc.height;
        } else {
          // Locate, then re-read until the target's frame holds still: taps
          // during layout or push animations land on whatever moved underneath.
          let cur = await fresh();
          let el = findOne(cur, s.tap);
          const deadline = t.now() + (s.settle_ms ?? 3000);
          for (;;) {
            if (t.paused()) throw new StepError('paused', 'paused while locating target');
            const next = await read();
            const el2 = findOne(next, s.tap);
            const same = ['x', 'y', 'width', 'height'].every(k => Math.abs(el.frame[k] - el2.frame[k]) < 1);
            cur = next; el = el2;
            if (same) break;
            if (t.now() >= deadline) throw new StepError('unstable', `target still moving: ${el.label}`);
          }
          if (!el.enabled) throw new StepError('disabled', `target is disabled: ${el.label}`);
          if (!onScreen(el, cur.screen)) throw new StepError('offscreen', `target is off screen; scroll first: ${el.label}`);
          const f = el.frame;
          nx = (f.x + f.width / 2 - cur.screen.x) / cur.screen.width;
          ny = (f.y + f.height / 2 - cur.screen.y) / cur.screen.height;
        }
        if (!(nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1)) throw new StepError('offscreen', 'tap point outside screen');
        if (t.paused()) throw new StepError('paused', 'paused before tap was sent');
        sent = true;
        await t.tap(nx, ny);
        break;
      }
      case 'swipe': {
        const sc = (await fresh()).screen;
        const norm = p => [(p[0] - sc.x) / sc.width, (p[1] - sc.y) / sc.height];
        const pts = [norm(s.swipe.from), norm(s.swipe.to)];
        if (pts.flat().some(v => !(v >= 0 && v <= 1))) throw new StepError('offscreen', 'swipe point outside screen');
        sent = true;
        await t.swipe(norm(s.swipe.from), norm(s.swipe.to), s.swipe.ms ?? 300);
        break;
      }
      case 'type': sent = true; await t.typeText(String(s.type)); break;
      case 'key': sent = true; await t.key(String(s.key)); break;
      case 'button': sent = true; await t.button(String(s.button)); break;
      case 'wait': {
        const ok = await waitFor(s.wait, s.timeout_ms ?? 5000);
        if (!ok) throw new StepError('wait_timeout', `condition not met: ${JSON.stringify(s.wait)}`);
        return; // no action happened, snapshot stays valid
      }
      case 'assert': {
        const ok = s.assert.foreground != null
          ? (await t.foreground()) === s.assert.foreground
          : matches(await read(), s.assert);
        if (!ok) throw new StepError('assert_failed', `assertion failed: ${JSON.stringify(s.assert)}`);
        return;
      }
    }
    record.actions++;
    snap = null; // the screen may have changed
  }
}
