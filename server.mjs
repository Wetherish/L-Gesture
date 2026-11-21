import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('./public/', import.meta.url));
const data = process.env.DATA_DIR || fileURLToPath(new URL('./.data/', import.meta.url));
const boardFile = join(data, 'board.json');
const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/camera.js', ['camera.js', 'text/javascript; charset=utf-8']],
  ['/crop.js', ['crop.js', 'text/javascript; charset=utf-8']],
  ['/hand-tracking.js', ['hand-tracking.js', 'text/javascript; charset=utf-8']],
  ['/gestures.js', ['gestures.js', 'text/javascript; charset=utf-8']],
  ['/keyboard.js', ['keyboard.js', 'text/javascript; charset=utf-8']],
]);
const photoNames = new Map([
  ['notes.jpg', 'Notes'], ['camera.jpg', 'Camera'], ['plant.jpg', 'Plant'],
]);
const legacyPhotoNames = new Map([
  ['notes.jpg', 'Notatki'], ['camera.jpg', 'Aparat'], ['plant.jpg', 'Roślina'],
]);
const samples = readdirSync(join(root, 'photos')).filter(name => photoNames.has(name)).map(name => ({
  id: name.split('.')[0], title: photoNames.get(name), image: '/photos/' + name,
}));
for (const sample of samples) staticFiles.set(sample.image, [sample.image.slice(1), 'image/jpeg']);

mkdirSync(data, { recursive: true });
let pins = [];
try {
  pins = JSON.parse(readFileSync(boardFile, 'utf8')).map(pin => {
    if (pin.source === 'camera' && pin.title === 'Kadr z kamery') {
      return { ...pin, title: 'Camera snapshot' };
    }
    const sample = samples.find(item => item.image === pin.image);
    if (pin.source === 'sample' && sample && pin.title === legacyPhotoNames.get(sample.image.slice('/photos/'.length))) {
      return { ...pin, title: sample.title };
    }
    return pin;
  });
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

function save(next) {
  writeFileSync(boardFile + '.tmp', JSON.stringify(next));
  renameSync(boardFile + '.tmp', boardFile);
  pins = next;
}

function reply(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
    throw Object.assign(new Error('Send the request with Content-Type: application/json.'), { status: 415 });
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    length += chunk.length;
    if (length > 2_000_000) {
      req.resume();
      throw Object.assign(new Error('The photo is too large.'), { status: 413 });
    }
    chunks.push(chunk);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    throw Object.assign(new Error('Invalid JSON.'), { status: 400 });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw Object.assign(new Error('Expected a JSON object.'), { status: 400 });
  }
  return body;
}

function validPosition({ x, y }) {
  return [x, y].every(value => Number.isFinite(value) && value >= 0 && value <= 1);
}

function validSize(size) {
  return size === undefined || (Number.isFinite(size) && size > 0 && size <= 1);
}

const server = createServer(async (req, res) => {
  const path = req.url?.split('?')[0];
  const method = req.method;
  try {
    const file = staticFiles.get(path);
    if (method === 'GET' && file) {
      const bytes = readFileSync(join(root, file[0]));
      res.writeHead(200, { 'Content-Type': file[1], 'X-Content-Type-Options': 'nosniff' });
      return res.end(bytes);
    }
    if (method === 'GET' && path === '/api/samples') return reply(res, 200, samples);
    if (method === 'GET' && path === '/api/pins') return reply(res, 200, pins);
    if (method === 'POST' && path === '/api/pins') {
      const body = await readBody(req);
      const sample = samples.find(item => item.id === body.sampleId);
      const image = sample?.image || body.image;
      if (!sample && (typeof image !== 'string' || !/^data:image\/jpeg;base64,[a-zA-Z0-9+/]+={0,2}$/.test(image))) {
        return reply(res, 400, { error: 'Choose a sample photo or provide a JPEG image.' });
      }
      const position = { x: body.x ?? 0.08, y: body.y ?? 0.1 };
      if (!validPosition(position)) return reply(res, 400, { error: 'Position must be between 0 and 1.' });
      if (!validSize(body.size)) return reply(res, 400, { error: 'Size must be greater than 0 and at most 1.' });
      const title = typeof body.title === 'string' ? body.title.trim().slice(0, 80) : '';
      const pin = {
        id: randomUUID(), image, title: title || sample?.title || 'Camera snapshot',
        source: sample ? 'sample' : 'camera', createdAt: new Date().toISOString(), ...position, size: body.size,
      };
      save([...pins, pin]);
      return reply(res, 201, pin);
    }
    const match = path?.match(/^\/api\/pins\/([\w-]+)$/);
    if (match && method === 'PATCH') {
      const body = await readBody(req);
      const existing = pins.find(pin => pin.id === match[1]);
      if (!existing) return reply(res, 404, { error: 'Pinned photo not found.' });
      const position = { x: body.x ?? existing.x, y: body.y ?? existing.y };
      if (!validPosition(position)) return reply(res, 400, { error: 'Position must be between 0 and 1.' });
      if (!validSize(body.size)) return reply(res, 400, { error: 'Size must be greater than 0 and at most 1.' });
      const updated = { ...existing, ...position, size: body.size ?? existing.size };
      save(pins.map(pin => pin.id === updated.id ? updated : pin));
      return reply(res, 200, updated);
    }
    if (match && method === 'DELETE') {
      if (!pins.some(pin => pin.id === match[1])) return reply(res, 404, { error: 'Pinned photo not found.' });
      save(pins.filter(pin => pin.id !== match[1]));
      res.writeHead(204);
      return res.end();
    }
    reply(res, 404, { error: 'Resource not found.' });
  } catch (error) {
    if (!error.status) console.error(error);
    if (!res.headersSent) reply(res, error.status || 500, { error: error.status ? error.message : 'Could not save changes.' });
  }
});

const port = Number(process.env.PORT || 3000);
server.listen(port, '127.0.0.1', () => console.log('L-Gesture: http://localhost:' + server.address().port));
