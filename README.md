# App Rail

A single **launcher** that runs each of your apps as its own background process and shows
each one as a **tab** in one browser window. Every app is just a small web server that
follows a simple **Contract** — drop in a manifest, bind a port, answer a health check —
and it shows up as a tab. A built-in **Store** installs more apps straight from GitHub.

The goal: stop rebuilding a frontend and hosting setup for every side project. Write the
backend, follow the Contract, and get a usable, tabbed home for all your apps for free.

---

## How it works

```
Browser ──► Shell (Node/Express, port 4000)
             • serves the App Rail UI (left rail + content area)
             • GET  /shell/apps            list installed apps + live status
             • POST /shell/install         clone a git URL → install → spawn → register
             • proxy /apps/<id>/* ────────► that app's subprocess (its own port)
             │ spawn + health-check + supervise
        ┌────▼─────┐  ┌──────────┐
        │  Store   │  │  Your    │   each app: its own repo, runtime, and port,
        │          │  │  app     │   iframed into a tab
        └──────────┘  └──────────┘
```

- The browser only ever talks to the **Shell**. It reverse-proxies `/apps/<id>/*` to the
  right subprocess, so there's no CORS and no port-juggling — and a crashed app only breaks
  its own tab.
- Each app is an **independent subprocess** with its own dependencies. Apps can be written
  in any language; the Shell just runs the commands the manifest declares.
- The Shell renders no app UI itself. Each app serves its own web UI, which the Shell iframes
  into a tab (**iframe-first**).

See [the design spec](docs/superpowers/specs/2026-07-05-shell-contract-design.md) for the
full rationale and decisions.

## The Contract — `app.manifest.json`

An app is anything with an `app.manifest.json` at its repo root:

```json
{
  "id": "my-app",
  "name": "My App",
  "logo": "logo.svg",
  "description": "What it does",
  "version": "0.1.0",
  "install": "npm install",
  "start": "node server.js",
  "port": "$PORT",
  "healthCheck": "/health"
}
```

**Required:** `id`, `name`, `logo`, `install`, `start`, `healthCheck`.

| Field | Meaning |
|-------|---------|
| `id` | Unique, URL-safe (`[a-z0-9-]`). Used in proxy paths and as the registry key. |
| `name` | Display name for the tab and Store. |
| `logo` | Path (relative to the app root) to a logo image the app serves; shown in the tab (falls back to a monogram). |
| `install` | Shell command run **once** at install time (e.g. `npm install`, `pip install -r requirements.txt`). |
| `start` | Shell command that launches the app's web server. |
| `healthCheck` | HTTP path the Shell polls until it returns 2xx. |
| `icon`, `description`, `version`, `port` | Optional. `port` is documentary — the Shell always assigns the real port. |

When the Shell starts an app it injects three env vars: **`PORT`** (bind this), **`APP_DATA_DIR`**
(a private folder for the app's data), and **`SHELL_URL`** (to call Shell endpoints).

## Running it

```bash
cd shell
npm install
npm start
```

Then open **http://localhost:4000**. The **Store** tab is always there.

## Adding apps

Open the Store (the diamond logo) and either:

- **Search a GitHub account** — type a username/profile URL; it lists that account's public
  repos that contain an `app.manifest.json`, each with an **Add** button.
- **Paste a repo URL** — a `github.com/you/app` URL, any `.git` URL, or a **local path** →
  it's cloned, installed, and added as a tab directly.

Installed apps persist in a registry, so they come back on the next launch. Kill an app's
process and only its tab shows "crashed" (with a Restart button) — the others stay live.

## Example apps

Each reference app now lives in its own repo, installable straight from the Store:

- **[hello-world](https://github.com/devsn198/hello-world)** — the minimal app: a manifest and a
  tiny server.
- **[clock](https://github.com/devsn198/clock)** — a live clock.
- **[manifest-maker](https://github.com/devsn198/manifest-maker)** — a form that generates an
  `app.manifest.json` for a new app, with live preview, copy, and download.

The **Store** itself is the exception: it ships in this repo at [`store/`](store/) because the
Shell seeds it on first run. It's the app that installs the others, so it can't be one of the
things you install. It follows the Contract like any other app, using only Shell endpoints.

## Retrofitting an existing app

Usually three small steps, no rewrite:

1. Read the port from `process.env.PORT` (or your language's equivalent).
2. Add a `/health` route that returns 2xx once ready.
3. Add `app.manifest.json` at the repo root with your real install/start commands and a logo.

## Project structure

```
shell/
  src/          server.js (entry), supervisor, installer, manifest, registry, ports
  public/       the App Rail UI (index.html, app.js, style.css)
  data/         runtime state (git-ignored): registry.json, apps/, app-data/
store/          the built-in Store, seeded into the rail on first run
tests/          node:test suites + fixtures/ (throwaway apps the API tests spawn)
docs/           design spec
```

## Status

Early and local-first. Out of scope for now: auth/sandboxing between apps, app updates/uninstall
UX, and non-web/native apps as tabs — see the spec's "Out of Scope" section.
