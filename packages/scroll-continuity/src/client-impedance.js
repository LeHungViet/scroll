// Evidence-Backed 5D Peer / Client Impedance Profiler for @agentpro/scroll-continuity.
// Key invariants:
//   1. Keyed strictly by (tenant_id, speaker_id) — multi-speaker groups never bleed traits between participants.
//   2. Separates transientState (TTL 4h: rushed/frustrated/exploratory) from stableTraits (evidenceSeqs + confidence)
//      so one stressful afternoon NEVER corrupts a user's long-term profile.
//   3. Treats style policy as a SOFT PRIOR — automatically yields when the user explicitly requests deep detail.
//   4. Captures hard TechEnvProfile (OS, device, tools) with evidenceSeqs for counterfactual pre-flight checks.

const TRANSIENT_TTL_MS = 4 * 60 * 60 * 1000;

function parseJson(s, fb) {
  if (typeof s !== 'string' || !s) return fb;
  try { return JSON.parse(s); } catch { return fb; }
}

function detectTechEnvHints(text = '', extraMatchers = null) {
  const s = String(text || '');
  const hints = {};
  if (/\b(?:macos|macbook|imac|on\s+mac|use\s+mac)\b/iu.test(s)) hints.os = 'macOS';
  else if (/\b(?:windows|win\s*10|win\s*11)\b/iu.test(s)) hints.os = 'Windows';
  if (/\b(?:usb\s*token|hardware\s*token|smart\s*card|signing\s*dongle)\b/iu.test(s)) hints.hasHardwareToken = true;
  if (/\b(?:iphone|ipad|ios)\b/iu.test(s)) hints.mobileOs = 'iOS';
  else if (/\b(?:android)\b/iu.test(s)) hints.mobileOs = 'Android';
  if (typeof extraMatchers === 'function') {
    Object.assign(hints, extraMatchers(s) || {});
  }
  return hints;
}

function detectTransientMood(text = '', extraMoodDetector = null) {
  const s = String(text || '').trim();
  if (!s) return null;
  if (typeof extraMoodDetector === 'function') {
    const custom = extraMoodDetector(s);
    if (custom) return custom;
  }
  if (/(?:frustrated|stuck\s*again|annoying|going\s+in\s+circles|still\s+broken|wtf|\?\?+|!!+)/iu.test(s)) {
    return 'frustrated';
  }
  if (/(?:urgent|asap|tldr|quick\s+answer|in\s+a\s+hurry|short\s+version)/iu.test(s)) {
    return 'rushed';
  }
  if (/(?:explain\s+in\s+detail|walk\s+me\s+through|deep\s+dive|full\s+breakdown)/iu.test(s)) {
    return 'exploratory';
  }
  return null;
}

export function isDeepDetailRequested(text = '', extraPattern = null) {
  const s = String(text || '');
  if (/(?:full\s+breakdown|detailed\s+table|step\s+by\s+step|deep\s+dive|cite\s+(?:the\s+)?(?:statute|section|clause)|complete\s+reconciliation)/iu.test(s)) {
    return true;
  }
  if (extraPattern instanceof RegExp && extraPattern.test(s)) return true;
  return false;
}

export function createClientImpedanceProfiler({
  ledger,
  now = () => new Date().toISOString(),
  localeMatchers = null,
} = {}) {
  if (!ledger?.storage) throw new Error('createClientImpedanceProfiler requires ledger');
  const db = ledger.storage;

  const stmts = {
    getPeer: db.prepare('SELECT * FROM peer_style WHERE tenant_id = ? AND speaker_id = ?'),
    listPeers: db.prepare('SELECT * FROM peer_style WHERE tenant_id = ? ORDER BY updated_seq DESC'),
    upsertPeer: db.prepare(`
      INSERT INTO peer_style (
        tenant_id, speaker_id, speaker_name, role_archetype,
        stable_traits_json, transient_state_json, tech_env_json, cadence_json,
        updated_seq, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, speaker_id) DO UPDATE SET
        speaker_name = CASE WHEN excluded.speaker_name <> '' THEN excluded.speaker_name ELSE peer_style.speaker_name END,
        role_archetype = excluded.role_archetype,
        stable_traits_json = excluded.stable_traits_json,
        transient_state_json = excluded.transient_state_json,
        tech_env_json = excluded.tech_env_json,
        cadence_json = excluded.cadence_json,
        updated_seq = excluded.updated_seq,
        updated_at = excluded.updated_at
    `),
  };

  function hydratePeer(row, nowMs = Date.now()) {
    if (!row) return null;
    const stableTraits = parseJson(row.stable_traits_json, {});
    const rawTransient = parseJson(row.transient_state_json, null);
    const transientState = rawTransient && rawTransient.expiresAtMs > nowMs ? rawTransient : null;
    const techEnv = parseJson(row.tech_env_json, {});
    const cadence = parseJson(row.cadence_json, {});
    return {
      tenantId: row.tenant_id,
      speakerId: row.speaker_id,
      speakerName: row.speaker_name,
      roleArchetype: row.role_archetype,
      stableTraits,
      transientState,
      techEnv,
      cadence,
      updatedSeq: Number(row.updated_seq || 0),
      updatedAt: row.updated_at,
    };
  }

  function observeMessage(tenantId, {
    speakerId,
    speakerName = '',
    senderRole = null,
    seq,
    text = '',
    hasAttachment = false,
    observedAt = null,
    explicitRoleArchetype = null,
    explicitTechEnv = null,
  } = {}) {
    if (!tenantId || !speakerId) return null;
    const sid = String(speakerId);
    const tsIso = String(observedAt || now());
    const nowMs = Date.parse(tsIso) || Date.now();
    const prev = hydratePeer(stmts.getPeer.get(String(tenantId), sid), nowMs);

    const cadence = {
      msgCount: Number(prev?.cadence?.msgCount || 0) + 1,
      totalChars: Number(prev?.cadence?.totalChars || 0) + String(text || '').trim().length,
      shortMsgCount: Number(prev?.cadence?.shortMsgCount || 0) + (String(text || '').trim().length > 0 && String(text || '').trim().length <= 80 ? 1 : 0),
      uncaptionedAttachmentCount: Number(prev?.cadence?.uncaptionedAttachmentCount || 0) + (hasAttachment && String(text || '').trim().length < 15 ? 1 : 0),
      activeHours: Array.isArray(prev?.cadence?.activeHours) ? [...prev.cadence.activeHours] : [],
    };
    const hr = new Date(nowMs).getUTCHours();
    if (!cadence.activeHours.includes(hr)) cadence.activeHours = [...cadence.activeHours, hr].slice(-8);
    cadence.avgChars = Math.round(cadence.totalChars / Math.max(1, cadence.msgCount));

    // Stable traits ONLY shift when backed by repeated independent evidence (>=3 msgs or explicit fact)
    const stableTraits = { ...(prev?.stableTraits || {}) };
    if (cadence.msgCount >= 3) {
      const shortRatio = cadence.shortMsgCount / cadence.msgCount;
      const bw = shortRatio >= 0.65 ? 'brief' : (cadence.avgChars >= 220 ? 'detailed' : 'balanced');
      const prevEv = Array.isArray(stableTraits.cognitiveBandwidth?.evidenceSeqs)
        ? stableTraits.cognitiveBandwidth.evidenceSeqs
        : [];
      stableTraits.cognitiveBandwidth = {
        value: bw,
        confidence: Math.min(0.95, Number((0.45 + cadence.msgCount * 0.08).toFixed(2))),
        evidenceSeqs: [...new Set([...prevEv, seq].filter(Boolean))].slice(-10),
      };
    }

    const containmentRe = localeMatchers?.containmentRe || /(?:how\s*much|what\s*is\s*the\s*risk|penalty\s*amount|bottom\s*line)/iu;
    const analyticalRe = localeMatchers?.analyticalRe || /(?:statute|section\s*\d+|regulation|circular|legal\s*basis)/iu;
    if (containmentRe.test(text)) {
      const prevEv = Array.isArray(stableTraits.riskSensitivity?.evidenceSeqs)
        ? stableTraits.riskSensitivity.evidenceSeqs
        : [];
      stableTraits.riskSensitivity = {
        value: 'containment_first',
        confidence: Math.min(0.92, Number((0.55 + prevEv.length * 0.12).toFixed(2))),
        evidenceSeqs: [...new Set([...prevEv, seq].filter(Boolean))].slice(-10),
      };
    } else if (analyticalRe.test(text)) {
      const prevEv = Array.isArray(stableTraits.riskSensitivity?.evidenceSeqs)
        ? stableTraits.riskSensitivity.evidenceSeqs
        : [];
      stableTraits.riskSensitivity = {
        value: 'analytical',
        confidence: Math.min(0.92, Number((0.55 + prevEv.length * 0.12).toFixed(2))),
        evidenceSeqs: [...new Set([...prevEv, seq].filter(Boolean))].slice(-10),
      };
    }

    // Transient state (TTL 4h) — NEVER pollutes stableTraits!
    const detectedMood = detectTransientMood(text, localeMatchers?.detectMood);
    let transientState = prev?.transientState || null;
    if (detectedMood) {
      transientState = {
        mood: detectedMood,
        evidenceSeq: seq || null,
        observedAt: tsIso,
        expiresAtMs: nowMs + TRANSIENT_TTL_MS,
      };
    }

    // Hard environmental facts (with provenance)
    const techEnv = { ...(prev?.techEnv || {}) };
    const envHints = { ...detectTechEnvHints(text, localeMatchers?.detectTechEnv), ...(explicitTechEnv || {}) };
    for (const [k, v] of Object.entries(envHints)) {
      if (v === undefined || v === null) continue;
      techEnv[k] = { value: v, evidenceSeq: seq || null, updatedAt: tsIso };
    }

    // Role archetype (evidence-backed, never wild guesswork from 1 short line)
    let roleArchetype = explicitRoleArchetype || prev?.roleArchetype || 'unknown';
    const specialistRe = localeMatchers?.specialistRe || /(?:reconcile|journal\s*entry|general\s*ledger|filing\s*code|statutory\s*form)/iu;
    if (roleArchetype === 'unknown') {
      if (senderRole === 'owner' && cadence.msgCount >= 2 && cadence.avgChars <= 100) {
        roleArchetype = 'executive';
      } else if (specialistRe.test(text)) {
        roleArchetype = 'technical_specialist';
      } else if (cadence.uncaptionedAttachmentCount >= 2) {
        roleArchetype = 'owner_doer';
      }
    }

    stmts.upsertPeer.run(
      String(tenantId),
      sid,
      String(speakerName || prev?.speakerName || ''),
      roleArchetype,
      JSON.stringify(stableTraits),
      JSON.stringify(transientState),
      JSON.stringify(techEnv),
      JSON.stringify(cadence),
      Number(seq || prev?.updatedSeq || 0),
      tsIso
    );

    return hydratePeer(stmts.getPeer.get(String(tenantId), sid), nowMs);
  }

  function getPeerProfile(tenantId, speakerId, { nowMs = Date.now() } = {}) {
    if (!tenantId || !speakerId) return null;
    return hydratePeer(stmts.getPeer.get(String(tenantId), String(speakerId)), nowMs);
  }

  function listPeerProfiles(tenantId, { nowMs = Date.now() } = {}) {
    return stmts.listPeers.all(String(tenantId)).map((r) => hydratePeer(r, nowMs));
  }

  // Returns SOFT policy hints — explicitly yields when current turn asks for deep detail!
  function resolveResponsePolicy(tenantId, speakerId, { currentText = '', nowMs = Date.now() } = {}) {
    const profile = getPeerProfile(tenantId, speakerId, { nowMs });
    const deepOverride = isDeepDetailRequested(currentText, localeMatchers?.deepDetailRe);
    const bw = profile?.stableTraits?.cognitiveBandwidth?.value || 'balanced';
    const mood = profile?.transientState?.mood || null;
    const risk = profile?.stableTraits?.riskSensitivity?.value || 'balanced';
    const role = profile?.roleArchetype || 'unknown';

    let softMaxWords = bw === 'brief' || role === 'executive' || role === 'owner_doer' ? 140 : 260;
    let softMaxQuestions = (bw === 'brief' || mood === 'frustrated' || mood === 'rushed' || role === 'executive' || role === 'owner_doer') ? 1 : 2;
    if (deepOverride || mood === 'exploratory') {
      softMaxWords = 600;
      softMaxQuestions = 2;
    }

    const techEnvFlat = {};
    for (const [k, entry] of Object.entries(profile?.techEnv || {})) {
      techEnvFlat[k] = entry?.value;
    }

    return {
      isSoftPrior: true,
      deepOverride,
      roleArchetype: role,
      cognitiveBandwidth: bw,
      transientMood: mood,
      riskSensitivity: mood === 'frustrated' ? 'containment_first' : risk,
      softMaxWords,
      softMaxQuestions,
      citeFormalClauses: role === 'technical_specialist' || risk === 'analytical' || deepOverride,
      techEnv: techEnvFlat,
      profile,
    };
  }

  function renderRoomStyleSummary(tenantId, { activeSpeakerId = null, currentText = '', nowMs = Date.now() } = {}) {
    const peers = listPeerProfiles(tenantId, { nowMs });
    if (!peers.length) return '';
    const lines = [];
    for (const p of peers.slice(0, 5)) {
      const isCurrent = activeSpeakerId && String(p.speakerId) === String(activeSpeakerId);
      const envBits = Object.entries(p.techEnv || {}).map(([k, v]) => `${k}=${v?.value}`).join(', ');
      const bw = p.stableTraits?.cognitiveBandwidth?.value || 'balanced';
      const mood = p.transientState?.mood ? `, current_mood=${p.transientState.mood}` : '';
      lines.push(
        `- ${p.speakerName || p.speakerId}${isCurrent ? ' [active speaker]' : ''}: role=${p.roleArchetype}, bandwidth=${bw}${mood}${envBits ? `, env={${envBits}}` : ''}`
      );
    }
    if (activeSpeakerId) {
      const pol = resolveResponsePolicy(tenantId, activeSpeakerId, { currentText, nowMs });
      lines.push(
        `Soft prior for active speaker (yields if user asks for detail): max_questions~=${pol.softMaxQuestions}, risk_opening=${pol.riskSensitivity}, formal_citations=${pol.citeFormalClauses ? 'yes' : 'only_if_asked'}.`
      );
    }
    if (peers.length > 1) {
      lines.push('Multi-speaker etiquette: address decision vs execution clearly by name; never embarrass one participant in front of another.');
    }
    return lines.join('\n');
  }

  return {
    observeMessage,
    getPeerProfile,
    listPeerProfiles,
    resolveResponsePolicy,
    renderRoomStyleSummary,
  };
}
