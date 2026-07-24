import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = process.env.PORT || 3000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const indexHtml = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');

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
  res.end(indexHtml);
}).listen(PORT, () => console.log(`manifest-maker listening on ${PORT}`));
