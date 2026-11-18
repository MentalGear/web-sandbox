// A neutral static file server on 127.0.0.1: node serve.mjs <dir> <port>
// Types by extension (html, htm, js, mjs, css, json); anything else application/octet-stream.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const [rootArg, port] = process.argv.slice(2);
const root = resolve(rootArg);
const TYPES = { '.html': 'text/html', '.htm': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

createServer(async (request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://x').pathname);
  const path = join(root, normalize(pathname));
  if (!path.startsWith(root)) return response.writeHead(403).end();
  try {
    const target = (await stat(path)).isDirectory() ? join(path, 'index.html') : path;
    response.writeHead(200, { 'content-type': TYPES[extname(target)] ?? 'application/octet-stream' });
    response.end(await readFile(target));
  } catch {
    response.writeHead(404).end('not found');
  }
}).listen(Number(port), '127.0.0.1');
