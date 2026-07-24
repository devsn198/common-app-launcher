import http from 'node:http';

// Reads the raw body itself rather than using a parser, so the test measures
// exactly what arrived over the wire.
http
  .createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end('{"ok":true}');
    }
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ method: req.method, received: body }));
    });
  })
  .listen(process.env.PORT || 3000, () => console.log(`json-echo on ${process.env.PORT}`));
