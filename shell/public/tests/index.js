// Entry point for the in-browser suites.
//
// Run the whole thing from the App Rail page with a single call:
//   const { run } = await import('/tests/index.js?v=' + Date.now());
//   return JSON.stringify(await run());
//
// The cache-buster matters — without it the browser reuses the previous module
// and edits to the tests appear to have no effect.
import { run } from './harness.js';
import rail from './rail.js';
import store from './store.js';
import theme from './theme.js';

export async function runAll() {
  return run({ theme, rail, store });
}

export { runAll as run };
