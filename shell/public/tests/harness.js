// Minimal assertion + runner harness for the in-browser suites.
//
// These run inside the live launcher page (the shell serves this directory), so
// they drive the real DOM the way a user does — no jsdom, no Playwright, and no
// browser download. The runner returns a compact summary: on success it is two
// numbers, which is the whole point of running the suite in one call.

export function ok(cond, msg) {
  if (!cond) throw new Error(msg || 'expected truthy');
}

export function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg ? msg + ': ' : ''}expected ${b}, got ${a}`);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Click the way a browser actually does: pointerdown → pointerup → click.
 *
 * A bare `el.click()` skips the pointer events, and the rail relies on
 * pointerdown to clear the flag that suppresses the click trailing a drag. A
 * suite that used the bare form passed on a fresh page and failed on a re-run,
 * because the previous run's last drag left that flag armed.
 */
export function realClick(el) {
  const opts = { bubbles: true, cancelable: true, pointerId: 1, button: 0, isPrimary: true };
  el.dispatchEvent(new PointerEvent('pointerdown', opts));
  el.dispatchEvent(new PointerEvent('pointerup', opts));
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

/** Poll until `fn()` is truthy, or throw. Beats sleeping a guessed duration. */
export async function until(fn, msg = 'condition', timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${msg}`);
}

/**
 * Run { suiteName: { testName: fn } } maps. Each test is isolated: a throw is
 * recorded and the run continues. Suites may expose `before`/`after` hooks,
 * which are excluded from the test list and used to save/restore state.
 */
export async function run(suites) {
  let pass = 0;
  const failures = [];

  for (const [suiteName, suite] of Object.entries(suites)) {
    const { before, after, ...tests } = suite;
    let ctx;
    try {
      ctx = before ? await before() : undefined;
    } catch (err) {
      failures.push(`${suiteName} › before: ${err.message}`);
      continue;
    }
    for (const [name, fn] of Object.entries(tests)) {
      try {
        await fn(ctx);
        pass++;
      } catch (err) {
        failures.push(`${suiteName} › ${name}: ${err.message}`);
      }
    }
    try {
      if (after) await after(ctx);
    } catch (err) {
      failures.push(`${suiteName} › after: ${err.message}`);
    }
  }

  return { pass, fail: failures.length, failures };
}
