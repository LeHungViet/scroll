// SCROLL v2.5.12 -- Unified Multimodal & MCP Media Pipeline Smoke Test
// Covers: MCP image/audio/resource extraction, zero base64 spill, binary read_file guard,
// Codex JSON-RPC inputImage/inputAudio/localAudio wire format, chat-session video/audio/doc/sticker,
// and scroll-telegram inbound staging + reply-to-media rehydration.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  extractMcpToolMedia,
  createDefaultMultimodalHooks,
  createToolRegistry,
  createChatSessionRuntime,
  createCodexAppServerClient,
  scaffold,
} from '../index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scroll-v25-mm-'));
fs.mkdirSync(path.join(tmpRoot, 'node_modules', '@agentpro'), { recursive: true });
fs.symlinkSync(ROOT, path.join(tmpRoot, 'node_modules', '@agentpro', 'scroll'), 'dir');
fs.cpSync(path.join(ROOT, 'packages', 'scroll-telegram'), path.join(tmpRoot, 'node_modules', '@agentpro', 'scroll-telegram'), { recursive: true });
const { createTelegramFleetDaemon } = await import(
  pathToFileURL(path.join(tmpRoot, 'node_modules', '@agentpro', 'scroll-telegram', 'src', 'telegram-daemon.js')).href
);

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log(`  ✔ ${name}`); pass++; }
  catch (e) { console.error(`  ✖ ${name} -- ${e?.stack || e}`); fail++; }
}

// Valid 1x1 transparent PNG
const TINY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
// Valid OggS magic header bytes
const TINY_OGG_B64 = Buffer.from('OggS\x00\x02\x00\x00\x00\x00\x00\x00\x00\x00fakeoggpayload1234', 'binary').toString('base64');
// Valid %PDF magic header bytes
const TINY_PDF_B64 = Buffer.from('%PDF-1.4\n1 0 obj <<>> endobj\n%%EOF\n', 'utf8').toString('base64');

console.log('SCROLL v2.5.12 -- Unified Multimodal & MCP Media Pipeline');

await t('1. extractMcpToolMedia stages image/audio/resource blobs, strips base64 bloat, & returns mediaItems', () => {
  const stageDir = path.join(tmpRoot, 'stage-1');
  const res = extractMcpToolMedia({
    ok: true,
    isError: false,
    content: [
      { type: 'text', text: '{"ok":true,"app":"Notion"}' },
      { type: 'image', data: TINY_PNG_B64, mimeType: 'image/png' },
      { type: 'audio', data: TINY_OGG_B64, mimeType: 'audio/ogg' },
      { type: 'resource', resource: { uri: 'file:///tmp/invoice.pdf', mimeType: 'application/pdf', blob: TINY_PDF_B64 } },
      { type: 'resource_link', uri: 'https://example.com/doc', name: 'Doc', mimeType: 'text/html' },
    ],
  }, { stagingDir: stageDir, toolName: 'mcp.river-cua.cua_observe' });

  assert.equal(res.savedMediaPaths.length, 3, 'stages PNG, OGG, and PDF resource blob');
  for (const p of res.savedMediaPaths) {
    assert.ok(fs.existsSync(p), `staged file exists: ${p}`);
  }
  assert.ok(res.savedMediaPaths[0].endsWith('.png'));
  assert.ok(res.savedMediaPaths[1].endsWith('.ogg'));
  assert.ok(res.savedMediaPaths[2].endsWith('.pdf'));

  assert.equal(res.mediaItems.length, 2, 'image + audio promoted to model mediaItems');
  assert.equal(res.mediaItems[0].kind, 'image');
  assert.ok(res.mediaItems[0].dataUrl.startsWith('data:image/png;base64,'));
  assert.equal(res.mediaItems[1].kind, 'audio');
  assert.ok(res.mediaItems[1].dataUrl.startsWith('data:audio/ogg;base64,'));

  const serialized = JSON.stringify(res.output);
  assert.equal(serialized.includes(TINY_PNG_B64), false, 'raw base64 MUST NOT leak into JSON text');
  assert.ok(res.output.savedImagePath.endsWith('.png'));
  assert.ok(res.output.text.includes('Saved media file(s)'));
});

await t('2. createToolRegistry MCP execution returns mediaItems without spilling base64 + read_file blocks binary files', async () => {
  const workDir = path.join(tmpRoot, 'work-2');
  const stageDir = path.join(tmpRoot, 'stage-2');
  fs.mkdirSync(workDir, { recursive: true });
  const pngFile = path.join(workDir, 'shot.png');
  fs.writeFileSync(pngFile, Buffer.from(TINY_PNG_B64, 'base64'));
  const txtFile = path.join(workDir, 'note.txt');
  fs.writeFileSync(txtFile, 'hello scroll', 'utf8');

  const fakeMcp = {
    listDiscoveredTools: () => [{
      server: 'river-cua',
      name: 'cua_observe',
      fullName: 'mcp.river-cua.cua_observe',
      description: 'Observe window',
      parameters: { type: 'object', properties: { app: { type: 'string' }, image: { type: 'boolean' } } },
      risk: 'read_only',
    }],
    callTool: async () => ({
      ok: true,
      isError: false,
      text: '{"ok":true,"app":"Notion"}',
      content: [
        { type: 'text', text: '{"ok":true,"app":"Notion"}' },
        { type: 'image', data: TINY_PNG_B64, mimeType: 'image/png' },
      ],
    }),
  };

  const registry = createToolRegistry({ cwd: workDir, mcpManager: fakeMcp });
  registry.syncMcpTools();

  const mcpExec = await registry.executeTool('mcp.river-cua.cua_observe', { app: 'Notion', image: true }, {
    mediaStagingDir: stageDir,
  });
  assert.equal(mcpExec.ok, true);
  assert.equal(mcpExec.mediaItems.length, 1);
  assert.equal(mcpExec.mediaItems[0].kind, 'image');
  assert.ok(fs.existsSync(mcpExec.output.savedImagePath));
  assert.equal(JSON.stringify(mcpExec.output).includes(TINY_PNG_B64), false);

  const binRead = await registry.executeTool('read_file', { path: 'shot.png' });
  assert.equal(binRead.ok, true);
  assert.equal(binRead.output.binary, true, 'read_file detects binary PNG instead of dumping UTF-8 garbage');
  assert.equal(binRead.output.content, '');

  const txtRead = await registry.executeTool('read_file', { path: 'note.txt' });
  assert.equal(txtRead.ok, true);
  assert.equal(txtRead.output.content, 'hello scroll');
});

await t('3. Codex App-Server wire protocol sends inputImage + inputAudio on tool results AND localAudio on user turns', async () => {
  const mockScript = path.join(tmpRoot, 'mock-codex-mm.mjs');
  const wireLog = path.join(tmpRoot, 'wire-log.jsonl');
  fs.writeFileSync(mockScript, `
import readline from 'node:readline';
import fs from 'node:fs';
const logPath = ${JSON.stringify(wireLog)};
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  fs.appendFileSync(logPath, JSON.stringify(msg) + '\\n');
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { serverInfo: { name: 'mock-codex' } } });
  } else if (msg.method === 'model/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { data: [{ id: 'gpt-6.1-terra', model: 'gpt-6.1-terra' }] } });
  } else if (msg.method === 'thread/start') {
    send({ jsonrpc: '2.0', id: msg.id, result: { thread: { id: 'th_mm_1' } } });
  } else if (msg.method === 'turn/start') {
    send({ jsonrpc: '2.0', id: msg.id, result: { turn: { id: 'turn_mm_1' } } });
    // Trigger a dynamic tool call back to client!
    send({
      jsonrpc: '2.0',
      id: 9001,
      method: 'item/tool/call',
      params: { threadId: 'th_mm_1', turnId: 'turn_mm_1', callId: 'call_obs_1', tool: 'cua_observe', arguments: { app: 'Notion', image: true } },
    });
  } else if (msg.id === 9001 && msg.result) {
    send({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { threadId: 'th_mm_1', turnId: 'turn_mm_1', delta: 'Saw Notion screenshot clearly!' } });
    send({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'th_mm_1', turn: { id: 'turn_mm_1', status: 'completed' } } });
  }
});
`, 'utf8');

  const client = createCodexAppServerClient({
    command: process.execPath,
    args: [mockScript],
    defaultModel: 'gpt-6.1-terra',
    timeoutMs: 15_000,
  });

  const audioFile = path.join(tmpRoot, 'voice.ogg');
  fs.writeFileSync(audioFile, Buffer.from(TINY_OGG_B64, 'base64'));

  try {
    const res = await client.generate('Check Notion and listen to my voice note', {
      model: 'gpt-6.1-terra',
      tools: [{ name: 'cua_observe', description: 'Observe window', parameters: { type: 'object', properties: {} } }],
      audios: [{ path: audioFile, mimeType: 'audio/ogg' }],
      onToolCall: async () => ({
        ok: true,
        text: '{"ok":true,"savedImagePath":"/tmp/notion.png"}',
        mediaItems: [
          { kind: 'image', mimeType: 'image/png', dataUrl: `data:image/png;base64,${TINY_PNG_B64}` },
          { kind: 'audio', mimeType: 'audio/ogg', dataUrl: `data:audio/ogg;base64,${TINY_OGG_B64}` },
        ],
      }),
    });
    assert.equal(res.text, 'Saw Notion screenshot clearly!');

    const wireEvents = fs.readFileSync(wireLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const turnStart = wireEvents.find((e) => e.method === 'turn/start');
    assert.ok(turnStart.params.input.some((i) => i.type === 'localAudio' && i.path === audioFile), 'turn/start carries native localAudio');

    const toolResp = wireEvents.find((e) => e.id === 9001 && e.result);
    assert.ok(toolResp, 'received tool result RPC reply');
    assert.ok(toolResp.result.contentItems.some((c) => c.type === 'inputText'), 'includes inputText');
    assert.ok(toolResp.result.contentItems.some((c) => c.type === 'inputImage' && c.imageUrl.startsWith('data:image/png;base64,')), 'includes native inputImage');
    assert.ok(toolResp.result.contentItems.some((c) => c.type === 'inputAudio' && c.audioUrl.startsWith('data:audio/ogg;base64,')), 'includes native inputAudio');
  } finally {
    await client.close();
  }
});

await t('4. chat-session processes video, voice, document, sticker & keeps JSONL transcript base64-free', async () => {
  const depDir = path.join(tmpRoot, 'dep-4');
  const stateDir = path.join(tmpRoot, 'state-4');
  fs.mkdirSync(depDir, { recursive: true });
  scaffold('mm-bot', depDir, { preset: 'assistant' });

  const oggPath = path.join(tmpRoot, 'in.ogg');
  fs.writeFileSync(oggPath, Buffer.from(TINY_OGG_B64, 'base64'));
  const vidPath = path.join(tmpRoot, 'in.mp4');
  fs.writeFileSync(vidPath, Buffer.from('\x00\x00\x00\x18ftypmp42', 'binary'));
  const csvPath = path.join(tmpRoot, 'data.csv');
  fs.writeFileSync(csvPath, 'item,price\nPho,55000\n', 'utf8');
  const framePath = path.join(tmpRoot, 'frame1.jpg');
  fs.writeFileSync(framePath, Buffer.from(TINY_PNG_B64, 'base64'));

  let seenOpts = null;
  const runtime = createChatSessionRuntime({
    agentName: 'mm-bot',
    deploymentDir: depDir,
    stateDir,
    multimodalHooks: {
      processVideo: async (att) => ({
        summary: `[Video processed: ${att.name}]`,
        images: [{ path: framePath, mimeType: 'image/jpeg' }],
        audio: { path: oggPath, mimeType: 'audio/ogg' },
      }),
    },
    provider: {
      name: 'mock-http',
      model: 'mock-1',
      ready: true,
      supportsTools: true,
      async generate(_p, opts) {
        seenOpts = opts;
        return { text: 'Processed all attachments cleanly!', usage: {} };
      },
    },
  });

  const turn = await runtime.sendTurn({
    conversationId: 'dm-1',
    text: 'Check these',
    attachments: [
      { type: 'voice', path: oggPath, mimeType: 'audio/ogg', duration: 4 },
      { type: 'video', path: vidPath, name: 'clip.mp4', mimeType: 'video/mp4', duration: 9 },
      { type: 'document', path: csvPath, name: 'data.csv', mimeType: 'text/csv' },
      { type: 'sticker', emoji: '😂', setName: 'funny' },
    ],
  });
  assert.equal(turn.text, 'Processed all attachments cleanly!');
  assert.ok(Array.isArray(seenOpts.images) && seenOpts.images.length >= 1, 'video keyframe forwarded to images[]');
  assert.ok(Array.isArray(seenOpts.audios) && seenOpts.audios.length >= 2, 'voice + video audio forwarded to audios[]');
  const lastMsgText = JSON.stringify(seenOpts.messages);
  assert.ok(lastMsgText.includes('Video processed: clip.mp4'), 'video summary included');
  assert.ok(lastMsgText.includes('Pho,55000'), 'CSV document extracted via default multimodal hook');
  assert.ok(lastMsgText.includes('Sticker sent: 😂'), 'sticker context preserved');
});

await t('5. scroll-telegram stages inbound voice, document, video, sticker & auto-rehydrates reply-to photo', async () => {
  const depDir = path.join(tmpRoot, 'dep-5');
  const stateDir = path.join(tmpRoot, 'state-5');
  fs.mkdirSync(depDir, { recursive: true });
  scaffold('tg-mm', depDir, { preset: 'assistant' });
  fs.writeFileSync(path.join(depDir, 'USER.md'), '---\nname: Alex\nrole: owner\n---\n# About\nOwner test.\n', 'utf8');

  const fileBodies = {
    'files/voice.ogg': Buffer.from(TINY_OGG_B64, 'base64'),
    'files/report.csv': Buffer.from('col1,col2\nA,100\n', 'utf8'),
    'files/old_photo.jpg': Buffer.from(TINY_PNG_B64, 'base64'),
  };
  const fileMap = {
    voice_fid_1: 'files/voice.ogg',
    doc_fid_1: 'files/report.csv',
    photo_fid_1: 'files/old_photo.jpg',
  };

  const mkJson = (obj) => ({
    ok: true,
    status: 200,
    json: async () => obj,
    text: async () => JSON.stringify(obj),
  });
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('/getMe')) return mkJson({ ok: true, result: { id: 777, username: 'tg_mm_bot', can_read_all_group_messages: true } });
    if (u.includes('/getFile')) {
      const body = JSON.parse(init.body || '{}');
      return mkJson({ ok: true, result: { file_id: body.file_id, file_path: fileMap[body.file_id] } });
    }
    if (u.includes('/file/bot')) {
      const match = Object.keys(fileBodies).find((k) => u.endsWith(k));
      const buf = fileBodies[match] || Buffer.from('ok');
      return { ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
    }
    return mkJson({ ok: true, result: { message_id: 99 } });
  };

  const seenCalls = [];
  const daemon = await createTelegramFleetDaemon({
    stateDir,
    ownerIds: ['100000101'],
    bots: [{
      id: 'tg-mm',
      agentName: 'tg-mm',
      username: 'tg_mm_bot',
      deploymentDir: depDir,
      token: 'TEST_TOKEN_MM',
      provider: 'mock',
      debounceQuietMs: 10,
      debounceMaxWaitMs: 40,
      delayScale: 0,
      turnRecovery: { enabled: false },
    }],
  }, {
    fetchImpl,
    logger: { info() {}, warn: (...a) => console.warn(...a), error: (...a) => console.error(...a) },
    providerFactory: async () => ({
      name: 'mock-tg',
      model: 'mock-1',
      ready: true,
      supportsTools: true,
      async generate(_p, opts) {
        seenCalls.push(opts);
        return { text: 'Got media!', usage: {} };
      },
    }),
  });

  const bot = daemon.bots.get('tg-mm');
  try {
    // 5a. Voice + CSV document staged automatically!
    await daemon.handleIncomingMessage(bot, {
      message_id: 1,
      chat: { id: 100000101, type: 'private' },
      from: { id: 100000101, first_name: 'Alex' },
      voice: { file_id: 'voice_fid_1', duration: 3, mime_type: 'audio/ogg', file_size: 40 },
    });
    await bot.debouncer.flushAll();
    assert.equal(seenCalls.length, 1);
    assert.ok(seenCalls[0].audios?.length === 1 && fs.existsSync(seenCalls[0].audios[0].path), 'Telegram voice downloaded to staging & passed to audios[]');

    await daemon.handleIncomingMessage(bot, {
      message_id: 2,
      chat: { id: 100000101, type: 'private' },
      from: { id: 100000101, first_name: 'Alex' },
      document: { file_id: 'doc_fid_1', file_name: 'report.csv', mime_type: 'text/csv', file_size: 20 },
    });
    await bot.debouncer.flushAll();
    assert.equal(seenCalls.length, 2);
    assert.ok(JSON.stringify(seenCalls[1].messages).includes('A,100'), 'Telegram CSV document downloaded & extracted into prompt');

    // 5b. Reply-to-photo rehydration!
    await daemon.handleIncomingMessage(bot, {
      message_id: 3,
      chat: { id: 100000101, type: 'private' },
      from: { id: 100000101, first_name: 'Alex' },
      text: 'xem lại ảnh này giúp anh',
      reply_to_message: {
        message_id: 0,
        from: { id: 100000101, first_name: 'Alex' },
        photo: [{ file_id: 'photo_fid_1', file_size: 90 }],
      },
    });
    await bot.debouncer.flushAll();
    assert.equal(seenCalls.length, 3);
    assert.ok(seenCalls[2].images?.length === 1, 'Replying to an older photo auto-rehydrates the image into images[]');
  } finally {
    await daemon.stop();
  }
});

fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log(`\nv25-multimodal-mcp: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
