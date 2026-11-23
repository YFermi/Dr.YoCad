#!/usr/bin/env bash
set -euo pipefail

# Session 5 Real-Time Collaboration Smoke Test (Node + socket.io-client)
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
  const uniqueEmail = `rt_${Date.now()}_${Math.floor(Math.random() * 10000)}@demo.local`;
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

function connectSocket(token, name) {
  return new Promise((resolve, reject) => {
    const socket = io(SOCKET_URL, {
      path: '/socket.io',
      transports: ['websocket'],
      reconnection: false,
      auth: { token, name },
    });
    const timer = setTimeout(() => {
      socket.disconnect();
      reject(new Error(`Socket connection timeout for ${name}`));
    }, 6000);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('connect_error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function waitForEvent(socket, eventName, predicate = () => true, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(eventName, handler);
      reject(new Error(`Timed out waiting for event "${eventName}"`));
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

function assertNoEvent(socket, eventName, waitMs = 300) {
  return new Promise((resolve, reject) => {
    const handler = (data) => {
      clearTimeout(timer);
      socket.off(eventName, handler);
      reject(new Error(`Unexpected "${eventName}" received: ${JSON.stringify(data)}`));
    };
    const timer = setTimeout(() => {
      socket.off(eventName, handler);
      resolve();
    }, waitMs);
    socket.on(eventName, handler);
  });
}

function emitEnvelope(socket, eventName, room, payload) {
  socket.emit(eventName, {
    room,
    payload,
    clientTs: Date.now(),
  });
}

async function main() {
  console.log(`[test-realtime] API=${API_URL} SOCKET=${SOCKET_URL}`);

  const userA = await loginOrRegister('admin@demo.local', 'Password123!', 'Admin Reviewer');
  const userB = await loginOrRegister('user@demo.local', 'Password123!', 'Design Reviewer');
  assert.notEqual(userA.user.id, userB.user.id, 'Users A and B must have distinct userIds');

  const projectsRes = await apiJson('/projects', {
    headers: { Authorization: `Bearer ${userA.token}` },
  });
  assert.equal(projectsRes.status, 200, 'GET /projects failed');
  const project = projectsRes.body.data.items[0];
  assert.ok(project?.id, 'No seeded project found');

  const filesRes = await apiJson(`/files?projectId=${encodeURIComponent(project.id)}`, {
    headers: { Authorization: `Bearer ${userA.token}` },
  });
  assert.equal(filesRes.status, 200, 'GET /files failed');
  const fileSummary = filesRes.body.data.items[0];
  assert.ok(fileSummary?.id, 'No seeded file found');

  const fileRes = await apiJson(`/files/${fileSummary.id}`, {
    headers: { Authorization: `Bearer ${userA.token}` },
  });
  assert.equal(fileRes.status, 200, 'GET /files/:id failed');
  const file = fileRes.body.data;
  const versionId = file.versions?.[0]?.id;
  assert.ok(versionId, 'File has no versionId');

  const room = `file:${file.id}`;
  let socketA = null;
  let socketB = null;
  let socketGuest = null;
  let createdAnnotationId = null;

  try {
    socketA = await connectSocket(userA.token, userA.user.name);
    socketB = await connectSocket(userB.token, userB.user.name);
    console.log(`[test-realtime] Connected socketA=${socketA.id} socketB=${socketB.id}`);

    // 1. Socket B joins first, then A joins -> B receives presence:join
    const roomStateBPromise = waitForEvent(socketB, 'room:state', (e) => e.room === room);
    emitEnvelope(socketB, 'file:join', room, { fileId: file.id });
    const roomStateB = await roomStateBPromise;
    assert.equal(roomStateB.payload.fileId, file.id);

    const presenceJoinBPromise = waitForEvent(
      socketB,
      'presence:join',
      (e) => e.room === room && e.payload?.user?.userId === userA.user.id
    );
    const roomStateAPromise = waitForEvent(socketA, 'room:state', (e) => e.room === room);
    emitEnvelope(socketA, 'file:join', room, { fileId: file.id });

    const [presenceJoinB, roomStateA] = await Promise.all([
      presenceJoinBPromise,
      roomStateAPromise,
    ]);
    assert.equal(presenceJoinB.payload.user.userId, userA.user.id);
    assert.ok(
      roomStateA.payload.activeUsers.length >= 2,
      `Expected >=2 active users in room:state, got ${roomStateA.payload.activeUsers.length}`
    );
    console.log('[test-realtime] PASS 1: file:join -> presence:join & room:state');

    // 1b. Unauthenticated socket (no JWT, no share token) cannot join the room
    socketGuest = await connectSocket(undefined, 'Anonymous Probe');
    const guestDenied = waitForEvent(socketGuest, 'file:join:error', (e) => e.fileId === file.id);
    const guestNoRoomState = assertNoEvent(socketGuest, 'room:state', 600);
    emitEnvelope(socketGuest, 'file:join', room, { fileId: file.id });
    await Promise.all([guestDenied, guestNoRoomState]);
    console.log('[test-realtime] PASS 1b: unauthenticated socket file:join rejected (no room:state)');

    // 2. REST create annotation by A (with x-socket-id) -> B receives annotation:create, A gets NO echo
    const guestNoDelta = assertNoEvent(socketGuest, 'annotation:create', 600);
    const annCreateBPromise = waitForEvent(
      socketB,
      'annotation:create',
      (e) => e.room === room && e.payload?.label === 'Realtime smoke pin'
    );
    const noEchoAPromise = assertNoEvent(socketA, 'annotation:create', 350);

    const createAnnRes = await apiJson(`/files/${file.id}/annotations`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${userA.token}`,
        'x-socket-id': socketA.id,
      },
      body: JSON.stringify({
        versionId,
        type: 'PIN',
        label: 'Realtime smoke pin',
        payload: {
          anchor: {
            kind: '3d',
            position: [10, 20, 30],
            cameraPose: {
              position: [100, 100, 100],
              target: [0, 0, 0],
              zoom: 1,
            },
          },
        },
      }),
    });
    assert.equal(createAnnRes.status, 201, `Create annotation failed: ${JSON.stringify(createAnnRes.body)}`);
    createdAnnotationId = createAnnRes.body.data.id;

    const [annEventB] = await Promise.all([annCreateBPromise, noEchoAPromise, guestNoDelta]);
    assert.equal(annEventB.payload.id, createdAnnotationId);
    assert.equal(annEventB.payload.label, 'Realtime smoke pin');
    console.log('[test-realtime] PASS 2: REST annotation -> socket broadcast to B (no echo to A)');

    // 3. Camera sync gated by follow mode + immediate cached pose + mutual follow rejection
    const noCamBeforeFollow = assertNoEvent(socketB, 'camera:sync', 300);
    const pose1 = { position: [50, 60, 70], target: [1, 2, 3], zoom: 1.25 };
    emitEnvelope(socketA, 'camera:sync', room, pose1);
    await noCamBeforeFollow;

    const initialPoseOnFollow = waitForEvent(
      socketB,
      'camera:sync',
      (e) => e.room === room && e.payload?.zoom === 1.25
    );
    emitEnvelope(socketB, 'follow:start', room, { leaderUserId: userA.user.id });
    const receivedCached = await initialPoseOnFollow;
    assert.deepEqual(receivedCached.payload.position, pose1.position);

    const nextPosePromise = waitForEvent(
      socketB,
      'camera:sync',
      (e) => e.room === room && e.payload?.zoom === 1.75
    );
    const pose2 = { position: [80, 90, 100], target: [4, 5, 6], zoom: 1.75 };
    emitEnvelope(socketA, 'camera:sync', room, pose2);
    const receivedPose2 = await nextPosePromise;
    assert.deepEqual(receivedPose2.payload.target, pose2.target);

    // Mutual follow rejection: A attempts to follow B while B follows A
    const mutualErrPromise = waitForEvent(
      socketA,
      'follow:error',
      (e) => e.room === room && e.payload?.code === 'MUTUAL_FOLLOW'
    );
    emitEnvelope(socketA, 'follow:start', room, { leaderUserId: userB.user.id });
    const mutualErr = await mutualErrPromise;
    assert.match(mutualErr.payload.message, /following you/i);
    console.log('[test-realtime] PASS 3: follow:start relays camera:sync & rejects mutual follow');

    // 4. follow:stop halts camera:sync delivery
    emitEnvelope(socketB, 'follow:stop', room, { leaderUserId: userA.user.id });
    await new Promise((r) => setTimeout(r, 80));

    const noCamAfterStop = assertNoEvent(socketB, 'camera:sync', 300);
    emitEnvelope(socketA, 'camera:sync', room, {
      position: [120, 130, 140],
      target: [0, 0, 0],
      zoom: 2,
    });
    await noCamAfterStop;
    console.log('[test-realtime] PASS 4: follow:stop halts camera:sync relay');

    // 5. Rate limit: 100 cursor:move events in < 100ms triggers rate_limit:error or disconnect
    const rateLimitPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Expected rate_limit:error or disconnect during cursor flood'));
      }, 3000);
      const onErr = (evt) => {
        if (evt?.payload?.code === 'RATE_LIMITED') {
          clearTimeout(timer);
          socketA.off('rate_limit:error', onErr);
          socketA.off('disconnect', onDisc);
          resolve('rate_limit:error');
        }
      };
      const onDisc = () => {
        clearTimeout(timer);
        socketA.off('rate_limit:error', onErr);
        socketA.off('disconnect', onDisc);
        resolve('disconnect');
      };
      socketA.on('rate_limit:error', onErr);
      socketA.once('disconnect', onDisc);
    });

    for (let i = 0; i < 100; i += 1) {
      emitEnvelope(socketA, 'cursor:move', room, { x: i, y: i * 0.5, z: 0 });
    }
    const rateLimitOutcome = await rateLimitPromise;
    console.log(`[test-realtime] PASS 5: cursor flood throttled (${rateLimitOutcome})`);

    // 6. HTTP presence ping fallback & project activity feed
    const pingRes = await apiJson(`/files/${file.id}/presence/ping`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${userA.token}` },
    });
    assert.equal(pingRes.status, 200, `Presence ping failed: ${JSON.stringify(pingRes.body)}`);
    assert.equal(pingRes.body.data.ttlSeconds, 30);

    const activityRes = await apiJson(`/projects/${project.id}/activity`, {
      headers: { Authorization: `Bearer ${userA.token}` },
    });
    assert.equal(activityRes.status, 200, `Activity feed failed: ${JSON.stringify(activityRes.body)}`);
    assert.ok(Array.isArray(activityRes.body.data), 'Activity response must be an array');
    console.log(
      `[test-realtime] PASS 6: presence ping (30s TTL) & activity feed (${activityRes.body.data.length} items)`
    );

    console.log('[test-realtime] ALL CHECKS PASSED');
  } finally {
    if (createdAnnotationId) {
      await apiJson(`/annotations/${createdAnnotationId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${userA.token}` },
      }).catch(() => undefined);
    }
    socketA?.disconnect();
    socketB?.disconnect();
    socketGuest?.disconnect();
  }
}

main().catch((err) => {
  console.error('[test-realtime] FAILED:', err);
  process.exit(1);
});
NODE_EOF
