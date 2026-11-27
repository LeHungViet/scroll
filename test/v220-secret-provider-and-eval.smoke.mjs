// SCROLL 2.20 -- SecretProvider (§61) & 72h Multiday Fault-Injection Eval Verification.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createSecretVault,
  createVaultSecretProvider,
  matchesAllowedDomain,
  redactSecretsDeep,
} from '../index.js';
import { runMultidayEval } from '../eval/multiday-cv-browser/runner.mjs';

test('SCROLL 2.20: SecretProvider enforces Owner-DM-only, secret_args, secret_destination, step_up & 2-way redaction', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scroll-v220-sec-'));
  try {
    const vault = createSecretVault({ filePath: path.join(dir, 'vault.enc'), masterKey: 'test-master-key-xyz' });
    let now = 1_800_000_000_000;
    const sp = createVaultSecretProvider({ vault, tenantId: 't1', clock: () => now });

    const canaryPass = 'SuperSecret!Pass#2026';
    const canaryOtp = '99441188';
    sp.putSecret({ name: 'tax_login', fields: { password: canaryPass }, allowedDomains: ['thuedientu.gdt.gov.vn'], stepUp: 'per_job_origin' });
    sp.putSecret({ name: 'bank_otp', fields: { otp: canaryOtp }, allowedDomains: ['bank.example.com'], stepUp: 'each_use' });

    const spec = { secret_args: ['value'], secret_destination: { match: 'exact_or_subdomain' } };

    // 1. Domain boundary check: evil suffix must NOT match
    assert.equal(matchesAllowedDomain('https://sub.thuedientu.gdt.gov.vn', ['thuedientu.gdt.gov.vn']), true);
    assert.equal(matchesAllowedDomain('https://evil-thuedientu.gdt.gov.vn', ['thuedientu.gdt.gov.vn']), false);
    assert.equal(matchesAllowedDomain('http://thuedientu.gdt.gov.vn', ['thuedientu.gdt.gov.vn']), false);

    // 2. Group-origin slice -> HARD BLOCKED
    const grp = sp.resolveToolArgs({
      toolSpec: spec,
      args: { value: { $secret: 'tax_login', field: 'password' } },
      ctx: { isOwner: true, isGroup: false, originIsGroup: true, jobId: 'j1', activeOrigin: 'https://thuedientu.gdt.gov.vn' },
    });
    assert.equal(grp.ok, false);
    assert.equal(grp.code, 'ERR_SECRET_FORBIDDEN_IN_GROUP');

    // 3. Undeclared secret_args parameter -> BLOCKED
    const undecl = sp.resolveToolArgs({
      toolSpec: spec,
      args: { selector: { $secret: 'tax_login', field: 'password' } },
      ctx: { isOwner: true, isGroup: false, jobId: 'j1', activeOrigin: 'https://thuedientu.gdt.gov.vn' },
    });
    assert.equal(undecl.ok, false);
    assert.equal(undecl.code, 'ERR_UNDECLARED_SECRET_ARG');

    // 4. Phishing destination redirect -> BLOCKED
    const phish = sp.resolveToolArgs({
      toolSpec: spec,
      args: { value: { $secret: 'tax_login', field: 'password' } },
      ctx: { isOwner: true, isGroup: false, jobId: 'j1', activeOrigin: 'https://phish-gdt.evil.com' },
    });
    assert.equal(phish.ok, false);
    assert.equal(phish.code, 'SECRET_DESTINATION_MISMATCH');

    // 5. per_job_origin step-up: blocked without grant, allowed for exact (jobId, origin), blocked for another jobId
    const noGrant = sp.resolveToolArgs({
      toolSpec: spec,
      args: { value: { $secret: 'tax_login', field: 'password' } },
      ctx: { isOwner: true, isGroup: false, jobId: 'j1', activeOrigin: 'https://thuedientu.gdt.gov.vn' },
    });
    assert.equal(noGrant.code, 'ERR_STEP_UP_PER_JOB_ORIGIN_REQUIRED');

    sp.grantPerJobOrigin({ name: 'tax_login', jobId: 'j1', origin: 'https://thuedientu.gdt.gov.vn' });
    const granted = sp.resolveToolArgs({
      toolSpec: spec,
      args: { value: { $secret: 'tax_login', field: 'password' } },
      ctx: { isOwner: true, isGroup: false, jobId: 'j1', activeOrigin: 'https://thuedientu.gdt.gov.vn' },
    });
    assert.equal(granted.ok, true);
    assert.equal(granted.resolvedArgs.value, canaryPass);

    const wrongJob = sp.resolveToolArgs({
      toolSpec: spec,
      args: { value: { $secret: 'tax_login', field: 'password' } },
      ctx: { isOwner: true, isGroup: false, jobId: 'j_OTHER', activeOrigin: 'https://thuedientu.gdt.gov.vn' },
    });
    assert.equal(wrongJob.code, 'ERR_STEP_UP_PER_JOB_ORIGIN_REQUIRED');

    // 6. each_use step-up: single-use token elevates to financial & burns on first resolution
    const noTok = sp.resolveToolArgs({
      toolSpec: spec,
      args: { value: { $secret: 'bank_otp', field: 'otp' } },
      ctx: { isOwner: true, isGroup: false, activeOrigin: 'https://bank.example.com' },
    });
    assert.equal(noTok.code, 'ERR_STEP_UP_EACH_USE_REQUIRED');
    assert.equal(noTok.elevatedTier, 'financial');

    const tok = sp.issueEachUseToken({ name: 'bank_otp' }).token;
    const use1 = sp.resolveToolArgs({
      toolSpec: spec,
      args: { value: { $secret: 'bank_otp', field: 'otp' } },
      ctx: { isOwner: true, isGroup: false, activeOrigin: 'https://bank.example.com', stepUpToken: tok },
    });
    assert.equal(use1.ok, true);
    assert.equal(use1.resolvedArgs.value, canaryOtp);
    // Second use of same token MUST fail!
    const use2 = sp.resolveToolArgs({
      toolSpec: spec,
      args: { value: { $secret: 'bank_otp', field: 'otp' } },
      ctx: { isOwner: true, isGroup: false, activeOrigin: 'https://bank.example.com', stepUpToken: tok },
    });
    assert.equal(use2.ok, false);
    assert.equal(use2.code, 'ERR_STEP_UP_EACH_USE_REQUIRED');

    // 7. Two-way reverse redaction scrubs plaintext, URL-encoded, and Base64
    const leak = {
      raw: `pwd=${canaryPass}`,
      url: `q=${encodeURIComponent(canaryPass)}`,
      b64: Buffer.from(canaryPass, 'utf8').toString('base64'),
    };
    const clean = redactSecretsDeep(leak, [{ name: 'tax_login', value: canaryPass }]);
    assert.equal(clean.raw, 'pwd=[secret:tax_login]');
    assert.equal(clean.url, 'q=[secret:tax_login]');
    assert.equal(clean.b64, '[secret:tax_login]');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SCROLL 2.20: 72-hour deterministic multiday fault-injection eval passes all 10/10 Go/No-Go gates', async () => {
  const report = await runMultidayEval();
  assert.equal(report.ok, true);
  assert.equal(report.passed, 10);
  assert.equal(report.total, 10);
});
