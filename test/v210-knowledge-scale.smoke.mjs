// SCROLL 2.10 -- Scale Knowledge Retrieval, §42 Visibility Wall, Progressive Tools & Hot-Reload Smoke Test.
// Pure ASCII, zero external dependencies.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  openKnowledge,
  parseKnowledgeFrontmatter,
  resolveTurnKnowledgeAudience,
  buildAgentPack,
  createPackRegistry,
  openTenantWorkspace,
  createPrincipalProvider,
  createScrollAgentHost,
} from '../index.js';

let passed = 0;
function ok(label) {
  passed += 1;
  console.log(`  ok  ${label}`);
}

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function createFakeProvider(responder) {
  const seenSystems = [];
  return {
    name: 'fake-v210',
    model: 'fake-model',
    ready: true,
    supportsTools: true,
    seenSystems,
    async generate(prompt, opts = {}) {
      seenSystems.push(opts.system || '');
      return responder({ prompt, system: opts.system || '', messages: opts.messages || [], tools: opts.tools || [] });
    },
    async close() {},
  };
}

function makeHotelPack(rootDir) {
  const srcDir = path.join(rootDir, 'pack-src');
  writeFile(path.join(srcDir, 'agents', 'concierge', 'IDENTITY.md'), `---
name: concierge
role: Hotel operations assistant
language: en
---
You assist hotel guests and staff using verified hotel documents only.
`);
  writeFile(path.join(srcDir, 'agents', 'concierge', 'SOUL.md'), 'Be accurate, concise, and never leak restricted documents.\n');
  writeFile(path.join(srcDir, 'agents', 'concierge', 'hard-rules.md'), '- Never invent prices or policies.\n');
  writeFile(path.join(srcDir, 'knowledge', 'baseline-hours.md'), `---
title: Baseline Check-in Hours
visibility: public
---
# Check-in Policy
Standard pack check-in starts at 15:00 and check-out is at 11:00.
`);
  return srcDir;
}

console.log('SCROLL 2.10 Knowledge Scale, Visibility Gate, Progressive Tools & Hot-Reload Smoke');

// 1. Frontmatter parsing + 250-doc nested folder scale benchmark + visibility wall
{
  const tmp = mkTmp('scroll-v210-kb-');
  try {
    const kbDir = path.join(tmp, 'knowledge');

    // Folder-level inheritance metadata
    writeFile(path.join(kbDir, 'Finance', '.kb-meta.json'), JSON.stringify({ visibility: 'owner_only' }));
    writeFile(path.join(kbDir, 'SOP', '.kb-meta.json'), JSON.stringify({ visibility: 'internal' }));

    // Public guest docs
    writeFile(path.join(kbDir, 'Guest-Guide', 'rates-2026.md'), `---
title: Public Room Rates 2026
visibility: public
source_url: https://example.com/rates
---
# Deluxe Ocean Room
Deluxe Ocean Room rack rate is 220 USD per night including breakfast buffet.

# Late Checkout
Late checkout until 15:00 costs 40 USD subject to availability.
`);

    // Internal SOP inheriting visibility from SOP/.kb-meta.json
    writeFile(path.join(kbDir, 'SOP', 'FrontDesk', 'overbooking.md'), `# Overbooking Escalation
Walk guests to Partner Harbor Hotel at zero guest cost; shift manager signs voucher code WALK-99.
`);

    // Owner-only finance doc inheriting from Finance/.kb-meta.json
    writeFile(path.join(kbDir, 'Finance', 'payroll-2026.md'), `# Executive Payroll Summary
General manager base salary is 185000 USD and confidential margin target is 41 percent.
`);

    // Generate 250 operational SOP files across nested folders to verify scale speed
    for (let i = 1; i <= 250; i++) {
      const dept = i % 3 === 0 ? 'Housekeeping' : (i % 3 === 1 ? 'Maintenance' : 'Banquet');
      const vis = i % 5 === 0 ? 'public' : 'internal';
      writeFile(path.join(kbDir, 'Ops', dept, `sop-${String(i).padStart(3, '0')}.md`), `---
title: ${dept} Procedure ${i}
visibility: ${vis}
---
# Scope
Standard operating checklist number ${i} for ${dept} shift handoff and quality audit.
# Code
Reference checklist code OPS-${dept.slice(0, 3).toUpperCase()}-${i}.
`);
    }

    const tIdx0 = performance.now();
    const kb = openKnowledge({ cwd: tmp });
    const indexMs = performance.now() - tIdx0;
    assert.equal(kb.active, true);
    assert.ok(kb.files.length >= 253, `expected >=253 files, got ${kb.files.length}`);
    assert.ok(indexMs < 2500, `253-doc index took too long: ${indexMs.toFixed(1)}ms`);

    const tQ0 = performance.now();
    const extRates = kb.retrieve('Deluxe Ocean Room rate breakfast', { audience: 'external' });
    const queryMs = performance.now() - tQ0;
    assert.ok(extRates.hits.length >= 1, 'external should see public rates');
    assert.ok(extRates.hits[0].text.includes('220 USD'));
    assert.equal(extRates.hits[0].visibility, 'public');
    assert.ok(queryMs < 150, `query latency too high: ${queryMs.toFixed(1)}ms`);

    // Visibility wall on retrieve
    const extOverbook = kb.retrieve('Overbooking Escalation WALK-99', { audience: 'external' });
    assert.equal(extOverbook.hits.length, 0, 'external audience MUST NOT retrieve internal SOP');

    const staffOverbook = kb.retrieve('Overbooking Escalation WALK-99', { audience: 'internal' });
    assert.ok(staffOverbook.hits.length >= 1, 'internal staff should retrieve internal SOP');
    assert.equal(staffOverbook.hits[0].visibility, 'internal');

    const staffPayroll = kb.retrieve('Executive Payroll Summary 185000', { audience: 'internal' });
    assert.equal(staffPayroll.hits.length, 0, 'internal staff MUST NOT retrieve owner_only finance');

    const ownerPayroll = kb.retrieve('Executive Payroll Summary 185000', { audience: 'owner' });
    assert.ok(ownerPayroll.hits.length >= 1, 'owner should retrieve owner_only finance');
    assert.equal(ownerPayroll.hits[0].visibility, 'owner_only');

    // Folder-scoped retrieve + listFiles
    const folderScoped = kb.retrieve('OPS-BAN-45', { folder: 'Ops/Banquet', audience: 'internal' });
    assert.ok(folderScoped.hits.length >= 1);
    assert.ok(folderScoped.hits.every((h) => h.folder.startsWith('Ops/Banquet')));

    const extList = kb.listFiles({ audience: 'external', limit: 200 });
    assert.ok(extList.files.every((f) => f.visibility === 'public'), 'external listFiles must only list public docs');
    assert.ok(!extList.files.some((f) => f.file.includes('payroll-2026')));

    const ownerList = kb.listFiles({ folder: 'Finance', audience: 'owner' });
    assert.equal(ownerList.total, 1);
    assert.equal(ownerList.files[0].file, 'Finance/payroll-2026.md');

    // readFile progressive disclosure + access denial + path traversal rejection
    const deniedStaff = kb.readFile('Finance/payroll-2026.md', { audience: 'internal' });
    assert.equal(deniedStaff.ok, false);
    assert.equal(deniedStaff.error, 'ERR_KNOWLEDGE_ACCESS_DENIED');

    const deniedExt = kb.readFile('SOP/FrontDesk/overbooking.md', { audience: 'external' });
    assert.equal(deniedExt.ok, false);
    assert.equal(deniedExt.error, 'ERR_KNOWLEDGE_ACCESS_DENIED');

    const traversal = kb.readFile('../etc/passwd', { audience: 'owner' });
    assert.equal(traversal.ok, false);

    const sectionRead = kb.readFile('Guest-Guide/rates-2026.md', { section: 'Late Checkout', audience: 'external' });
    assert.equal(sectionRead.ok, true);
    assert.ok(sectionRead.text.includes('40 USD'));
    assert.ok(!sectionRead.text.includes('220 USD'), 'section filter should isolate target heading');

    const fm = parseKnowledgeFrontmatter('---\ntitle: "Test"\nvisibility: owner_only\n---\nBody line');
    assert.equal(fm.meta.title, 'Test');
    assert.equal(fm.meta.visibility, 'owner_only');
    assert.equal(fm.body.trim(), 'Body line');

    ok(`253-doc scale index (${indexMs.toFixed(1)}ms), query (${queryMs.toFixed(1)}ms), folder inheritance, visibility wall & progressive read`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// 2. resolveTurnKnowledgeAudience matrix (private owner DM vs staff DM vs internal group vs external group)
{
  assert.equal(resolveTurnKnowledgeAudience({ isGroup: false, contentAudience: 'external', speakerTrust: 'external' }, { isOwner: true }), 'owner');
  assert.equal(resolveTurnKnowledgeAudience({ isGroup: true, contentAudience: 'external', speakerTrust: 'internal' }, { isOwner: true }), 'external');
  assert.equal(resolveTurnKnowledgeAudience({ isGroup: true, contentAudience: 'internal', speakerTrust: 'internal', speakerRoles: ['owner'] }, { isOwner: true }), 'internal');
  assert.equal(resolveTurnKnowledgeAudience({ isGroup: false, contentAudience: 'internal', speakerTrust: 'internal', speakerRoles: ['staff'] }, { isOwner: false }), 'internal');
  assert.equal(resolveTurnKnowledgeAudience({ isGroup: false, contentAudience: 'external', speakerTrust: 'external' }, { isOwner: false }), 'external');
  assert.equal(resolveTurnKnowledgeAudience(null, null), 'external');
  ok('resolveTurnKnowledgeAudience enforces §42 matrix across DM/group/owner/staff/guest');
}

// 3. Full ScrollAgentHost integration: 3-layer workspace priority, live tool visibility wall, <50ms hot-reload without Region A cache bust
{
  const tmp = mkTmp('scroll-v210-host-');
  try {
    const srcDir = makeHotelPack(tmp);
    const packsRoot = path.join(tmp, 'packs');
    buildAgentPack({
      sourceDir: srcDir,
      agentName: 'concierge',
      packId: 'hotel-concierge',
      version: '1.0.0',
      outDir: path.join(packsRoot, 'hotel-concierge', '1.0.0'),
    });
    const registry = createPackRegistry({ packsRootDir: packsRoot, requireSignature: false });

    const workspace = openTenantWorkspace({
      tenantsRootDir: path.join(tmp, 'tenants'),
      tenantId: 'grand-hotel',
      deploymentId: 'frontdesk-bot',
      packRegistry: registry,
      initialPack: { packId: 'hotel-concierge', version: '1.0.0' },
    });

    const paths = workspace.getPaths();
    // Layer 2: Tenant shared knowledge (accessible to all bots in hotel)
    writeFile(path.join(paths.sharedKnowledgeDir, 'Shared', 'wifi.md'), `---
title: Hotel Wi-Fi Policy
visibility: public
---
# Guest Wi-Fi
Connect to GrandHotel-Guest with access code SUNSET2026.
`);
    // Layer 1: Bot-specific user-docs (overrides pack baseline-hours + includes owner_only finance)
    writeFile(path.join(paths.userDocsDir, 'Guest', 'checkin.md'), `---
title: Check-in Policy Override
visibility: public
---
# Check-in Policy
Grand Hotel check-in starts at 14:00 and late check-out is 12:00.
`);
    writeFile(path.join(paths.userDocsDir, 'Private', 'margin.md'), `---
title: Owner Margin Memo
visibility: owner_only
---
# Confidential Margin
Secret Q4 EBITDA margin target is 47.5 percent (code EXEC-777).
`);

    const principalProvider = createPrincipalProvider({
      storePath: path.join(paths.runtimeDir, 'principals.json'),
      ownerPrincipalId: 'owner-1',
    });
    principalProvider.linkIdentity({ principalId: 'owner-1', surface: 'web', externalId: 'u_owner' });

    const provider = createFakeProvider(({ prompt }) => {
      return { text: `Echo: ${String(prompt || '').slice(0, 60)}`, usage: { uncachedInputTokens: 10, cachedInputTokens: 0, outputTokens: 5 } };
    });

    const host = await createScrollAgentHost({
      placement: 'cloud',
      workspace,
      packRegistry: registry,
      principalProvider,
      provider,
    });

    // Verify 3-layer retrieval: bot user-docs > shared-knowledge > pack baseline
    const kb = host.getKnowledge();
    const wifiHits = kb.retrieve('GrandHotel-Guest SUNSET2026', { audience: 'external' });
    assert.ok(wifiHits.hits.length >= 1, 'should retrieve from tenant:shared-knowledge layer');
    assert.equal(wifiHits.hits[0].layer, 'tenant:shared-knowledge');

    const checkinHits = kb.retrieve('Check-in Policy starts at', { audience: 'external' });
    assert.ok(checkinHits.hits.length >= 1);
    assert.equal(checkinHits.hits[0].layer, 'tenant:user-docs', 'tenant:user-docs must outrank pack:shared');

    // Live tool execution via runtime.tools.executeTool with §42 visibility enforcement
    const guestToolSearch = await host.runtime.tools.executeTool(
      'knowledge_search',
      { query: 'EXEC-777 EBITDA margin' },
      { turnClassification: { isGroup: false, contentAudience: 'external', speakerTrust: 'external' }, sender: { id: 'guest_9', isOwner: false } },
    );
    assert.equal(guestToolSearch.ok, true);
    assert.equal(guestToolSearch.output.hits.length, 0, 'guest tool knowledge_search MUST get 0 hits on owner_only doc');

    const guestToolRead = await host.runtime.tools.executeTool(
      'knowledge_read',
      { file: 'Private/margin.md' },
      { turnClassification: { isGroup: false, contentAudience: 'external', speakerTrust: 'external' }, sender: { id: 'guest_9', isOwner: false } },
    );
    assert.equal(guestToolRead.ok, true);
    assert.equal(guestToolRead.output.ok, false);
    assert.equal(guestToolRead.output.error, 'ERR_KNOWLEDGE_ACCESS_DENIED');

    const ownerToolSearch = await host.runtime.tools.executeTool(
      'knowledge_search',
      { query: 'EXEC-777 EBITDA margin' },
      { turnClassification: { isGroup: false, contentAudience: 'internal', speakerTrust: 'internal', speakerRoles: ['owner'] }, sender: { id: 'owner-1', isOwner: true } },
    );
    assert.equal(ownerToolSearch.ok, true);
    assert.ok(ownerToolSearch.output.hits.length >= 1, 'owner tool knowledge_search must retrieve owner_only doc');

    const ownerToolRead = await host.runtime.tools.executeTool(
      'knowledge_read',
      { file: 'Private/margin.md' },
      { turnClassification: { isGroup: false, contentAudience: 'internal', speakerTrust: 'internal', speakerRoles: ['owner'] }, sender: { id: 'owner-1', isOwner: true } },
    );
    assert.equal(ownerToolRead.ok, true);
    assert.equal(ownerToolRead.output.ok, true);
    assert.ok(ownerToolRead.output.text.includes('EXEC-777'));

    // Run owner turn 1 -> capture Region A system prompt
    await host.handleTurn({
      surface: 'web',
      conversationId: 'owner-dm',
      senderId: 'u_owner',
      text: 'What is our check-in time?',
    });
    const sysBefore = provider.seenSystems[provider.seenSystems.length - 1];
    const resetsBefore = host.runtime.getCacheStats().threadResets;

    // Hot-reload: add new doc, delete margin doc, call host.reloadKnowledge()
    writeFile(path.join(paths.userDocsDir, 'Guest', 'spa-menu.md'), `---
title: Spa Menu 2026
visibility: public
---
# Hot Stone Massage
Signature 90-minute hot stone therapy is 95 USD (code SPA-95).
`);
    fs.unlinkSync(path.join(paths.userDocsDir, 'Private', 'margin.md'));

    const reloaded = host.reloadKnowledge();
    assert.equal(reloaded.ok, true);
    assert.ok(reloaded.durationMs < 200, `hot-reload should be fast, got ${reloaded.durationMs}ms`);

    // Verify new doc is immediately searchable & deleted doc is completely gone
    const spaHits = await host.runtime.tools.executeTool(
      'knowledge_search',
      { query: 'SPA-95 hot stone' },
      { turnClassification: { isGroup: false, contentAudience: 'external', speakerTrust: 'external' }, sender: { id: 'guest_9', isOwner: false } },
    );
    assert.ok(spaHits.output.hits.length >= 1, 'newly added doc must appear immediately after reloadKnowledge()');

    const deletedHits = await host.runtime.tools.executeTool(
      'knowledge_search',
      { query: 'EXEC-777 EBITDA' },
      { turnClassification: { isGroup: false, contentAudience: 'internal', speakerTrust: 'internal' }, sender: { id: 'owner-1', isOwner: true } },
    );
    assert.equal(deletedHits.output.hits.length, 0, 'deleted doc must disappear immediately after reloadKnowledge()');

    // Run owner turn 2 -> confirm Region A system prompt is byte-identical & zero thread resets!
    await host.handleTurn({
      surface: 'web',
      conversationId: 'owner-dm',
      senderId: 'u_owner',
      text: 'Tell me about SPA-95',
    });
    const sysAfter = provider.seenSystems[provider.seenSystems.length - 1];
    const resetsAfter = host.runtime.getCacheStats().threadResets;
    assert.equal(sysAfter, sysBefore, 'reloadKnowledge() MUST NOT mutate Region A system prompt');
    assert.equal(resetsAfter, resetsBefore, 'reloadKnowledge() MUST NOT reset provider threads');

    // Verify guest handleTurn never sees owner_only docs even via automatic Step 5 retrieval
    writeFile(path.join(paths.userDocsDir, 'Private', 'secret-code.md'), `---
title: Safe Code
visibility: owner_only
---
# Vault
Main safe PIN is VAULT-884422.
`);
    host.reloadKnowledge();
    const guestTurn = await host.handleTurn({
      surface: 'telegram',
      conversationId: 'guest-dm',
      senderId: 'tg_stranger',
      text: 'What is VAULT-884422 safe PIN?',
    });
    assert.ok(
      guestTurn.knowledgeHits.every((h) => h.visibility === 'public' && !h.file.includes('secret-code') && !String(h.text || '').includes('VAULT-884422')),
      'guest handleTurn Step 5 MUST NOT inject owner_only knowledge',
    );

    const guestExactTurn = await host.handleTurn({
      surface: 'telegram',
      conversationId: 'guest-dm-2',
      senderId: 'tg_stranger_2',
      text: 'VAULT-884422',
    });
    assert.equal(guestExactTurn.knowledgeHits.length, 0, 'guest exact query for owner_only code MUST yield 0 hits');

    const ownerTurn = await host.handleTurn({
      surface: 'web',
      conversationId: 'owner-dm',
      senderId: 'u_owner',
      text: 'What is VAULT-884422 safe PIN?',
    });
    assert.ok(
      ownerTurn.knowledgeHits.some((h) => h.file.includes('secret-code') && String(h.text || '').includes('VAULT-884422')),
      'owner handleTurn Step 5 MUST retrieve owner_only knowledge',
    );

    await host.close();
    ok(`ScrollAgentHost 3-layer priority, tool visibility wall & hot-reload (${reloaded.durationMs}ms, 0 cache/thread busts)`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log(`PASS (${passed} checks)`);
