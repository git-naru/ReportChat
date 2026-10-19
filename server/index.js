import express from 'express';
import multer from 'multer';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { ACCEPT_EXT, ConvertError, checkTools, convertToPages, kindOf } from './convert.js';
import { ROOM_ID_RE, RoomStore, cleanColor, cleanName, isId, newId, PAGE_WIDTH } from './rooms.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const MAX_FILE_MB = Number(process.env.MAX_FILE_MB || 100);
const UNLOAD_AFTER_MS = 10 * 60_000;

const store = new RoomStore(DATA_DIR);
/** roomId → Set<client>, client = {ws, user: {sid, id, name, color}} */
const clients = new Map();
/** roomId → 진행 중인 변환 수 (변환 중에는 방을 메모리에서 내리지 않는다) */
const converting = new Map();
const unloadTimers = new Map();

const app = express();
const upload = multer({
  dest: path.join(os.tmpdir(), 'reportchat-uploads'),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: 20 },
});

app.use(express.static(path.join(ROOT, 'public')));
app.get('/r/:room', (_req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));

app.get('/api/config', (_req, res) => {
  res.json({ accept: ACCEPT_EXT, maxFileMB: MAX_FILE_MB, pageWidth: PAGE_WIDTH });
});

app.post('/api/rooms', (_req, res) => {
  res.json({ id: newId(8) });
});

app.get('/files/:room/:file', (req, res) => {
  const { room, file } = req.params;
  if (!ROOM_ID_RE.test(room) || !/^[A-Za-z0-9_-]+\.[a-z]+$/.test(file)) return res.sendStatus(404);
  res.sendFile(file, { root: store.filesDir(room), maxAge: '7d', immutable: true }, (err) => {
    if (err && !res.headersSent) res.sendStatus(404);
  });
});

app.post('/api/rooms/:room/upload', upload.array('files'), async (req, res) => {
  const files = req.files || [];
  const cleanup = () => Promise.all(files.map((f) => fs.rm(f.path, { force: true })));
  try {
    const roomId = req.params.room;
    if (!ROOM_ID_RE.test(roomId)) return res.status(400).json({ error: '잘못된 방 주소입니다.' });
    if (files.length === 0) return res.status(400).json({ error: '파일을 선택해 주세요.' });
    const room = await store.get(roomId);
    const by = cleanName(req.body?.name) || '익명';
    const docs = [];

    for (const f of files) {
      // multer는 파일명을 latin1로 넘겨준다
      const name = Buffer.from(f.originalname, 'latin1').toString('utf8').slice(0, 200);
      if (!kindOf(name)) {
        docs.push({ name, error: `지원하지 않는 형식입니다 (${ACCEPT_EXT.join(', ')})` });
        await fs.rm(f.path, { force: true });
        continue;
      }
      const doc = { id: newId(), name, kind: kindOf(name), status: 'converting', pages: [], by, createdAt: new Date().toISOString() };
      room.addDoc(doc);
      broadcast(roomId, { t: 'doc', doc });
      docs.push(doc);
      convert(roomId, doc, f.path);
    }
    store.save(room);
    res.json({ docs });
  } catch (err) {
    await cleanup();
    console.error('업로드 실패:', err);
    res.status(500).json({ error: '업로드를 처리하지 못했습니다.' });
  }
});

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? `파일이 너무 큽니다 (최대 ${MAX_FILE_MB}MB).` : err.message;
    return res.status(400).json({ error: msg });
  }
  console.error(err);
  res.status(500).json({ error: '서버 오류가 발생했습니다.' });
});

async function convert(roomId, doc, srcPath) {
  converting.set(roomId, (converting.get(roomId) || 0) + 1);
  const started = Date.now();
  try {
    const pages = await convertToPages({ srcPath, name: doc.name, outDir: store.filesDir(roomId), prefix: doc.id });
    const room = await store.get(roomId);
    const updated = room.setDocPages(doc.id, pages.map((p, i) => ({
      id: `${doc.id}_${i + 1}`,
      url: `/files/${roomId}/${p.file}`,
      w: p.w,
      h: p.h,
    })));
    if (updated) {
      broadcast(roomId, { t: 'doc', doc: updated });
      // 새로 올린 문서를 모두의 화면에 띄운다
      room.setView(updated.pages[0].id);
      broadcast(roomId, { t: 'view', pageId: room.view, by: doc.by });
      store.save(room);
    }
    console.log(`[room ${roomId}] ${doc.name}: ${pages.length}쪽 변환 (${Date.now() - started}ms)`);
  } catch (err) {
    const message = err instanceof ConvertError ? err.message : '파일을 변환하지 못했습니다.';
    if (!(err instanceof ConvertError)) console.error(`[room ${roomId}] ${doc.name} 변환 실패:`, err);
    const room = await store.get(roomId);
    const failed = room.failDoc(doc.id, message);
    if (failed) broadcast(roomId, { t: 'doc', doc: failed });
    store.save(room);
  } finally {
    await fs.rm(srcPath, { force: true });
    converting.set(roomId, converting.get(roomId) - 1);
    scheduleUnload(roomId);
  }
}

// ---------------------------------------------------------------- WebSocket

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4 * 1024 * 1024 });

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
}

function broadcast(roomId, msg, except) {
  const data = JSON.stringify(msg);
  for (const c of clients.get(roomId) || []) if (c !== except) send(c.ws, data);
}

function usersOf(roomId) {
  return [...(clients.get(roomId) || [])].map((c) => c.user);
}

function scheduleUnload(roomId) {
  clearTimeout(unloadTimers.get(roomId));
  if (clients.get(roomId)?.size || converting.get(roomId)) return;
  unloadTimers.set(roomId, setTimeout(() => {
    unloadTimers.delete(roomId);
    if (clients.get(roomId)?.size || converting.get(roomId)) return;
    clients.delete(roomId);
    converting.delete(roomId);
    store.unload(roomId).catch((err) => console.error(`[room ${roomId}] 저장 실패:`, err.message));
  }, UNLOAD_AFTER_MS));
}

wss.on('connection', (ws) => {
  let client = null;
  let roomId = null;
  let room = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', async (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }

    if (msg.t === 'join') {
      if (client || !ROOM_ID_RE.test(msg.room) || !isId(msg.clientId)) return ws.close(4000, 'bad join');
      roomId = msg.room;
      room = await store.get(roomId);
      client = {
        ws,
        user: { sid: newId(6), id: msg.clientId, name: cleanName(msg.name) || '익명', color: cleanColor(msg.color) || '#2563eb' },
      };
      if (!clients.has(roomId)) clients.set(roomId, new Set());
      clients.get(roomId).add(client);
      clearTimeout(unloadTimers.get(roomId));
      send(ws, { t: 'init', you: client.user, room: room.toJSON(), users: usersOf(roomId) });
      broadcast(roomId, { t: 'users', users: usersOf(roomId) }, client);
      return;
    }
    if (!client) return;
    const { user } = client;

    switch (msg.t) {
      case 'ops': {
        const applied = room.applyOps(msg.ops, user);
        if (applied.length) {
          broadcast(roomId, { t: 'ops', ops: applied, by: user.sid }, client);
          store.save(room);
        }
        break;
      }
      case 'draft':
        // 그리는 중인 선은 저장하지 않고 다른 사람에게만 실시간으로 전달한다
        if (isId(msg.id) && isId(msg.pageId) && Array.isArray(msg.points) && msg.points.length <= 2000) {
          broadcast(roomId, { t: 'draft', by: user.sid, id: msg.id, pageId: msg.pageId, tool: msg.tool, color: cleanColor(msg.color), width: Number(msg.width) || 3, points: msg.points, reset: !!msg.reset }, client);
        }
        break;
      case 'cursor':
        if (msg.pageId === null || isId(msg.pageId)) {
          broadcast(roomId, { t: 'cursor', sid: user.sid, pageId: msg.pageId, x: Number(msg.x) || 0, y: Number(msg.y) || 0 }, client);
        }
        break;
      case 'view':
        if (room.setView(msg.pageId)) {
          broadcast(roomId, { t: 'view', pageId: msg.pageId, by: user.name }, client);
          store.save(room);
        }
        break;
      case 'me':
        user.name = cleanName(msg.name) || user.name;
        user.color = cleanColor(msg.color) || user.color;
        broadcast(roomId, { t: 'users', users: usersOf(roomId) });
        break;
      case 'delDoc': {
        const doc = room.removeDoc(msg.docId);
        if (doc) {
          broadcast(roomId, { t: 'docRemoved', docId: doc.id, view: room.view, by: user.name });
          store.save(room);
          const dir = store.filesDir(roomId);
          for (const p of doc.pages) fs.rm(path.join(dir, path.basename(p.url)), { force: true }).catch(() => {});
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    if (!client) return;
    clients.get(roomId)?.delete(client);
    broadcast(roomId, { t: 'users', users: usersOf(roomId) });
    scheduleUnload(roomId);
  });
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000);

async function shutdown() {
  clearInterval(heartbeat);
  await store.flush();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

const tools = await checkTools();
if (!tools.soffice) console.warn('⚠ LibreOffice(soffice)가 없어 PPT/Excel/Word 변환을 할 수 없습니다.');
if (!tools.pdftoppm) console.warn('⚠ poppler(pdftoppm)가 없어 PDF 및 Office 문서 변환을 할 수 없습니다.');
server.listen(PORT, () => console.log(`ReportChat: http://localhost:${PORT}`));
