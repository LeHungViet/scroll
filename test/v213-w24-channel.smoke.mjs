// SCROLL 2.13.1 -- W24 / Buzz Relay Channel Adapter Smoke Tests.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  W24_KINDS,
  W24_DEFAULT_MAX_HOPS,
  httpRelayOf,
  wsRelayOf,
  parseAuthTag,
  parseImetaTags,
  buildImetaTag,
  buildNip98Header,
  buildNip42AuthEvent,
  createW24Client,
  normalizeW24Event,
  evaluateW24Access,
  formatW24PeerUntrustedEnvelope,
  createChannelEngine,
} from '../lib/channels/index.js';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  \u2714 ${name}`);
    passed++;
  } catch (err) {
    console.error(`  \u2716 ${name}\n    ${err?.stack || err}`);
    failed++;
  }
}

const BOT_PUB = 'a'.repeat(64);
const OWNER_PUB = 'b'.repeat(64);
const PEER_PUB = 'c'.repeat(64);
const PEER_AGENT_PUB = 'd'.repeat(64);
const CHANNEL_ID = '11111111-2222-4333-8444-555555555555';
const AUTH_TAG = JSON.stringify(['auth', OWNER_PUB, '', 'f'.repeat(128)]);

function fakeFinalizeEvent(template, secretBytes) {
  const pubkey = Buffer.from(secretBytes).toString('hex').slice(0, 64).padEnd(64, 'a');
  const id = crypto.createHash('sha256')
    .update(JSON.stringify([0, pubkey, template.created_at, template.kind, template.tags, template.content]))
    .digest('hex');
  return { ...template, pubkey, id, sig: 'e'.repeat(128) };
}

console.log('SCROLL 2.13.1 -- W24 Channel Adapter');

await test('1. Relay URL normalization & NIP-OA / NIP-42 / NIP-98 builders', () => {
  assert.equal(httpRelayOf('wss://relay.w24.ai/'), 'https://relay.w24.ai');
  assert.equal(wsRelayOf('https://relay.w24.ai/'), 'wss://relay.w24.ai');
  assert.deepEqual(parseAuthTag(AUTH_TAG), ['auth', OWNER_PUB, '', 'f'.repeat(128)]);
  assert.equal(parseAuthTag('not-json'), null);

  const secret = Buffer.alloc(32, 0xaa);
  const hdr = buildNip98Header({
    finalizeEvent: fakeFinalizeEvent,
    secretBytes: secret,
    method: 'POST',
    fullUrl: 'https://relay.w24.ai/events',
    bodyBytes: Buffer.from('{"ok":1}'),
  });
  assert.ok(hdr.startsWith('Nostr '));
  const decoded = JSON.parse(Buffer.from(hdr.slice(6), 'base64').toString('utf8'));
  assert.equal(decoded.kind, W24_KINDS.NIP98_AUTH);
  assert.ok(decoded.tags.some((t) => t[0] === 'payload'));

  const nip42 = buildNip42AuthEvent({
    finalizeEvent: fakeFinalizeEvent,
    secretBytes: secret,
    authTag: AUTH_TAG,
    relayUrl: 'https://relay.w24.ai',
    challenge: 'nonce-123',
  });
  assert.equal(nip42.kind, W24_KINDS.NIP42_AUTH);
  assert.ok(nip42.tags.some((t) => t[0] === 'relay' && t[1] === 'wss://relay.w24.ai'));
  assert.ok(nip42.tags.some((t) => t[0] === 'challenge' && t[1] === 'nonce-123'));
  assert.ok(nip42.tags.some((t) => t[0] === 'auth' && t[1] === OWNER_PUB));
});

await test('2. createW24Client publishes profile, thread reply, typing kind:20002 & Blossom media upload', async () => {
  const calls = [];
  const mockFetch = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    if (url.endsWith('/upload')) {
      const sha = init.headers['X-SHA-256'];
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ url: `https://relay.w24.ai/media/${sha}.jpg`, type: 'image/jpeg', size: 4, sha256: sha }),
      };
    }
    if (url.endsWith('/events')) {
      const ev = JSON.parse(Buffer.from(init.body).toString('utf8'));
      return { ok: true, status: 200, text: async () => JSON.stringify({ event_id: ev.id }) };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify([]) };
  };

  const client = createW24Client({
    relayUrl: 'wss://relay.w24.ai',
    secretBytes: Buffer.alloc(32, 0xaa),
    pubkey: BOT_PUB,
    authTag: AUTH_TAG,
    finalizeEvent: fakeFinalizeEvent,
    fetchImpl: mockFetch,
  });

  const up = await client.uploadMedia({ data: Buffer.from([1, 2, 3, 4]), mimeType: 'image/jpeg' });
  assert.ok(up.url.startsWith('https://relay.w24.ai/media/'));
  assert.equal(calls[0].method, 'PUT');
  assert.equal(calls[0].headers['x-auth-tag'], AUTH_TAG);

  const prof = await client.publishProfile({ name: 'Jen', about: 'Assistant', picture: up.url });
  assert.equal(prof.event.kind, W24_KINDS.PROFILE);
  assert.equal(JSON.parse(prof.event.content).is_agent, true);
  assert.ok(prof.event.tags.some((t) => t[0] === 'auth'));

  const rootHex = '1'.repeat(64);
  const replyHex = '2'.repeat(64);
  const sent = await client.postMessage({
    channelId: CHANNEL_ID,
    text: 'Hello team',
    rootId: rootHex,
    replyTo: replyHex,
    mentions: [OWNER_PUB],
    hopCount: 2,
    attachments: [{ url: up.url, mimeType: 'image/jpeg', size: 4, sha256: up.sha256 }],
  });
  assert.equal(sent.event.kind, W24_KINDS.MESSAGE);
  assert.ok(sent.event.tags.some((t) => t[0] === 'h' && t[1] === CHANNEL_ID));
  assert.ok(sent.event.tags.some((t) => t[0] === 'e' && t[1] === rootHex && t[3] === 'root'));
  assert.ok(sent.event.tags.some((t) => t[0] === 'e' && t[1] === replyHex && t[3] === 'reply'));
  assert.ok(sent.event.tags.some((t) => t[0] === 'w24-hop' && t[1] === '2'));
  assert.equal(parseImetaTags(sent.event.tags).length, 1);

  const typing = await client.sendTyping({ channelId: CHANNEL_ID, rootId: rootHex });
  assert.equal(typing.event.kind, W24_KINDS.TYPING);
  assert.equal(typing.event.content, '');
  assert.ok(typing.event.tags.some((t) => t[0] === 'h' && t[1] === CHANNEL_ID));
});

await test('3. normalizeW24Event + createChannelEngine parity (DM, group mention, thread, self-ignore, imeta)', () => {
  const selfEv = { id: '3'.repeat(64), pubkey: BOT_PUB, kind: 9, created_at: 1700000000, content: 'hi', tags: [['h', CHANNEL_ID]] };
  assert.equal(normalizeW24Event(selfEv, { botPubkey: BOT_PUB }), null, 'must ignore self-authored events');

  const imeta = buildImetaTag({ url: 'https://relay.w24.ai/media/' + '9'.repeat(64) + '.png', mimeType: 'image/png', size: 1234 });
  const grpEv = {
    id: '4'.repeat(64),
    pubkey: PEER_PUB,
    kind: 9,
    created_at: 1700000010,
    content: 'Check this invoice @Jen',
    tags: [['h', CHANNEL_ID], ['p', BOT_PUB], ['e', '5'.repeat(64), '', 'root'], imeta],
  };
  const norm = normalizeW24Event(grpEv, {
    botPubkey: BOT_PUB,
    botName: 'Jen',
    ownerPubkey: OWNER_PUB,
    channelMeta: { id: CHANNEL_ID, name: 'finance', isDm: false },
    senderProfile: { display_name: 'Minh' },
  });
  assert.equal(norm.channel, 'w24');
  assert.equal(norm.isGroup, true);
  assert.equal(norm.isExplicitMention, true);
  assert.equal(norm.threadId, '5'.repeat(64));
  assert.equal(norm.senderName, 'Minh');
  assert.equal(norm.isOwner, false);
  assert.equal(norm.attachments.length, 1);
  assert.equal(norm.attachments[0].mimeType, 'image/png');

  const engine = createChannelEngine();
  const evalRes = engine.evaluateIncoming({
    botKey: 'tn1:bot1:w24',
    chatId: norm.chatId,
    chatTitle: norm.chatTitle,
    threadId: norm.threadId,
    messageId: norm.messageId,
    senderId: norm.senderId,
    senderName: norm.senderName,
    text: norm.text,
    isGroup: norm.isGroup,
    isMentioned: norm.isMentioned,
    surface: 'w24',
    policy: { groupPolicy: 'mention' },
  });
  assert.equal(evalRes.shouldReply, true);
});

await test('4. evaluateW24Access 0-token privacy gate & Agent-to-Agent hop-limit guard', () => {
  assert.equal(evaluateW24Access({ senderId: OWNER_PUB, ownerPubkey: OWNER_PUB, respondTo: 'owner-only' }).allowed, true);
  assert.equal(evaluateW24Access({ senderId: PEER_PUB, ownerPubkey: OWNER_PUB, respondTo: 'owner-only' }).allowed, false);
  assert.equal(evaluateW24Access({ senderId: PEER_PUB, ownerPubkey: OWNER_PUB, respondTo: 'allowlist', allowList: [PEER_PUB] }).allowed, true);
  assert.equal(evaluateW24Access({ senderId: PEER_PUB, ownerPubkey: OWNER_PUB, respondTo: 'allowlist', allowList: [] }).allowed, false);
  assert.equal(evaluateW24Access({ senderId: PEER_PUB, ownerPubkey: OWNER_PUB, respondTo: 'anyone' }).allowed, true);

  assert.equal(
    evaluateW24Access({ senderId: PEER_AGENT_PUB, ownerPubkey: OWNER_PUB, respondTo: 'anyone', isFromAgent: true, hopCount: W24_DEFAULT_MAX_HOPS }).reason,
    'w24_hop_limit_exceeded',
  );
  assert.equal(
    evaluateW24Access({ senderId: PEER_AGENT_PUB, ownerPubkey: OWNER_PUB, respondTo: 'anyone', isFromAgent: true, hopCount: 2 }).allowed,
    true,
  );

  const env = formatW24PeerUntrustedEnvelope({ senderName: 'QA Agent', senderId: PEER_AGENT_PUB, hopCount: 1, channelId: CHANNEL_ID, text: 'Run test' });
  assert.ok(env.includes('UNTRUSTED_PEER_DATA'));
  assert.ok(env.includes('Run test'));
});

console.log(`\nW24 Channel Adapter tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
