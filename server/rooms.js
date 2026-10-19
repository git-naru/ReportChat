import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const ROOM_ID_RE = /^[A-Za-z0-9_-]{6,40}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

// 페이지 좌표계: 가로 1000, 세로는 페이지 비율에 따름
export const PAGE_WIDTH = 1000;
export const LIMITS = { points: 20000, text: 10000, name: 40, objects: 100000 };

export function newId(bytes = 9) {
  return crypto.randomBytes(bytes).toString('base64url');
}

const num = (v, min, max) => (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : undefined);
const color = (v) => (typeof v === 'string' && COLOR_RE.test(v) ? v.toLowerCase() : undefined);

export function cleanName(v) {
  return typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, '').trim().slice(0, LIMITS.name) : '';
}
export const cleanColor = color;
export const isId = (v) => typeof v === 'string' && ID_RE.test(v);

const COORD = 1e5;

/** 필드별 검증기. undefined를 돌려주면 허용하지 않는 값이다. */
const FIELDS = {
  stroke: {
    color,
    width: (v) => num(v, 0.2, 200),
    tool: (v) => (v === 'pen' || v === 'highlighter' ? v : undefined),
    tx: (v) => num(v, -COORD, COORD),
    ty: (v) => num(v, -COORD, COORD),
  },
  text: {
    color,
    x: (v) => num(v, -COORD, COORD),
    y: (v) => num(v, -COORD, COORD),
    size: (v) => num(v, 4, 400),
    text: (v) => (typeof v === 'string' && v.length <= LIMITS.text ? v : undefined),
  },
};

function cleanPoints(v) {
  if (!Array.isArray(v) || v.length === 0 || v.length > LIMITS.points) return undefined;
  const out = [];
  for (const p of v) {
    if (!Array.isArray(p) || num(p[0], -COORD, COORD) === undefined || num(p[1], -COORD, COORD) === undefined) return undefined;
    out.push([Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10]);
  }
  return out;
}

/** 클라이언트가 보낸 객체를 검증해 저장 가능한 형태로 만든다. 잘못되면 null. */
export function sanitizeObject(o) {
  if (!o || typeof o !== 'object' || !isId(o.id) || !isId(o.pageId)) return null;
  const fields = FIELDS[o.type];
  if (!fields) return null;
  const out = { id: o.id, type: o.type, pageId: o.pageId };
  if (o.type === 'stroke') {
    out.points = cleanPoints(o.points);
    if (!out.points) return null;
    out.tx = 0;
    out.ty = 0;
  }
  for (const [key, check] of Object.entries(fields)) {
    if (o[key] === undefined && (key === 'tx' || key === 'ty')) continue;
    const v = check(o[key]);
    if (v === undefined) return null;
    out[key] = v;
  }
  return out;
}

export function sanitizePatch(type, patch) {
  const fields = FIELDS[type];
  if (!fields || !patch || typeof patch !== 'object') return null;
  const out = {};
  for (const [key, value] of Object.entries(patch)) {
    const check = fields[key];
    const v = check && check(value);
    if (v === undefined) return null;
    out[key] = v;
  }
  return Object.keys(out).length ? out : null;
}

export class Room {
  constructor(id, data = {}) {
    this.id = id;
    this.createdAt = data.createdAt || new Date().toISOString();
    this.docs = Array.isArray(data.docs) ? data.docs : [];
    this.objects = new Map((data.objects || []).map((o) => [o.id, o]));
    this.view = data.view || null; // 함께 보는 페이지 id
    this.pageIds = new Set();
    for (const doc of this.docs) {
      // 변환 도중 서버가 꺼졌던 문서는 실패로 표시한다
      if (doc.status === 'converting') Object.assign(doc, { status: 'error', error: '서버가 재시작되어 변환이 중단되었습니다. 다시 올려 주세요.' });
      for (const p of doc.pages) this.pageIds.add(p.id);
    }
  }

  addDoc(doc) {
    this.docs.push(doc);
  }

  setDocPages(docId, pages) {
    const doc = this.docs.find((d) => d.id === docId);
    if (!doc) return null;
    doc.pages = pages;
    doc.status = 'ready';
    for (const p of pages) this.pageIds.add(p.id);
    return doc;
  }

  failDoc(docId, message) {
    const doc = this.docs.find((d) => d.id === docId);
    if (doc) Object.assign(doc, { status: 'error', error: message });
    return doc;
  }

  /** 문서와 그 위의 필기를 지운다. 지워진 문서를 돌려준다. */
  removeDoc(docId) {
    const i = this.docs.findIndex((d) => d.id === docId);
    if (i < 0) return null;
    const [doc] = this.docs.splice(i, 1);
    const pages = new Set(doc.pages.map((p) => p.id));
    for (const id of pages) this.pageIds.delete(id);
    for (const [id, o] of this.objects) if (pages.has(o.pageId)) this.objects.delete(id);
    if (pages.has(this.view)) this.view = this.docs.find((d) => d.pages.length)?.pages[0].id || null;
    return doc;
  }

  setView(pageId) {
    if (!this.pageIds.has(pageId)) return false;
    this.view = pageId;
    return true;
  }

  /**
   * 편집 연산을 적용하고, 실제로 반영된 연산만 정규화해서 돌려준다.
   * 연산: {k:'add', obj} | {k:'upd', id, patch} | {k:'del', id}
   */
  applyOps(ops, author) {
    if (!Array.isArray(ops)) return [];
    const applied = [];
    for (const op of ops.slice(0, 5000)) {
      if (!op || typeof op !== 'object') continue;
      if (op.k === 'add') {
        const obj = sanitizeObject(op.obj);
        if (!obj || this.objects.has(obj.id) || !this.pageIds.has(obj.pageId) || this.objects.size >= LIMITS.objects) continue;
        obj.author = author.id;
        obj.authorName = author.name;
        this.objects.set(obj.id, obj);
        applied.push({ k: 'add', obj });
      } else if (op.k === 'upd') {
        const obj = this.objects.get(op.id);
        const patch = obj && sanitizePatch(obj.type, op.patch);
        if (!patch) continue;
        Object.assign(obj, patch);
        applied.push({ k: 'upd', id: obj.id, patch });
      } else if (op.k === 'del') {
        if (this.objects.delete(op.id)) applied.push({ k: 'del', id: op.id });
      }
    }
    return applied;
  }

  toJSON() {
    return { id: this.id, createdAt: this.createdAt, docs: this.docs, objects: [...this.objects.values()], view: this.view };
  }
}

/** 방 상태를 메모리에 두고 디스크(DATA_DIR/rooms/<id>/room.json)에 주기적으로 저장한다 */
export class RoomStore {
  constructor(dataDir) {
    this.dir = path.join(dataDir, 'rooms');
    this.rooms = new Map();
    this.loading = new Map();
    this.timers = new Map();
  }

  roomDir(id) {
    return path.join(this.dir, id);
  }

  filesDir(id) {
    return path.join(this.dir, id, 'files');
  }

  async get(id) {
    if (!ROOM_ID_RE.test(id)) throw new Error('invalid room id');
    if (this.rooms.has(id)) return this.rooms.get(id);
    if (!this.loading.has(id)) {
      this.loading.set(id, (async () => {
        let data = {};
        try {
          data = JSON.parse(await fs.readFile(path.join(this.roomDir(id), 'room.json'), 'utf8'));
        } catch (err) {
          if (err.code !== 'ENOENT') console.error(`[room ${id}] 상태 파일을 읽지 못해 새로 시작합니다:`, err.message);
        }
        await fs.mkdir(this.filesDir(id), { recursive: true });
        const room = new Room(id, data);
        this.rooms.set(id, room);
        this.loading.delete(id);
        return room;
      })());
    }
    return this.loading.get(id);
  }

  save(room, delay = 1000) {
    if (this.timers.has(room.id)) return;
    this.timers.set(room.id, setTimeout(() => {
      this.timers.delete(room.id);
      this.write(room).catch((err) => console.error(`[room ${room.id}] 저장 실패:`, err.message));
    }, delay));
  }

  async write(room) {
    const file = path.join(this.roomDir(room.id), 'room.json');
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(room));
    await fs.rename(tmp, file);
  }

  async flush() {
    for (const [id, t] of this.timers) {
      clearTimeout(t);
      this.timers.delete(id);
      await this.write(this.rooms.get(id));
    }
  }

  /** 접속자가 없는 방을 메모리에서 내린다 */
  async unload(id) {
    const room = this.rooms.get(id);
    if (!room) return;
    if (this.timers.has(id)) {
      clearTimeout(this.timers.get(id));
      this.timers.delete(id);
    }
    await this.write(room);
    this.rooms.delete(id);
  }
}
