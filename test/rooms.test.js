import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Room, RoomStore, sanitizeObject, sanitizePatch } from '../server/rooms.js';

const author = { id: 'user1', name: '홍길동' };
const stroke = (over = {}) => ({ id: 's1', type: 'stroke', pageId: 'p1', tool: 'pen', color: '#FF0000', width: 4, points: [[1.234, 2], [3, 4]], ...over });
const text = (over = {}) => ({ id: 't1', type: 'text', pageId: 'p1', x: 10, y: 20, size: 24, color: '#00ff00', text: '안녕\n하세요', ...over });

function roomWithPage() {
  const room = new Room('room01');
  room.addDoc({ id: 'd1', name: 'a.png', status: 'converting', pages: [] });
  room.setDocPages('d1', [{ id: 'p1', url: '/files/room01/d1-1.png', w: 800, h: 600 }]);
  return room;
}

test('sanitizeObject: 정상 객체는 정규화된다', () => {
  const s = sanitizeObject(stroke());
  assert.equal(s.color, '#ff0000');
  assert.deepEqual(s.points, [[1.2, 2], [3, 4]]);
  assert.equal(s.tx, 0);
  assert.equal(sanitizeObject(text()).text, '안녕\n하세요');
});

test('sanitizeObject: 잘못된 값은 거부한다', () => {
  assert.equal(sanitizeObject(stroke({ color: 'red' })), null);
  assert.equal(sanitizeObject(stroke({ points: [] })), null);
  assert.equal(sanitizeObject(stroke({ points: [[1, NaN]] })), null);
  assert.equal(sanitizeObject(stroke({ tool: 'laser' })), null);
  assert.equal(sanitizeObject(stroke({ id: '../x' })), null);
  assert.equal(sanitizeObject(text({ text: 'x'.repeat(20000) })), null);
  assert.equal(sanitizeObject({ ...text(), type: 'script' }), null);
});

test('sanitizePatch: 타입별 허용 필드만 받는다', () => {
  assert.deepEqual(sanitizePatch('text', { x: 5, text: 'b' }), { x: 5, text: 'b' });
  assert.equal(sanitizePatch('text', { points: [] }), null);
  assert.equal(sanitizePatch('stroke', { text: 'a' }), null);
  assert.deepEqual(sanitizePatch('stroke', { tx: 3, ty: -2 }), { tx: 3, ty: -2 });
});

test('applyOps: 추가·수정·삭제와 작성자 기록', () => {
  const room = roomWithPage();
  let applied = room.applyOps([{ k: 'add', obj: stroke() }, { k: 'add', obj: text() }], author);
  assert.equal(applied.length, 2);
  assert.equal(room.objects.get('s1').author, 'user1');
  assert.equal(room.objects.get('s1').authorName, '홍길동');

  // 같은 id 재추가, 없는 페이지, 클라이언트가 보낸 작성자는 무시
  applied = room.applyOps([
    { k: 'add', obj: stroke() },
    { k: 'add', obj: stroke({ id: 's2', pageId: 'nope' }) },
    { k: 'add', obj: { ...stroke({ id: 's3' }), author: 'someone-else' } },
  ], author);
  assert.equal(applied.length, 1);
  assert.equal(room.objects.get('s3').author, 'user1');

  applied = room.applyOps([{ k: 'upd', id: 't1', patch: { text: '수정' } }, { k: 'upd', id: 't1', patch: { evil: 1 } }], author);
  assert.equal(applied.length, 1);
  assert.equal(room.objects.get('t1').text, '수정');

  applied = room.applyOps([{ k: 'del', id: 's1' }, { k: 'del', id: 's1' }], author);
  assert.equal(applied.length, 1);
  assert.equal(room.objects.has('s1'), false);
});

test('removeDoc: 문서와 그 위 필기, 함께 보기 페이지를 정리한다', () => {
  const room = roomWithPage();
  room.addDoc({ id: 'd2', name: 'b.pdf', status: 'converting', pages: [] });
  room.setDocPages('d2', [{ id: 'q1', url: '/x', w: 1, h: 1 }]);
  room.applyOps([{ k: 'add', obj: stroke() }, { k: 'add', obj: stroke({ id: 's2', pageId: 'q1' }) }], author);
  room.setView('p1');
  room.removeDoc('d1');
  assert.deepEqual([...room.objects.keys()], ['s2']);
  assert.equal(room.view, 'q1');
  assert.equal(room.setView('p1'), false);
});

test('RoomStore: 저장 후 다시 불러오고, 변환 중이던 문서는 실패로 표시한다', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-test-'));
  try {
    const store = new RoomStore(dir);
    const room = await store.get('roomAB12');
    room.addDoc({ id: 'd1', name: 'a.png', status: 'converting', pages: [] });
    room.addDoc({ id: 'd2', name: 'b.png', status: 'converting', pages: [] });
    room.setDocPages('d2', [{ id: 'p1', url: '/x', w: 10, h: 10 }]);
    room.applyOps([{ k: 'add', obj: stroke() }], author);
    await store.unload('roomAB12');

    const again = await new RoomStore(dir).get('roomAB12');
    assert.equal(again.docs[0].status, 'error');
    assert.equal(again.docs[1].status, 'ready');
    assert.equal(again.objects.get('s1').color, '#ff0000');
    await assert.rejects(store.get('../etc'));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
