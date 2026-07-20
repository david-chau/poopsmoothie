import fs from 'node:fs';
import path from 'node:path';
import { rooms } from './rooms.js';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const ROOMS_DIR = path.join(DATA_DIR, 'rooms');

fs.mkdirSync(ROOMS_DIR, { recursive: true });

function roomFile(code) {
  return path.join(ROOMS_DIR, `${code}.json`);
}

function serializeRoom(room) {
  return {
    ...room,
    players: [...room.players.values()],
    round: { ...room.round, timeoutHandle: undefined }, // not serializable, dropped
  };
}

function deserializeRoom(obj) {
  const players = new Map((obj.players || []).map((p) => [p.id, { ...p, connected: false, socketId: null }]));
  return { ...obj, players, round: { ...obj.round, timeoutHandle: null } };
}

/** gap #3: write via temp-file + rename so a crash mid-write can't corrupt the file. */
export function saveRoom(room) {
  room.lastActivity = Date.now();
  const file = roomFile(room.code);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(serializeRoom(room)));
  fs.renameSync(tmp, file);
}

export function deleteRoom(code) {
  try {
    fs.unlinkSync(roomFile(code));
  } catch {
    // already gone, fine
  }
}

/** gap #2: load every persisted room back into memory on boot. */
export function loadAllRooms() {
  const loaded = [];
  for (const name of fs.readdirSync(ROOMS_DIR)) {
    if (!name.endsWith('.json')) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(ROOMS_DIR, name), 'utf8'));
      const room = deserializeRoom(raw);
      rooms.set(room.code, room);
      loaded.push(room);
    } catch (err) {
      console.error(`skipping corrupt room file ${name}:`, err.message);
    }
  }
  return loaded;
}
