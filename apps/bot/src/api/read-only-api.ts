import http from 'node:http';

export function createReadOnlyApiServer(options: { host: string; port: number }) {
  const server = http.createServer((request, response) => {
    if (request.method !== 'GET') {
      response.writeHead(405, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'Only read-only GET endpoints are available' }));
      return;
    }

    if (request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'Not found' }));
  });
  server.listen(options.port, options.host, () => {
    console.log(`Read-only API listening at http://${options.host}:${options.port}`);
  });
  return server;
}
