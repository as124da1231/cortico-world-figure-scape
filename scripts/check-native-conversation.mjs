#!/usr/bin/env node

import assert from 'node:assert/strict';

const [address, ...pairs] = process.argv.slice(2);
assert.ok(address && pairs.length, 'Usage: node scripts/check-native-conversation.mjs <Coo loopback URL> <questionCursor:replyCursor> [...]');

const base = new URL(address);
assert.ok(['http:', 'https:'].includes(base.protocol) && ['127.0.0.1', '[::1]', 'localhost'].includes(base.hostname)
  && !base.username && !base.password, 'Use the existing local Coo instance');

const samples = pairs.map(pair => {
  assert.match(pair, /^\d+:\d+$/, 'Use questionCursor:replyCursor for each recorded pair');
  const [question, reply] = pair.split(':').map(Number);
  assert.ok(Number.isSafeInteger(question) && Number.isSafeInteger(reply) && question > 0 && reply > question, 'Invalid cursor pair');
  return { question, reply };
});
const oldest = Math.min(...samples.map(sample => sample.question));

async function eventAt(cursor) {
  const url = new URL(`/api/events?from=${cursor}&to=${cursor + 1}&archive=1`, base);
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(8000) });
  assert.ok(response.ok, `Coo event archive returned ${response.status}`);
  const { events } = await response.json();
  const event = events.find(row => row.cursor === cursor);
  assert.ok(event, `Missing archived event ${cursor}`);
  return event;
}

function readHistory() {
  const endpoint = new URL('/ws/providers/world%3Adesktop-pet/panels/chat', base);
  endpoint.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(endpoint);
  return new Promise((resolve, reject) => {
    const rows = [];
    let before = Infinity;
    let complete = false;
    const timer = setTimeout(() => finish(Error('Native chat history deadline exceeded')), 12000);
    function finish(error) {
      if (complete) return;
      complete = true;
      clearTimeout(timer);
      socket.close();
      if (error) reject(error);
      else resolve(rows);
    }
    socket.addEventListener('open', () => socket.send(JSON.stringify({ t: 'hello' })));
    socket.addEventListener('error', () => finish(Error('Native chat history socket failed')));
    socket.addEventListener('close', () => finish(Error('Native chat history socket closed before the requested page')));
    socket.addEventListener('message', event => {
      try {
        const message = JSON.parse(event.data);
        if (message.t !== 'init' && message.t !== 'older') return;
        rows.push(...message.items);
        if (message.more && Number.isSafeInteger(message.before) && message.before >= oldest) {
          assert.ok(message.before < before, 'Native chat history repeated its pagination cursor');
          before = message.before;
          socket.send(JSON.stringify({ t: 'more', before }));
        } else {
          finish();
        }
      } catch (error) {
        finish(error);
      }
    });
  });
}

const spoken = beats => beats?.map(beat => beat.text).join('');

function inspect(rows, cursor, kind, readText, expected) {
  const matches = rows.filter(row => row.cursor === cursor);
  return { count: matches.length, complete: matches[0]?.kind === kind && readText(matches[0]) === expected };
}

const archive = await Promise.all(samples.map(async ({ question, reply }) => {
  const [input, output] = await Promise.all([eventAt(question), eventAt(reply)]);
  assert.ok(input.source === 'desktop-pet' && ['desktop-pet.message', 'desktop-pet.speech'].includes(input.type) && typeof input.meta?.text === 'string' && input.meta.text,
    `Event ${question} must be an archived native Desktop Pet text or voice message`);
  assert.ok(output.source === 'desktop-pet' && output.type === 'desktop-pet.self' && output.meta?.kind === 'say' && spoken(output.meta.beats),
    `Event ${reply} must contain the archived native Desktop Pet reply`);
  return { question, reply, input: input.meta.text, output: spoken(output.meta.beats) };
}));

const native = await readHistory();
const reopened = await readHistory();
const results = archive.map(({ question, reply, input, output }) => {
  const check = rows => ({
    question: inspect(rows, question, 'user', row => row.text, input),
    reply: inspect(rows, reply, 'say', row => spoken(row.beats), output),
  });
  return { question, reply, native: check(native), reopened: check(reopened) };
});

// Only cursors and verification results leave the process.
console.log(JSON.stringify(results, null, 2));
for (const sample of results) {
  for (const view of [sample.native, sample.reopened]) {
    if ([view.question, view.reply].some(row => row.count !== 1 || !row.complete)) process.exitCode = 1;
  }
}
