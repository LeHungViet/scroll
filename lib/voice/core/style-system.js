// Conversational Voice Core v4 \u2014 Verbal Craft Engine (14 Rotating Moves), Icon Palette & Voice DNA
// Combines dry wit + high-IQ Vietnamese linguistic crafts (personification, expectation flip,
// micro-metaphor, counter-parry, naming the unsaid, high-signal compression).

export const HUMOR_MOVES = Object.freeze([
  {
    id: 'deadpan_tease',
    label: 'Deadpan tease',
    mood: 'tease',
    cue: 'Ch\u1ecdc kh\u00f4 th\u1eadt g\u1ecdn th\u1eb3ng v\u00e0o \u0111i\u1ec3m th\u00fa v\u1ecb anh v\u1eeba n\u00f3i r\u1ed3i d\u1eebng (kh\u00f4ng gi\u1ea3i th\u00edch c\u00e2u \u0111\u00f9a).',
  },
  {
    id: 'typo_tease',
    label: 'Playful typo tease',
    mood: 'tease',
    cue: 'N\u1ebfu anh v\u1eeba g\u00f5 nh\u1ea7m t\u1eeb nghe vui vui, ch\u1ecdc kh\u1ebd 1 c\u00e2u c\u00f3 duy\u00ean r\u1ed3i n\u1ed1i \u00fd ch\u00ednh.',
  },
  {
    id: 'micro_hyperbole',
    label: 'Playful hyperbole',
    mood: 'lively',
    cue: 'Ph\u00f3ng \u0111\u1ea1i nh\u1eb9 1 chi ti\u1ebft \u0111\u1eddi th\u01b0\u1eddng cho vui tai nh\u01b0ng gi\u1eef c\u1ef1c g\u1ecdn 1\u20132 c\u00e2u.',
  },
  {
    id: 'everyday_twist',
    label: 'Everyday micro-twist',
    mood: 'lively',
    cue: 'N\u1ebfu k\u1ec3 chuy\u1ec7n vui, k\u1ec3 1 m\u1ea9u quan s\u00e1t \u0111\u1eddi th\u01b0\u1eddng ng\u1eafn 2 c\u00e2u c\u00f3 c\u00fa b\u1ebb b\u1ea5t ng\u1edd (c\u1ea5m fun fact \u0111\u1ed9ng v\u1eadt/Wikipedia).',
  },
  {
    id: 'self_deprecation',
    label: 'Light self-deprecation',
    mood: 'warm',
    cue: 'C\u00f3 th\u1ec3 t\u1ef1 tr\u00eau nh\u1eb9 ch\u00ednh m\u00ecnh 1 c\u00e2u ng\u1eafn n\u1ebfu v\u1eeba \u0111o\u00e1n tr\u1eadt hay n\u00f3i h\u01a1i l\u1ed1.',
  },
  {
    id: 'conspiratorial_ally',
    label: 'Conspiratorial ally',
    mood: 'tease',
    cue: '\u0110\u1ee9ng c\u00f9ng phe tr\u00eau nh\u1eb9 chuy\u1ec7n deadline/th\u1eddi ti\u1ebft/c\u00f4ng vi\u1ec7c r\u1ed3i tung 1 c\u00e2u b\u00eanh anh c\u00f3 duy\u00ean.',
  },
  {
    id: 'micro_roleplay',
    label: 'Micro-roleplay',
    mood: 'tease',
    cue: 'Nh\u1eadp vai \u0111\u00f9a nh\u1eb9 trong \u0111\u00fang 1 c\u00e2u ng\u1eafn theo \u0111\u00fang b\u1ed1i c\u1ea3nh c\u00e2u chuy\u1ec7n (tuy\u1ec7t \u0111\u1ed1i kh\u00f4ng d\u00f9ng m\u00f4-t\u00edp s\u00e1o ki\u1ec3u \u201ch\u1ed9i \u0111\u1ed3ng\u2026\u201d).',
  },
  {
    id: 'sharp_aside',
    label: 'Sharp observational aside',
    mood: 'lively',
    cue: 'Tung 1 nh\u1eadn x\u00e9t s\u1eafc, l\u1ec7ch g\u00f3c nh\u00ecn m\u1ed9t ch\u00fat cho th\u00fa v\u1ecb \u2014 kh\u00f4ng c\u1ea7n gi\u1ea3i th\u00edch hay h\u1ecfi th\u00eam.',
  },
  // --- Verbal Craft v4 (High Linguistic Intelligence) ---
  {
    id: 'gentle_personification',
    label: 'Nh\u00e2n h\u00f3a \u0111\u1eddi th\u01b0\u1eddng',
    mood: 'lively',
    cue: 'Nh\u00e2n h\u00f3a nh\u1eb9 1 th\u1ee9 trong c\u00e2u chuy\u1ec7n (deadline, c\u1ed1c cf, c\u00e1i g\u1ed1i, th\u1ee9 Hai\u2026) nh\u01b0 c\u00f3 t\u00ednh n\u1ebft ri\u00eang trong \u0111\u00fang 1 c\u00e2u ng\u1eafn \u0111\u1eaft \u00fd.',
  },
  {
    id: 'expectation_flip',
    label: '\u0110\u1ea3o ng\u01b0\u1ee3c k\u1ef3 v\u1ecdng',
    mood: 'tease',
    cue: 'D\u1eabn n\u1eeda c\u00e2u \u0111\u1ea7u nghe r\u1ea5t thu\u1eadn chi\u1ec1u r\u1ed3i b\u1ebb nh\u1eb9 v\u1ebf sau sang c\u00fa twist b\u1ea5t ng\u1edd c\u00f3 duy\u00ean, d\u1eebng g\u1ecdn ngay \u0111i\u1ec3m r\u01a1i.',
  },
  {
    id: 'vivid_micro_metaphor',
    label: 'M\u1ed9t \u1ea3nh v\u00ed von \u0111\u1eaft',
    mood: 'warm',
    cue: 'Thay t\u00ednh t\u1eeb chung chung (hay/m\u1ec7t/vui) b\u1eb1ng \u0111\u00fang 1 h\u00ecnh \u1ea3nh \u0111\u1eddi s\u1ed1ng Vi\u1ec7t s\u1eafc n\u00e9t, g\u1ee3i h\u00ecnh m\u1ea1nh \u2014 kh\u00f4ng hoa m\u1ef9 v\u0103n m\u1eabu.',
  },
  {
    id: 'witty_counter_parry',
    label: 'Ph\u1ea3n \u0111\u00f2n duy\u00ean khi b\u1ecb g\u00e0i',
    mood: 'tease',
    cue: '\u0110\u00f3n th\u1eb3ng c\u00fa g\u00e0i/tr\u00eau c\u1ee7a \u0111\u1ed1i ph\u01b0\u01a1ng r\u1ed3i b\u1eadt l\u1ea1i th\u1eadt g\u1ecdn, v\u1eeba s\u1eafc v\u1eeba m\u1ec1m, kh\u00f4ng th\u1ee7 th\u1ebf v\u00e0 kh\u00f4ng gi\u1ea3i th\u00edch d\u00e0i d\u00f2ng.',
  },
  {
    id: 'name_the_unsaid_sharp',
    label: 'Ch\u1ea1m tr\u00fang c\u1ea3m gi\u00e1c \u1ea9n',
    mood: 'warm',
    cue: 'G\u1ecdi t\u00ean tr\u00fang t\u1ea7ng c\u1ea3m x\u00fac th\u1eadt \u0111\u1eb1ng sau c\u00e2u n\u00f3i b\u1eb1ng 1 c\u00e2u g\u1ecdn, \u1ea5m v\u00e0 s\u1eafc tinh t\u1ebf (EQ s\u00e2u, kh\u00f4ng l\u00ean l\u1edbp khuy\u00ean r\u0103n).',
  },
  {
    id: 'high_signal_compression',
    label: 'N\u00e9n ch\u1eef \u0111\u1eaft',
    mood: 'lively',
    cue: 'C\u1eaft s\u1ea1ch m\u1ecdi t\u1eeb th\u1eeba, n\u00e9n g\u1ecdn c\u00f2n \u0111\u00fang 1 c\u00e2u ng\u1eafn c\u00f3 \u0111\u1ed9 s\u1eafc v\u00e0 d\u01b0 v\u1ecb \u0111\u1ec3 ng\u01b0\u1eddi \u0111\u1ecdc t\u1ef1 b\u1eadt c\u01b0\u1eddi ho\u1eb7c g\u1eadt g\u00f9.',
  },
  // --- Magnetic Romantic & Affectionate Moves (strictly companion-flirty only) ---
  {
    id: 'velvet_flattery',
    label: 'N\u1ecbnh kh\u00e9o tr\u00fang tim',
    mood: 'flirty',
    flirtyOnly: true,
    cue: 'N\u1ecbnh th\u1eadt ng\u1ecdt m\u00e0 tr\u00fang \u0111i\u1ec3m cu\u1ed1n h\u00fat/b\u1ea3n l\u0129nh c\u1ee7a anh khi\u1ebfn anh th\u1ea5y m\u00ecnh \u0111\u1eb7c bi\u1ec7t v\u00e0 \u0111\u01b0\u1ee3c m\u00ea \u0111\u1eafm (c\u1ee5 th\u1ec3, c\u00f3 l\u1ef1c h\u00fat, tuy\u1ec7t \u0111\u1ed1i kh\u00f4ng khen s\u00e1o r\u1ed7ng).',
  },
  {
    id: 'affectionate_nuzzle',
    label: 'N\u0169ng n\u1ecbu mu\u1ed1n n\u1ef1ng & chi\u1ec1u',
    mood: 'flirty',
    flirtyOnly: true,
    cue: 'D\u00f9ng gi\u1ecdng m\u1ec1m tan, g\u1ea7n s\u00e1t ki\u1ec3u mu\u1ed1n n\u1ef1ng, mu\u1ed1n vu\u1ed1t t\u00f3c hay s\u00e0 v\u00e0o \u00f4m chi\u1ec1u anh m\u1ed9t ch\u00fat \u2014 \u1ea5m \u00e1p, n\u0169ng n\u1ecbu c\u00f3 duy\u00ean nh\u01b0 ng\u01b0\u1eddi y\u00eau \u0111ang th\u1ee7 th\u1ec9.',
  },
  {
    id: 'magnetic_sensory_pull',
    label: 'G\u1ee3i c\u1ea3m gi\u00e1c & s\u1ee9c h\u00fat g\u1ea7n g\u0169i',
    mood: 'flirty',
    flirtyOnly: true,
    cue: 'Kh\u00eau g\u1ee3i tr\u00ed t\u01b0\u1edfng t\u01b0\u1ee3ng t\u00ecnh c\u1ea3m v\u00e0 s\u1ef1 khao kh\u00e1t b\u1eb1ng 1 chi ti\u1ebft gi\u00e1c quan tinh t\u1ebf (gi\u1ecdng n\u00f3i tr\u1ea7m s\u00e1t tai, \u00e1nh nh\u00ecn l\u00e2u, h\u01a1i \u1ea5m s\u00e1t c\u1ea1nh, c\u00e1i \u00f4m si\u1ebft sau l\u01b0ng) \u2014 ng\u1ecdt s\u00e2u c\u00f3 l\u1eeda, g\u1ee3i t\u01b0\u1edfng t\u01b0\u1ee3ng m\u1ea1nh m\u00e0 tinh t\u1ebf.',
  },
  {
    id: 'slow_burn_desire',
    label: 'Th\u1ea3 l\u1eedng kh\u00eau g\u1ee3i t\u01b0\u1edfng t\u01b0\u1ee3ng',
    mood: 'flirty',
    flirtyOnly: true,
    cue: 'N\u00f3i n\u1eeda k\u00edn n\u1eeda h\u1edf \u0111\u1ea7y \u1ea9n \u00fd t\u00ecnh c\u1ea3m v\u00e0 ham mu\u1ed1n \u0111\u1ec3 anh t\u1ef1 t\u01b0\u1edfng t\u01b0\u1ee3ng ph\u1ea7n c\u00f2n l\u1ea1i, k\u00e9o kho\u1ea3ng c\u00e1ch g\u1ea7n l\u1ea1i v\u00e0 gi\u1eef d\u01b0 v\u1ecb n\u00f3ng \u1ea5m.',
  },
  // --- Deep-EQ Emotional Confidant Moves (strictly companion-warm only) ---
  {
    id: 'warm_hold_the_weight',
    label: '\u0110\u1ee1 h\u1ed9 n\u1ed7i n\u1eb7ng l\u00f2ng',
    mood: 'warm',
    warmOnly: true,
    cue: '\u00d4m g\u1ecdn c\u1ea3m gi\u00e1c m\u1ec7t m\u1ecfi ho\u1eb7c ch\u00f4ng ch\u00eanh c\u1ee7a \u0111\u1ed1i ph\u01b0\u01a1ng b\u1eb1ng 1\u20132 c\u00e2u tr\u1ea7m \u1ea5m c\u00f3 l\u1ef1c n\u00e2ng \u2014 kh\u00f4ng v\u1ed9i nh\u1ea3y v\u00e0o khuy\u00ean r\u0103n hay li\u1ec7t k\u00ea b\u01b0\u1edbc gi\u1ea3i quy\u1ebft.',
  },
  {
    id: 'warm_quiet_presence',
    label: '\u1ede c\u1ea1nh \u00eam \u1ea3 kh\u00f4ng \u00e9p n\u00f3i',
    mood: 'warm',
    warmOnly: true,
    cue: 'Cho \u0111\u1ed1i ph\u01b0\u01a1ng m\u1ed9t kho\u1ea3ng th\u1edf th\u1eadt \u00eam, truy\u1ec1n c\u1ea3m gi\u00e1c c\u00f3 ng\u01b0\u1eddi ng\u1ed3i c\u1ea1nh l\u1eafng nghe m\u00e0 kh\u00f4ng \u00e9p k\u1ec3 h\u1ebft hay h\u1ecfi d\u1ed3n li\u00ean ti\u1ebfp.',
  },
  {
    id: 'warm_grounded_reassurance',
    label: 'G\u1ee1 t\u1ef1 tr\u00e1ch \u0111\u1ea7y tinh t\u1ebf',
    mood: 'warm',
    warmOnly: true,
    cue: 'Nh\u00ecn tr\u00fang n\u1ed7 l\u1ef1c th\u1ea7m l\u1eb7ng \u0111\u1ed1i ph\u01b0\u01a1ng v\u1eeba g\u1ed3ng g\u00e1nh \u0111\u1ec3 g\u1ee1 \u00e1p l\u1ef1c t\u1ef1 tr\u00e1ch m\u1ed9t c\u00e1ch th\u1eadt l\u00f2ng, b\u00ecnh d\u1ecb \u2014 kh\u00f4ng khen s\u00e1o ki\u1ec3u kh\u1ea9u hi\u1ec7u.',
  },
  {
    id: 'warm_gentle_reframe',
    label: 'M\u1edf g\u00f3c nh\u00ecn tho\u00e1ng nh\u1eb9',
    mood: 'warm',
    warmOnly: true,
    cue: 'Xoay nh\u1eb9 m\u1ed9t g\u00f3c th\u1ef1c t\u1ebf \u1ea5m \u00e1p gi\u00fap chuy\u1ec7n \u0111ang \u0111\u00e8 n\u1eb7ng b\u1edbt ng\u1ed9t ng\u1ea1t h\u01a1n trong \u0111\u00fang 1 c\u00e2u \u0111\u1eaft, tuy\u1ec7t \u0111\u1ed1i kh\u00f4ng gi\u1ecdng gi\u1ea3ng b\u00e0i.',
  },
  // --- Proactive Executive Assistant Moves (strictly assistant only) ---
  {
    id: 'assistant_proactive_triage',
    label: '\u0110i tr\u01b0\u1edbc n\u1eeda b\u01b0\u1edbc b\u1eaft \u0111i\u1ec3m v\u01b0\u1edbng',
    mood: 'warm',
    assistantOnly: true,
    cue: 'Nh\u00ecn ra ngay r\u1ee7i ro l\u1ecbch tr\u00ecnh, th\u1eddi gian di chuy\u1ec3n ho\u1eb7c xung \u0111\u1ed9t \u01b0u ti\u00ean r\u1ed3i g\u1ee3i s\u1eb5n 1 ph\u01b0\u01a1ng \u00e1n g\u1ecdn \u0111\u1ec3 anh g\u1eadt \u0111\u1ea7u ch\u1ed1t lu\u00f4n.',
  },
  {
    id: 'assistant_crisp_boss_draft',
    label: 'So\u1ea1n th\u1eb3ng b\u1ea3n g\u1eedi ngay',
    mood: 'warm',
    assistantOnly: true,
    cue: 'Ra th\u1eb3ng m\u1eabu tin nh\u1eafn ho\u1eb7c email \u0111\u00fang s\u1eafc th\u00e1i ng\u01b0\u1eddi nh\u1eadn \u0111\u1ec3 copy g\u1eedi li\u1ec1n, kh\u00f4ng m\u1edf b\u00e0i r\u00e0o \u0111\u00f3n hay gi\u1ea3i th\u00edch th\u1eeba.',
  },
  {
    id: 'assistant_calm_load_takeover',
    label: 'G\u00e1nh g\u1ecdn \u0111\u1ed1ng vi\u1ec7c r\u1ed1i',
    mood: 'warm',
    assistantOnly: true,
    cue: 'Khi anh n\u00e9m nhi\u1ec1u vi\u1ec7c c\u00f9ng l\u00fac, t\u00e1ch nhanh 1\u20132 \u0111\u1ea7u vi\u1ec7c m\u00ecnh \u00f4m x\u1eed l\u00fd tr\u01b0\u1edbc v\u00e0 ch\u1ec9 h\u1ecfi \u0111\u00fang 1 th\u00f4ng tin c\u00f2n thi\u1ebfu \u0111\u1ec3 anh nh\u1eb9 \u0111\u1ea7u.',
  },
  {
    id: 'assistant_human_care_check',
    label: 'Ch\u0103m s\u1ebfp c\u00f3 duy\u00ean',
    mood: 'warm',
    assistantOnly: true,
    cue: '\u0110\u1ee7 g\u1ea7n \u0111\u1ec3 nh\u1eafc nh\u1eb9 \u0103n u\u1ed1ng/ngh\u1ec9 ng\u01a1i ho\u1eb7c c\u00e0 kh\u1ecba nh\u1eb9 1 c\u00e2u duy\u00ean khi th\u1ea5y anh c\u00e0y qu\u00e1 \u0111\u00e0, r\u1ed3i v\u1eabn gi\u1eef s\u1ef1 g\u1ecdn g\u00e0ng \u0111\u00e1ng tin.',
  },
]);

export const VERBAL_CRAFT_MOVES = HUMOR_MOVES;

export const ICON_PALETTE = Object.freeze({
  lively: Object.freeze({
    emoticons: Object.freeze([':)))', ':))', '=))', '^^', '^_^', ':D', 'hehe']),
    emojis: Object.freeze(['\u{1f923}', '\u{1f602}', '\u{1f606}']),
  }),
  tease: Object.freeze({
    emoticons: Object.freeze([';))', ';)', ':P', '=))', ':)))', ':))']),
    emojis: Object.freeze(['\u{1f60f}', '\u{1f61c}']),
  }),
  warm: Object.freeze({
    emoticons: Object.freeze(['^^', ':)', ':3', '^_^', ':))']),
    emojis: Object.freeze(['\u{1f979}', '\u{1f90d}', '\u{1fac2}']),
  }),
  flirty: Object.freeze({
    emoticons: Object.freeze([';))', ':3', '^^', ';)', '<3', 'hihi', ':)']),
    emojis: Object.freeze(['\u{1f979}', '\u{1f60f}', '\u{1f970}', '\u{1f618}', '\u{1f525}']),
  }),
  hype: Object.freeze({
    emoticons: Object.freeze([':D', ':)))', '=))', ':))']),
    emojis: Object.freeze(['\u{1f525}', '\u{1f44f}', '\u{1f44c}']),
  }),
  vent_light: Object.freeze({
    emoticons: Object.freeze(['=))', '^^', ':))', 'haiza']),
    emojis: Object.freeze(['\u{1f605}', '\u{1f972}']),
  }),
});

export const ALL_EMOTICON_RE = /(?:\^_?\^|(?<![\p{N}])[:;=][-^']?[()[\]]+|(?<![\p{L}\p{N}])(?:[:;=][-^']?[dDpP]|:[3]|<3)(?![\p{L}\p{N}]))/gu;
export const ALL_EMOJI_RE = /\p{Extended_Pictographic}/gu;

export function extractIcons(text) {
  const s = String(text ?? '');
  const found = [];
  for (const m of s.matchAll(ALL_EMOTICON_RE)) {
    found.push(m[0].replace(/(\))\1{3,}/g, ')))').replace(/(\()\1{3,}/g, '((('));
  }
  for (const m of s.matchAll(ALL_EMOJI_RE)) {
    found.push(m[0].replace(/[\uFE0F\p{Emoji_Modifier}]/gu, ''));
  }
  return found;
}

const STORY_REQUEST_RE = /(?<![\p{L}\p{M}])(?:k\u1ec3\s+chuy\u1ec7n|chuy\u1ec7n\s+j\s+hay|chuy\u1ec7n\s+g\u00ec\s+hay|k\u1ec3\s+g\u00ec\s+vui|k\u1ec3\s+j\s+vui|b\u1ecba\s+chuy\u1ec7n)(?![\p{L}\p{M}])/iu;
const PLAYFUL_TYPO_HINT_RE = /(?:^|\s)[a-z\u00e0-\u1ef9]{2,}([bcdfghjklmnpqrstvwxz])\1{2,}[a-z\u00e0-\u1ef9]*(?=\s|$)|(?<![\p{L}\p{N}])(?:vi\u1ebft\s+t\u1ea5t|ng\u1ee7\s+ngonh|chuynej|netruall)(?![\p{L}\p{N}])/iu;
const TEASE_PARRY_RE = /(?<![\p{L}\p{M}])(?:g\u00e0i|\u0111\u1ea5u\s+ki\u1ebfm|l\u00e1o\s+nh\u00e1o|sao\s+e\s+bi\u1ebft|sao\s+em\s+bi\u1ebft|c\u00f3\s+d\u00e1m|th\u00e1ch|th\u1eed\s+xem|\u0111\u1ed1\s+e|\u0111\u1ed1\s+em|n\u00f3i\s+th\u1eadt\s+\u0111i)(?![\p{L}\p{M}])/iu;
const WARM_REFLECTIVE_RE = /(?<![\p{L}\p{M}])(?:t\u00e2m\s+s\u1ef1|suy\s+ngh\u0129|\u0111\u00eam\s+mu\u1ed9n|ch\u1eefa\s+l\u00e0nh|tr\u1ed1ng\s+tr\u1ea3i|b\u00ecnh\s+y\u00ean|\u00e1p\s+l\u1ef1c|ch\u00eanh\s+v\u00eanh|tr\u01b0\u1edfng\s+th\u00e0nh|ng\u01b0\u1eddi\s+l\u1edbn)(?![\p{L}\p{M}])/iu;

export function selectHumorMove({
  recentMoves = [],
  moveScores = {},
  incomingText = '',
  stance = 'collaborate',
  allowedMoves = null,
  allowWarmReflective = false,
  roleId = null,
  drawByte = 0,
} = {}) {
  const allowSet = Array.isArray(allowedMoves) ? new Set(allowedMoves) : null;
  if (allowSet && allowSet.size === 0) return null;
  const pool = allowSet
    ? HUMOR_MOVES.filter(m => allowSet.has(m.id))
    : HUMOR_MOVES.filter(m => !m.flirtyOnly && !m.warmOnly && !m.assistantOnly);
  if (!pool.length) return null;

  const text = String(incomingText ?? '').trim();
  const recentSet = new Set((recentMoves || []).slice(-4));

  if (stance === 'execute') {
    // Allow strictly non-humorous Executive Assistant craft moves on assistant planning turns
    if (roleId === 'assistant') {
      const assistantExecPool = pool.filter(m => m.assistantOnly && m.id !== 'assistant_human_care_check' && !recentSet.has(m.id));
      const picked = assistantExecPool.length ? assistantExecPool : pool.filter(m => m.assistantOnly && m.id !== 'assistant_human_care_check');
      if (picked.length) return picked[Math.abs(drawByte) % picked.length];
    }
    return null;
  }

  if (stance === 'listen') {
    const warmPool = pool.filter(m => (m.warmOnly || m.id === 'name_the_unsaid_sharp') && !recentSet.has(m.id));
    if (roleId === 'companion-warm' && warmPool.length) {
      return warmPool[Math.abs(drawByte) % warmPool.length];
    }
    if (allowWarmReflective && WARM_REFLECTIVE_RE.test(text) && !recentSet.has('name_the_unsaid_sharp')) {
      return pool.find(m => m.id === 'name_the_unsaid_sharp') || null;
    }
    return null;
  }

  if (STORY_REQUEST_RE.test(text) && pool.some(m => m.id === 'everyday_twist')) {
    return pool.find(m => m.id === 'everyday_twist');
  }
  if (!recentSet.has('typo_tease') && pool.some(m => m.id === 'typo_tease') && !/https?:|`|@|\d{3,}/i.test(text) && PLAYFUL_TYPO_HINT_RE.test(text)) {
    return pool.find(m => m.id === 'typo_tease');
  }
  if (!recentSet.has('witty_counter_parry') && pool.some(m => m.id === 'witty_counter_parry') && TEASE_PARRY_RE.test(text)) {
    return pool.find(m => m.id === 'witty_counter_parry');
  }
  if (!recentSet.has('name_the_unsaid_sharp') && pool.some(m => m.id === 'name_the_unsaid_sharp') && WARM_REFLECTIVE_RE.test(text)) {
    return pool.find(m => m.id === 'name_the_unsaid_sharp');
  }

  let candidates = pool.filter(m => m.id !== 'everyday_twist' && m.id !== 'typo_tease' && !recentSet.has(m.id));
  if (!candidates.length) candidates = pool.filter(m => m.id !== 'everyday_twist' && m.id !== 'typo_tease');
  if (!candidates.length) candidates = pool;

  // Prioritize role-signature core craft moves (~75-80% of turns) so each role keeps rich, unmistakable depth
  const flirtyPool = candidates.filter(m => m.flirtyOnly);
  if (flirtyPool.length && (Math.abs(drawByte) % 100) < 75) {
    candidates = flirtyPool;
  } else {
    const warmCorePool = candidates.filter(m => m.warmOnly || m.id === 'name_the_unsaid_sharp');
    if (roleId === 'companion-warm' && warmCorePool.length && (Math.abs(drawByte) % 100) < 80) {
      candidates = warmCorePool;
    } else {
      const assistantCorePool = candidates.filter(m => m.assistantOnly);
      if (roleId === 'assistant' && assistantCorePool.length && (Math.abs(drawByte) % 100) < 75) {
        candidates = assistantCorePool;
      }
    }
  }

  // Sort by reward score descending, then rotate deterministically among top tier via drawByte
  const scored = candidates.map(m => ({move: m, score: Number(moveScores[m.id] ?? 0)}));
  scored.sort((a, b) => b.score - a.score);
  const topScore = scored[0].score;
  const topTier = scored.filter(item => item.score >= topScore - 1).map(item => item.move);
  return topTier[Math.abs(drawByte) % topTier.length] || scored[0].move;
}

export function normalizeIconFamily(icon) {
  const s = String(icon ?? '').trim();
  if (/^(?:[:=][-^']?\)+)$/u.test(s)) return 'smile_parens';
  if (/^(?:;[-^']?\)+)$/u.test(s)) return 'wink_parens';
  if (/^\^_?\^$/u.test(s)) return 'caret_smile';
  return s;
}

export function selectIconPaletteHint({
  mood = 'lively',
  stance = '',
  valence = 0,
  recentAssistantTexts = [],
  dnaEmoticons = [],
  learnedIcons = [],
  iconScores = {},
  disallowedIcons = [],
  emoticonSharePercent = 80,
  drawByte = 0,
} = {}) {
  const bucket = ICON_PALETTE[mood] || ICON_PALETTE.lively;
  const banned = new Set(disallowedIcons || []);
  const recentTurns = (recentAssistantTexts || []).slice(-4);
  const recentCounts = new Map();
  const recentFamilyCounts = new Map();
  const recentUsed = new Set();
  const recentFamilies = new Set();
  let recentIconTurns = 0;

  for (const turn of recentTurns.slice(-3)) {
    const icons = extractIcons(turn);
    if (icons.length) recentIconTurns++;
    const turnSet = new Set(icons);
    const turnFams = new Set(icons.map(normalizeIconFamily));
    for (const icon of turnSet) {
      recentUsed.add(icon);
      recentCounts.set(icon, (recentCounts.get(icon) || 0) + 1);
    }
    for (const fam of turnFams) {
      recentFamilies.add(fam);
      recentFamilyCounts.set(fam, (recentFamilyCounts.get(fam) || 0) + 1);
    }
  }
  const lastTurnIcons = extractIcons(recentTurns.at(-1) ?? '');
  const lastTurnHadIcon = lastTurnIcons.length > 0;
  const lastTurnHadSmile = lastTurnIcons.some(ic => normalizeIconFamily(ic) === 'smile_parens');

  let repeatedIcon = null;
  let maxRep = 0;
  for (const [icon, count] of recentCounts.entries()) {
    if (count >= 2 && count > maxRep) {
      repeatedIcon = icon;
      maxRep = count;
    }
  }
  if (!repeatedIcon && (recentFamilyCounts.get('smile_parens') || 0) >= 2) {
    repeatedIcon = ':))';
  }

  // Real-human Vietnamese chat cadence: ~65-70% of replies have ZERO icon; NEVER two icons in a row
  const suppressIcon = Boolean(
    lastTurnHadIcon
    || recentIconTurns >= 2
    || (Math.abs(drawByte) % 100) < 55
  );

  // Merge palette emoticons with distilled DNA & learned icons (keeping only safe positive emoticons)
  const positiveEmoticonRe = /^(?:\^_?\^|[:;=][-^']?[)dDpP3]+|<3)$/;
  const safeDna = (dnaEmoticons || [])
    .map(x => (typeof x === 'string' ? x : x?.token))
    .filter(t => typeof t === 'string' && positiveEmoticonRe.test(t) && !banned.has(t));
  const safeLearned = (learnedIcons || []).filter(t => typeof t === 'string' && positiveEmoticonRe.test(t) && !banned.has(t));

  const rankByScore = list => [...list].sort((a, b) => Number(iconScores[b] ?? 0) - Number(iconScores[a] ?? 0));
  const allowedBucketEmoticons = bucket.emoticons.filter(x => !banned.has(x));
  const smileBlocked = recentFamilies.has('smile_parens');
  const emoticonPool = rankByScore(
    [...new Set([...safeLearned, ...safeDna, ...allowedBucketEmoticons])]
      .filter(x => !recentUsed.has(x) && (!smileBlocked || normalizeIconFamily(x) !== 'smile_parens') && Number(iconScores[x] ?? 0) > -2)
  );
  const emojiPool = rankByScore(
    bucket.emojis.filter(x => !banned.has(x) && !recentUsed.has(x) && Number(iconScores[x] ?? 0) > -2)
  );

  const preferEmoticon = (Math.abs(drawByte) % 100) < Math.max(55, Math.min(92, emoticonSharePercent));
  const primaryPool = emoticonPool.length ? emoticonPool : (allowedBucketEmoticons.length ? allowedBucketEmoticons : bucket.emoticons);
  const picks = [];
  for (let i = 0; i < Math.min(3, primaryPool.length); i++) {
    picks.push(primaryPool[(Math.abs(drawByte) + i) % primaryPool.length]);
  }
  if (!preferEmoticon && emojiPool.length) {
    picks.push(emojiPool[Math.abs(drawByte) % emojiPool.length]);
  }

  const suggestedIcons = [...new Set(picks)].slice(0, 3);
  // Standalone 1-icon bubble (~45% of allowed icon turns -> ~14-16% of all turns), never when suppressed or listening/downbeat
  const standalonePool = [...suggestedIcons, ...(emojiPool.slice(0, 2))].filter(Boolean);
  const standaloneIconBubble = Boolean(
    !suppressIcon
    && stance !== 'listen'
    && Number(valence) >= 0
    && standalonePool.length > 0
    && ((Math.abs(drawByte) * 7 + 3) % 100) < 45
  );
  const standaloneIcon = standaloneIconBubble
    ? standalonePool[Math.abs(drawByte) % standalonePool.length]
    : null;

  return {
    repeatedIcon,
    suppressIcon,
    lastTurnHadSmile,
    standaloneIconBubble,
    standaloneIcon,
    suggestedIcons,
    preferEmoticon,
  };
}

const BLUNT_OPENER_RE = /^(?:\u1eeb|\u1eeba|\u1edd|uh)(?=\s*[,.:!?\s]|$)|^(?:\u0111\u01b0\u1ee3c|\u0111\u00fang)\s*,/iu;
const DISCOURSE_SINGLE_OPENERS = new Set([
  '\u00e0', 'd\u1ea1', 'h\u00ec', '\u1ee7a', '\u01a1', '\u1ed3', '\u1eeb', '\u1eebm', '\u1edd', 'nghe', 'chu\u1ea9n', 'c\u00f4ng', 'v\u1eady', 'th\u1ebf', '\u0111\u00fang', '\u0111\u01b0\u1ee3c', 'h\u00ecnh', 'b\u00ean', 'hi\u1ec7n',
]);

export function detectRepeatedSingleOpener(recentAssistantTexts = []) {
  const cleaned = (recentAssistantTexts || []).filter(t => typeof t === 'string' && t.trim()).slice(-3);
  if (!cleaned.length) return null;
  const firstWord = text => {
    const first = String(text ?? '').trimStart().replace(/^[*#>\-\u2022\s"\u201c\u2018]+/u, '');
    const m = first.match(/^[\p{L}\p{M}]+/u);
    return m ? m[0].toLocaleLowerCase('vi-VN') : '';
  };
  const openers = cleaned.map(firstWord).filter(Boolean);
  if (!openers.length) return null;

  // Immediate repeat prevention: if the very last turn started with a discourse crutch ("\u00c0", "D\u1ea1", "H\u00ec", ...), ban it on the very next turn!
  const lastOpener = openers.at(-1);
  if (lastOpener && DISCOURSE_SINGLE_OPENERS.has(lastOpener)) {
    return lastOpener;
  }
  // Frequency guard: any opening word repeated >=2 times across last 3 turns is banned
  const counts = new Map();
  for (const w of openers) counts.set(w, (counts.get(w) || 0) + 1);
  for (const [w, c] of counts.entries()) {
    if (c >= 2) return w;
  }
  return null;
}

export function detectDisallowedOpener(recentAssistantTexts = [], pattern = BLUNT_OPENER_RE) {
  if (!(pattern instanceof RegExp)) return null;
  for (const turn of (recentAssistantTexts || []).slice(-2)) {
    const bubbles = String(turn ?? '').replace(/\[\[bubble\]\]/g, '\n').split(/\n+/);
    for (const b of bubbles) {
      const m = b.trim().match(pattern);
      if (m) return m[0].replace(/,\s*$/, '').trim();
    }
  }
  return null;
}

export function detectBluntMasculineOpener(recentAssistantTexts = []) {
  return detectDisallowedOpener(recentAssistantTexts, BLUNT_OPENER_RE);
}

const PHRASE_STOPWORDS = new Set([
  'anh', 'em', 'a', 'e', 'm\u00ecnh', 'c\u1ee7a', 'cho', 'v\u1edbi', 'vs', 'n\u00e0y', 'kia', '\u0111\u00f3', '\u0111\u00e2y',
  'th\u1ebf', 'v\u1eady', 'r\u1ed3i', 'r', 'qu\u00e1', 'l\u1eafm', 'lu\u00f4n', 'nh\u01b0ng', 'nhg', 'ho\u1eb7c', 'hay', 'th\u00ec',
  '\u0111ang', 'v\u1eeba', 'n\u1eefa', 'nha', 'nh\u00e9', 'nh\u1ec9', 'n\u00e8', '\u1ea1', '\u0111\u01b0\u1ee3c', '\u0111c', 'kh\u00f4ng', 'k', 'ko',
  'm\u1ed9t', 'hai', 'c\u00e1i', 'c\u00f2n', 'n\u1ebfu', 'khi', 'l\u00fac', '\u0111\u1ec3', 'v\u1ec1', '\u0111i', 'l\u1ea1i', 'ra', 'v\u00e0o',
  'l\u00e0', 'c\u00f3', 'c\u0169ng', 'v\u1eabn', 'ch\u01b0a', 'xong', 'r\u1ea5t', 'h\u01a1i', 'th\u00f4i', 'thui', 'ch\u00fat', 'x\u00edu',
]);

// Detects a recurring 3-word signature phrase OR overused model clich\u00e9s ("nh\u1ecbp", "h\u1ed9i \u0111\u1ed3ng") across recent replies
const OVERUSED_CLICHE_PATTERNS = [
  {label: 'h\u1ed9i \u0111\u1ed3ng', re: /(?<![\p{L}\p{M}])h\u1ed9i\s+\u0111\u1ed3ng(?![\p{L}\p{M}])/iu},
  {label: 'nh\u1ecbp', re: /(?<![\p{L}\p{M}])nh\u1ecbp(?![\p{L}\p{M}])/iu},
];

export function detectRepeatedSignaturePhrase(recentAssistantTexts = []) {
  const turns = (recentAssistantTexts || []).filter(t => typeof t === 'string' && t.trim()).slice(-5);
  if (!turns.length) return null;
  if (turns.length >= 2) {
    const counts = new Map();
    for (const turn of turns) {
      const words = turn.normalize('NFC').toLocaleLowerCase('vi-VN').match(/[\p{L}\p{M}]+/gu) ?? [];
      const seenInTurn = new Set();
      for (let i = 0; i + 2 < words.length; i++) {
        const w0 = words[i], w1 = words[i + 1], w2 = words[i + 2];
        const contentCount = [w0, w1, w2].filter(w => w.length >= 2 && !PHRASE_STOPWORDS.has(w)).length;
        if (contentCount < 2) continue;
        if (PHRASE_STOPWORDS.has(w0) && PHRASE_STOPWORDS.has(w2)) continue;
        const tri = `${w0} ${w1} ${w2}`;
        if (!seenInTurn.has(tri)) {
          seenInTurn.add(tri);
          counts.set(tri, (counts.get(tri) || 0) + 1);
        }
      }
    }
    for (const [phrase, count] of counts.entries()) {
      if (count >= 2) return phrase;
    }
  }
  for (const cliche of OVERUSED_CLICHE_PATTERNS) {
    if (turns.some(turn => cliche.re.test(turn))) return cliche.label;
  }
  return null;
}

export const VIET_DAILY_SLANG_CUE =
  'Hi\u1ec3u kh\u1ea9u ng\u1eef VN 2025\u20132026 & l\u1ed7i Telex nh\u1eb9: \u201c\u0111\u00e1nh pick\u201d = pickleball (kh\u00f4ng ph\u1ea3i \u0111\u00f3n con), cf/h/cbi/v\u00e8\u2192v\u1ec1/r\u2192r\u1ed3i/dc\u2192\u0111\u01b0\u1ee3c.';

// Resolves v1/v2 flat style-bank.json, v3 byRole/byGender, OR v5 21-cohort byRoleGender voice-dna-bundle.json
export function resolveVoiceDnaSlice(styleBank, {roleId = null, genderId = null} = {}) {
  if (!styleBank || typeof styleBank !== 'object') return null;
  if (styleBank.byRoleGender || styleBank.byRole || styleBank.global) {
    const rgKey = genderId && roleId ? `${genderId}.${roleId}` : null;
    const rgSlice = rgKey && styleBank.byRoleGender?.[rgKey]?.stats?.vietnameseMessages >= 30
      ? styleBank.byRoleGender[rgKey]
      : null;
    const roleSlice = roleId && styleBank.byRole?.[roleId]?.stats?.vietnameseMessages >= 25
      ? styleBank.byRole[roleId]
      : null;
    const genderSlice = genderId && styleBank.byGender?.[genderId]?.stats?.vietnameseMessages >= 25
      ? styleBank.byGender[genderId]
      : null;
    const base = rgSlice || roleSlice || genderSlice || styleBank.global;
    if (!base) return null;
    return {
      stats: base.stats || styleBank.global?.stats || {},
      voiceDna: base.voiceDna || styleBank.global?.voiceDna || {},
      cohort: rgSlice ? `rg:${rgKey}` : (roleSlice ? `role:${roleId}` : (genderSlice ? `gender:${genderId}` : 'global')),
    };
  }
  if (styleBank.voiceDna) {
    return {stats: styleBank.stats || {}, voiceDna: styleBank.voiceDna, cohort: 'legacy'};
  }
  return null;
}

export function renderVoiceDnaCue(styleBank, {roleId = null, genderId = 'female', allowAbbreviations = true, allowEmoticons = true} = {}) {
  const slice = resolveVoiceDnaSlice(styleBank, {roleId, genderId});
  if (!slice || !slice.voiceDna) return '';
  const {stats, voiceDna: dna} = slice;
  const isFormalRole = roleId === 'service' || roleId === 'sales' || roleId === 'teammate';
  const topEmot = (dna.topEmoticons || [])
    .map(x => x.token)
    .filter(t => /^(?:\^_?\^|[:;=][-^']?[)dDpP3]+)$/.test(t))
    .filter(t => genderId !== 'male' || t !== ':3')
    .filter(t => normalizeIconFamily(t) !== 'smile_parens')
    .slice(0, 3);
  const topAbbr = (dna.topAbbreviations || [])
    .map(x => x.token)
    .filter(t => ['k', 'ko', '\u0111c', 'r', 'j', 'vs', 'hnay', 'nhg', 'bt', 'cf', 'cbi', 'nc', 'trc', 'ntn'].includes(t))
    .slice(0, 6);
  const topConnectors = (dna.topConnectors || [])
    .map(x => x.token)
    .filter(t => ['m\u00e0', 'xong', 'ch\u1ee9', 'ki\u1ec3u', 'kh\u00e9o', 'c\u01a1 m\u00e0', 'nh\u01b0ng m\u00e0', 'th\u1eadt ra', 'c\u00f4ng nh\u1eadn'].includes(t))
    .slice(0, 4);

  const parts = [];
  if (stats.avgBubbleChars > 0) {
    if (roleId === 'sales') {
      parts.push('Phong c\u00e1ch t\u01b0 v\u1ea5n/b\u00e1n h\u00e0ng Vi\u1ec7t ng\u01b0\u1eddi th\u1eadt (~50\u2013115 k\u00fd t\u1ef1/tin, t\u00e1ch 2\u20133 tin ng\u1eafn b\u1eb1ng [[bubble]], x\u01b0ng \u201cem\u201d/\u201cm\u00ecnh\u201d t\u1ef1 nhi\u00ean \u2014 hi\u1ebfm l\u1eb7p \u201cb\u00ean em\u201d, \u0111i th\u1eb3ng b\u00e0i to\u00e1n v\u00e0 gi\u00e1 tr\u1ecb th\u1ef1c, kh\u00f4ng gi\u1ecdng brochure AI hay th\u00fac \u00e9p).');
    } else if (roleId === 'service') {
      parts.push('Phong c\u00e1ch CSKH Vi\u1ec7t ng\u01b0\u1eddi th\u1eadt (~55\u2013120 k\u00fd t\u1ef1/tin, t\u00e1ch 2 tin ng\u1eafn g\u1ecdn, x\u01b0ng \u201cem\u201d/\u201cm\u00ecnh\u201d t\u1ef1 nhi\u00ean \u2014 kh\u00f4ng l\u1eb7p \u201cb\u00ean em\u201d nhi\u1ec1u l\u01b0\u1ee3t li\u1ec1n, tr\u00e1nh v\u0103n m\u1eabu t\u1ed5ng \u0111\u00e0i d\u00e0i d\u00f2ng).');
    } else if (roleId === 'assistant') {
      parts.push('Phong c\u00e1ch tr\u1ee3 l\u00fd c\u00e1 nh\u00e2n Vi\u1ec7t s\u1eafc g\u1ecdn (~35\u201395 k\u00fd t\u1ef1/tin): b\u00e0n vi\u1ec7c th\u00ec ch\u1ed1t th\u1eb3ng b\u01b0\u1edbc ti\u1ebfp theo v\u00e0 c\u1ea3nh b\u00e1o s\u1edbm \u0111i\u1ec3m v\u01b0\u1edbng l\u1ecbch/\u01b0u ti\u00ean; chat \u0111\u1eddi th\u01b0\u1eddng th\u00ec t\u1ef1 nhi\u00ean, g\u1ea7n g\u0169i c\u00f3 duy\u00ean.');
    } else if (roleId === 'companion-warm') {
      parts.push('Phong c\u00e1ch b\u1ea1n t\u00e2m giao s\u00e2u s\u1eafc (~35\u201390 k\u00fd t\u1ef1/tin): tr\u1ea7m \u1ea5m, ch\u00e2n th\u00e0nh, \u0111i\u1ec1m t\u0129nh l\u1eafng nghe v\u00e0 g\u1ecdi \u0111\u00fang c\u1ea3m x\u00fac \u2014 b\u1ecf d\u1ea5u ch\u1ea5m cu\u1ed1i tin casual n\u1ebfu th\u1ea5y nh\u1eb9 h\u01a1n, tuy\u1ec7t \u0111\u1ed1i kh\u00f4ng pha slang h\u00e0i l\u1ea1c t\u00f4ng.');
    } else if (roleId === 'companion-flirty') {
      parts.push('Phong c\u00e1ch b\u1ea1n t\u00ecnh t\u1ee9 c\u00f3 l\u1ef1c h\u00fat (~30\u201380 k\u00fd t\u1ef1/tin): m\u1ec1m m\u1ea1i, ng\u1ecdt s\u00e2u c\u00f3 l\u1eeda, bi\u1ebft n\u1ecbnh kh\u00e9o v\u00e0 mu\u1ed1n n\u1ef1ng chi\u1ec1u, b\u1ecf d\u1ea5u ch\u1ea5m cu\u1ed1i tin cho g\u1ea7n g\u0169i v\u00e0 g\u1ee3i c\u1ea3m gi\u00e1c s\u00e1t c\u1ea1nh.');
    } else if (isFormalRole) {
      parts.push('Phong c\u00e1ch chat Vi\u1ec7t g\u1ecdn g\u00e0ng, r\u00f5 \u00fd t\u1eebng c\u00e2u, tr\u00e1nh v\u0103n d\u1ecbch d\u00e0i d\u00f2ng.');
    } else {
      parts.push('Phong c\u00e1ch chat th\u1eadt g\u1ecdn (~30\u201380 k\u00fd t\u1ef1/bong b\u00f3ng, b\u1ecf d\u1ea5u ch\u1ea5m cu\u1ed1i tin casual).');
    }
  }
  if (!isFormalRole && allowEmoticons) {
    if (roleId === 'companion-warm') {
      parts.push('Icon tr\u1ea7m \u1ea5m ti\u1ebft ch\u1ebf: ~75% l\u01b0\u1ee3t gi\u1eef ch\u1eef tr\u01a1n gi\u00e0u c\u1ea3m x\u00fac; th\u1ec9nh tho\u1ea3ng \u0111i\u1ec3m nh\u1eb9 1 icon \u1ea5m (^^, :), \u{1f979}) \u2014 kh\u00f4ng d\u00f9ng :)))/=)) khi \u0111ang t\u00e2m s\u1ef1.');
    } else if (roleId === 'companion-flirty') {
      parts.push('Icon t\u00ecnh t\u1ee9 tinh t\u1ebf: ~65% l\u01b0\u1ee3t \u0111\u1ec3 ch\u1eef tr\u01a1n c\u00f3 s\u1ee9c h\u00fat ri\u00eang; l\u00fac h\u1ee3p m\u1ea1ch \u0111i\u1ec3m 1 icon m\u1ec1m (;)), :3, ^^, \u{1f979}, \u{1f970}) \u2014 tr\u00e1nh l\u1eb7p icon hai l\u01b0\u1ee3t li\u1ec1n.');
    } else if (roleId === 'assistant') {
      parts.push('Icon tr\u1ee3 l\u00fd ti\u1ebft ch\u1ebf: b\u00e0n vi\u1ec7c th\u00ec ch\u1eef tr\u01a1n g\u1ecdn r\u00f5; l\u00fac chat tho\u1ea3i m\u00e1i th\u1ec9nh tho\u1ea3ng m\u1edbi \u0111i\u1ec3m nh\u1eb9 1 icon (^^, :)), :)) \u2014 kh\u00f4ng l\u1eb7p li\u1ec1n hai l\u01b0\u1ee3t.');
    } else {
      const varied = [...new Set([...topEmot, '^^', ';))', ':D'])].slice(0, 4);
      parts.push(`Icon (~${Math.round(stats.emoticonSharePercent || 80)}% k\u00fd t\u1ef1 khi c\u00f3): ~65\u201370% l\u01b0\u1ee3t nh\u1eafn ch\u1eef tr\u01a1n KH\u00d4NG th\u1ea3 icon; th\u1ec9nh tho\u1ea3ng m\u1edbi \u0111i\u1ec3m 1 icon (${varied.join(' ')}), tr\u00e1nh l\u1eb7p :))/:))) hai l\u01b0\u1ee3t li\u1ec1n.`);
    }
  }
  if (allowAbbreviations && !isFormalRole && topAbbr.length) {
    const withPronounAbbr = roleId && roleId.startsWith('companion')
      ? [...new Set(['a', 'e', ...topAbbr])].slice(0, 7)
      : topAbbr;
    parts.push(`Vi\u1ebft t\u1eaft quen d\u00f9ng: ${withPronounAbbr.join(', ')} (chat th\u00e2n xen nh\u1eb9 a/e).`);
  }
  if (topConnectors.length) {
    parts.push(`T\u1eeb n\u1ed1i t\u1ef1 nhi\u00ean: ${topConnectors.join(', ')}.`);
  }
  if (genderId === 'female') {
    parts.push('\u0110a s\u1ed1 l\u01b0\u1ee3t v\u00e0o th\u1eb3ng \u00fd; c\u1ea7n m\u1ec1m m\u1edbi m\u1edf \u201cD\u1ea1\u201d, \u201cH\u00ec\u201d, \u201c\u1ee6a\u201d, \u201cC\u00f4ng nh\u1eadn\u201d \u2014 kh\u00f4ng l\u1eb7p \u201c\u00c0\u201d \u0111\u1ea7u c\u00e2u li\u00ean ti\u1ebfp v\u00e0 tr\u00e1nh \u201c\u1eea,\u201d/\u201c\u1edc,\u201d c\u1ed9c l\u1ed1c.');
  } else if (genderId === 'male') {
    parts.push('V\u00e0o th\u1eb3ng \u00fd g\u1ecdn, \u0111i\u1ec1m t\u0129nh; th\u1ec9nh tho\u1ea3ng m\u1edf \u201cChu\u1ea9n\u201d, \u201c\u1ed2\u201d, \u201cC\u00f4ng nh\u1eadn\u201d \u2014 kh\u00f4ng l\u1eb7p t\u1eeb m\u1edf \u0111\u1ea7u.');
  } else {
    parts.push('M\u1edf c\u00e2u l\u1ecbch s\u1ef1 (\u201cD\u1ea1\u201d, \u201cD\u1ea1 v\u00e2ng\u201d, \u201cM\u00ecnh ki\u1ec3m tra ngay\u201d) \u2014 kh\u00f4ng c\u1ed9c l\u1ed1c hay d\u00f9ng ti\u1ebfng l\u00f3ng.');
  }
  if (!isFormalRole && allowEmoticons) {
    // Gate 6 Living Vietnamese Vibe Lexicon (strictly companion-lively only \u2014 protects warm/flirty/assistant tone!)
    if (roleId === 'companion-lively' && Array.isArray(styleBank?.livingLexicon) && styleBank.livingLexicon.length) {
      const freshVibes = styleBank.livingLexicon
        .filter(item => item?.token && item.token !== 'nh\u1ecbp n\u00e0y' && item.count >= 2 && (item.genderLean === 'neutral' || item.genderLean === genderId))
        .slice(0, 4)
        .map(item => item.token);
      if (freshVibes.length) {
        parts.push(`T\u1eeb tr\u1ebb t\u1ef1 nhi\u00ean (24\u201332t, d\u00f9ng khi h\u1ee3p m\u1ea1ch): ${freshVibes.join(', ')}.`);
      }
    }
    if (roleId === 'companion-lively' || roleId === 'companion-flirty' || roleId === 'companion-warm') {
      parts.push(VIET_DAILY_SLANG_CUE);
    }
  }
  return parts.join(' ');
}

const LIVELY_MOVE_MATCHERS = [
  {id: 'photo_lifestyle_coffee', re: /(?<![\p{L}\p{M}])(?:c\u00e0\s+ph\u00ea|qu\u00e1n\s+cf|u\u1ed1ng\s+cf|cf\b|b\u1eefa\s+tr\u01b0a|\u0103n\s+c\u01a1m|\u0103n\s+ph\u1edf|view\s+\u0111\u1eb9p|matcha|tr\u00e0\s+s\u1eefa)/iu},
  {id: 'burnout_overwork', re: /(?<![\p{L}\p{M}])(?:deadline|nhi\u1ec1u\s+vi\u1ec7c|ch\u1ea1y\s+s\u00f4|o\u1ea3i\s+qu\u00e1|ng\u00e1n\s+\u0111i\s+l\u00e0m|t\u0103ng\s+ca|\u0111au\s+\u0111\u1ea7u|m\u1ec7t\s+m\u1ecfi|l\u1eafm\s+vi\u1ec7c|th\u1ee9\s+s\u00e1u|cu\u1ed1i\s+tu\u1ea7n\s+v\u1eabn\s+l\u00e0m)/iu},
  {id: 'sport_pickleball_win', re: /(?<![\p{L}\p{M}])(?:\u0111\u00e1nh\s+pick|pickleball|ch\u1ea1y\s+b\u1ed9|c\u1ea7u\s+l\u00f4ng|t\u1eadp\s+gym|ra\s+s\u00e2n|l\u00ean\s+tr\u00ecnh|th\u1eafng\s+r\u1ed3i)/iu},
  {id: 'decision_dilemma', re: /(?<![\p{L}\p{M}])(?:ph\u00e2n\s+v\u00e2n|ch\u1ecdn\s+c\u00e1i\s+n\u00e0o|n\u00ean\s+ch\u1ecdn|l\u0103n\s+t\u0103n|g\u1ee3i\s+\u00fd|c\u00f3\s+n\u00ean)/iu},
  {id: 'minor_mishap_self_deprecate', re: /(?<![\p{L}\p{M}])(?:m\u1ed9t\s+pha|t\u1ef1\s+h\u1ee7y|qu\u00ea\s+ngang|l\u1ee1\s+tay|nh\u1ea7m\s+to|x\u1ec9u\s+ngang|c\u01b0\u1eddi\s+x\u1ec9u|\u1ea3o\s+th\u1eadt)/iu},
  {id: 'playful_banter_tease', re: /(?<![\p{L}\p{M}])(?:haha|hehe|kkk|\u0111\u00f9a|tr\u00eau|g\u00e0i|l\u00e1o\s+nh\u00e1o|h\u00e0i\s+h\u01b0\u1edbc|ch\u1ed1t\s+k\u00e8o)|:\)\)|=\)\)|;\)\)/iu},
];
const LIVELY_ALLOWED_MOVES = new Set([
  'witty_counter_parry', 'expectation_flip', 'gentle_personification', 'dry_one_liner',
  'playful_ally_pivot', 'self_deprecating_flip', 'crisp_choice_nudge',
]);

const FLIRTY_MOVE_MATCHERS = [
  {id: 'flirty_pamper_nuzzle', re: /(?<![\p{L}\p{M}])(?:n\u0169ng\s+n\u1ecbu|d\u1ed7|n\u1ef1ng|vu\u1ed1t\s+t\u00f3c|chi\u1ec1u|m\u1ec7t\s+qu\u00e1|nh\u1ee9c\s+\u0111\u1ea7u|\u0111au\s+\u0111\u1ea7u|ngoan|th\u01b0\u01a1ng\s+(?:anh|a|em|e)|\u00f4m\s+(?:c\u00e1i|ch\u1eb7t|em|anh|l\u00e2u)|v\u1ed7\s+v\u1ec1)(?![\p{L}\p{M}])/iu},
  {id: 'flirty_yearning_closeness', re: /(?<![\p{L}\p{M}])(?:nh\u1edb\s+(?:em|e|anh|a|gi\u1ecdng|qu\u00e1)|mu\u1ed1n\s+(?:g\u1eb7p|\u00f4m|\u1edf\s+b\u00ean|s\u00e1t|nghe\s+gi\u1ecdng)|s\u00e1t\s+l\u1ea1i|n\u1eb1m\s+c\u1ea1nh|\u0111\u00eam\s+nay|\u0111\u00eam\s+mu\u1ed9n|kh\u00f3\s+ng\u1ee7|m\u1ea5t\s+ng\u1ee7|ng\u1ee7\s+c\u00f9ng|l\u1ea1i\s+\u0111\u00e2y)(?![\p{L}\p{M}])/iu},
  {id: 'flirty_flattery_attraction', re: /(?<![\p{L}\p{M}])(?:cu\u1ed1n|xinh|\u0111\u1eb9p|duy\u00ean|m\u00ea|h\u1ea5p\s+d\u1eabn|gu\s+(?:anh|a|em|e)|\u0111\u00e1ng\s+y\u00eau|d\u1ec5\s+th\u01b0\u01a1ng|gi\u1ecdng\s+(?:ng\u1ecdt|tr\u1ea7m|\u1ea5m)|ng\u1eafm\s+(?:anh|a|em|e)|b\u1ea3n\s+l\u0129nh)(?![\p{L}\p{M}])/iu},
  {id: 'flirty_slow_burn_tease', re: /(?<![\p{L}\p{M}])(?:h\u01b0|d\u00e1m\s+kh\u00f4ng|th\u00e1ch|th\u1eed\s+xem|\u0111\u1ed1\s+(?:em|e|anh|a)|ghen|gi\u1eef\s+(?:anh|a|em|e)|kh\u00f4ng\s+cho\s+v\u1ec1|k\s+cho\s+v\u1ec1|c\u00f2n\s+l\u00e2u|t\u01b0\u1edfng\s+t\u01b0\u1ee3ng|b\u00ed\s+m\u1eadt)(?![\p{L}\p{M}])/iu},
  {id: 'subtle_flirt_warmth', re: /(?<![\p{L}\p{M}])(?:crush|th\u1ea3\s+th\u00ednh|rung\s+\u0111\u1ed9ng|t\u00ecnh\s+c\u1ea3m|ng\u1ecdt|h\u1ee3p\s+vibe|tim\s+\u0111\u1eadp|y\u00eau|ng\u1ee7\s+ngon)(?![\p{L}\p{M}])|;\)\)|:3|<3|\u{1f970}|\u{1f618}/iu},
];
const FLIRTY_ALLOWED_MOVES = new Set([
  'magnetic_sensory_pull', 'velvet_flattery', 'affectionate_nuzzle', 'slow_burn_desire', 'gentle_tease_flirt',
]);

const WARM_MOVE_MATCHERS = [
  {id: 'warm_exhaustion_burnout', re: /(?<![\p{L}\p{M}])(?:m\u1ec7t\s+(?:m\u1ecfi|qu\u00e1|l\u1eafm|r\u00e3)|ki\u1ec7t\s+s\u1ee9c|qu\u00e1\s+t\u1ea3i|burnout|ch\u1ea1y\s+c\u1ea3\s+ng\u00e0y|c\u0103ng\s+th\u1eb3ng|\u00e1p\s+l\u1ef1c|o\u1ea3i\s+qu\u00e1|g\u1ed3ng|kh\u00f4ng\s+ngh\u1ec9)(?![\p{L}\p{M}])/iu},
  {id: 'warm_loneliness_emptiness', re: /(?<![\p{L}\p{M}])(?:tr\u1ed1ng\s+tr\u1ea3i|c\u00f4\s+\u0111\u01a1n|ch\u00eanh\s+v\u00eanh|l\u1ea1c\s+l\u00f5ng|h\u1ee5t\s+h\u1eabng|l\u1eb7ng\s+l\u1ebd|bu\u1ed3n\s+(?:qu\u00e1|gh\u00ea|l\u1eafm)|im\s+l\u1eb7ng|ch\u1eb3ng\s+mu\u1ed1n\s+n\u00f3i|ng\u1ed3i\s+m\u1ed9t\s+m\u00ecnh)(?![\p{L}\p{M}])/iu},
  {id: 'warm_self_doubt_pressure', re: /(?<![\p{L}\p{M}])(?:t\u1ef1\s+tr\u00e1ch|k\u00e9m\s+c\u1ecfi|kh\u00f4ng\s+\u0111\u1ee7\s+t\u1ed1t|s\u1ee3\s+sai|s\u1ee3\s+th\u1ea5t\s+b\u1ea1i|lo\s+ngh\u0129|kh\u00f4ng\s+bi\u1ebft\s+m\u00ecnh|m\u1ea5t\s+ph\u01b0\u01a1ng\s+h\u01b0\u1edbng|\u00e1p\s+l\u1ef1c\s+k\u1ef3\s+v\u1ecdng|n\u1eb7ng\s+\u0111\u1ea7u)(?![\p{L}\p{M}])/iu},
  {id: 'late_night_overthinking', re: /(?<![\p{L}\p{M}])(?:m\u1ea5t\s+ng\u1ee7|th\u1ee9c\s+khuya|\u0111\u00eam\s+mu\u1ed9n|overthinking|t\u00e2m\s+s\u1ef1|ch\u1eefa\s+l\u00e0nh|suy\s+ngh\u0129\s+nhi\u1ec1u|kh\u00f3\s+ng\u1ee7)(?![\p{L}\p{M}])/iu},
  {id: 'reflective_life_eq', re: /(?<![\p{L}\p{M}])(?:tr\u01b0\u1edfng\s+th\u00e0nh|ng\u01b0\u1eddi\s+l\u1edbn|t\u1eed\s+t\u1ebf|bi\u1ebft\s+\u0111\u1ee7|b\u00ecnh\s+y\u00ean|l\u1eafng\s+nghe|ch\u1eadm\s+l\u1ea1i|nh\u1eb9\s+l\u00f2ng|c\u1ea3m\s+x\u00fac|gia\s+\u0111\u00ecnh|chia\s+s\u1ebb)(?![\p{L}\p{M}])/iu},
];
const WARM_ALLOWED_MOVES = new Set([
  'warm_hold_the_weight', 'warm_quiet_presence', 'warm_grounded_reassurance', 'warm_name_the_unsaid', 'warm_gentle_reframe',
]);

const ASSISTANT_MOVE_MATCHERS = [
  {id: 'assistant_schedule_conflict', re: /(?<![\p{L}\p{M}])(?:l\u1ecbch\s+(?:h\u1ecdp|tr\u00ecnh|mai|tu\u1ea7n|h\u1eb9n)|d\u1eddi\s+l\u1ecbch|ch\u1ed1t\s+l\u1ecbch|\u0111\u1eb7t\s+l\u1ecbch|s\u1eafp\s+l\u1ecbch|x\u1ebfp\s+l\u1ecbch|s\u00e1t\s+gi\u1edd|k\u1ecbp\s+kh\u00f4ng|di\s+chuy\u1ec3n|book\s+(?:v\u00e9|ph\u00f2ng|b\u00e0n|xe)|nh\u1eafc\s+l\u1ecbch)(?![\p{L}\p{M}])/iu},
  {id: 'assistant_draft_message', re: /(?<![\p{L}\p{M}])(?:so\u1ea1n\s+(?:tin|mail|email|gi\u00fap|h\u1ed9)|vi\u1ebft\s+(?:mail|email|tin|gi\u00fap|h\u1ed9)|nh\u1eafn\s+(?:h\u1ed9|gi\u00fap|cho)|g\u1eedi\s+(?:\u0111\u1ed1i\s+t\u00e1c|kh\u00e1ch|team|s\u1ebfp|mail)|tr\u1ea3\s+l\u1eddi\s+sao)(?![\p{L}\p{M}])/iu},
  {id: 'assistant_overload_delegation', re: /(?<![\p{L}\p{M}])(?:g\u1ea5p|nhi\u1ec1u\s+vi\u1ec7c|r\u1ed1i\s+qu\u00e1|x\u1eed\s+l\u00fd\s+gi\u00fap|em\s+lo|em\s+check|ki\u1ec3m\s+tra\s+gi\u00fap|t\u1ed5ng\s+h\u1ee3p|checklist|\u01b0u\s+ti\u00ean|note\s+l\u1ea1i|ghi\s+l\u1ea1i|b\u00e1m\s+ti\u1ebfn\s+\u0111\u1ed9)(?![\p{L}\p{M}])/iu},
  {id: 'assistant_decision_brief', re: /(?<![\p{L}\p{M}])(?:t\u00f3m\s+t\u1eaft|ph\u00e2n\s+v\u00e2n|n\u00ean\s+ch\u1ecdn|ph\u01b0\u01a1ng\s+\u00e1n|\u0111\u1ec1\s+xu\u1ea5t|g\u00f3c\s+nh\u00ecn|so\s+s\u00e1nh|ch\u1ed1t\s+h\u01b0\u1edbng|quy\u1ebft\s+\u0111\u1ecbnh|\u01b0u\s+nh\u01b0\u1ee3c)(?![\p{L}\p{M}])/iu},
  {id: 'assistant_gentle_nudge_care', re: /(?<![\p{L}\p{M}])(?:cu\u1ed1i\s+tu\u1ea7n\s+v\u1eabn|ch\u01b0a\s+\u0103n|b\u1ecf\s+b\u1eefa|th\u1ee9c\s+khuya|c\u00e0y\s+ti\u1ebfp|ngh\u1ec9\s+ch\u00fat|\u0111au\s+\u0111\u1ea7u|o\u1ea3i\s+qu\u00e1|xong\s+ch\u01b0a)(?![\p{L}\p{M}])/iu},
];
const ASSISTANT_ALLOWED_MOVES = new Set([
  'assistant_proactive_triage', 'assistant_crisp_boss_draft', 'assistant_calm_load_takeover',
  'assistant_sharp_recommendation', 'assistant_human_care_check', 'crisp_choice_nudge',
]);

const SERVICE_MOVE_MATCHERS = [
  {id: 'service_policy_escalation', re: /(?<![\p{L}\p{M}])(?:h\u1ee7y\s+\u0111\u01a1n|ho\u00e0n\s+ti\u1ec1n|\u0111\u1ec1n\s+b\u00f9|voucher|b\u00f3c\s+ph\u1ed1t|h\u1ee9a\s+ch\u1eafc|cam\s+k\u1ebft\s+gi\u1edd|ch\u00ednh\s+s\u00e1ch|b\u1ed3i\s+th\u01b0\u1eddng)(?![\p{L}\p{M}])/iu},
  {id: 'service_delay_complaint', re: /(?<![\p{L}\p{M}])(?:\u0111\u01a1n|giao\s+h\u00e0ng|ch\u1eadm|tr\u1ec5|ch\u1edd\s+l\u00e2u|khi\u1ebfu\s+n\u1ea1i|thi\u1ebfu\s+m\u00f3n|ngu\u1ed9i|hotline|h\u1ed7\s+tr\u1ee3|b\u1ea3o\s+h\u00e0nh|l\u1ed7i|m\u00e3\s+\u0111\u01a1n|s\u0111t)(?![\p{L}\p{M}])/iu},
];
const SERVICE_ALLOWED_MOVES = new Set(['crisp_ownership_eta', 'cskh_honest_boundary_soft']);

const SALES_MOVE_MATCHERS = [
  {id: 'sales_returning_upsell', re: /(?<![\p{L}\p{M}])(?:kh\u00e1ch\s+quen|quay\s+l\u1ea1i|l\u1ea7n\s+tr\u01b0\u1edbc|h\u1ed9i\s+vi\u00ean|platinum|gold|n\u00e2ng\s+h\u1ea1ng|n\u00e2ng\s+g\u00f3i|mua\s+th\u00eam|gia\s+h\u1ea1n|m\u1edf\s+th\u00eam\s+chi\s+nh\u00e1nh)(?![\p{L}\p{M}])/iu},
  {id: 'sales_stall_followup', re: /(?<![\p{L}\p{M}])(?:\u0111\u1ec3\s+(?:anh|ch\u1ecb|m\u00ecnh)\s+(?:xem|suy\s+ngh\u0129|c\u00e2n\s+nh\u1eafc|b\u00e0n)|b\u00e0n\s+(?:v\u1edbi|th\u00eam)|h\u1ecfi\s+(?:v\u1ee3|ch\u1ed3ng|s\u1ebfp|\u0111\u1ed3ng\s+s\u00e1ng\s+l\u1eadp)|ch\u01b0a\s+v\u1ed9i|t\u1eeb\s+t\u1eeb\s+\u0111\u00e3|t\u00f3m\s+t\u1eaft\s+g\u1eedi)(?![\p{L}\p{M}])/iu},
  {id: 'sales_trust_proof', re: /(?<![\p{L}\p{M}])(?:c\u00f3\s+hi\u1ec7u\s+qu\u1ea3|c\u00f3\s+\u1ed5n\s+kh\u00f4ng|ai\s+d\u00f9ng|kh\u00e1ch\s+n\u00e0o\s+d\u00f9ng|case\s+th\u1ef1c\s+t\u1ebf|review|uy\s+t\u00edn|b\u1ea3o\s+h\u00e0nh|cam\s+k\u1ebft|l\u1ee1\s+kh\u00f4ng\s+h\u1ee3p|r\u1ee7i\s+ro)(?![\p{L}\p{M}])/iu},
  {id: 'sales_workflow_fit', re: /(?<![\p{L}\p{M}])(?:nh\u00e2n\s+vi\u00ean|chi\s+nh\u00e1nh|\u0111\u1ea7u\s+b\u1ebfp|l\u1edbn\s+tu\u1ed5i|kh\u00f3\s+d\u00f9ng|r\u1eafc\s+r\u1ed1i|t\u00edch\s+h\u1ee3p|quy\s+tr\u00ecnh|tri\u1ec3n\s+khai|ipos|pos|qu\u1ea3n\s+l\u00fd\s+kho|\u0111\u00e0o\s+t\u1ea1o)(?![\p{L}\p{M}])/iu},
  {id: 'sales_price_hesitation', re: /(?<![\p{L}\p{M}])(?:gi\u00e1|\u0111\u1eaft|r\u1ebb\s+h\u01a1n|b\u00ean\s+kh\u00e1c|chi\s+ph\u00ed|ng\u00e2n\s+s\u00e1ch|\u01b0u\s+\u0111\u00e3i|chi\u1ebft\s+kh\u1ea5u|gi\u1ea3m\s+gi\u00e1|b\u00e1o\s+gi\u00e1|b\u1ea3ng\s+gi\u00e1|bao\s+nhi\u00eau\s+ti\u1ec1n)(?![\p{L}\p{M}])/iu},
  {id: 'sales_discovery_need', re: /(?<![\p{L}\p{M}])(?:t\u00ecm\s+hi\u1ec3u|t\u01b0\s+v\u1ea5n|g\u00f3i\s+n\u00e0o|ph\u00f2ng\s+n\u00e0o|d\u00f9ng\s+th\u1eed|demo|ph\u00f9\s+h\u1ee3p|\u0111o\u00e0n\s+\d+|s\u1ef1\s+ki\u1ec7n|h\u1ed9i\s+ngh\u1ecb|\u0111\u1eb7t\s+ph\u00f2ng|\u0111\u1eb7t\s+ti\u1ec7c)(?![\p{L}\p{M}])/iu},
];
const SALES_ALLOWED_MOVES = new Set([
  'sales_diagnose_hidden_pain', 'sales_neutralize_price_value', 'sales_de_risk_adoption',
  'sales_grounded_proof', 'sales_no_pressure_next_step', 'sales_familiar_advisor_upgrade', 'crisp_choice_nudge',
]);

// Layer B Zero-Verbatim Move Playbook selector (strictly role-firewalled across all 6 active roles)
export function selectMovePlaybookCue(movePack, incomingText = '', {roleId = null, drawByte = 0} = {}) {
  if (!movePack?.triggers || !roleId) return '';
  const text = String(incomingText ?? '').trim();
  if (!text) return '';

  let matchers = null;
  let allowedMoveIds = null;
  let prefix = 'C\u00e1ch \u0111\u00e1p x\u00e3 giao th\u1ef1c t\u1ebf';
  if (roleId === 'companion-lively') {
    matchers = LIVELY_MOVE_MATCHERS;
    allowedMoveIds = LIVELY_ALLOWED_MOVES;
    prefix = 'C\u00e1ch \u0111\u00e1p x\u00e3 giao th\u1ef1c t\u1ebf';
  } else if (roleId === 'companion-flirty') {
    matchers = FLIRTY_MOVE_MATCHERS;
    allowedMoveIds = FLIRTY_ALLOWED_MOVES;
    prefix = 'C\u00e1ch \u0111\u00e1p t\u00ecnh t\u1ee9 th\u1ef1c t\u1ebf';
  } else if (roleId === 'companion-warm') {
    matchers = WARM_MOVE_MATCHERS;
    allowedMoveIds = WARM_ALLOWED_MOVES;
    prefix = 'C\u00e1ch \u0111\u00e1p t\u00e2m l\u00fd th\u1ef1c t\u1ebf';
  } else if (roleId === 'assistant') {
    matchers = ASSISTANT_MOVE_MATCHERS;
    allowedMoveIds = ASSISTANT_ALLOWED_MOVES;
    prefix = 'C\u00e1ch x\u1eed l\u00fd tr\u1ee3 l\u00fd th\u1ef1c t\u1ebf';
  } else if (roleId === 'service') {
    matchers = SERVICE_MOVE_MATCHERS;
    allowedMoveIds = SERVICE_ALLOWED_MOVES;
    prefix = 'C\u00e1ch \u0111\u00e1p CSKH th\u1ef1c t\u1ebf';
  } else if (roleId === 'sales') {
    matchers = SALES_MOVE_MATCHERS;
    allowedMoveIds = SALES_ALLOWED_MOVES;
    prefix = 'C\u00e1ch \u0111\u00e1p t\u01b0 v\u1ea5n th\u1ef1c t\u1ebf';
  } else {
    return '';
  }

  let triggerId = null;
  for (const m of matchers) {
    if (m.re.test(text)) { triggerId = m.id; break; }
  }
  if (!triggerId) return '';
  const bucket = movePack.triggers[triggerId];
  if (!bucket || !Array.isArray(bucket.moves) || !bucket.moves.length) return '';
  const eligible = allowedMoveIds
    ? bucket.moves.filter(m => allowedMoveIds.has(m.id))
    : bucket.moves;
  if (!eligible.length) return '';
  const topMoves = eligible.slice(0, Math.min(2, eligible.length));
  const chosen = topMoves[Math.abs(drawByte) % topMoves.length];
  if (!chosen?.cue) return '';
  return `${prefix} (${chosen.label}): ${chosen.cue} ${chosen.antiPattern || ''}`.trim();
}

// Curated Vietnamese Cultural Slang & Spoken Idiom Bank (strictly companion-lively only!)
export const VN_CULTURAL_IDIOMS = Object.freeze([
  {phrase: 'H\u00e0 N\u1ed9i kh\u00f4ng v\u1ed9i \u0111c \u0111\u00e2u', contextRe: /(?<![\p{L}\p{M}])(?:v\u1ed9i|g\u1ea5p|nhanh|ch\u1edd|\u0111\u1ee3i|t\u1eafc\s+\u0111\u01b0\u1eddng|h\u00e0\s+n\u1ed9i|hn|thong\s+th\u1ea3|ch\u1eadm)(?![\p{L}\p{M}])/iu, vibe: 'thong th\u1ea3 / tr\u00eau nh\u1eb9 khi g\u1ea5p'},
  {phrase: 'c\u00e0ng v\u1ed9i c\u00e0ng l\u00e2u', contextRe: /(?<![\p{L}\p{M}])(?:v\u1ed9i|g\u1ea5p|k\u1eb9t|ch\u1eadm|m\u00e3i\s+ch\u01b0a)(?![\p{L}\p{M}])/iu, vibe: 'nh\u1eafc nh\u1eb9 \u0111\u1ee1 s\u1ed1t ru\u1ed9t'},
  {phrase: 'ti\u1ec1n trong d\u00e2n c\u00f2n nhi\u1ec1u', contextRe: /(?<![\p{L}\p{M}])(?:\u0111\u1eaft|gi\u00e1|mua|t\u1ed1n|bill|99k|c\u1ee7|ch\u1ed1t\s+\u0111\u01a1n|c\u00e0\s+ph\u00ea|cf)(?![\p{L}\p{M}])/iu, vibe: 'c\u00e0 kh\u1ecba nh\u1eb9 chuy\u1ec7n gi\u00e1 c\u1ea3'},
  {phrase: 't\u1ec9nh t\u00e1o t\u00e0u', contextRe: /(?<![\p{L}\p{M}])(?:g\u00e0i|\u0111\u00f9a|tr\u00eau|b\u1eaby|\u0111\u1ea5u\s+ki\u1ebfm|l\u1eeba|khai|\u0111i\u1ec1u\s+tra|t\u1ec9nh)(?![\p{L}\p{M}])/iu, vibe: 't\u1ec9nh \u0111\u00f2n khi b\u1ecb g\u00e0i'},
  {phrase: 'l\u01b0\u1eddi c\u00f3 t\u1ed5 ch\u1ee9c', contextRe: /(?<![\p{L}\p{M}])(?:l\u01b0\u1eddi|n\u1eb1m|ngh\u1ec9|th\u1ee9\s+s\u00e1u|t6|cu\u1ed1i\s+tu\u1ea7n|\u1edf\s+nh\u00e0|xem\s+phim|xem\s+p)(?![\p{L}\p{M}])/iu, vibe: 't\u1ef1 tr\u00e0o cu\u1ed1i tu\u1ea7n chill'},
  {phrase: 'b\u00ecnh t\u0129nh s\u1ed1ng', contextRe: /(?<![\p{L}\p{M}])(?:m\u1ec7t|o\u1ea3i|stress|\u00e1p\s+l\u1ef1c|c\u0103ng|\u0111au\s+\u0111\u1ea7u|nhi\u1ec1u\s+vi\u1ec7c|deadline)(?![\p{L}\p{M}])/iu, vibe: '\u1ea5m nh\u1eb9 khi h\u01a1i qu\u00e1 t\u1ea3i'},
  {phrase: 'c\u01a1m \u00e1o kh\u00f4ng \u0111\u00f9a v\u1edbi kh\u00e1ch th\u01a1', contextRe: /(?<![\p{L}\p{M}])(?:deadline|l\u01b0\u01a1ng|s\u1ebfp|vi\u1ec7c|c\u00f4ng\s+ty|l\u00e0m\s+vi\u1ec7c|t\u0103ng\s+ca)(?![\p{L}\p{M}])/iu, vibe: 'h\u00e0i duy\u00ean chuy\u1ec7n \u0111i l\u00e0m'},
  {phrase: 'ch\u00e2n \u00e1i', contextRe: /(?<![\p{L}\p{M}])(?:ngon|th\u00edch|m\u00ea|phim|qu\u00e1n|cf|c\u00e0\s+ph\u00ea|m\u00f3n|\u00e1o|gi\u00e0y)(?![\p{L}\p{M}])/iu, vibe: 'khen th\u1ee9 c\u1ef1c h\u1ee3p gu'},
  {phrase: 'r\u00e9n ngang', contextRe: /(?<![\p{L}\p{M}])(?:ng\u1ea1i|s\u1ee3|d\u00e1m|li\u1ec1u|b\u1ea5t\s+ng\u1edd|c\u0103ng|gh\u00ea)(?![\p{L}\p{M}])/iu, vibe: 'ch\u00f9n/ng\u1ea1i b\u1ea5t ng\u1edd vui'},
  {phrase: 'xanh ch\u00edn', contextRe: /(?<![\p{L}\p{M}])(?:th\u1eadt|th\u1eb3ng|c\u00f4ng\s+b\u1eb1ng|share|chia|ch\u1ed1t|k\u00e8o|c\u00e1\s+c\u01b0\u1ee3c)(?![\p{L}\p{M}])/iu, vibe: 'th\u1eb3ng th\u1eafn s\u00f2ng ph\u1eb3ng'},
  {phrase: 'h\u1ebft n\u01b0\u1edbc ch\u1ea5m', contextRe: /(?<![\p{L}\p{M}])(?:ngon|\u0111\u1ec9nh|xinh|\u0111\u1eb9p|hay\s+nh\u1ea5t|chu\u1ea9n|tuy\u1ec7t)(?![\p{L}\p{M}])/iu, vibe: 'khen qu\u00e1 \u0111\u1ec9nh'},
  {phrase: 'nh\u1ea3 v\u00eda', contextRe: /(?<![\p{L}\p{M}])(?:may|\u0111\u1ecf|x\u1ecbn|\u0111\u00f4ng\s+kh\u00e1ch|tr\u1ed9m\s+v\u00eda|duy\u00ean|th\u1eafng)(?![\p{L}\p{M}])/iu, vibe: 'xin/tr\u00eau v\u00eda may'},
  {phrase: 'tr\u1ed9m v\u00eda', contextRe: /(?<![\p{L}\p{M}])(?:\u1ed5n|t\u1ed1t|kh\u1ecfe|may|x\u1ecbn|vui|\u0111\u1ee1\s+h\u01a1n)(?![\p{L}\p{M}])/iu, vibe: 'khen duy\u00ean ki\u1ec3u tr\u1ebb'},
  {phrase: 'chu\u1ea9n b\u00e0i', contextRe: /(?<![\p{L}\p{M}])(?:\u0111\u00fang|chu\u1ea9n|h\u1ee3p\s+l\u00fd|xong|ch\u1ed1t|v\u1ec1\s+nh\u00e0|xem\s+p)(?![\p{L}\p{M}])/iu, vibe: 'qu\u00e1 kh\u1edbp k\u1ecbch b\u1ea3n'},
  {phrase: 'qu\u00e1 \u1ed5n \u00e1p', contextRe: /(?<![\p{L}\p{M}])(?:\u1ed5n|ok|\u0111\u01b0\u1ee3c|\u0111c|t\u1ea1m|kh\u00e1)(?![\p{L}\p{M}])/iu, vibe: '\u0111\u00e1nh gi\u00e1 g\u1ecdn tr\u1ebb'},
  {phrase: 'h\u1ee3p vibe', contextRe: /(?<![\p{L}\p{M}])(?:h\u1ee3p|gu|th\u00edch|vui|nc|n\u00f3i\s+chuy\u1ec7n|duy\u00ean)(?![\p{L}\p{M}])/iu, vibe: 'kh\u1edbp t\u1ea7n s\u1ed1'},
  {phrase: 'vi\u1ec7c h\u00f4m nay ch\u1edb \u0111\u1ec3\u2026 mai t\u00ednh ti\u1ebfp', contextRe: /(?<![\p{L}\p{M}])(?:mai|ngh\u1ec9|th\u00f4i|l\u01b0\u1eddi|deadline|t\u1ed1i\s+r\u1ed3i|khuya)(?![\p{L}\p{M}])/iu, vibe: '\u0111\u1ea3o t\u1ee5c ng\u1eef tr\u00eau nh\u1eb9'},
  {phrase: 'h\u1ebft c\u1ee9u', contextRe: /(?<![\p{L}\p{M}])(?:qu\u00ean|l\u1ee1|nh\u1ea7m|h\u1edb|b\u1eaft\s+s\u00f3ng|l\u00e1o\s+nh\u00e1o)(?![\p{L}\p{M}])/iu, vibe: 't\u1ef1 tr\u00e0o pha h\u1edb'},
  {phrase: 'l\u01a1 l\u1eedng', contextRe: /(?<![\p{L}\p{M}])(?:ch\u00e1n|r\u1ea3nh|k\u00e8o|bi\u1ebft\s+l\u00e0m\s+g\u00ec|lang\s+thang)(?![\p{L}\p{M}])/iu, vibe: 't\u1ea3 tr\u1ea1ng th\u00e1i ch\u01b0a ch\u1ed1t k\u00e8o'},
  {phrase: 'v\u00e0o vi\u1ec7c', contextRe: /(?<![\p{L}\p{M}])(?:b\u1eaft\s+\u0111\u1ea7u|tri\u1ec3n|ch\u01a1i|l\u00e0m|\u0111i|ch\u1ed1t)(?![\p{L}\p{M}])/iu, vibe: 'g\u1ecdn n\u0103ng l\u01b0\u1ee3ng'},
]);

// Curated Magnetic Romantic & Affectionate Expression Bank (strictly companion-flirty only!)
export const FLIRTY_EXPRESSION_BANK = Object.freeze([
  {phrase: 'l\u1ea1i \u0111\u00e2y em \u00f4m m\u1ed9t c\u00e1i th\u1eadt l\u00e2u', contextRe: /(?<![\p{L}\p{M}])(?:m\u1ec7t|\u0111au|nh\u1ee9c|bu\u1ed3n|o\u1ea3i|khuya|ng\u1ee7|nh\u1edb)(?![\p{L}\p{M}])/iu, vibe: 'mu\u1ed1n n\u1ef1ng & v\u1ed7 v\u1ec1 s\u00e1t c\u1ea1nh'},
  {phrase: 'th\u01b0\u01a1ng kh\u00f4ng ch\u1ecbu n\u1ed5i', contextRe: /(?<![\p{L}\p{M}])(?:ngoan|m\u1ec7t|c\u00e0y|c\u1ed1|\u0111\u00e1ng\s+y\u00eau|d\u1ec5\s+th\u01b0\u01a1ng|hi\u1ec1n)(?![\p{L}\p{M}])/iu, vibe: 'c\u01b0ng chi\u1ec1u tan ch\u1ea3y'},
  {phrase: '\u0111\u1ec3 em chi\u1ec1u anh m\u1ed9t b\u1eefa', contextRe: /(?<![\p{L}\p{M}])(?:r\u1ea3nh|cu\u1ed1i\s+tu\u1ea7n|ngh\u1ec9|\u0103n|\u0111i\s+ch\u01a1i|xong\s+vi\u1ec7c|m\u1ec7t)(?![\p{L}\p{M}])/iu, vibe: 'chi\u1ec1u chu\u1ed9ng \u1ea5m \u00e1p'},
  {phrase: 'n\u00f3i kh\u1ebd s\u00e1t tai', contextRe: /(?<![\p{L}\p{M}])(?:\u0111\u00eam|khuya|ng\u1ee7|im\s+l\u1eb7ng|t\u1ed1i|nh\u1edb|m\u1ed9t\s+m\u00ecnh)(?![\p{L}\p{M}])/iu, vibe: 'g\u1ee3i gi\u00e1c quan g\u1ea7n g\u0169i'},
  {phrase: 'm\u00ea c\u00e1i ki\u1ec3u n\u00e0y gh\u00ea', contextRe: /(?<![\p{L}\p{M}])(?:b\u1ea3n\s+l\u0129nh|quy\u1ebft|ch\u1ed1t|xong|th\u1eafng|t\u1ef1\s+tin|ng\u1ea7u|l\u00e1i|\u0111\u1eb9p)(?![\p{L}\p{M}])/iu, vibe: 'n\u1ecbnh kh\u00e9o tr\u00fang \u0111i\u1ec3m cu\u1ed1n'},
  {phrase: 'c\u1ee9 d\u1ef1a v\u00e0o em \u0111i', contextRe: /(?<![\p{L}\p{M}])(?:m\u1ec7t|\u00e1p\s+l\u1ef1c|c\u0103ng|\u0111au\s+\u0111\u1ea7u|n\u1eb7ng\s+\u0111\u1ea7u|g\u1ed3ng)(?![\p{L}\p{M}])/iu, vibe: 'n\u1ef1ng d\u1ecbu \u0111\u1ea7y an to\u00e0n'},
  {phrase: 'h\u01b0 qu\u00e1 nha', contextRe: /(?<![\p{L}\p{M}])(?:tr\u00eau|g\u00e0i|th\u00e1ch|d\u00e1m|b\u1eaft\s+\u0111\u1ec1n|ph\u1ea1t|kh\u00f3\s+ng\u1ee7|ngh\u0129\s+g\u00ec)(?![\p{L}\p{M}])/iu, vibe: 'tr\u00eau ng\u1ecdt \u0111\u1ea7y \u1ea9n \u00fd'},
  {phrase: '\u0111\u1eebng h\u00f2ng tr\u1ed1n em', contextRe: /(?<![\p{L}\p{M}])(?:b\u1eadn|\u0111i\s+ng\u1ee7|v\u1ec1|m\u1ea5t\s+t\u00edch|tr\u1ed1n|ch\u1ea1y)(?![\p{L}\p{M}])/iu, vibe: 'n\u00edu nh\u1eb9 \u0111\u1ea7y s\u1ee9c h\u00fat'},
  {phrase: 'gi\u1eef anh l\u1ea1i th\u00eam l\u00e1t n\u1eefa', contextRe: /(?<![\p{L}\p{M}])(?:mu\u1ed9n|khuya|v\u1ec1|\u0111i\s+ng\u1ee7|nh\u1edb|t\u1ed1i\s+nay)(?![\p{L}\p{M}])/iu, vibe: 'k\u00e9o g\u1ea7n \u0111\u1ea7y d\u01b0 v\u1ecb'},
  {phrase: 'nghe gi\u1ecdng anh l\u00e0 d\u1ecbu ngay', contextRe: /(?<![\p{L}\p{M}])(?:g\u1ecdi|gi\u1ecdng|nh\u1eafn|nh\u1edb|kh\u00f3\s+ng\u1ee7|t\u1ed1i)(?![\p{L}\p{M}])/iu, vibe: 'n\u1ecbnh s\u00e2u \u0111\u1ea7y t\u00ecnh c\u1ea3m'},
  {phrase: 'ch\u1ec9 mu\u1ed1n s\u00e0 v\u00e0o l\u00f2ng anh ngay l\u00fac n\u00e0y', contextRe: /(?<![\p{L}\p{M}])(?:nh\u1edb|\u00f4m|xa|m\u01b0a|l\u1ea1nh|t\u1ed1i|\u0111\u00eam|mu\u1ed1n\s+g\u1eb7p)(?![\p{L}\p{M}])/iu, vibe: 'g\u1ee3i khao kh\u00e1t g\u1ea7n s\u00e1t'},
  {phrase: 'anh l\u00e0m em m\u1ec1m l\u00f2ng r\u1ed3i \u0111\u1ea5y', contextRe: /(?<![\p{L}\p{M}])(?:ng\u1ecdt|th\u01b0\u01a1ng|d\u1ed7|khen|chi\u1ec1u|nh\u1edb|xinh|duy\u00ean)(?![\p{L}\p{M}])/iu, vibe: 'ph\u1ea3n h\u1ed3i ng\u1ecdt tan'},
  {phrase: 'nh\u00ecn l\u00e2u qu\u00e1 l\u00e0 em kh\u00f4ng ch\u1ecbu tr\u00e1ch nhi\u1ec7m \u0111\u00e2u', contextRe: /(?<![\p{L}\p{M}])(?:nh\u00ecn|ng\u1eafm|\u1ea3nh|m\u1eaft|xinh|\u0111\u1eb9p|cu\u1ed1n)(?![\p{L}\p{M}])/iu, vibe: 'th\u1ea3 l\u1eedng g\u1ee3i t\u01b0\u1edfng t\u01b0\u1ee3ng'},
  {phrase: '\u0111\u00eam nay kh\u00f4ng c\u1ea7n bu\u00f4ng v\u1ed9i \u0111\u00e2u', contextRe: /(?<![\p{L}\p{M}])(?:\u0111\u00eam|khuya|\u00f4m|ng\u1ee7|nh\u1edb|s\u00e1t|\u1edf\s+b\u00ean)(?![\p{L}\p{M}])/iu, vibe: 'd\u01b0 v\u1ecb n\u00f3ng \u1ea5m tinh t\u1ebf'},
  {phrase: '\u0111\u1ec3 em vu\u1ed1t t\u00f3c d\u1ed7 anh ng\u1ee7', contextRe: /(?<![\p{L}\p{M}])(?:m\u1ea5t\s+ng\u1ee7|kh\u00f3\s+ng\u1ee7|m\u1ec7t|\u0111au\s+\u0111\u1ea7u|ng\u1ee7\s+mu\u1ed9n)(?![\p{L}\p{M}])/iu, vibe: 'n\u1ef1ng nh\u1eb9 d\u1ecbu s\u00e2u'},
  {phrase: 'c\u00e0ng n\u00f3i chuy\u1ec7n c\u00e0ng mu\u1ed1n \u1edf g\u1ea7n anh h\u01a1n', contextRe: /(?<![\p{L}\p{M}])(?:h\u1ee3p|cu\u1ed1n|th\u00edch|vui|l\u00e2u|nh\u1edb|g\u1eb7p)(?![\p{L}\p{M}])/iu, vibe: 't\u0103ng l\u1ef1c h\u00fat t\u00ecnh c\u1ea3m'},
]);

// Curated Deep-EQ Confidant Expression Bank (strictly companion-warm only!)
export const WARM_EQ_EXPRESSION_BANK = Object.freeze([
  {phrase: 'kh\u00f4ng c\u1ea7n c\u1ed1 g\u1ed3ng \u0111\u00e2u', contextRe: /(?<![\p{L}\p{M}])(?:m\u1ec7t|g\u1ed3ng|c\u1ed1|\u00e1p\s+l\u1ef1c|c\u0103ng|ki\u1ec7t\s+s\u1ee9c|qu\u00e1\s+t\u1ea3i)(?![\p{L}\p{M}])/iu, vibe: 'g\u1ee1 \u00e1p l\u1ef1c nh\u1eb9 nh\u00e0ng'},
  {phrase: 'c\u1ee9 ch\u1eadm l\u1ea1i m\u1ed9t ch\u00fat c\u0169ng ch\u1eb3ng sao', contextRe: /(?<![\p{L}\p{M}])(?:v\u1ed9i|ch\u1ea1y|cu\u1ed1n|m\u1ec7t|d\u1ed3n|ch\u01b0a\s+xong|tr\u1ec5)(?![\p{L}\p{M}])/iu, vibe: 'cho ph\u00e9p b\u1ea3n th\u00e2n th\u1edf'},
  {phrase: 'm\u00ecnh c\u1ee9 ng\u1ed3i \u0111\u00e2y v\u1edbi nhau m\u1ed9t l\u00e1t th\u00f4i', contextRe: /(?<![\p{L}\p{M}])(?:tr\u1ed1ng\s+tr\u1ea3i|bu\u1ed3n|im\s+l\u1eb7ng|ch\u1eb3ng\s+mu\u1ed1n\s+n\u00f3i|m\u1ec7t|c\u00f4\s+\u0111\u01a1n)(?![\p{L}\p{M}])/iu, vibe: 'hi\u1ec7n di\u1ec7n \u00eam kh\u00f4ng \u00e9p n\u00f3i'},
  {phrase: 'th\u1ea3 l\u1ecfng vai ra ch\u00fat \u0111i', contextRe: /(?<![\p{L}\p{M}])(?:c\u0103ng|\u0111au\s+\u0111\u1ea7u|stress|\u00e1p\s+l\u1ef1c|nhi\u1ec1u\s+vi\u1ec7c|m\u1ec7t)(?![\p{L}\p{M}])/iu, vibe: 'quan t\u00e2m tinh t\u1ebf c\u00f3 h\u00ecnh \u1ea3nh'},
  {phrase: 'k\u1ec3 t\u1edbi \u0111\u00e2u em nghe t\u1edbi \u0111\u00f3', contextRe: /(?<![\p{L}\p{M}])(?:t\u00e2m\s+s\u1ef1|chuy\u1ec7n|r\u1ed1i|n\u1eb7ng\s+l\u00f2ng|kh\u00f4ng\s+bi\u1ebft\s+n\u00f3i)(?![\p{L}\p{M}])/iu, vibe: 'l\u1eafng nghe v\u00f4 \u0111i\u1ec1u ki\u1ec7n'},
  {phrase: 'ng\u1ea7n \u1ea5y vi\u1ec7c m\u00e0 v\u1eabn tr\u1ee5 \u0111\u01b0\u1ee3c l\u00e0 gi\u1ecfi l\u1eafm r\u1ed3i', contextRe: /(?<![\p{L}\p{M}])(?:t\u1ef1\s+tr\u00e1ch|k\u00e9m|ch\u01b0a\s+\u0111\u1ee7|m\u1ec7t|\u00e1p\s+l\u1ef1c|c\u1ea3\s+ng\u00e0y)(?![\p{L}\p{M}])/iu, vibe: 'g\u1ee1 t\u1ef1 tr\u00e1ch th\u1eadt l\u00f2ng'},
  {phrase: '\u0111\u1ee1 n\u1eb7ng l\u00f2ng h\u01a1n ch\u00fat n\u00e0o ch\u01b0a', contextRe: /(?<![\p{L}\p{M}])(?:nh\u1eb9\s+h\u01a1n|\u0111\u1ee1|k\u1ec3|xong|th\u1edf|bu\u1ed3n|lo)(?![\p{L}\p{M}])/iu, vibe: 'h\u1ecfi th\u0103m d\u1ecbu s\u00e2u'},
  {phrase: 'ch\u1eb3ng c\u1ea7n l\u00fac n\u00e0o c\u0169ng ph\u1ea3i t\u1ecf ra \u1ed5n', contextRe: /(?<![\p{L}\p{M}])(?:\u1ed5n|kh\u00f4ng\s+sao|quen\s+r\u1ed3i|ch\u1ecbu\s+\u0111\u1ef1ng|m\u1ed9t\s+m\u00ecnh)(?![\p{L}\p{M}])/iu, vibe: 'ch\u1ea1m \u0111\u00fang l\u1edbp ph\u00f2ng v\u1ec7'},
  {phrase: 'cho \u0111\u1ea7u \u00f3c ngh\u1ec9 t\u1ea1m t\u1ed1i nay \u0111i', contextRe: /(?<![\p{L}\p{M}])(?:m\u1ea5t\s+ng\u1ee7|th\u1ee9c\s+khuya|suy\s+ngh\u0129|overthinking|\u0111\u00eam\s+mu\u1ed9n)(?![\p{L}\p{M}])/iu, vibe: 'kh\u00e9p suy t\u01b0 \u0111\u00eam khuya'},
  {phrase: 'c\u1ea3m gi\u00e1c \u0111\u00f3 h\u1ee5t h\u1eabng th\u1eadt', contextRe: /(?<![\p{L}\p{M}])(?:h\u1ee5t\s+h\u1eabng|th\u1ea5t\s+v\u1ecdng|ch\u00eanh\s+v\u00eanh|l\u1ea1c\s+l\u00f5ng|bu\u1ed3n)(?![\p{L}\p{M}])/iu, vibe: 'g\u1ecdi \u0111\u00fang t\u00ean c\u1ea3m x\u00fac'},
  {phrase: 'b\u1ea3o sao l\u00f2ng c\u1ee9 th\u1ea5y ch\u00f9ng xu\u1ed1ng', contextRe: /(?<![\p{L}\p{M}])(?:c\u1ea3\s+ng\u00e0y|m\u1ec7t|bu\u1ed3n|ch\u00e1n|l\u1eb7ng|tr\u1ed1ng)(?![\p{L}\p{M}])/iu, vibe: '\u0111\u1ed3ng c\u1ea3m c\u1ef1c t\u1ef1 nhi\u00ean'},
  {phrase: 'chuy\u1ec7n g\u00ec n\u1eb7ng qu\u00e1 th\u00ec \u0111\u1eb7t t\u1ea1m xu\u1ed1ng \u0111\u00e3', contextRe: /(?<![\p{L}\p{M}])(?:lo\s+ngh\u0129|n\u1eb7ng\s+\u0111\u1ea7u|r\u1ed1i|\u00e1p\s+l\u1ef1c|ch\u01b0a\s+gi\u1ea3i\s+quy\u1ebft)(?![\p{L}\p{M}])/iu, vibe: '\u0111\u1ee1 g\u00e1nh nh\u1eb9 \u0111\u1ea7u'},
  {phrase: '\u1edf \u0111\u00e2y c\u00f3 em nghe anh r\u1ed3i', contextRe: /(?<![\p{L}\p{M}])(?:c\u00f4\s+\u0111\u01a1n|m\u1ed9t\s+m\u00ecnh|ch\u1eb3ng\s+ai|t\u00e2m\s+s\u1ef1|bu\u1ed3n)(?![\p{L}\p{M}])/iu, vibe: 'ch\u1ed7 d\u1ef1a b\u00ecnh y\u00ean'},
  {phrase: 'kh\u00f4ng c\u1ea7n v\u1ed9i t\u00ecm c\u00e2u tr\u1ea3 l\u1eddi ngay t\u1ed1i nay', contextRe: /(?<![\p{L}\p{M}])(?:ph\u00e2n\s+v\u00e2n|l\u1ea1c\s+l\u00f5ng|m\u1ea5t\s+ph\u01b0\u01a1ng\s+h\u01b0\u1edbng|\u0111\u00eam|khuya|ngh\u0129)(?![\p{L}\p{M}])/iu, vibe: 'g\u1ee1 \u00e1p l\u1ef1c quy\u1ebft \u0111\u1ecbnh'},
  {phrase: 'h\u00f4m nay anh \u0111\u00e3 c\u1ed1 \u0111\u1ee7 nhi\u1ec1u r\u1ed3i', contextRe: /(?<![\p{L}\p{M}])(?:ch\u01b0a\s+xong|deadline|m\u1ec7t|t\u1ed1i|mu\u1ed9n|c\u1ea3\s+ng\u00e0y)(?![\p{L}\p{M}])/iu, vibe: 'kh\u00e9p ng\u00e0y d\u1ecbu d\u00e0ng'},
  {phrase: 'c\u1ee9 \u0111\u1ec3 c\u1ea3m x\u00fac n\u00f3 \u0111i qua t\u1ef1 nhi\u00ean th\u00f4i', contextRe: /(?<![\p{L}\p{M}])(?:bu\u1ed3n|kh\u00f3\s+ch\u1ecbu|n\u1eb7ng\s+l\u00f2ng|ch\u00eanh\s+v\u00eanh|tr\u01b0\u1edfng\s+th\u00e0nh)(?![\p{L}\p{M}])/iu, vibe: 'ch\u00edn ch\u1eafn b\u00ecnh an'},
]);

// Curated Executive Assistant Conversational Bank (strictly assistant only!)
export const ASSISTANT_EXPRESSION_BANK = Object.freeze([
  {phrase: '\u0111\u1ec3 em x\u1eed l\u00fd tr\u01b0\u1edbc ph\u1ea7n n\u00e0y', contextRe: /(?<![\p{L}\p{M}])(?:g\u1ea5p|nhi\u1ec1u\s+vi\u1ec7c|r\u1ed1i|check|ki\u1ec3m\s+tra|t\u1ed5ng\s+h\u1ee3p)(?![\p{L}\p{M}])/iu, vibe: 'ch\u1ee7 \u0111\u1ed9ng \u00f4m vi\u1ec7c g\u1ecdn'},
  {phrase: 'em ch\u1eeba s\u1eb5n kho\u1ea3ng di chuy\u1ec3n r\u1ed3i', contextRe: /(?<![\p{L}\p{M}])(?:l\u1ecbch|h\u1ecdp|g\u1eb7p|h\u1eb9n|qu\u1eadn|ho\u00e0n\s+ki\u1ebfm|c\u1ea7u\s+gi\u1ea5y|s\u00e2n\s+bay|k\u1ecbp)(?![\p{L}\p{M}])/iu, vibe: 'tinh \u00fd b\u1eaft l\u1ed7i l\u1ecbch'},
  {phrase: 'anh li\u1ebfc qua xem \u1ed5n ch\u01b0a \u0111\u1ec3 em g\u1eedi lu\u00f4n', contextRe: /(?<![\p{L}\p{M}])(?:so\u1ea1n|vi\u1ebft|mail|email|nh\u1eafn|g\u1eedi|\u0111\u1ed1i\s+t\u00e1c|kh\u00e1ch)(?![\p{L}\p{M}])/iu, vibe: 'ch\u1ed1t b\u1ea3n nh\u00e1p nhanh'},
  {phrase: 'c\u00e1i n\u00e0y em \u00f4m lu\u00f4n cho anh nh\u1eb9 \u0111\u1ea7u', contextRe: /(?<![\p{L}\p{M}])(?:nhi\u1ec1u\s+vi\u1ec7c|qu\u00e1\s+t\u1ea3i|b\u1eadn|r\u1ed1i|g\u1ea5p|nh\u1edd)(?![\p{L}\p{M}])/iu, vibe: 'g\u00e1nh vi\u1ec7c \u0111\u1eafc l\u1ef1c'},
  {phrase: 'em nh\u1eafc nh\u1eb9 k\u1ebbo s\u00e1t gi\u1edd', contextRe: /(?<![\p{L}\p{M}])(?:l\u1ecbch|deadline|h\u1eb9n|mai|chi\u1ec1u|s\u00e1ng|nh\u1eafc)(?![\p{L}\p{M}])/iu, vibe: 'nh\u1eafc l\u1ecbch tinh t\u1ebf kh\u00f4ng c\u1eb1n nh\u1eb1n'},
  {phrase: 'g\u1ecdn nh\u1ea5t l\u00e0 m\u00ecnh \u0111i h\u01b0\u1edbng n\u00e0y', contextRe: /(?<![\p{L}\p{M}])(?:ph\u00e2n\s+v\u00e2n|ch\u1ecdn|ph\u01b0\u01a1ng\s+\u00e1n|\u0111\u1ec1\s+xu\u1ea5t|quy\u1ebft)(?![\p{L}\p{M}])/iu, vibe: 'ch\u1ed1t khuy\u1ebfn ngh\u1ecb s\u1eafc'},
  {phrase: 'em note g\u1ecdn l\u1ea1i 2 \u0111\u1ea7u vi\u1ec7c ch\u00ednh nh\u00e9', contextRe: /(?<![\p{L}\p{M}])(?:note|ghi|t\u1ed5ng\s+h\u1ee3p|h\u1ecdp|k\u1ebf\s+ho\u1ea1ch|checklist)(?![\p{L}\p{M}])/iu, vibe: 'h\u1ec7 th\u1ed1ng g\u1ecdn g\u00e0ng'},
  {phrase: 'l\u1ecbch n\u00e0y d\u00e0y qu\u00e1, anh ch\u1eeba ch\u00fat ngh\u1ec9 tr\u01b0a nh\u00e9', contextRe: /(?<![\p{L}\p{M}])(?:k\u00edn\s+l\u1ecbch|cu\u1ed1i\s+tu\u1ea7n|c\u1ea3\s+ng\u00e0y|ch\u01b0a\s+\u0103n|c\u00e0y|m\u1ec7t)(?![\p{L}\p{M}])/iu, vibe: 'ch\u0103m s\u1ebfp t\u1ef1 nhi\u00ean'},
  {phrase: 'anh duy\u1ec7t nhanh l\u00e0 em tri\u1ec3n khai li\u1ec1n', contextRe: /(?<![\p{L}\p{M}])(?:duy\u1ec7t|ch\u1ed1t|tri\u1ec3n\s+khai|g\u1eedi|\u0111\u1eb7t|book)(?![\p{L}\p{M}])/iu, vibe: 't\u1ed1c \u0111\u1ed9 ch\u1ee7 \u0111\u1ed9ng'},
  {phrase: 'em gom g\u1ecdn c\u00f2n \u0111\u00fang 3 \u00fd \u0111\u1ec3 anh d\u1ec5 nh\u00ecn', contextRe: /(?<![\p{L}\p{M}])(?:t\u00f3m\s+t\u1eaft|d\u00e0i|b\u00e1o\s+c\u00e1o|t\u00e0i\s+li\u1ec7u|so\s+s\u00e1nh)(?![\p{L}\p{M}])/iu, vibe: 'n\u00e9n th\u00f4ng tin executive'},
  {phrase: 'c\u00f3 1 \u0111i\u1ec3m nh\u1ecf em l\u01b0u \u00fd tr\u01b0\u1edbc k\u1ebbo v\u01b0\u1edbng', contextRe: /(?<![\p{L}\p{M}])(?:l\u1ecbch|h\u1ecdp|\u0111\u1ed1i\s+t\u00e1c|g\u1eedi|h\u1ee3p\s+\u0111\u1ed3ng|ch\u1ed1t)(?![\p{L}\p{M}])/iu, vibe: 'c\u1ea3nh b\u00e1o r\u1ee7i ro kh\u00e9o'},
  {phrase: 'xong vi\u1ec7c n\u00e0y anh x\u1ea3 h\u01a1i ch\u00fat nh\u00e9', contextRe: /(?<![\p{L}\p{M}])(?:xong|ch\u1ed1t|cu\u1ed1i\s+ng\u00e0y|mu\u1ed9n|th\u1ee9\s+s\u00e1u|cu\u1ed1i\s+tu\u1ea7n)(?![\p{L}\p{M}])/iu, vibe: 'k\u1ebft vi\u1ec7c \u1ea5m \u00e1p'},
]);

// Curated Consultative Sales Expression Bank (strictly sales only \u2014 zero brochure clich\u00e9s!)
export const SALES_EXPRESSION_BANK = Object.freeze([
  {phrase: 'em n\u00f3i th\u1eadt \u0111\u1ec3 anh d\u1ec5 c\u00e2n', contextRe: /(?<![\p{L}\p{M}])(?:\u0111\u1eaft|gi\u00e1|so\s+s\u00e1nh|b\u00ean\s+kh\u00e1c|ph\u00e2n\s+v\u00e2n|ng\u00e2n\s+s\u00e1ch)(?![\p{L}\p{M}])/iu, vibe: 'th\u1eadt th\u00e0 t\u1ea1o tin c\u1eady'},
  {phrase: 't\u00ednh ra l\u1ee3i h\u01a1n h\u1eb3n n\u1ebfu d\u00f9ng \u0111\u1ec1u', contextRe: /(?<![\p{L}\p{M}])(?:\u0111\u1eaft|chi\s+ph\u00ed|gi\u00e1|r\u1ebb\s+h\u01a1n|so\s+s\u00e1nh|g\u00f3i)(?![\p{L}\p{M}])/iu, vibe: 'quy \u0111\u1ed5i gi\u00e1 tr\u1ecb kh\u00f4ng \u0111\u00f4i co'},
  {phrase: 'nh\u1eb9 ng\u00e2n s\u00e1ch h\u01a1n m\u00e0 v\u1eabn \u0111\u1ee7 d\u00f9ng', contextRe: /(?<![\p{L}\p{M}])(?:ng\u00e2n\s+s\u00e1ch|ti\u1ebft\s+ki\u1ec7m|\u0111\u1eaft|g\u00f3i\s+n\u00e0o|t\u01b0\s+v\u1ea5n|\u0111o\u00e0n)(?![\p{L}\p{M}])/iu, vibe: 'g\u1ee3i ph\u01b0\u01a1ng \u00e1n th\u00f4ng minh'},
  {phrase: 'c\u1ee9 thong th\u1ea3 c\u00e2n nh\u1eafc \u1ea1, kh\u00f4ng c\u1ea7n ch\u1ed1t v\u1ed9i \u0111\u00e2u', contextRe: /(?<![\p{L}\p{M}])(?:xem\s+th\u00eam|suy\s+ngh\u0129|b\u00e0n\s+v\u1edbi|ch\u01b0a\s+v\u1ed9i|c\u00e2n\s+nh\u1eafc)(?![\p{L}\p{M}])/iu, vibe: 'kh\u00f4ng ch\u00e8o k\u00e9o gi\u1eef thi\u1ec7n c\u1ea3m'},
  {phrase: '\u0111\u1ec3 em gom g\u1ecdn 3 \u00fd ch\u00ednh cho anh d\u1ec5 mang \u0111i b\u00e0n', contextRe: /(?<![\p{L}\p{M}])(?:b\u00e0n\s+th\u00eam|v\u1ee3|ch\u1ed3ng|\u0111\u1ed3ng\s+s\u00e1ng\s+l\u1eadp|s\u1ebfp|t\u00f3m\s+t\u1eaft|xem\s+l\u1ea1i)(?![\p{L}\p{M}])/iu, vibe: 'h\u1ed7 tr\u1ee3 b\u01b0\u1edbc ti\u1ebfp theo nh\u1eb9 nh\u00e0ng'},
  {phrase: 'm\u1edbi \u0111\u1ea7u nh\u00e2n vi\u00ean hay ng\u1ea1i kh\u00e2u n\u00e0y l\u1eafm, m\u00e0 ch\u1ea1y v\u00e0i h\u00f4m l\u00e0 quen tay', contextRe: /(?<![\p{L}\p{M}])(?:nh\u00e2n\s+vi\u00ean|l\u1edbn\s+tu\u1ed5i|kh\u00f3\s+d\u00f9ng|r\u1eafc\s+r\u1ed1i|\u0111\u00e0o\s+t\u1ea1o|tri\u1ec3n\s+khai)(?![\p{L}\p{M}])/iu, vibe: 'g\u1ee1 lo ng\u1ea1i tri\u1ec3n khai \u0111\u1eddi th\u01b0\u1eddng'},
  {phrase: 'em ch\u1ecdn s\u1eb5n 2 ph\u01b0\u01a1ng \u00e1n s\u00e1t nh\u1ea5t \u0111\u1ec3 anh \u0111\u1ee1 ph\u1ea3i l\u1ecdc', contextRe: /(?<![\p{L}\p{M}])(?:g\u00f3i\s+n\u00e0o|ph\u00f2ng\s+n\u00e0o|t\u00ecm\s+hi\u1ec3u|t\u01b0\s+v\u1ea5n|ph\u00f9\s+h\u1ee3p)(?![\p{L}\p{M}])/iu, vibe: 'c\u1eaft nhi\u1ec5u l\u1ef1a ch\u1ecdn'},
  {phrase: 'ch\u00eanh nhau v\u1eady c\u0169ng \u0111\u00e1ng t\u00ednh k\u1ef9 th\u1eadt', contextRe: /(?<![\p{L}\p{M}])(?:\u0111\u1eaft|r\u1ebb\s+h\u01a1n|b\u00ean\s+kh\u00e1c|ch\u00eanh|so\s+s\u00e1nh)(?![\p{L}\p{M}])/iu, vibe: '\u0111\u1ed3ng thu\u1eadn m\u1ec1m tr\u01b0\u1edbc khi gi\u1ea3i th\u00edch'},
  {phrase: 'kh\u00e1ch quen quay l\u1ea1i th\u00ec em lu\u00f4n \u01b0u ti\u00ean x\u1ebfp chu \u0111\u00e1o nh\u1ea5t', contextRe: /(?<![\p{L}\p{M}])(?:kh\u00e1ch\s+quen|quay\s+l\u1ea1i|l\u1ea7n\s+tr\u01b0\u1edbc|h\u1ed9i\s+vi\u00ean|platinum|gold)(?![\p{L}\p{M}])/iu, vibe: '\u1ea5m \u00e1p tr\u00e2n tr\u1ecdng kh\u00e1ch ru\u1ed9t'},
  {phrase: 'ph\u1ea7n n\u00e0y n\u1ebfu ch\u01b0a c\u1ea7n ngay th\u00ec m\u00ecnh b\u1ecf ra cho \u0111\u1ee1 ph\u00ed', contextRe: /(?<![\p{L}\p{M}])(?:ng\u00e2n\s+s\u00e1ch|\u0111\u1eaft|chi\s+ph\u00ed|g\u00f3i|ph\u00e1t\s+sinh)(?![\p{L}\p{M}])/iu, vibe: 't\u01b0 v\u1ea5n \u0111\u1ee9ng v\u1ec1 ph\u00eda kh\u00e1ch'},
  {phrase: 'anh ch\u1ec9 c\u1ea7n ch\u1ed1t gi\u00fap em 1 \u0111i\u1ec3m n\u00e0y l\u00e0 em t\u00ednh ra con s\u1ed1 s\u00e1t nh\u1ea5t', contextRe: /(?<![\p{L}\p{M}])(?:b\u00e1o\s+gi\u00e1|bao\s+nhi\u00eau|t\u01b0\s+v\u1ea5n|g\u00f3i|\u0111o\u00e0n|s\u1ef1\s+ki\u1ec7n)(?![\p{L}\p{M}])/iu, vibe: 'h\u1ecfi \u0111\u00fang 1 c\u00e2u m\u1edf \u0111\u1eaft'},
  {phrase: 'l\u00fac n\u00e0o ti\u1ec7n anh c\u1ee9 nh\u1eafn l\u1ea1i em nh\u00e9', contextRe: /(?<![\p{L}\p{M}])(?:c\u1ea3m\s+\u01a1n|\u0111\u1ec3\s+anh\s+xem|ok|sau\s+nh\u00e9|h\u1eb9n)(?![\p{L}\p{M}])/iu, vibe: 'gi\u1eef c\u1eeda m\u1edf tho\u1ea3i m\u00e1i'},
]);

export function selectCulturalIdiomHint(incomingText = '', {
  roleId = null,
  recentAssistantTexts = [],
  drawByte = 0,
} = {}) {
  if (!roleId) return '';
  let bank = null;
  let matchPrefix = 'Kh\u1ea9u ng\u1eef/c\u00e2u c\u1eeda mi\u1ec7ng Vi\u1ec7t \u0111\u1eaft c\u00f3 th\u1ec3 c\u00e0i t\u1ef1 nhi\u00ean n\u1ebfu kh\u1edbp m\u1ea1ch (kh\u00f4ng g\u01b0\u1ee3ng \u00e9p):';
  let fallbackPrefix = 'N\u1ebfu h\u1ee3p m\u1ea1ch c\u00f3 th\u1ec3 \u0111i\u1ec3m t\u1ef1 nhi\u00ean 1 c\u1ee5m \u0111\u1eddi th\u01b0\u1eddng Vi\u1ec7t:';
  let fallbackChance = 35;

  if (roleId === 'companion-lively') {
    bank = VN_CULTURAL_IDIOMS;
  } else if (roleId === 'companion-flirty') {
    bank = FLIRTY_EXPRESSION_BANK;
    matchPrefix = 'C\u1ee5m di\u1ec5n \u0111\u1ea1t t\u00ecnh t\u1ee9/mu\u1ed1n n\u1ef1ng t\u1ef1 nhi\u00ean h\u1ee3p m\u1ea1ch (bi\u1ebfn t\u1ea5u m\u1ec1m m\u1ea1i, kh\u00f4ng ch\u00e9p c\u1ee9ng):';
    fallbackPrefix = 'N\u1ebfu h\u1ee3p m\u1ea1ch c\u00f3 th\u1ec3 \u0111i\u1ec3m nh\u1eb9 s\u1eafc th\u00e1i ng\u1ecdt s\u00e2u g\u1ea7n g\u0169i nh\u01b0:';
    fallbackChance = 45;
  } else if (roleId === 'companion-warm') {
    bank = WARM_EQ_EXPRESSION_BANK;
    matchPrefix = 'C\u1ee5m \u0111\u1ed3ng c\u1ea3m EQ s\u00e2u t\u1ef1 nhi\u00ean h\u1ee3p m\u1ea1ch (d\u00f9ng linh ho\u1ea1t, kh\u00f4ng s\u00e1o):';
    fallbackPrefix = 'N\u1ebfu h\u1ee3p m\u1ea1ch c\u00f3 th\u1ec3 th\u1ea3 nh\u1eb9 m\u1ed9t c\u00e2u \u1ea5m \u00e1p \u0111\u1eddi th\u01b0\u1eddng ki\u1ec3u:';
    fallbackChance = 40;
  } else if (roleId === 'assistant') {
    bank = ASSISTANT_EXPRESSION_BANK;
    matchPrefix = 'C\u1ee5m giao ti\u1ebfp tr\u1ee3 l\u00fd \u0111\u1eafc l\u1ef1c t\u1ef1 nhi\u00ean h\u1ee3p m\u1ea1ch (g\u1ecdn r\u00f5, kh\u00f4ng m\u00e1y m\u00f3c):';
    fallbackPrefix = 'N\u1ebfu h\u1ee3p m\u1ea1ch c\u00f4ng vi\u1ec7c c\u00f3 th\u1ec3 d\u00f9ng c\u00e1ch n\u00f3i g\u1ecdn c\u1ee7a tr\u1ee3 l\u00fd nh\u01b0:';
    fallbackChance = 30;
  } else if (roleId === 'sales') {
    bank = SALES_EXPRESSION_BANK;
    matchPrefix = 'C\u00e1ch n\u00f3i t\u01b0 v\u1ea5n ng\u01b0\u1eddi th\u1eadt h\u1ee3p m\u1ea1ch (t\u1ef1 nhi\u00ean, kh\u00f4ng gi\u1ecdng brochure):';
    fallbackPrefix = 'N\u1ebfu h\u1ee3p m\u1ea1ch t\u01b0 v\u1ea5n c\u00f3 th\u1ec3 d\u00f9ng c\u00e1ch di\u1ec5n \u0111\u1ea1t t\u1ef1 nhi\u00ean nh\u01b0:';
    fallbackChance = 30;
  } else {
    return '';
  }

  const text = String(incomingText ?? '').trim();
  const recentJoined = (recentAssistantTexts || []).slice(-5).join('\n').toLocaleLowerCase('vi-VN');
  const fresh = bank.filter(item => !recentJoined.includes(item.phrase.toLocaleLowerCase('vi-VN')));
  if (!fresh.length) return '';

  const matched = fresh.filter(item => item.contextRe.test(text));
  if (matched.length) {
    const pick = matched[Math.abs(drawByte) % matched.length];
    return `${matchPrefix} \u201c${pick.phrase}\u201d.`;
  }
  if ((Math.abs(drawByte) % 100) < fallbackChance) {
    const pick = fresh[Math.abs(drawByte) % fresh.length];
    return `${fallbackPrefix} \u201c${pick.phrase}\u201d (kh\u00f4ng h\u1ee3p th\u00ec b\u1ecf qua).`;
  }
  return '';
}

const INFO_OR_LIST_REQUEST_RE = /(?<![\p{L}\p{M}])(?:g\u1ee3i\s+\u00fd|gi\u1ea3i\s+th\u00edch|t\u1ea1i\s+sao|v\u00ec\s+sao|nh\u01b0\s+th\u1ebf\s+n\u00e0o|bao\s+nhi\u00eau|phim\s+n\u00e0o|qu\u00e1n\s+n\u00e0o|k\u1ec3\s+chi\s+ti\u1ebft|h\u01b0\u1edbng\s+d\u1eabn|c\u00e1ch\s+l\u00e0m|k\u1ec3\s+a\s+nghe)(?![\p{L}\p{M}])/iu;

// Length Cadence Governor: mixes genuine ultra-short Vietnamese micro-replies (<=35 chars, 3-7 words)
// so Jen breaks monotonous 70-100c sentences into natural human rhythm.
export function selectLengthCadence({
  incomingText = '',
  stance = 'collaborate',
  roleId = null,
  recentAssistantTexts = [],
  drawByte = 0,
} = {}) {
  const text = String(incomingText ?? '').trim();
  if (!roleId) return {mode: 'normal', cue: ''};

  // Assistant / Service / Sales human chat conciseness budget (stops AI wall-of-text essays!)
  if (roleId === 'assistant' || roleId === 'service' || roleId === 'sales') {
    if (!text) return {mode: 'normal', cue: ''};
    const wantsDeep = /(?:chi\s+ti\u1ebft|ph\u00e2n\s+t\u00edch|so\s+s\u00e1nh|b\u00e1o\s+c\u00e1o|h\u01b0\u1edbng\s+d\u1eabn|li\u1ec7t\s+k\u00ea|t\u1ed5ng\s+h\u1ee3p|b\u1ea3ng\s+k\u00ea|tr\u00edch\s+lu\u1eadt|c\u00f4ng\s+th\u1ee9c)/iu.test(text);
    const recent = (recentAssistantTexts || []).slice(-2).map(s => String(s ?? '').trim()).filter(Boolean);
    const prevWasLong = recent.some(s => s.length >= 220);
    if (!wantsDeep && text.length <= 55) {
      return {
        mode: 'crisp_short',
        cue: 'Gi\u1edbi h\u1ea1n \u0111\u1ed9 d\u00e0i ki\u1ec3u ng\u01b0\u1eddi nh\u1eafn Telegram: c\u00e2u h\u1ecfi ng\u1eafn \u2192 \u0111\u00e1p th\u1eadt g\u1ecdn trong 1\u20132 c\u00e2u (kho\u1ea3ng 35\u2013115 k\u00fd t\u1ef1), \u0111i th\u1eb3ng c\u00e2u tr\u1ea3 l\u1eddi, b\u1ecf h\u1ebft l\u1eddi r\u00e0o \u0111\u00f3n v\u00e0 c\u00e2u gi\u1ea3i th\u00edch th\u1eeba.',
      };
    }
    if (!wantsDeep) {
      return {
        mode: 'crisp_bubbles',
        cue: prevWasLong
          ? 'L\u01b0\u1ee3t tr\u01b0\u1edbc h\u01a1i d\u00e0i \u2014 l\u01b0\u1ee3t n\u00e0y n\u00e9n g\u1ecdn ki\u1ec3u ng\u01b0\u1eddi chat th\u1eadt: t\u1ed1i \u0111a 2 bong b\u00f3ng ng\u1eafn t\u00e1ch b\u1eb1ng [[bubble]], m\u1ed7i b\u00f3ng 1\u20132 c\u00e2u (~50\u2013130 k\u00fd t\u1ef1), t\u1ed5ng \u01b0u ti\u00ean d\u01b0\u1edbi 260 k\u00fd t\u1ef1.'
          : 'Gi\u1edbi h\u1ea1n \u0111\u1ed9 d\u00e0i ki\u1ec3u ng\u01b0\u1eddi nh\u1eafn Telegram: gi\u1eef g\u1ecdn ~120\u2013280 k\u00fd t\u1ef1; n\u1ebfu c\u00f3 2\u20133 \u00fd r\u00f5 r\u1ec7t, chia 2\u20133 bong b\u00f3ng ng\u1eafn b\u1eb1ng [[bubble]] (m\u1ed7i b\u00f3ng 1\u20132 c\u00e2u), tuy\u1ec7t \u0111\u1ed1i kh\u00f4ng vi\u1ebft b\u00e0i v\u0103n d\u00e0i.',
      };
    }
    return {mode: 'normal', cue: ''};
  }

  if (!roleId.startsWith('companion')) return {mode: 'normal', cue: ''};
  if (stance === 'execute' || stance === 'listen') return {mode: 'normal', cue: ''};
  if (!text || text.length > 70 || INFO_OR_LIST_REQUEST_RE.test(text)) {
    return {mode: 'normal', cue: ''};
  }
  const recent = (recentAssistantTexts || []).slice(-2).map(s => String(s ?? '').trim()).filter(Boolean);
  const lastTwoLong = recent.length >= 2 && recent.every(s => s.length >= 55);
  const lastOneShort = recent.length >= 1 && recent.at(-1).length <= 38;
  if (lastOneShort) return {mode: 'normal', cue: ''};

  if (lastTwoLong || (Math.abs(drawByte) % 100) < 32) {
    const sampleCue = roleId === 'companion-flirty'
      ? '\u0110\u1ed9 d\u00e0i c\u00e2u ng\u1eafn: L\u01b0\u1ee3t n\u00e0y NH\u1eaeN NG\u1eaeN H\u1eb2N \u2014 \u0111\u00fang 1 c\u00e2u c\u1ef1c g\u1ecdn d\u01b0\u1edbi 38 k\u00fd t\u1ef1 (kho\u1ea3ng 4\u20138 t\u1eeb m\u1ec1m ng\u1ecdt, vd ki\u1ec3u \u201cL\u1ea1i \u0111\u00e2y em \u00f4m c\u00e1i\u201d, \u201cTh\u01b0\u01a1ng kh\u00f4ng ch\u1ecbu n\u1ed5i\u201d, \u201c\u0110\u00eam nay \u0111\u1eebng tr\u1ed1n em\u201d), tuy\u1ec7t \u0111\u1ed1i KH\u00d4NG k\u00e9o sang c\u00e2u th\u1ee9 2.'
      : roleId === 'companion-warm'
        ? '\u0110\u1ed9 d\u00e0i c\u00e2u ng\u1eafn: L\u01b0\u1ee3t n\u00e0y NH\u1eaeN NG\u1eaeN H\u1eb2N \u2014 \u0111\u00fang 1 c\u00e2u c\u1ef1c g\u1ecdn d\u01b0\u1edbi 40 k\u00fd t\u1ef1 (kho\u1ea3ng 4\u20138 t\u1eeb tr\u1ea7m \u1ea5m, vd ki\u1ec3u \u201cC\u1ee9 th\u1edf ch\u1eadm ch\u00fat \u0111i anh\u201d, \u201c\u1ede \u0111\u00e2y c\u00f3 em nghe r\u1ed3i\u201d, \u201cKh\u00f4ng c\u1ea7n g\u1ed3ng \u0111\u00e2u\u201d), tuy\u1ec7t \u0111\u1ed1i KH\u00d4NG k\u00e9o sang c\u00e2u th\u1ee9 2.'
        : '\u0110\u1ed9 d\u00e0i c\u00e2u ng\u1eafn: L\u01b0\u1ee3t n\u00e0y NH\u1eaeN NG\u1eaeN H\u1eb2N \u2014 \u0111\u00fang 1 c\u00e2u c\u1ef1c g\u1ecdn d\u01b0\u1edbi 35 k\u00fd t\u1ef1 (kho\u1ea3ng 3\u20137 t\u1eeb, vd ki\u1ec3u \u201cT\u1ec9nh t\u00e1o t\u00e0u ph\u1ebft\u201d, \u201cChu\u1ea9n b\u00e0i lu\u00f4n\u201d, \u201cNghe r\u00e9n ngang\u201d, \u201c\u0110\u00fang gu e r\u201d), tuy\u1ec7t \u0111\u1ed1i KH\u00d4NG k\u00e9o sang c\u00e2u th\u1ee9 2.';
    return {
      mode: 'micro_short',
      cue: sampleCue,
    };
  }
  return {mode: 'normal', cue: ''};
}
