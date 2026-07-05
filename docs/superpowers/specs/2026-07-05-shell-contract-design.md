# Common App Framework — Shell + Contract Design Spec

**Date:** 2026-07-05
**Status:** Approved design (Phase 1 of 3)
**Scope:** The Shell (launcher) + the Contract (app plugin rulebook). The Store is built as the
reference app that validates the Contract. The GitHub-driven store *features* beyond this reference
implementation are a future phase.

---

## 1. Problem & Goal

Rebuilding a frontend for every personal project is wasteful. The goal is a single **launcher/shell**
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
                          │  • Serves web UI + generic renderer   │
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
  "description": "Browse and install apps from GitHub",
  "version": "0.1.0",
  "install": "npm install",
  "start": "node main.js",
  "port": "$PORT",
  "healthCheck": "/health"
}
```

Field semantics:
- `id` — unique, stable, URL-safe. Used in proxy paths (`/apps/<id>/*`) and as the registry key.
- `name`, `icon`, `description`, `version` — display metadata for the tab and Store listing.
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
- `GET /ui` → the app's declarative UI JSON for its default screen (see §4). This is what the Shell
  requests to render the tab.
- Action endpoints — arbitrary app-defined routes that declarative UI actions point at (form submits,
  button clicks). They return either a new declarative UI JSON screen or a result the renderer can
  apply.

### 3.4 Shell-side Contract endpoints the app may call

- `POST /shell/tabs` — register a newly installed app as a tab. Body: the installed app's `id` and
  local path (the Shell reads its manifest from there). The Shell spawns it, health-checks it, and
  adds a tab. Callable by **any** app — the Store is not privileged; it simply happens to be the app
  that uses this.
- `GET /shell/apps` — list currently installed/registered apps (so the Store can show installed
  state without keeping its own database).

## 4. UI Generation (Hybrid)

**Default — declarative JSON.** An app's `/ui` (and action endpoints) return a JSON description of a
screen built from a fixed component vocabulary the Shell's generic renderer knows how to draw. Actions
carry the app endpoint to call. Illustrative shape:

```json
{
  "title": "Installed Apps",
  "components": [
    { "type": "text", "value": "Apps available from your GitHub" },
    { "type": "table",
      "columns": ["Name", "Description", "Installed"],
      "rows": [["Notes", "A notes app", "No"]],
      "rowActions": [{ "label": "Install", "endpoint": "/install", "method": "POST" }] },
    { "type": "form",
      "endpoint": "/add-source", "method": "POST",
      "fields": [{ "name": "repo", "label": "Repo URL", "type": "text" }],
      "submitLabel": "Add" }
  ]
}
```

Initial component vocabulary (grown over time as apps need more): `text`, `table` (with row actions),
`form` (text/number/select/checkbox/file fields), `button`, `list`. The vocabulary is a versioned,
documented part of the Contract.

**Escape hatch — raw HTML.** An app may designate a route that returns raw HTML/JS instead of
declarative JSON; the Shell embeds it in an iframe for that one screen. This is the exception for
screens the vocabulary can't express (e.g. a custom chart), not the default path.

## 5. The Store (Reference App)

The Store is built using **only** the Contract — no Shell internals. Its role in this phase is to
prove the Contract is complete and ergonomic.

- **Discovery:** lists GitHub repos via the GitHub API and checks each for `app.manifest.json` at the
  root (default mode). Alternatively reads a **curated registry file** (a JSON list of repos +
  metadata) when the user prefers a curated catalog. Both modes feed the same install flow.
- **Listing:** renders repos as a declarative `table` (name, description, installed y/n) with an
  Install row action. Installed state comes from `GET /shell/apps`.
- **Install:** clones the repo into a Shell-managed apps directory, runs the manifest's `install`
  command, then calls `POST /shell/tabs` to register it.
- **No local persistence:** the Shell's registry is the source of truth for what's installed, so a
  relaunch remembers state without the Store keeping its own database.

## 6. Data Flow — Installing an App End to End

1. Browser opens the Store tab → Shell proxies to Store subprocess → Store returns declarative UI.
2. Store fetches repo list (GitHub API / registry file) and renders the table.
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
injection, health check, declarative UI render, action proxying, and tab registration. Supporting
checks:
- Kill a running app's process → its tab shows "crashed" + Restart; other tabs stay live.
- Restart the Shell → previously installed apps reappear as tabs from the registry.
- An app using the raw-HTML escape hatch renders correctly in its iframe screen.

## 10. Locked Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Shell form | Local web app | Web widgets make generic UI generation easiest; no native packaging burden. |
| Process model | One subprocess per app | Dependency isolation; a crash is contained; matches "install requirements" literally. |
| Shell language | Node.js/TypeScript | Strong async I/O for supervising/streaming many subprocesses; shared JS for the renderer. |
| App language | Language-agnostic | Manifest declares explicit install/start commands; Shell needs no per-language knowledge. |
| UI generation | Hybrid (declarative + raw-HTML escape hatch) | Zero-frontend default, with an exit for screens the vocabulary can't express. |
| Store privileges | None | Tab registration is a normal Contract endpoint any app can call; keeps one contract tier. |
| App discovery | Manifest scan (default) + curated registry (opt-in) | Zero-maintenance default, with a curated catalog when wanted. |

## 11. Out of Scope (Future Phases)

- Auth/sandboxing/permissions between apps (all apps are currently trusted local code).
- App updates/versioning/uninstall UX beyond the basics.
- Cross-app communication or shared state beyond the Shell registry.
- Rich Store features (search, categories, ratings) beyond the reference install flow.
