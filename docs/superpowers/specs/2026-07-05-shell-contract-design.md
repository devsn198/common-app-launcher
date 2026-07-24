# App Rail — Shell + Contract Design Spec

**Date:** 2026-07-05
**Status:** Approved design (Phase 1 of 3)
**Scope:** The Shell + the Contract (app plugin rulebook). The Store is built as the
reference app that validates the Contract. The GitHub-driven store *features* beyond this reference
implementation are a future phase.

---

## 1. Problem & Goal

Rebuilding a frontend for every personal project is wasteful. The goal is a single **shell**
that hosts each of the user's apps as a tab, where each app supplies only backend logic and gets a
usable UI "for free." A **Mini Store** — itself the first tab — lets the user pull an app's repo from
GitHub, install its dependencies, and register it as a new tab, so future apps require writing backend
code only.

This is three subsystems: the **Shell**, the **Contract** apps follow, and the **Store**. This spec
covers the Shell + Contract, with the Store built as the reference app that proves the Contract works.

## 2. Architecture Overview

```
                          ┌─────────────────────────────────────┐
        Browser  ◄──────► │              SHELL (Node/TS)          │
     (single web UI)      │                                       │
                          │  • Serves App Rail UI (tab chrome)    │
                          │  • Tab bar + tab lifecycle            │
                          │  • Subprocess supervisor              │
                          │  • Proxy: /apps/<id>/* → subprocess   │
                          │  • POST /shell/tabs (registration)    │
                          │  • Persists installed-app registry    │
                          └───────┬───────────────┬───────────────┘
                                  │ spawn+proxy   │ spawn+proxy
                          ┌───────▼──────┐ ┌──────▼────────┐
                          │ Store app    │ │  App B        │   ... each: own repo,
                          │ (subprocess) │ │ (subprocess)  │       own runtime,
                          └──────────────┘ └───────────────┘       own port
```

Key properties:
- The browser talks **only** to the Shell. App subprocesses are never exposed to the browser
  directly — the Shell proxies `/apps/<id>/*` to the right subprocess. This eliminates CORS and
  port-juggling, and means a crashed app breaks only its own tab.
- Each app is an **independent subprocess** with its own dependency environment. Apps can be written
  in any language.

## 3. The Contract

The Contract is the entire agreement between the Shell and an app. An app that satisfies it gets
hosted as a tab. Nothing else about the app is the Shell's concern.

### 3.1 Manifest

Each app repo has an `app.manifest.json` at its root:

```json
{
  "id": "store",
  "name": "Mini Store",
  "icon": "🛍️",
  "logo": "logo.svg",
  "description": "Browse and install apps from GitHub",
  "version": "0.1.0",
  "install": "npm install",
  "start": "node main.js",
  "port": "$PORT",
  "healthCheck": "/health"
}
```

Required fields: `id`, `name`, `logo`, `install`, `start`, `healthCheck`. The rest are optional.

Field semantics:
- `id` — unique, stable, URL-safe. Used in proxy paths (`/apps/<id>/*`) and as the registry key.
- `logo` — path (relative to the app root) to a logo image the app serves; the Shell renders it in the
  app's rail tile via the proxy (`/apps/<id>/<logo>`), falling back to a name monogram if it fails to
  load. **Required.**
- `name`, `icon`, `description`, `version` — display metadata for the tab and Store listing (`icon` is
  an optional emoji; the tile prefers `logo`).
- `install` — shell command run **once** at install time, in the app's directory (e.g.
  `pip install -r requirements.txt`, `npm install`, `go build`). Explicitly declared, **not**
  auto-detected by the Shell — this is what makes the framework language-agnostic without the Shell
  needing per-language knowledge.
- `start` — shell command to launch the app subprocess, run in the app's directory.
- `port` — literal string `"$PORT"`; documents that the app must bind the port the Shell injects via
  the `PORT` env var. (Kept as an explicit field for clarity/forward-compat rather than being
  implicit.)
- `healthCheck` — HTTP path the Shell polls (GET) until it returns 2xx, signalling the app is ready.

### 3.2 Runtime environment injected by the Shell

When the Shell spawns an app it injects environment variables:
- `PORT` — a free port the Shell picked; the app **must** bind its HTTP server to it.
- `APP_DATA_DIR` — an absolute path to a per-app directory the Shell created for persistent app data.
- `SHELL_URL` — base URL of the Shell, so the app can call Contract endpoints (e.g. tab registration).

### 3.3 App-side HTTP API the app must expose

- `GET <healthCheck>` → 2xx once ready.
- `GET /` → the app's own web UI (HTML/JS/CSS). The Shell proxies this and embeds it in the app's tab
  as an iframe (see §4). Everything else the app serves (assets, action endpoints) is the app's own
  business — the Shell just proxies `/apps/<id>/*` through to it.

### 3.4 Shell-side Contract endpoints the app may call

- `POST /shell/tabs` — register a newly installed app as a tab. Body: the installed app's `id` and
  local path (the Shell reads its manifest from there). The Shell spawns it, health-checks it, and
  adds a tab. Callable by **any** app — the Store is not privileged; it simply happens to be the app
  that uses this.
- `GET /shell/apps` — list currently installed/registered apps (so the Store can show installed
  state without keeping its own database).

### 3.5 Shared theme (optional affordance)

> Added 2026-07-23. Design decision: one source of truth for App Rail's look.

The Shell serves its design tokens at **`GET /theme.css`**. Because apps are reverse-proxied onto the
Shell's own origin — an iframe at `/apps/<id>/` is still `localhost:4000` — an app adopts the entire
visual system with one line:

```html
<link rel="stylesheet" href="/theme.css" />
```

This is **optional**. An app that omits it is unaffected and keeps full control of its own look; the
Shell never imposes styling on app content. Apps that adopt it inherit surfaces (`--s-0`…`--s-3`),
depth primitives (`--rim`, `--under`, `--depth-rest`, `--depth-raised`), ink, status colours, the type
and spacing scales, and the motion curve.

Two rules govern the system, and they matter more than any individual value:

1. **Depth comes from light, not shadow.** On `#10141d` a dark drop shadow is invisible — there is no
   luminance left to darken. Raised surfaces get a rim highlight on top and a dark under-edge
   (`--depth-rest` / `--depth-raised`); shadows only ground an element that is already lifted.
2. **The accent signals state, never decoration.** `--accent` marks the active tab, focus, and the
   primary action in a view. Using it ornamentally is what makes an interface read as a brochure
   rather than an instrument.

*Constraint:* the path is absolute, so it resolves only when the app is running behind the Shell. An
app launched standalone (`node server.js` on its own port) will 404 that request and fall back to
browser defaults. This is deliberate — shipping fallback copies of the tokens into each app is exactly
the duplication this endpoint removes. The tokens live in `shell/public/theme.css`.

## 4. UI Generation (Iframe-first)

**Each app owns its UI.** An app serves its own web frontend at `/`; the Shell spawns the app, proxies
`/apps/<id>/*` to it, and embeds that UI in the app's tab as an iframe. The Shell renders no app UI
itself — it provides only the tab chrome (tab bar, status, crash/restart states). The Contract's UI
obligation is therefore minimal: *serve a web UI + a health check.*

Because an app's iframe is served through the Shell's own origin (`/apps/<id>/`), the app's own
`fetch('/shell/...')` calls reach the Shell directly — no CORS or cross-origin setup.

**Iframe caveat.** App assets are mounted under `/apps/<id>/`, so apps should use **relative** asset
paths (or set a `<base>`), not absolute `/`-rooted ones.

> **Design note (2026-07-21): declarative-JSON UI dropped.** An earlier draft made the *default* UI
> path a generic declarative-JSON renderer in the Shell (a versioned component vocabulary — `text`,
> `table`, `form`, …) so a backend-only app could get "a UI for free," with raw-HTML-in-an-iframe as
> an escape hatch. Since every app supplies its own UI in practice, that sole justification
> disappears and only cost remains (a Shell-owned vocabulary to version as part of the Contract, a
> renderer, an action round-trip protocol — whose own fallback was already the iframe). The escape
> hatch *is* the model. If visual consistency across apps is ever wanted, the tool is an **opt-in
> shared CSS/template kit** that apps import — not a renderer baked into the Shell — which can be
> added later with zero Contract changes.

## 5. The Store (Reference App)

The Store is built using **only** the Contract — no Shell internals. Its role in this phase is to
prove the Contract is complete and ergonomic.

- **Discovery:** lists GitHub repos via the GitHub API and checks each for `app.manifest.json` at the
  root (default mode). Alternatively reads a **curated registry file** (a JSON list of repos +
  metadata) when the user prefers a curated catalog. Both modes feed the same install flow.
- **Listing:** renders repos in its own HTML page (name, description, installed y/n) with an Install
  control per repo. Installed state comes from `GET /shell/apps`.
- **Install:** clones the repo into a Shell-managed apps directory, runs the manifest's `install`
  command, then calls `POST /shell/tabs` to register it.
- **No local persistence:** the Shell's registry is the source of truth for what's installed, so a
  relaunch remembers state without the Store keeping its own database.

## 6. Data Flow — Installing an App End to End

1. Browser opens the Store tab → Shell proxies to Store subprocess → Store returns its HTML page.
2. Store fetches repo list (GitHub API / registry file) and renders the list.
3. User clicks **Install** on a repo → browser posts the action to the Shell → Shell proxies to the
   Store's `/install`.
4. Store clones the repo locally and runs the manifest's `install` command.
5. Store calls `POST /shell/tabs` with the new app's id + path.
6. Shell spawns the new app's subprocess, injects env, polls its health check.
7. On healthy → Shell adds the tab and persists it to the registry → browser shows the new tab.

## 7. Error Handling

- **App fails health check on launch** → its tab shows a static "failed to start" state with captured
  stderr; the rest of the Shell keeps working.
- **App crashes while running** → the supervisor detects the dead process, marks the tab "crashed,"
  and offers a Restart action; other tabs and the Shell are unaffected.
- **Install command fails** (bad requirements, network) → the Store surfaces the failure inline;
  nothing is registered as a tab, and no partial tab appears.
- **Malformed manifest** → install/registration is rejected with a clear message; no tab is created.

## 8. Persistence

The Shell owns a small registry (e.g. a JSON file in the Shell's data directory) of installed apps:
`{ id, name, icon, path, version }` per app. On startup the Shell reads the registry and re-spawns +
health-checks each app, rebuilding the tab bar. Per-app data lives under each app's `APP_DATA_DIR`.

## 9. Verification

Because the Store *is* the reference app, the end-to-end acceptance test is: **use the Store to
install a trivial "hello world" app from a GitHub repo and see it appear as a working tab.** That one
flow exercises the entire Contract — manifest parsing, dependency install, subprocess spawn, env
injection, health check, UI proxying into an iframe tab, and tab registration. Supporting checks:
- Kill a running app's process → its tab shows "crashed" + Restart; other tabs stay live.
- Restart the Shell → previously installed apps reappear as tabs from the registry.
- An installed app's own web UI renders correctly in its iframe tab (relative asset paths work).

## 10. Locked Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Shell form | Local web app | Iframed app UIs, no native packaging burden. |
| Process model | One subprocess per app | Dependency isolation; a crash is contained; matches "install requirements" literally. |
| Shell language | Node.js/TypeScript | Strong async I/O for supervising/streaming many subprocesses. |
| App language | Language-agnostic | Manifest declares explicit install/start commands; Shell needs no per-language knowledge. |
| UI generation | Iframe-first (each app owns its UI) | Every app supplies its own frontend anyway; a Shell-side declarative renderer would be pure overhead (see §4 design note). |
| Store privileges | None | Tab registration is a normal Contract endpoint any app can call; keeps one contract tier. |
| App discovery | Manifest scan (default) + curated registry (opt-in) | Zero-maintenance default, with a curated catalog when wanted. |

## 11. Out of Scope (Future Phases)

- Auth/sandboxing/permissions between apps (all apps are currently trusted local code).
- App updates/versioning/uninstall UX beyond the basics.
- Cross-app communication or shared state beyond the Shell registry.
- Rich Store features (search, categories, ratings) beyond the reference install flow.
