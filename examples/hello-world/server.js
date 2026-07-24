import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The Shell injects these. An app MUST bind PORT; the others are optional.
const PORT = process.env.PORT || 3000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DATA_DIR = process.env.APP_DATA_DIR || '.';

// Demonstrate per-app persistence: count how many times we've booted.
const counterFile = path.join(APP_DATA_DIR, 'boots.json');
let boots = 0;
try {
  boots = JSON.parse(fs.readFileSync(counterFile, 'utf8')).boots ?? 0;
} catch {}
boots += 1;
try {
  fs.writeFileSync(counterFile, JSON.stringify({ boots }));
} catch {}

const page = `<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>Hello World</title>
    <link rel="stylesheet" href="/theme.css" />
    <style>
      body { font: var(--fs-lg) var(--font-ui); display: grid; place-content: center; height: 100vh;
             margin: 0; background: var(--s-0); color: var(--text); text-align: center; }
      /* Raised the same way the launcher's tiles are: rim light + ambient. */
      .card { background: var(--s-1); padding: var(--sp-6) 56px; border-radius: var(--r-lg);
              border: 1px solid var(--line);
              box-shadow: var(--depth-rest), var(--elev-ambient); }
      h1 { margin: 0 0 6px; font-size: var(--fs-xl); }
      p { color: var(--muted); margin: var(--sp-1) 0; }
      code { background: var(--s-sunken); color: var(--text); padding: 2px 6px;
             border-radius: var(--r-sm); font: var(--fs-sm) var(--font-mono); }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>👋 Hello World</h1>
      <p>This app runs as its own subprocess, iframed into a Shell tab.</p>
      <p>Boot #${boots} · port <code>${PORT}</code></p>
    </div>
  </body>
</html>`;

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end('{"ok":true}');
  }
  if (req.url === '/logo.svg') {
    res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
    return res.end(fs.readFileSync(path.join(__dirname, 'logo.svg')));
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(page);
});

server.listen(PORT, () => console.log(`hello-world listening on ${PORT}`));
