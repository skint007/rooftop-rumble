/**
 * Static file server plus WebSocket rooms for online play.
 *
 * TypeScript under src/client and src/shared is type-stripped on request, so the
 * browser loads the same modules the server runs. No build step.
 *
 *   PORT=8080 npm start
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { Room, parseClientMsg } from './room.ts';
import { ROOM_CODE_LENGTH, type ServerMsg } from '../shared/protocol.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PORT = Number(process.env.PORT ?? 8080);
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.ts': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};
const stripped = new Map<string, string>();

// Only files under public/, src/client/ and src/shared/ are served.
function resolvePath(urlPath: string): string | null {
  const clean = normalize(decodeURIComponent(urlPath)).replace(/^([/\\])+/, '');
  const rel = clean === '' ? 'index.html' : clean;
  const allowed = [`src${sep}client${sep}`, `src${sep}shared${sep}`];
  if (allowed.some((dir) => rel.startsWith(dir))) return join(ROOT, rel);
  if (rel.includes('..')) return null;
  return join(ROOT, 'public', rel);
}

const http = createServer(async (req, res) => {
  // Everything is inside the try: a malformed URL or bad %-escape must not crash the server.
  try {
    const path = resolvePath(new URL(req.url ?? '/', 'http://x').pathname);
    const type = path && MIME[extname(path)];
    if (!path || !type) return void res.writeHead(404).end('Not found');
    let body: string | Buffer;
    if (path.endsWith('.ts')) {
      body = stripped.get(path) ?? stripTypeScriptTypes(await readFile(path, 'utf8'));
      if (process.env.NODE_ENV === 'production') stripped.set(path, body);
    } else {
      body = await readFile(path);
    }
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' }).end(body);
  } catch {
    res.writeHead(404).end('Not found');
  }
});

const rooms = new Map<string, Room>();

function newCode(): string {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  for (;;) {
    let code = '';
    for (let i = 0; i < ROOM_CODE_LENGTH; i++) code += letters[Math.floor(Math.random() * letters.length)];
    if (!rooms.has(code)) return code;
  }
}

// Caps that keep one abusive client from taking the whole server down.
const MAX_CLIENTS = 256;
const MAX_ROOMS = 32;
const MAX_FAILED_JOINS = 5; // per connection, then it's closed
const MAX_BUFFERED = 1 << 20; // drop clients that stop reading instead of queueing forever
const HEARTBEAT_MS = 15_000;

function send(ws: WebSocket, msg: ServerMsg): void {
  if (ws.readyState !== ws.OPEN) return;
  if (ws.bufferedAmount > MAX_BUFFERED) return void ws.terminate();
  ws.send(JSON.stringify(msg));
}

let nextClient = 1;
const wss = new WebSocketServer({ server: http, path: '/ws', maxPayload: 4096 });
const alive = new WeakMap<WebSocket, boolean>();

// Pings every client. One that misses a pong is cut off, so a player whose
// connection silently died gets handed to a CPU instead of stalling the match.
setInterval(() => {
  for (const ws of wss.clients) {
    if (alive.get(ws) === false) {
      ws.terminate();
      continue;
    }
    alive.set(ws, false);
    ws.ping();
  }
}, HEARTBEAT_MS).unref();

wss.on('connection', (ws) => {
  if (wss.clients.size > MAX_CLIENTS) return void ws.close(1013, 'Server full');
  const clientId = `c${nextClient++}`;
  let room: Room | null = null;
  let failedJoins = 0;
  alive.set(ws, true);
  ws.on('pong', () => alive.set(ws, true));
  // Oversized or invalid frames emit 'error' (then 'close'). Unhandled, it would crash the process.
  ws.on('error', () => ws.terminate());

  ws.on('message', (data) => {
    const msg = parseClientMsg(String(data));
    if (!msg) return send(ws, { t: 'error', message: 'Bad message.' });
    if (msg.t === 'create' || msg.t === 'join') {
      if (room) return;
      if (msg.t === 'create' && rooms.size >= MAX_ROOMS) {
        return send(ws, { t: 'error', message: 'The server is full. Try again later.' });
      }
      const target = msg.t === 'create' ? new Room(newCode()) : rooms.get(msg.code.toUpperCase());
      if (!target) {
        send(ws, { t: 'error', message: 'No room with that code.' });
        if (++failedJoins >= MAX_FAILED_JOINS) ws.close(1008, 'Too many failed joins');
        return;
      }
      const err = target.join(clientId, msg.name, (m) => send(ws, m));
      if (err) return send(ws, { t: 'error', message: err });
      rooms.set(target.code, target);
      room = target;
      return;
    }
    room?.handle(clientId, msg);
  });

  ws.on('close', () => {
    if (!room) return;
    room.leave(clientId);
    if (room.empty) {
      room.dispose();
      rooms.delete(room.code);
    }
  });
});

http.listen(PORT, () => console.log(`Rooftop Rumble on http://localhost:${PORT}`));

// Node ignores SIGTERM when it runs as PID 1 in a container, so exit explicitly.
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => process.exit(0));
