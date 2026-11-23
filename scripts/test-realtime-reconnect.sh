#!/usr/bin/env bash
set -euo pipefail

# Session 5 Reconnect Test (Node + socket.io-client)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"
exec node --input-type=module - <<'NODE_EOF'
import assert from 'node:assert/strict';
import { io } from 'socket.io-client';

const API_URL = process.env.API_URL || 'http://localhost:3000/api/v1';
const SOCKET_URL = process.env.SOCKET_URL || new URL(API_URL).origin;

async function apiJson(path, options = {}) {
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function loginOrRegister(email, password, fallbackName) {
  const login = await apiJson('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  if (login.status === 200 && login.body?.success && login.body?.data?.tokens?.accessToken) {
    return {
      token: login.body.data.tokens.accessToken,
      user: login.body.data.user,
    };
  }
  const uniqueEmail = `rtr_${Date.now()}_${Math.floor(Math.random() * 10000)}@demo.local`;
  const reg = await apiJson('/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      email: uniqueEmail,
      password,
      name: fallbackName,
    }),
  });
  assert.equal(reg.status, 201, `Failed to register fallback user: ${JSON.stringify(reg.body)}`);
  return {
    token: reg.body.data.tokens.accessToken,
    user: reg.body.data.user,
  };
}

function waitForEvent(socket, eventName, predicate = () => true, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(eventName, handler);
      reject(new Error(`Timed out waiting for "${eventName}"`));
    }, timeoutMs);

    const handler = (data) => {
      if (predicate(data)) {
        clearTimeout(timer);
        socket.off(eventName, handler);
        resolve(data);
      }
    };
    socket.on(eventName, handler);
  });
}

function createAutoRejoinSocket(token, name, room, fileId) {
  const socket = io(SOCKET_URL, {
    path: '/socket.io',
    transports: ['websocket'],
    reconnection: false,
    auth: { token, name },
  });

  // Mirror apps/web/src/lib/realtime.ts auto-rejoin on connect
  socket.on('connect', () => {
    socket.emit('file:join', {
      room,
      payload: { fileId },
      clientTs: Date.now(),
    });
  });

  return socket;
}

async function main() {
  console.log(`[test-realtime-reconnect] API=${API_URL} SOCKET=${SOCKET_URL}`);

  const userA = await loginOrRegister('admin@demo.local', 'Password123!', 'Admin Reconnect');
  const userB = await loginOrRegister('user@demo.local', 'Password123!', 'Peer Reconnect');

  const projectsRes = await apiJson('/projects', {
    headers: { Authorization: `Bearer ${userA.token}` },
  });
  assert.equal(projectsRes.status, 200);
  const project = projectsRes.body.data.items[0];
  assert.ok(project?.id);

  const filesRes = await apiJson(`/files?projectId=${encodeURIComponent(project.id)}`, {
    headers: { Authorization: `Bearer ${userA.token}` },
  });
  assert.equal(filesRes.status, 200);
  const files = filesRes.body.data.items;
  assert.ok(files.length > 0 && files[0]?.id);

  // Pick a file where userA is not already connected (e.g. an open preview browser tab)
  let file = files[0];
  let room = `file:${file.id}`;
  let socketB = createAutoRejoinSocket(userB.token, userB.user.name, room, file.id);
  let socketA = null;

  try {
    let stateB = await waitForEvent(socketB, 'room:state', (e) => e.room === room);
    if (stateB.payload.activeUsers.some((u) => u.userId === userA.user.id) && files.length > 1) {
      socketB.disconnect();
      file = files.find((f) => f.id !== file.id) || files[1];
      room = `file:${file.id}`;
      socketB = createAutoRejoinSocket(userB.token, userB.user.name, room, file.id);
      stateB = await waitForEvent(socketB, 'room:state', (e) => e.room === room);
    }

    socketA = createAutoRejoinSocket(userA.token, userA.user.name, room, file.id);
    const initialStateA = await waitForEvent(socketA, 'room:state', (e) => e.room === room);
    assert.ok(
      initialStateA.payload.activeUsers.some((u) => u.userId === userB.user.id),
      'Initial RoomState for A should include B'
    );
    console.log('[test-realtime-reconnect] PASS 1: Both A and B joined room');

    // Disconnect A while B stays connected -> B receives presence:leave for A
    const leavePromiseB = waitForEvent(
      socketB,
      'presence:leave',
      (e) => e.room === room && e.payload?.userId === userA.user.id
    );
    socketA.disconnect();
    await leavePromiseB;
    console.log('[test-realtime-reconnect] PASS 2: B observed presence:leave when A disconnected');

    // Reconnect A -> A automatically rejoins and receives fresh RoomState with B present
    const rejoinStateAPromise = waitForEvent(socketA, 'room:state', (e) => e.room === room);
    const rejoinPresenceBPromise = waitForEvent(
      socketB,
      'presence:join',
      (e) => e.room === room && e.payload?.user?.userId === userA.user.id
    );
    socketA.connect();

    const [rejoinStateA] = await Promise.all([
      rejoinStateAPromise,
      rejoinPresenceBPromise,
    ]);

    const userIds = rejoinStateA.payload.activeUsers.map((u) => u.userId);
    assert.ok(userIds.includes(userA.user.id), 'Rejoined RoomState missing A');
    assert.ok(userIds.includes(userB.user.id), 'Rejoined RoomState missing B');
    console.log('[test-realtime-reconnect] PASS 3: A reconnected, rejoined, and received fresh RoomState with B');
    console.log('[test-realtime-reconnect] ALL CHECKS PASSED');
  } finally {
    socketA?.disconnect();
    socketB?.disconnect();
  }
}

main().catch((err) => {
  console.error('[test-realtime-reconnect] FAILED:', err);
  process.exit(1);
});
NODE_EOF
