import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

// The Shell injects these. An app MUST bind PORT; the others are optional.
const PORT = process.env.PORT || 3000;
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
    <style>
      body { font: 16px system-ui; display: grid; place-content: center; height: 100vh;
             margin: 0; background: #f6f8fc; color: #1a2233; text-align: center; }
      .card { background: #fff; padding: 40px 56px; border-radius: 16px;
              box-shadow: 0 10px 40px rgba(20,40,80,.08); }
      h1 { margin: 0 0 6px; } p { color: #6b7688; margin: 4px 0; }
      code { background: #eef1f7; padding: 2px 6px; border-radius: 5px; }
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

const logoSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v7A2.5 2.5 0 0 1 17.5 15H10l-4 4v-4H6.5A2.5 2.5 0 0 1 4 12.5z" fill="#5b8cff"/><circle cx="10" cy="9" r="1.4" fill="#fff"/><circle cx="15" cy="9" r="1.4" fill="#fff"/></svg>';

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end('{"ok":true}');
  }
  if (req.url === '/logo.svg') {
    res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
    return res.end(logoSvg);
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(page);
});

server.listen(PORT, () => console.log(`hello-world listening on ${PORT}`));
