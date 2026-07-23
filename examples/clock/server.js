import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = process.env.PORT || 3000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const page = `<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>Clock</title>
    <style>
      body { margin: 0; height: 100vh; display: grid; place-content: center;
             background: #10141d; color: #e7ebf3; font: 16px system-ui; text-align: center; }
      #t { font-size: 64px; font-weight: 700; letter-spacing: 2px; font-variant-numeric: tabular-nums; }
      #d { color: #8a94a8; margin-top: 8px; }
    </style>
  </head>
  <body>
    <div>
      <div id="t">--:--:--</div>
      <div id="d"></div>
    </div>
    <script>
      function tick() {
        const now = new Date();
        document.getElementById('t').textContent = now.toLocaleTimeString();
        document.getElementById('d').textContent = now.toLocaleDateString(undefined,
          { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
      }
      tick(); setInterval(tick, 1000);
    </script>
  </body>
</html>`;

http.createServer((req, res) => {
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
}).listen(PORT, () => console.log(`clock listening on ${PORT}`));
