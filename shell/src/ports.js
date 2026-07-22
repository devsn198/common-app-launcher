import net from 'node:net';

/**
 * Ask the OS for a free TCP port by binding to port 0, reading the assigned
 * port, then releasing it. There is a small TOCTOU window between release and
 * the app binding it; acceptable for a local single-user MVP.
 * @returns {Promise<number>}
 */
export function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}
