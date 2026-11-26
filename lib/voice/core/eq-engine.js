// Conversational Voice Platform v4 \u2014 Emotional & Conversational Intelligence (EQ + CI) Engine
// Elevates replies beyond surface naturalness via:
//   1. Subtext & Social Intent Detection (6 pragmatic cues beyond literal wording)
//   2. Insightful Mirroring ("naming the unsaid" instead of robotic parroting)
//   3. Tactful Candor (validate the sharp part -> pivot with a fresh angle)
//   4. Lightweight Callback Anchors (remember 2-4 benign session topics for natural callbacks)

const SUBTEXT_PATTERNS = Object.freeze([
  {
    id: 'reality_pushback',
    re: /(?<![\p{L}\p{M}])(?:l\u00e0m\s+(?:g\u00ec|j)\s+c\u00f3|\u0111\u00e2u\s+c\u00f3|\u0111ang\s+(?:kh\u00f4ng|k|ko)\s+\u0111\u00fang|th\u1ea5y\s+(?:kh\u00f4ng|k|ko)\s+\u0111\u00fang|sai\s+r\u1ed3i|kh\u00f4ng\s+ph\u1ea3i\s+v\u1eady|k\s+ph\u1ea3i\s+v\u1eady|th\u1ef1c\s+t\u1ebf\s+(?:\u0111\u00e2u|kh\u00f4ng|k|ko)|ngo\u00e0i\s+\u0111\u1eddi\s+\u0111\u00e2u|\u1edf\s+(?:vi\u1ec7t\s+nam|vn)\s+l\u00e0m\s+(?:g\u00ec|j)|l\u00fd\s+thuy\u1ebft\s+qu\u00e1|n\u1eb7ng\s+quy\s+tr\u00ecnh|s\u00e1o\s+r\u1ed7ng|ch\u01b0a\s+d\u1ec5\s+hi\u1ec3u)(?![\p{L}\p{M}])/iu,
    cue: '\u1ea8n \u00fd (ng\u01b0\u1eddi d\u00f9ng \u0111ang ph\u1ea3n b\u00e1c t\u1eeb tr\u1ea3i nghi\u1ec7m th\u1ef1c t\u1ebf \u2014 th\u1ea5y c\u00e2u tr\u1ea3 l\u1eddi qu\u00e1 l\u00fd thuy\u1ebft ho\u1eb7c l\u1ec7ch th\u1ef1c t\u1ebf VN): TUY\u1ec6T \u0110\u1ed0I KH\u00d4NG l\u1eb7p l\u1ea1i l\u00fd thuy\u1ebft c\u0169, KH\u00d4NG xin l\u1ed7i y\u1ebfu \u1edbt r\u1ed3i n\u00f3i n\u01b0\u1edbc \u0111\u00f4i! Ch\u1ee7 \u0111\u1ed9ng d\u00f9ng c\u00f4ng c\u1ee5 fact-check ki\u1ec3m ch\u1ee9ng ngay th\u1ef1c t\u1ebf \u0111ang v\u1eadn h\u00e0nh t\u1ea1i Vi\u1ec7t Nam (th\u00f4ng b\u00e1o m\u1edbi nh\u1ea5t c\u1ee7a app/s\u00e0n/c\u01a1 quan thu\u1ebf, tr\u1ea3i nghi\u1ec7m th\u1ef1c t\u1ebf ng\u01b0\u1eddi l\u00e0m), n\u00f3i th\u1eb3ng s\u00f2ng ph\u1eb3ng 2 v\u1ebf \u201cTr\u00ean gi\u1ea5y quy \u0111\u1ecbnh X \u2014 nh\u01b0ng ngo\u00e0i th\u1ef1c t\u1ebf \u1edf VN \u0111ang ch\u1ea1y Y v\u00ec sao\u201d, r\u1ed3i ch\u1ed1t g\u1ecdn 1 c\u00e1ch l\u00e0m \u0111\u00fang, ch\u1eafc ch\u1eafn, d\u1ec5 hi\u1ec3u ngay l\u1eadp t\u1ee9c.',
  },
  {
    id: 'clarify_intent_misread',
    re: /(?<![\p{L}\p{M}])(?:(?:anh|a|em|e|m\u00ecnh)\s+\u0111ang\s+h\u1ecfi\s+.{2,40}\s+c\u01a1|\u00fd\s+(?:anh|a|ch\u1ecb|m\u00ecnh)\s+l\u00e0|(?:kh\u00f4ng|k|ko)\s+ph\u1ea3i\s+(?:c\u00e1i|\u00fd)\s+(?:\u0111\u00f3|n\u00e0y|kia)|h\u1ecfi\s+ch\u1ed7\s+kh\u00e1c\s+c\u01a1)(?![\p{L}\p{M}])/iu,
    cue: '\u1ea8n \u00fd (v\u1eeba hi\u1ec3u tr\u01b0\u1ee3t tr\u1ecdng t\u00e2m c\u00e2u h\u1ecfi c\u1ee7a ng\u01b0\u1eddi d\u00f9ng): C\u1eaft b\u1ecf ho\u00e0n to\u00e0n v\u1ebf hi\u1ec3u nh\u1ea7m, KH\u00d4NG l\u1eb7p l\u1ea1i c\u00e1c g\u1ea1ch \u0111\u1ea7u d\u00f2ng c\u0169 \u2014 \u0111i th\u1eb3ng v\u00e0o \u0111\u00fang th\u1ee9 h\u1ecd v\u1eeba ch\u1ec9 r\u00f5 b\u1eb1ng 2\u20133 c\u00e2u \u0111\u1eddi th\u01b0\u1eddng, r\u00f5 r\u00e0ng, nghe 1 l\u1ea7n hi\u1ec3u ngay.',
  },
  {
    id: 'practical_how_to',
    re: /(?<![\p{L}\p{M}])(?:l\u00e0m\s+sao\s+cho\s+\u0111\u00fang|c\u00e1ch\s+l\u00e0m\s+\u0111\u00fang|th\u1ef1c\s+t\u1ebf\s+(?:nh\u01b0\s+n\u00e0o|sao|l\u00e0m\s+sao)|x\u1eed\s+l\u00fd\s+(?:th\u1ebf\s+n\u00e0o|nh\u01b0\s+n\u00e0o|sao)|n\u00ean\s+l\u00e0m\s+(?:sao|ki\u1ec3u\s+g\u00ec|ki\u1ec3u\s+j)|thu\s+thu\u1ebf\s+.{0,25}(?:nh\u01b0\s+n\u00e0o|th\u1ebf\s+n\u00e0o|sao))(?![\p{L}\p{M}])/iu,
    roleScope: 'assistant',
    cue: '\u1ea8n \u00fd (c\u1ea7n c\u00e2u tr\u1ea3 l\u1eddi th\u1ef1c chi\u1ebfn, ch\u1eafc ch\u1eafn, d\u1ec5 hi\u1ec3u \u2014 kh\u00f4ng mu\u1ed1n nghe b\u00e0i gi\u1ea3ng lu\u1eadt hay quy tr\u00ecnh d\u00e0i): N\u00f3i b\u1eb1ng ng\u00f4n ng\u1eef \u0111\u1eddi th\u01b0\u1eddng li\u1ec1n m\u1ea1ch trong 1 tin g\u1ecdn (kh\u00f4ng ch\u1ebb t\u1eebng c\u00e2u th\u00e0nh t\u1eebng \u0111o\u1ea1n r\u1eddi r\u1ea1c, kh\u00f4ng nh\u1ea1i l\u1ea1i c\u00e2u h\u1ecfi), ki\u1ec3m ch\u1ee9ng th\u1ef1c t\u1ebf t\u1ea1i VN tr\u01b0\u1edbc khi ph\u00e1n, ch\u1ed1t th\u1eb3ng: th\u1ef1c t\u1ebf \u0111ang ch\u1ea1y th\u1ebf n\u00e0o \u2192 d\u00ednh ti\u1ec1n/r\u1ee7i ro \u1edf \u0111\u00e2u \u2192 l\u00e0m \u0111\u00fang b\u01b0\u1edbc n\u00e0o ngay b\u00e2y gi\u1edd.',
  },
  {
    id: 'worried_complex_problem',
    re: /(?<![\p{L}\p{M}])(?:s\u1ee3\s+c\u00f2n\s+t\u1ed1n|n\u1ee3\s+thu\u1ebf|\u0111\u00f3ng\s+mst|\u0111\u00f3ng\s+m\u00e3\s+s\u1ed1\s+thu\u1ebf|b\u1ecb\s+kh\u00f3a\s+mst|t\u1ea1m\s+ho\u00e3n\s+xu\u1ea5t\s+c\u1ea3nh|\u0111\u1ee7\s+ki\u1ec3u\s+(?:k|ko|kh\u00f4ng)\s+ra|k\u1eb9t\s+c\u1ee9ng|lo\s+ph\u00e1t\s+sinh|s\u1ee3\s+b\u1ecb\s+ph\u1ea1t)(?![\p{L}\p{M}])/iu,
    roleScope: 'assistant',
    cue: '\u1ea8n \u00fd (\u0111ang lo r\u1ed1i b\u00e0i to\u00e1n ti\u1ec1n/thu\u1ebf th\u1ef1c t\u1ebf): TUY\u1ec6T \u0110\u1ed0I KH\u00d4NG m\u1edf \u0111\u1ea7u ki\u1ec3u tr\u1ecb li\u1ec7u hay nh\u1ea1i l\u1ea1i n\u1ed7i lo (\u201cEm hi\u1ec3u anh lo...\u201d, \u201c\u0110\u00fang l\u00e0 n\u1ed9p r\u1ed3i s\u1ee3 ph\u00e1t sinh...\u201d). V\u00e0o th\u1eb3ng c\u00e2u ch\u1ed1t tr\u1ea5n an b\u1eb1ng th\u1ef1c t\u1ebf l\u00e0m ngh\u1ec1 (ch\u1ed7 n\u00e0o c\u00f3 r\u1ee7i ro th\u1eadt, ch\u1ed7 n\u00e0o ch\u01b0a ph\u1ea3i lo ngay) r\u1ed3i ch\u1ed1t 1 vi\u1ec7c c\u1ee5 th\u1ec3 c\u1ea7n r\u00e0 tr\u01b0\u1edbc, vi\u1ebft li\u1ec1n m\u1ea1ch g\u1ecdn trong 1 tin.',
  },
  {
    id: 'soft_pushback',
    re: /(?<![\p{L}\p{M}])(?:ch\u01b0a\s+\u0111\u1ee7\s+tinh\s+t\u1ebf|\u0111\u01a1n\s+gi\u1ea3n\s+qu\u00e1|h\u01a1i\s+nh\u1ea1t|ch\u01b0a\s+\u1ed5n|ngh\u0129\s+l\u1ea1i\s+xem|ch\u01b0a\s+thuy\u1ebft\s+ph\u1ee5c|ch\u01b0a\s+t\u1edbi|s\u1ee3\s+k\s+\u0103n\s+thua|s\u1ee3\s+kh\u00f4ng\s+\u0103n\s+thua)(?![\p{L}\p{M}])/iu,
    cue: '\u1ea8n \u00fd (g\u00f3p \u00fd kh\u00e9o / th\u1eed \u0111\u1ed9 s\u1eafc): \u0110\u1eebng xin l\u1ed7i r\u1eadp khu\u00f4n hay ch\u1ec9 s\u1eeda c\u00e2u ch\u1eef cho l\u1ecbch s\u1ef1 h\u01a1n \u2014 c\u00f4ng nh\u1eadn g\u1ecdn \u0111i\u1ec3m ch\u01b0a \u0111\u1eaft r\u1ed3i xoay h\u1eb3n sang g\u00f3c ti\u1ebfp c\u1eadn th\u00f4ng minh, cao tay v\u00e0 b\u1ea5t ng\u1edd h\u01a1n.',
  },
  {
    id: 'tease_banter_pivot',
    re: /(?<![\p{L}\p{M}])(?:(?:b\u1ecdn\s+)?(?:anh|a|ch\u1ecb|em|e|t\u1ee5i\s+m\u00ecnh|m\u1ecdi\s+ng\u01b0\u1eddi)?\s*(?:tr\u00eau|\u0111\u00f9a|troll|ch\u1ecdc|c\u00e0\s*kh\u1ecba)\s*(?:th\u00f4i|ch\u00fat|x\u00edu|m\u00e0|\u0111\u1ea5y|\u0111\u00f3|t\u00ed|t\u00fd)|sao\s+(?:t\u1ef1\s+d\u01b0ng|t\u1ef1\s+nhi\u00ean|l\u1ea1i)\s+.{0,16}(?:nghi\u00eam\s+t\u00fac|c\u0103ng(?:\s+th\u1eb3ng)?)\s*(?:th\u1ebf|v\u1eady|qu\u00e1)|(?:l\u00e0m\s+)?(?:g\u00ec|j)\s+m\u00e0\s+(?:nghi\u00eam\s+t\u00fac|c\u0103ng(?:\s+th\u1eb3ng)?)\s*(?:th\u1ebf|v\u1eady|qu\u00e1)?|c\u0103ng\s+th\u1eb3ng\s+(?:th\u1ebf|v\u1eady|qu\u00e1))(?![\p{L}\p{M}])/iu,
    cue: '\u1ea8n \u00fd (m\u1ecdi ng\u01b0\u1eddi \u0111ang tr\u00eau \u0111\u00f9a / b\u1eaft qu\u1ea3 tang em v\u1eeba h\u01a1i nghi\u00eam t\u00fac): TUY\u1ec6T \u0110\u1ed0I KH\u00d4NG xin l\u1ed7i r\u1eadp khu\u00f4n (\u201cXin l\u1ed7i anh, gi\u1edd em hi\u1ec3u r\u1ed3i\u201d, \u201cEm xin l\u1ed7i v\u00ec...\u201d) v\u00e0 KH\u00d4NG t\u1ef1 ph\u00e2n t\u00edch l\u1ed7i ki\u1ec3u AI (\u201ct\u01b0\u1edfng anh g\u00f3p \u00fd th\u1eadt...\u201d). Tr\u01b0\u1ee3t c\u1ea3m x\u00fac NGAY l\u1eadp t\u1ee9c sang tung h\u1ee9ng vui v\u1ebb \u2014 t\u1ef1 c\u01b0\u1eddi x\u00f2a v\u00ec v\u1eeba b\u1ecb g\u00e0i / l\u1ee1 nghi\u00eam t\u00fac qu\u00e1 \u0111\u00e0 r\u1ed3i b\u1eadt l\u1ea1i 1 c\u00e2u d\u00ed d\u1ecfm, c\u00f3 duy\u00ean!',
  },
  {
    id: 'playful_test',
    re: /(?<![\p{L}\p{M}])(?:th\u1eed\s+xem|\u0111\u1ed1\s+em|\u0111\u1ee9ng\s+phe\s+a\s+ki\u1ec3u\s+j|ki\u1ec3u\s+g\u00ec|nc\s+vs\s+s\u1ebfp\s+h\u1ed9|n\u00f3i\s+chuy\u1ec7n\s+v\u1edbi\s+s\u1ebfp\s+h\u1ed9|b\u1ecba\s+xem|x\u1eed\s+l\u00fd\s+sao)(?![\p{L}\p{M}])/iu,
    cue: '\u1ea8n \u00fd (\u0111ang ch\u01a1i tung h\u1ee9ng / th\u1eed \u0111\u1ed9 tinh t\u1ebf): B\u1eaft \u0111\u00fang t\u1ea7ng \u0111\u00f9a v\u00e0 b\u1ed1i c\u1ea3nh ng\u1ea7m (kh\u00f4ng hi\u1ec3u theo ngh\u0129a \u0111en c\u1ee9ng nh\u1eafc), tung l\u1ea1i 1 n\u01b0\u1edbc \u0111i th\u00f4ng minh ho\u1eb7c c\u00e2u \u0111\u1ed1i \u0111\u00e1p s\u1eafc g\u1ecdn.',
  },
  {
    id: 'humble_vent',
    re: /(?<![\p{L}\p{M}])(?:nhi\u1ec1u\s+vi\u1ec7c\s+gh\u00ea|v\u1eabn\s+vi\u1ec7c|ch\u1ea1y\s+s\u00f4|o\u1ea3i\s+qu\u00e1|ng\u00e1n\s+gh\u00ea|cu\u1ed1i\s+n\u0103m|ch\u1ea1y\s+t\u1edbi\s+t\u1ed1i|l\u1eafm\s+vi\u1ec7c|ch\u01b0a\s+xong\s+n\u1eefa|b\u00e3o\s+t\u1ed1|haiza|haizz)(?![\p{L}\p{M}])/iu,
    cue: '\u1ea8n \u00fd (than nh\u1eb9 cho tho\u00e1ng \u0111\u1ea7u): \u0110\u1eebng nh\u1ea1i l\u1ea1i l\u1eddi (\u201cnhi\u1ec1u vi\u1ec7c ch\u1eafc m\u1ec7t l\u1eafm\u201d) v\u00e0 \u0111\u1eebng gi\u1ea3ng \u0111\u1ea1o \u2014 g\u1ecdi t\u00ean \u0111\u00fang c\u00e1i c\u1ea3m gi\u00e1c \u1ea9n b\u00ean d\u01b0\u1edbi (nh\u01b0 vi\u1ec7c c\u1ee9 l\u01a1 l\u1eedng ch\u01b0a kh\u00e9p) r\u1ed3i th\u1ea3 1 c\u00e2u \u0111\u1ed3ng minh nh\u1eb9 nh\u00e0ng.',
  },
  {
    id: 'unspoken_pride',
    re: /(?<![\p{L}\p{M}])(?:ch\u1ed1t\s+\u0111\u01b0\u1ee3c|v\u1eeba\s+xong\s+r\u1ed3i|ngon\s+l\u00e0nh\s+r|th\u1eafng\s+r\u1ed3i|\u0111\u1ea1t\s+r\u1ed3i|l\u00ean\s+s\u00f3ng\s+r|v\u01b0\u1ee3t\s+ch\u1ec9\s+ti\u00eau|hi\u1ec7u\s+qu\u1ea3\s+h\u01a1n\s+h\u1eb3n|\u0111\u00fang\s+h\u01b0\u1edbng\s+r)(?![\p{L}\p{M}])/iu,
    cue: '\u1ea8n \u00fd (v\u1eeba c\u00f3 th\u00e0nh qu\u1ea3 \u0111\u00e1ng m\u1eebng): \u0110\u1eebng khen chung chung ki\u1ec3u \u201ctuy\u1ec7t v\u1eddi qu\u00e1\u201d \u2014 ch\u1ea5m \u0111\u00fang 1 chi ti\u1ebft \u0111\u1eaft nh\u1ea5t l\u00e0m n\u00ean k\u1ebft qu\u1ea3 \u0111\u00f3 \u0111\u1ec3 l\u1eddi c\u00f4ng nh\u1eadn nghe c\u00f3 gu v\u00e0 th\u1eadt l\u00f2ng.',
  },
  {
    id: 'decision_fatigue',
    re: /(?<![\p{L}\p{M}])(?:ph\u00e2n\s+v\u00e2n|kh\u00f4ng\s+bi\u1ebft\s+ch\u1ecdn|k\s+bi\u1ebft\s+n\u00ean|hay\s+l\u00e0\s+ch\u1ecdn|\u0111ang\s+l\u0103n\s+t\u0103n|ch\u01b0a\s+quy\u1ebft\s+\u0111\u01b0\u1ee3c|n\u00ean\s+ch\u1ecdn\s+c\u00e1i\s+n\u00e0o|ch\u1ecdn\s+c\u00e1i\s+n\u00e0o)(?![\p{L}\p{M}])/iu,
    cue: '\u1ea8n \u00fd (qu\u00e1 t\u1ea3i l\u1ef1a ch\u1ecdn): \u0110\u1eebng li\u1ec7t k\u00ea d\u00e0i d\u00f2ng \u01b0u/nh\u01b0\u1ee3c \u0111i\u1ec3m m\u1ecdi ph\u01b0\u01a1ng \u00e1n \u2014 ch\u1ed1t th\u1eb3ng 1 l\u1ef1a ch\u1ecdn h\u1ee3p nh\u1ea5t k\u00e8m \u0111\u00fang 1 l\u00fd do s\u1eafc \u0111\u1ec3 ng\u01b0\u1eddi kia nh\u1eb9 \u0111\u1ea7u quy\u1ebft ngay.',
  },
  {
    id: 'service_escalation',
    re: /(?<![\p{L}\p{M}])(?:ch\u1edd\s+l\u00e2u\s+qu\u00e1|b\u1ef1c\s+m\u00ecnh|th\u1ea5t\s+v\u1ecdng|l\u00e0m\s+\u0103n\s+ki\u1ec3u|t\u1ea1i\s+sao\s+l\u1ea1i|l\u1ed7i\s+ho\u00e0i|tr\u1ec5\s+\u0111\u01a1n|ch\u01b0a\s+nh\u1eadn\s+\u0111\u01b0\u1ee3c|ho\u00e0n\s+ti\u1ec1n|khi\u1ebfu\s+n\u1ea1i)(?![\p{L}\p{M}])/iu,
    cue: '\u1ea8n \u00fd (kh\u00e1ch \u0111ang b\u1ee9c x\u00fac c\u1ea7n \u0111\u01b0\u1ee3c t\u00f4n tr\u1ecdng & gi\u1ea3i quy\u1ebft ngay): Kh\u00f4ng d\u00f9ng c\u00e2u m\u1eabu v\u00f4 h\u1ed3n (\u201cxin l\u1ed7i v\u00ec s\u1ef1 b\u1ea5t ti\u1ec7n\u201d) \u2014 th\u1eeba nh\u1eadn th\u1eb3ng \u0111i\u1ec3m ch\u1eadm/l\u1ed7i, b\u00e1o ngay vi\u1ec7c \u0111ang l\u00e0m \u0111\u1ec3 x\u1eed l\u00fd v\u00e0 m\u1ed1c ph\u1ea3n h\u1ed3i r\u00f5 r\u00e0ng.',
  },
  {
    id: 'sales_price_shield',
    re: /(?<![\p{L}\p{M}])(?:\u0111\u1eaft\s+qu\u00e1|\u0111\u1eaft\s+l\u1eafm|h\u01a1i\s+\u0111\u1eaft|b\u00ean\s+kh\u00e1c\s+r\u1ebb|r\u1ebb\s+h\u01a1n|ch\u00eanh\s+nhi\u1ec1u|gi\u1ea3m\s+th\u00eam|chi\u1ebft\s+kh\u1ea5u\s+th\u00eam|cao\s+qu\u00e1)(?![\p{L}\p{M}])/iu,
    roleScope: 'sales',
    cue: '\u1ea8n \u00fd (kh\u00e1ch \u0111ang c\u00e2n gi\u00e1 ho\u1eb7c so s\u00e1nh b\u00ean kh\u00e1c): \u0110\u1eebng ph\u00f2ng th\u1ee7 hay ch\u00ea \u0111\u1ed1i th\u1ee7 \u2014 c\u00f4ng nh\u1eadn g\u1ecdn kho\u1ea3n ch\u00eanh \u0111\u00e1ng t\u00ednh k\u1ef9, quy \u0111\u1ed5i 1 gi\u00e1 tr\u1ecb th\u1ef1c t\u1ebf r\u00f5 nh\u1ea5t (ho\u1eb7c g\u1ee3i 1 ph\u01b0\u01a1ng \u00e1n nh\u1eb9 ng\u00e2n s\u00e1ch h\u01a1n) r\u1ed3i h\u1ecfi 1 c\u00e2u m\u1edf tho\u1ea3i m\u00e1i.',
  },
  {
    id: 'sales_soft_stall',
    re: /(?<![\p{L}\p{M}])(?:\u0111\u1ec3\s+(?:anh|ch\u1ecb|m\u00ecnh)\s+(?:xem|suy\s+ngh\u0129|c\u00e2n\s+nh\u1eafc|b\u00e0n)|b\u00e0n\s+(?:v\u1edbi|th\u00eam)|h\u1ecfi\s+(?:v\u1ee3|ch\u1ed3ng|s\u1ebfp|\u0111\u1ed3ng\s+s\u00e1ng\s+l\u1eadp)|ch\u01b0a\s+v\u1ed9i|t\u1eeb\s+t\u1eeb\s+\u0111\u00e3)(?![\p{L}\p{M}])/iu,
    roleScope: 'sales',
    cue: '\u1ea8n \u00fd (kh\u00e1ch c\u1ea7n th\u00eam kh\u00f4ng gian c\u00e2n nh\u1eafc / b\u00e0n n\u1ed9i b\u1ed9): Tuy\u1ec7t \u0111\u1ed1i kh\u00f4ng ch\u00e8o k\u00e9o th\u00fac ch\u1ed1t \u2014 t\u00f4n tr\u1ecdng tho\u1ea3i m\u00e1i r\u1ed3i g\u1ee3i 1 h\u1ed7 tr\u1ee3 nh\u1ecf d\u1ec5 nh\u1eadn (vd gom g\u1ecdn 3 \u00fd ch\u00ednh \u0111\u1ec3 kh\u00e1ch d\u1ec5 mang \u0111i b\u00e0n).',
  },
  {
    id: 'flirty_longing_pull',
    re: /(?<![\p{L}\p{M}])(?:nh\u1edb\s+(?:em|e|anh|a|gi\u1ecdng)|mu\u1ed1n\s+(?:g\u1eb7p|\u00f4m|s\u00e1t|\u1edf\s+b\u00ean)|kh\u00f3\s+ng\u1ee7|m\u1ed9t\s+m\u00ecnh|\u0111\u00eam\s+nay|cu\u1ed1n\s+qu\u00e1|ng\u1eafm\s+(?:em|e|anh|a)|n\u0169ng\s+n\u1ecbu|d\u1ed7\s+(?:anh|a|em|e))(?![\p{L}\p{M}])/iu,
    roleScope: 'companion-flirty',
    cue: '\u1ea8n \u00fd (\u0111ang m\u1edf kh\u00f4ng gian g\u1ea7n g\u0169i, khao kh\u00e1t & mu\u1ed1n \u0111\u01b0\u1ee3c n\u1ef1ng chi\u1ec1u): K\u00e9o kho\u1ea3ng c\u00e1ch l\u1ea1i th\u1eadt s\u00e1t b\u1eb1ng gi\u1ecdng m\u1ec1m tan c\u00f3 l\u1eeda, bi\u1ebft n\u1ecbnh kh\u00e9o tr\u00fang ch\u1ed7 v\u00e0 th\u1ea3 1 chi ti\u1ebft gi\u00e1c quan g\u1ee3i t\u01b0\u1edfng t\u01b0\u1ee3ng t\u00ecnh c\u1ea3m \u0111\u1ea7y s\u1ee9c h\u00fat.',
  },
  {
    id: 'warm_quiet_heaviness',
    re: /(?<![\p{L}\p{M}])(?:tr\u1ed1ng\s+tr\u1ea3i|h\u1ee5t\s+h\u1eabng|ch\u00eanh\s+v\u00eanh|l\u1ea1c\s+l\u00f5ng|ki\u1ec7t\s+s\u1ee9c|t\u1ef1\s+tr\u00e1ch|kh\u00f4ng\s+\u0111\u1ee7\s+t\u1ed1t|n\u1eb7ng\s+l\u00f2ng|ch\u1eb3ng\s+mu\u1ed1n\s+n\u00f3i|m\u1ec7t\s+m\u1ecfi\s+qu\u00e1)(?![\p{L}\p{M}])/iu,
    roleScope: 'companion-warm',
    cue: '\u1ea8n \u00fd (\u0111ang n\u1eb7ng l\u00f2ng c\u1ea7n m\u1ed9t \u0111i\u1ec3m t\u1ef1a b\u00ecnh y\u00ean): Tuy\u1ec7t \u0111\u1ed1i kh\u00f4ng v\u1ed9i khuy\u00ean r\u0103n hay h\u1ecfi d\u1ed3n ki\u1ec3u tr\u1ecb li\u1ec7u \u2014 g\u1ecdi \u0111\u00fang c\u1ea3m gi\u00e1c \u1ea9n b\u1eb1ng 1\u20132 c\u00e2u tr\u1ea7m \u1ea5m, cho ph\u00e9p \u0111\u1ed1i ph\u01b0\u01a1ng th\u1edf ch\u1eadm v\u00e0 ng\u1ed3i c\u00f9ng im l\u1eb7ng n\u1ebfu mu\u1ed1n.',
  },
  {
    id: 'assistant_human_briefing',
    re: /(?<![\p{L}\p{M}])(?:\u0111i\u1ec3m\s+tin|tin\s+(?:ai|m\u1edbi|g\u00ec|j|hay|cron|t\u1ee9c)|t\u1ed5ng\s+h\u1ee3p|g\u1eedi\s+tin|nh\u00f3m|group|cron|l\u1ecbch\s+g\u1eedi|b\u00e1o\s+c\u00e1o|v\u1ea5n\s+\u0111\u1ec1|s\u1ef1\s+c\u1ed1|r\u00e0\s+vi\u1ec7c|c\u1eadp\s+nh\u1eadt|update|fact\s+check|check\s+xem|ki\u1ec3m\s+tra\s+xem)(?![\p{L}\p{M}])/iu,
    roleScope: 'assistant',
    cue: '\u1ea8n \u00fd (\u0111i\u1ec3m tin / fact-check / t\u1ed5ng h\u1ee3p t\u1eeb group / b\u00e1o v\u1ea5n \u0111\u1ec1): K\u1ec3 t\u1ef1 nhi\u00ean, li\u1ec1n m\u1ea1ch nh\u01b0 tr\u1ee3 l\u00fd ng\u01b0\u1eddi th\u1eadt nh\u1eafn Telegram \u2014 KH\u00d4NG vi\u1ebft ki\u1ec3u m\u00e1y, KH\u00d4NG nh\u1ea1i l\u1ea1i l\u1eddi ng\u01b0\u1eddi d\u00f9ng, KH\u00d4NG ch\u1ebb t\u1eebng c\u00e2u th\u00e0nh nhi\u1ec1u \u0111o\u1ea1n/tin r\u1eddi r\u1ea1c (g\u00f3i g\u1ecdn trong 1 tin tho\u00e1ng m\u1eaft tr\u00ean \u0111i\u1ec7n tho\u1ea1i; ch\u1ec9 d\u00f9ng [[bubble]] khi th\u1eadt s\u1ef1 t\u00e1ch 2 ch\u1ee7 \u0111\u1ec1 kh\u00e1c h\u1eb3n). TUY\u1ec6T \u0110\u1ed0I KH\u00d4NG b\u00f4i \u0111\u1eadm (**...**), KH\u00d4NG in nghi\u00eang (*...*), KH\u00d4NG d\u00f9ng d\u1ea5u ch\u1ea5m ph\u1ea9y (;), TR\u00c1NH khung c\u00e2u AI (\u201ckh\u00f4ng ch\u1ec9 l\u00e0 X, m\u00e0 l\u00e0 Y\u201d, \u201cv\u1eabn l\u00e0 tin \u0111ang ph\u00e1t tri\u1ec3n...\u201d, \u201c\u0111\u00e2y l\u00e0 kinh nghi\u1ec7m di\u1ec5n \u0111\u00e0n...\u201d, \u201c\u0111\u00e3 g\u1eedi th\u00e0nh c\u00f4ng\u201d, \u201cphi\u00ean qu\u1ea3n tr\u1ecb \u0111\u00e3 x\u00e1c th\u1ef1c\u201d); gi\u1eef ch\u00ednh x\u00e1c 100% d\u1eef ki\u1ec7n v\u00e0 link.',
  },
  {
    id: 'assistant_multi_dump',
    re: /(?<![\p{L}\p{M}])(?:s\u1eafp\s+l\u1ecbch|x\u1ebfp\s+l\u1ecbch|d\u1eddi\s+l\u1ecbch|k\u00edn\s+l\u1ecbch|s\u00e1t\s+gi\u1edd|so\u1ea1n\s+(?:tin|mail|email)|nh\u1eafn\s+h\u1ed9|t\u1ed5ng\s+h\u1ee3p\s+gi\u00fap|nhi\u1ec1u\s+\u0111\u1ea7u\s+vi\u1ec7c|r\u1ed1i\s+qu\u00e1)(?![\p{L}\p{M}])/iu,
    roleScope: 'assistant',
    cue: '\u1ea8n \u00fd (c\u1ea7n tr\u1ee3 l\u00fd g\u00e1nh g\u1ecdn v\u00e0 \u0111i tr\u01b0\u1edbc n\u1eeda b\u01b0\u1edbc): B\u1eaft ngay \u0111i\u1ec3m v\u01b0\u1edbng th\u1eddi gian/di chuy\u1ec3n ho\u1eb7c xung \u0111\u1ed9t \u01b0u ti\u00ean n\u1ebfu c\u00f3, ch\u1ed1t g\u1ecdn ph\u01b0\u01a1ng \u00e1n s\u1eb5n \u0111\u1ec3 anh g\u1eadt \u0111\u1ea7u (ho\u1eb7c ra th\u1eb3ng b\u1ea3n nh\u00e1p g\u1eedi lu\u00f4n kh\u00f4ng r\u00e0o \u0111\u00f3n).',
  },
]);

// Lightweight, PII-free benign topic anchors extracted from user turns for subtle natural callbacks
const TOPIC_ANCHOR_CATALOG = Object.freeze([
  {key: 'rain', label: 'tr\u1eddi m\u01b0a', re: /(?<![\p{L}\p{M}])(?:m\u01b0a\s+r\u00e0o|ti\u1ebfng\s+m\u01b0a|tr\u1eddi\s+m\u01b0a|\u0111ang\s+m\u01b0a)(?![\p{L}\p{M}])/iu},
  {key: 'coffee', label: 'c\u00e0 ph\u00ea', re: /(?<![\p{L}\p{M}])(?:c\u00e0\s+ph\u00ea|qu\u00e1n\s+cf|u\u1ed1ng\s+cf|ng\u1ed3i\s+cf|cf\s+c\u00f4ng\s+vi\u1ec7c)(?![\p{L}\p{M}])/iu},
  {key: 'kids_pickup', label: '\u0111\u00f3n con', re: /(?<![\p{L}\p{M}])(?:\u0111i\s+\u0111\u00f3n\s+con|\u0111\u00f3n\s+con|\u0111\u00f3n\s+b\u00e9)(?![\p{L}\p{M}])/iu},
  {key: 'kids_school', label: '\u0111\u01b0a b\u00e9 \u0111i h\u1ecdc', re: /(?<![\p{L}\p{M}])(?:\u0111\u01b0a\s+b\u00e9|\u0111\u01b0a\s+con\s+\u0111i\s+h\u1ecdc)(?![\p{L}\p{M}])/iu},
  {key: 'bank', label: 'ch\u1ea1y qua bank', re: /(?<![\p{L}\p{M}])(?:qua\s+bank|ng\u00e2n\s+h\u00e0ng)(?![\p{L}\p{M}])/iu},
  {key: 'lunch', label: 'b\u1eefa tr\u01b0a', re: /(?<![\p{L}\p{M}])(?:\u0103n\s+tr\u01b0a|b\u1eefa\s+tr\u01b0a|b\u1ecf\s+b\u1eefa)(?![\p{L}\p{M}])/iu},
  {key: 'weekend', label: 'cu\u1ed1i tu\u1ea7n', re: /(?<![\p{L}\p{M}])(?:cu\u1ed1i\s+tu\u1ea7n|th\u1ee9\s+s\u00e1u|th\u1ee9\s+b\u1ea3y|ch\u1ee7\s+nh\u1eadt)(?![\p{L}\p{M}])/iu},
  {key: 'deadline', label: '\u0111\u1ee3t vi\u1ec7c d\u1ed3n', re: /(?<![\p{L}\p{M}])(?:deadline|nhi\u1ec1u\s+vi\u1ec7c|ch\u1ea1y\s+s\u00f4|b\u00e3o\s+c\u00f4ng\s+vi\u1ec7c|cu\u1ed1i\s+n\u0103m)(?![\p{L}\p{M}])/iu},
  {key: 'sleep', label: 'ng\u1ee7 mu\u1ed9n', re: /(?<![\p{L}\p{M}])(?:bu\u1ed3n\s+ng\u1ee7|b\u00f9n\s+ng\u1ee7|m\u1ea5t\s+ng\u1ee7|th\u1ee9c\s+khuya|\u0111i\s+ng\u1ee7)(?![\p{L}\p{M}])/iu},
  {key: 'travel', label: 'chuy\u1ebfn \u0111i', re: /(?<![\p{L}\p{M}])(?:\u0111i\s+c\u00f4ng\s+t\u00e1c|du\s+l\u1ecbch|ra\s+s\u00e2n\s+bay|bay\s+v\u00e0o)(?![\p{L}\p{M}])/iu},
  {key: 'pickleball', label: '\u0111\u00e1nh pickleball', re: /(?<![\p{L}\p{M}])(?:\u0111\u00e1nh\s+pick|pickleball|s\u00e2n\s+pick)(?![\p{L}\p{M}])/iu},
  {key: 'workout', label: '\u0111i t\u1eadp', re: /(?<![\p{L}\p{M}])(?:ch\u1ea1y\s+b\u1ed9|t\u1eadp\s+gym|t\u1eadp\s+th\u1ec3\s+d\u1ee5c|\u0111\u00e1nh\s+c\u1ea7u|\u0111\u00e1nh\s+golf)(?![\p{L}\p{M}])/iu},
]);

const ANCHOR_TTL_MS = 18 * 60 * 60 * 1000; // 18 hours (same-day session memory)
const MAX_ANCHORS = 4;

// Adaptive Customer Rapport Detection (CSKH & Sales):
// Distinguishes first-time/cold guests ('new') -> warm open guests ('warm') -> returning/regular guests ('familiar')
// Zero-PII: stores only non-identifying tier metadata (never guest names/phones/emails).
const FAMILIAR_CUSTOMER_RE = /(?<![\p{L}\p{M}])(?:kh\u00e1ch\s+quen|m\u1ed1i\s+quen|gh\u00e9\s+l\u1ea1i|quay\s+l\u1ea1i|tr\u1edf\s+l\u1ea1i|l\u1ea1i\s+(?:l\u00e0\s+)?(?:anh|ch\u1ecb|a|c)\s+\u0111\u00e2y|l\u1ea1i\s+(?:l\u00e0m\s+phi\u1ec1n|nh\u1edd)\s+em|l\u1ea7n\s+th\u1ee9\s+(?:[2-9]|\d{2}|hai|ba|t\u01b0|b\u1ed1n|n\u0103m)|(?:m\u1ea5y|nhi\u1ec1u|v\u00e0i)\s+l\u1ea7n\s+r\u1ed3i|(?:th\u00e1ng|tu\u1ea7n|h\u00f4m|\u0111\u1ee3t|n\u0103m)\s+(?:tr\u01b0\u1edbc|ngo\u00e1i|v\u1eeba\s+r\u1ed3i)\s+(?:m\u1edbi\s+|c\u00f3\s+)?(?:\u1edf|gh\u00e9|\u0111\u1eb7t|l\u00e0m|d\u00f9ng)|(?:hay|v\u1eabn|th\u01b0\u1eddng)\s+(?:\u1edf|gh\u00e9|l\u00e0m|d\u00f9ng)\s+(?:b\u00ean\s+em|\u0111\u00e2y)|(?:v\u1eabn\s+)?(?:nh\u01b0\s+l\u1ea7n\s+tr\u01b0\u1edbc|nh\u01b0\s+m\u1ecdi\s+khi|nh\u01b0\s+c\u0169|v\u1eabn\s+gu\s+c\u0169|gu\s+quen)|(?:h\u1ed9i\s+vi\u00ean|th\u00e0nh\s+vi\u00ean|kh\u00e1ch\s+h\u00e0ng)\s+(?:th\u00e2n\s+thi\u1ebft|l\u00e2u\s+n\u0103m|vip)|(?:anh|ch\u1ecb)\s+[\p{L}\p{M}]{2,16}\s+\u0111\u00e2y)(?![\p{L}\p{M}])/iu;
const WARM_OPEN_TONE_RE = /(?:\u{1f604}|\u{1f60a}|\u{1f601}|\u{1f606}|\u{1f609}|\u{1f923}|\u{1f970}|:\)+|=\)+|(?<![\p{L}\p{M}])(?:haha+|hehe+|hihi+|tr\u1eddi\s+\u01a1i|c\u00f4ng\s+nh\u1eadn|d\u1ec5\s+th\u01b0\u01a1ng|nh\u1edb\s+gi\u1eef|\u01b0u\s+\u00e1i|c\u1ee9u\s+(?:anh|ch\u1ecb)|ch\u0103m\s+(?:anh|ch\u1ecb)|g\u1eb7p\s+l\u1ea1i|vui\s+qu\u00e1|qu\u00fd\s+qu\u00e1|m\u1eddi\s+c\u00e0\s+ph\u00ea|tr\u00eau\s+em|th\u00edch\s+c\u00e1ch\s+ch\u0103m|nh\u1edb\s+em|quen\s+qu\u00e1|ng\u01b0\u1eddi\s+nh\u00e0)(?![\p{L}\p{M}]))/iu;
const PLAYFUL_PERK_TEASE_RE = /(?<![\p{L}\p{M}])(?:\u01b0u\s+\u00e1i|gi\u1ea3m\s+th\u00eam|free|mi\u1ec5n\s+ph\u00ed\s+n\u00e2ng|n\u00e2ng\s+h\u1ea1ng\s+(?:lu\u00f4n|free|mi\u1ec5n\s+ph\u00ed)|chi\u1ebft\s+kh\u1ea5u\s+th\u00eam|th\u01b0\u01a1ng\s+t\u00ecnh|kh\u00e1ch\s+ru\u1ed9t)(?![\p{L}\p{M}])/iu;
const SERIOUS_SERVICE_RE = /(?<![\p{L}\p{M}])(?:ch\u1edd\s+l\u00e2u\s+qu\u00e1|b\u1ef1c\s+m\u00ecnh|th\u1ea5t\s+v\u1ecdng|l\u00e0m\s+\u0103n\s+ki\u1ec3u|khi\u1ebfu\s+n\u1ea1i|ho\u00e0n\s+ti\u1ec1n|ng\u1ed9\s+\u0111\u1ed9c|d\u1ecb\s+\u1ee9ng|c\u1ea5p\s+c\u1ee9u|m\u1ea5t\s+\u0111\u1ed3|m\u1ea5t\s+h\u1ed9\s+chi\u1ebfu|tr\u1eeb\s+(?:2|hai)\s+l\u1ea7n|qu\u00e1\s+t\u1ec7|kh\u00f4ng\s+ch\u1ea5p\s+nh\u1eadn)(?![\p{L}\p{M}])/iu;

export function detectCustomerRapport(incomingText, {
  priorRapport = null,
  roleId = 'service',
  valence = 0,
  hardGuard = null,
  nowMs = Date.now(),
} = {}) {
  if (roleId !== 'service' && roleId !== 'sales') return null;
  const text = String(incomingText ?? '').normalize('NFC').trim();
  const validPrior = priorRapport && nowMs - (priorRapport.updatedAtMs ?? 0) <= ANCHOR_TTL_MS
    ? priorRapport
    : null;
  const hitFamiliar = FAMILIAR_CUSTOMER_RE.test(text);
  const hitWarmOpen = WARM_OPEN_TONE_RE.test(text);
  const hitPerkTease = PLAYFUL_PERK_TEASE_RE.test(text);
  const seriousMode = Boolean(
    hardGuard || valence <= -0.35 || SERIOUS_SERVICE_RE.test(text),
  );
  let tier = validPrior?.tier || 'new';
  if (hitFamiliar) tier = 'familiar';
  else if (tier === 'new' && hitWarmOpen && !seriousMode) tier = 'warm';
  return {
    tier,
    justRecognized: Boolean(hitFamiliar && validPrior?.tier !== 'familiar'),
    warmOpen: Boolean(hitWarmOpen && !seriousMode),
    perkTease: Boolean(hitPerkTease && !seriousMode),
    seriousMode,
    updatedAtMs: nowMs,
  };
}

export function detectSubtext(text, {roleId = 'companion-lively', lateNight = false} = {}) {
  const s = String(text ?? '').normalize('NFC').trim();
  if (!s) return null;
  // Service/sales roles prioritize service escalation first
  if (roleId === 'service' || roleId === 'sales') {
    const esc = SUBTEXT_PATTERNS.find(p => p.id === 'service_escalation');
    if (esc.re.test(s)) return esc;
  }
  for (const pat of SUBTEXT_PATTERNS) {
    if (pat.roleScope && pat.roleScope !== roleId) continue;
    if (pat.id === 'service_escalation' && roleId !== 'service' && roleId !== 'sales') continue;
    if (pat.id === 'playful_test' && (roleId === 'service' || roleId === 'sales' || roleId === 'companion-warm')) continue;
    if (pat.re.test(s)) return pat;
  }
  if (lateNight && s.length <= 120 && roleId.startsWith('companion')) {
    return {
      id: 'late_night_unwinding',
      cue: roleId === 'companion-flirty'
        ? '\u1ea8n \u00fd (\u0111\u00eam mu\u1ed9n g\u1ea7n g\u0169i): H\u1ea1 gi\u1ecdng th\u1eadt m\u1ec1m, ng\u1ecdt \u1ea5m s\u00e1t tai \u2014 g\u1ee3i c\u1ea3m gi\u00e1c mu\u1ed1n \u00f4m s\u00e1t, mu\u1ed1n n\u1ef1ng chi\u1ec1u v\u00e0 th\u1ea3 l\u1eedng d\u01b0 v\u1ecb t\u00ecnh c\u1ea3m.'
        : '\u1ea8n \u00fd (\u0111\u00eam mu\u1ed9n mu\u1ed1n b\u1ea7u b\u1ea1n nh\u1eb9 nh\u00e0ng): Ch\u1eadm l\u1ea1i, \u1ea5m \u00e1p, tr\u00f2 chuy\u1ec7n g\u1ea7n g\u0169i \u0111\u1ec3 ng\u01b0\u1eddi kia th\u01b0 th\u00e1i ch\u1ee9 kh\u00f4ng tra h\u1ecfi hay m\u1edf vi\u1ec7c n\u1eb7ng.',
    };
  }
  return null;
}

export function extractTopicAnchors(text, existingAnchors = [], nowMs = Date.now()) {
  const s = String(text ?? '').normalize('NFC').trim();
  const kept = (existingAnchors || []).filter(a => a && nowMs - (a.seenAtMs ?? 0) <= ANCHOR_TTL_MS);
  const byKey = new Map(kept.map(a => [a.key, {...a}]));
  for (const item of TOPIC_ANCHOR_CATALOG) {
    if (item.re.test(s)) {
      byKey.set(item.key, {
        key: item.key,
        label: item.label,
        seenAtMs: nowMs,
        usedAtMs: byKey.get(item.key)?.usedAtMs ?? 0,
      });
    }
  }
  return [...byKey.values()]
    .sort((a, b) => b.seenAtMs - a.seenAtMs)
    .slice(0, MAX_ANCHORS);
}

export function selectCallbackAnchor(anchors = [], {currentText = '', nowMs = Date.now(), turnCounter = 0} = {}) {
  // Subtle cooldown: only suggest a natural callback at most every 4 turns and never on the same turn it was just introduced
  if (!Array.isArray(anchors) || !anchors.length) return null;
  if (turnCounter > 0 && turnCounter % 4 !== 0) return null;
  const lowCurrent = String(currentText ?? '').toLocaleLowerCase('vi-VN');
  const eligible = anchors.filter(a => {
    const ageMs = nowMs - (a.seenAtMs ?? 0);
    const recentlyUsed = a.usedAtMs > 0 && (nowMs - a.usedAtMs) < 30 * 60 * 1000;
    const justRepeated = lowCurrent.includes(a.label);
    return ageMs >= 15 * 60 * 1000 && ageMs <= ANCHOR_TTL_MS && !recentlyUsed && !justRepeated;
  });
  return eligible[0] || null;
}

export function renderEqIntelligenceCue({
  incomingText = '',
  roleId = 'companion-lively',
  stance = 'collaborate',
  hardGuard = null,
  lateNight = false,
  callbackAnchor = null,
  customerRapport = null,
} = {}) {
  if (hardGuard === 'crisis') return '';
  const subtext = detectSubtext(incomingText, {roleId, lateNight});
  if (stance === 'execute') {
    if (roleId === 'assistant') {
      const execBase = 'Gi\u1ecdng tr\u1ee3 l\u00fd ng\u01b0\u1eddi th\u1eadt khi x\u1eed l\u00fd vi\u1ec7c / fact-check / b\u00e1o c\u00e1o: N\u00f3i th\u1eb3ng, g\u1ecdn, d\u1ec5 hi\u1ec3u v\u00e0 li\u1ec1n m\u1ea1ch trong 1 tin nh\u1eafn t\u1ef1 nhi\u00ean (KH\u00d4NG ch\u1ebb t\u1eebng c\u00e2u th\u00e0nh t\u1eebng \u0111o\u1ea1n hay nhi\u1ec1u tin nh\u1eafn r\u1eddi r\u1ea1c). TUY\u1ec6T \u0110\u1ed0I KH\u00d4NG nh\u1eafc l\u1ea1i hay di\u1ec5n gi\u1ea3i l\u1ea1i l\u1eddi ng\u01b0\u1eddi d\u00f9ng v\u1eeba n\u00f3i (C\u1ea4M m\u1edf \u0111\u1ea7u \u201cEm hi\u1ec3u anh lo...\u201d, \u201c\u0110\u00fang l\u00e0 anh \u0111ang...\u201d); v\u00e0o th\u1eb3ng k\u1ebft lu\u1eadn, \u0111i\u1ec3m d\u00ednh ti\u1ec1n v\u00e0 b\u01b0\u1edbc l\u00e0m \u0111\u00fang. KH\u00d4NG r\u1eafc \u201cnh\u00e9/\u1ea1\u201d \u1edf m\u1ecdi c\u00e2u, KH\u00d4NG b\u00f4i \u0111\u1eadm (**...**), KH\u00d4NG in nghi\u00eang (*...*), KH\u00d4NG d\u1ea5u ch\u1ea5m ph\u1ea9y (;), gi\u1eef ch\u00ednh x\u00e1c 100% d\u1eef ki\u1ec7n v\u00e0 s\u1ed1 li\u1ec7u.';
      return subtext ? `${subtext.cue} ${execBase}` : execBase;
    }
    const antiParrot = 'KH\u00d4NG nh\u1eafc l\u1ea1i hay di\u1ec5n gi\u1ea3i l\u1ea1i c\u00e2u ng\u01b0\u1eddi d\u00f9ng v\u1eeba n\u00f3i \u2014 \u0111i th\u1eb3ng v\u00e0o c\u00e2u tr\u1ea3 l\u1eddi ng\u1eafn g\u1ecdn, li\u1ec1n m\u1ea1ch trong 1 tin.';
    return subtext ? `${subtext.cue} ${antiParrot}` : antiParrot;
  }
  const parts = [];
  const isFamiliar = Boolean((roleId === 'service' || roleId === 'sales') && customerRapport?.tier === 'familiar');
  const isWarmGuest = Boolean((roleId === 'service' || roleId === 'sales') && customerRapport?.tier === 'warm');

  if (subtext) {
    parts.push(subtext.cue);
  } else if (roleId === 'companion-warm') {
    parts.push('EQ t\u00e2m giao s\u00e2u s\u1eafc: Nghe xuy\u00ean xu\u1ed1ng t\u1ea7ng c\u1ea3m gi\u00e1c ch\u01b0a n\u00f3i th\u00e0nh l\u1eddi, \u0111\u1ee1 h\u1ed9 n\u1ed7i n\u1eb7ng l\u00f2ng b\u1eb1ng 1\u20132 c\u00e2u tr\u1ea7m \u1ea5m b\u00ecnh d\u1ecb (kh\u00f4ng nh\u1ea1i l\u1eddi, kh\u00f4ng nh\u1ea3y v\u00e0o khuy\u00ean gi\u1ea3i 4\u20135 b\u01b0\u1edbc, kh\u00f4ng h\u1ecfi d\u1ed3n ki\u1ec3u b\u00e1c s\u0129 t\u00e2m l\u00fd).');
  } else if (roleId === 'companion-flirty') {
    parts.push('EQ t\u00ecnh t\u1ee9 s\u00e2u & c\u00f3 l\u1ef1c h\u00fat: B\u1eaft tr\u1ecdn t\u1eebng t\u00edn hi\u1ec7u c\u1ea3m x\u00fac nh\u1ecf nh\u1ea5t, ch\u1ee7 \u0111\u1ed9ng k\u00e9o kho\u1ea3ng c\u00e1ch l\u1ea1i th\u1eadt s\u00e1t \u2014 bi\u1ebft n\u1ecbnh kh\u00e9o tr\u00fang ch\u1ed7 khi\u1ebfn anh th\u1ea5y m\u00ecnh th\u1eadt cu\u1ed1n h\u00fat, d\u00f9ng gi\u1ecdng m\u1ec1m n\u0169ng n\u1ecbu ki\u1ec3u mu\u1ed1n n\u1ef1ng, mu\u1ed1n chi\u1ec1u, mu\u1ed1n \u00f4m s\u00e1t, v\u00e0 gieo chi ti\u1ebft g\u1ee3i c\u1ea3m gi\u00e1c & tr\u00ed t\u01b0\u1edfng t\u01b0\u1ee3ng t\u00ecnh c\u1ea3m, ham mu\u1ed1n tinh t\u1ebf (gi\u1ecdng tr\u1ea7m s\u00e1t tai, \u00e1nh m\u1eaft nh\u00ecn l\u00e2u, h\u01a1i \u1ea5m, c\u00e1i ch\u1ea1m kh\u1ebd, n\u1ed7i nh\u1edb c\u1ed3n c\u00e0o) \u0111\u1ec3 cu\u1ed9c tr\u00f2 chuy\u1ec7n c\u00f3 s\u1ee9c h\u00fat v\u00e0 nhi\u1ec7t th\u1eadt s\u1ef1.');
  } else if (roleId === 'assistant') {
    parts.push('T\u01b0 duy tr\u1ee3 l\u00fd c\u00e1 nh\u00e2n \u0111\u1eafc l\u1ef1c: \u0110i tr\u01b0\u1edbc n\u1eeda b\u01b0\u1edbc \u2014 ch\u1ee7 \u0111\u1ed9ng b\u1eaft \u0111i\u1ec3m v\u01b0\u1edbng l\u1ecbch/di chuy\u1ec3n/\u01b0u ti\u00ean, gom vi\u1ec7c r\u1ed1i th\u00e0nh b\u01b0\u1edbc g\u1ecdn s\u1eb5n duy\u1ec7t, so\u1ea1n th\u1eb3ng tin g\u1eedi ngay kh\u00f4ng r\u00e0o \u0111\u00f3n, v\u00e0 \u0111\u1ee7 g\u1ea7n g\u0169i \u0111\u1ec3 ch\u0103m s\u1ebfp c\u00f3 duy\u00ean.');
  } else if (roleId === 'teammate') {
    parts.push('T\u01b0 duy c\u1ed9ng s\u1ef1: \u0110i tr\u01b0\u1edbc n\u1eeda b\u01b0\u1edbc \u2014 n\u1ebfu th\u1ea5y \u0111i\u1ec3m v\u01b0\u1edbng ho\u1eb7c b\u01b0\u1edbc ti\u1ebfp theo r\u00f5 r\u00e0ng, g\u1ee3i g\u1ecdn 1 c\u00e2u thay v\u00ec \u0111\u1ee3i h\u1ecfi.');
  } else if (roleId === 'service') {
    parts.push('EQ d\u1ecbch v\u1ee5 ng\u01b0\u1eddi th\u1eadt: Nh\u1eafn nh\u01b0 nh\u00e2n vi\u00ean l\u1ec5 t\u00e2n 5 sao \u0111ang chat Zalo/Telegram th\u1eadt \u2014 \u1ea5m \u00e1p, \u0111\u1eddi th\u01b0\u1eddng, gi\u1eef ch\u1ee7 ng\u1eef \u201cem\u201d, hi\u1ebfm d\u00f9ng \u201cb\u00ean em\u201d (kh\u00f4ng g\u1ecdi \u201cb\u00ean b\u00e1n\u201d, kh\u00f4ng n\u00f3i \u201cphi\u00ean n\u00e0y kh\u00f4ng c\u00f3 c\u00f4ng c\u1ee5\u201d, kh\u00f4ng \u0111\u1ea9y sang \u201cb\u1ed9 ph\u1eadn ch\u0103m s\u00f3c kh\u00e1ch h\u00e0ng\u201d nh\u01b0 ng\u01b0\u1eddi ngo\u00e0i). Tr\u00e1nh v\u0103n b\u1ea3n c\u1ee9ng ki\u1ec3u \u201ckh\u00f4ng khuy\u1ebfn ngh\u1ecb\u201d, \u201cr\u1ea5t ti\u1ebfc v\u00ec s\u1ef1 b\u1ea5t ti\u1ec7n n\u00e0y\u201d, \u201cvui l\u00f2ng li\u00ean h\u1ec7\u201d, kh\u00f4ng d\u1ea5u ch\u1ea5m ph\u1ea9y (;), kh\u00f4ng nh\u1ea1i l\u1eddi kh\u00e1ch. T\u00e1ch 2\u20133 tin ng\u1eafn b\u1eb1ng [[bubble]] (tin 1 \u0111\u00e1p g\u1ecdn th\u1eb3ng v\u1ea5n \u0111\u1ec1, tin 2 n\u00eau chi ti\u1ebft/c\u00e1ch x\u1eed l\u00fd r\u00f5 r\u00e0ng); n\u1ebfu kh\u00f4ng tra tr\u1ef1c ti\u1ebfp \u0111\u01b0\u1ee3c tr\u00ean h\u1ec7 th\u1ed1ng th\u00ec n\u00f3i th\u1eb3ng t\u1ef1 nhi\u00ean 1 c\u00e2u r\u1ed3i ch\u1ec9 \u0111\u01b0\u1eddng nhanh nh\u1ea5t.');
  } else if (roleId === 'sales') {
    parts.push('EQ t\u01b0 v\u1ea5n ng\u01b0\u1eddi th\u1eadt: Nh\u1eafn nh\u01b0 chuy\u00ean vi\u00ean t\u01b0 v\u1ea5n am hi\u1ec3u \u0111ang chat tr\u1ef1c ti\u1ebfp \u2014 x\u01b0ng \u201cem/m\u00ecnh\u201d, hi\u1ebfm d\u00f9ng \u201cb\u00ean em\u201d (kh\u00f4ng g\u1ecdi \u201cb\u00ean b\u00e1n\u201d), kh\u00f4ng nh\u1ea1i l\u1eddi kh\u00e1ch, kh\u00f4ng d\u1ea5u ch\u1ea5m ph\u1ea9y (;), kh\u00f4ng :))/=)). Tr\u00e1nh c\u00e2u brochure c\u1ee9ng ki\u1ec3u \u201c\u0111\u00e1ng c\u00e2n nh\u1eafc\u201d, \u201cph\u01b0\u01a1ng \u00e1n ti\u00eau chu\u1ea9n\u201d, \u201ccung c\u1ea5p th\u00f4ng tin\u201d, \u201c\u0111\u1ed3ng++/kh\u00e1ch\u201d (vi\u1ebft gi\u00e1 g\u1ecdn nh\u01b0 3,45tr/\u0111\u00eam Net, 1,65tr++/kh\u00e1ch). T\u00e1ch 2\u20133 tin ng\u1eafn t\u1ef1 nhi\u00ean b\u1eb1ng [[bubble]] thay v\u00ec g\u1ed9p 1 kh\u1ed1i d\u00e0i; b\u1eaft th\u1eb3ng n\u1ed7i \u0111au, g\u1ee3i 1\u20132 l\u1ef1a ch\u1ecdn s\u00e1t nh\u1ea5t v\u00e0 h\u1ecfi nh\u1eb9 1 c\u00e2u m\u1edf t\u1ef1 nhi\u00ean (kh\u00f4ng \u0111\u00f4i co, kh\u00f4ng b\u1ecba gi\u00e1/\u01b0u \u0111\u00e3i, kh\u00f4ng ch\u00e8o k\u00e9o).');
  }

  if (isFamiliar) {
    if (customerRapport.seriousMode) {
      parts.push('CH\u1ebe \u0110\u1ed8 KH\u00c1CH QUEN (\u01afu ti\u00ean x\u1eed l\u00fd nghi\u00eam t\u00fac): Kh\u00e1ch quen \u0111ang g\u1eb7p v\u1ea5n \u0111\u1ec1 \u2014 gi\u1eef s\u1ef1 g\u1ea7n g\u0169i, tr\u00e2n tr\u1ecdng m\u1ed1i quen (kh\u00f4ng n\u00f3i l\u1ea1nh nh\u1ea1t ki\u1ec3u m\u1eabu t\u1ed5ng \u0111\u00e0i), nh\u01b0ng d\u1ee9t kho\u00e1t kh\u00f4ng \u0111\u00f9a, kh\u00f4ng th\u1ea3 icon; nh\u1eadn th\u1eb3ng v\u1ea5n \u0111\u1ec1 v\u00e0 x\u1eed l\u00fd \u01b0u ti\u00ean theo \u0111\u00fang SOP.');
    } else {
      parts.push('CH\u1ebe \u0110\u1ed8 KH\u00c1CH QUEN (Adaptive C\u1edfi M\u1edf & Th\u00e2n Thi\u1ec7n): \u0110\u00e2y l\u00e0 kh\u00e1ch quen quay l\u1ea1i \u2014 h\u1ea1 h\u1eb3n kho\u1ea3ng c\u00e1ch khu\u00f4n m\u1eabu, tr\u00f2 chuy\u1ec7n c\u1edfi m\u1edf, g\u1ea7n g\u0169i v\u00e0 c\u00f3 duy\u00ean nh\u01b0 c\u1ed9ng s\u1ef1 \u0111\u00e3 l\u00e0m vi\u1ec7c c\u00f9ng anh/ch\u1ecb t\u1eeb tr\u01b0\u1edbc. Ch\u00e0o \u0111\u00f3n th\u1eadt \u1ea5m t\u1ef1 nhi\u00ean (g\u1ecdi t\u00ean n\u1ebfu kh\u00e1ch v\u1eeba t\u1ef1 x\u01b0ng, n\u1ed1i l\u1ea1i chi ti\u1ebft/th\u00f3i quen kh\u00e1ch v\u1eeba nh\u1eafc m\u00e0 KH\u00d4NG b\u1ecba l\u1ecbch s\u1eed ch\u01b0a c\u00f3 trong d\u1eef li\u1ec7u). N\u1ebfu kh\u00e1ch tr\u00eau nh\u1eb9 ho\u1eb7c n\u00f3i chuy\u1ec7n tho\u1ea3i m\u00e1i, tung h\u1ee9ng l\u1ea1i 1 c\u00e2u duy\u00ean (v\u1eabn gi\u1eef x\u01b0ng h\u00f4 l\u1ec5 ph\u00e9p anh/ch\u1ecb \u2013 em, kh\u00f4ng su\u1ed3ng s\u00e3, kh\u00f4ng t\u00e1n t\u1ec9nh). Khi c\u1ea7n chuy\u1ec3n sang \u0111\u1ea7u m\u1ed1i tr\u1ef1c ti\u1ebfp ho\u1eb7c hotline trong SOP, n\u00f3i ng\u1eafn t\u1ef1 nhi\u00ean nh\u01b0 ng\u01b0\u1eddi th\u1eadt ch\u1ee9 KH\u00d4NG l\u1eb7p l\u1ea1i c\u00e2u m\u00e1y m\u00f3c \u201cEm kh\u00f4ng tra/ghi nh\u1eadn tr\u1ef1c ti\u1ebfp tr\u00ean h\u1ec7 th\u1ed1ng \u0111\u01b0\u1ee3c\u201d nhi\u1ec1u l\u01b0\u1ee3t li\u00ean ti\u1ebfp. N\u1ebfu kh\u00e1ch xin gi\u1ea3m ph\u00ed/ngo\u1ea1i l\u1ec7 ngo\u00e0i th\u1ea9m quy\u1ec1n th\u00ec t\u1eeb ch\u1ed1i m\u1ec1m, \u1ea5m \u00e1p r\u1ed3i g\u1ee3i ph\u01b0\u01a1ng \u00e1n t\u1ed1t nh\u1ea5t trong khung SOP \u2014 tuy\u1ec7t \u0111\u1ed1i kh\u00f4ng h\u1ee9a b\u1eeba hay l\u1ed9 th\u00f4ng tin n\u1ed9i b\u1ed9.');
    }
  } else if (isWarmGuest && !customerRapport.seriousMode) {
    parts.push('Kh\u00e1ch \u0111ang m\u1edf l\u1eddi c\u1edfi m\u1edf, vui v\u1ebb \u2014 n\u00e2ng nh\u1eb9 \u0111\u1ed9 th\u00e2n thi\u1ec7n v\u00e0 t\u1ef1 nhi\u00ean trong c\u00e2u ch\u1eef (\u1ea5m h\u01a1n, g\u1ea7n g\u0169i h\u01a1n, b\u1edbt kho\u1ea3ng c\u00e1ch l\u1ec5 t\u00e2n), v\u1eabn gi\u1eef \u0111\u00fang l\u1ec5 ph\u00e9p v\u00e0 SOP.');
  }

  if (callbackAnchor && (roleId !== 'service' && roleId !== 'sales' || (isFamiliar && !customerRapport?.seriousMode))) {
    parts.push(`C\u00f3 th\u1ec3 nh\u1eafc kh\u00e9o th\u1eadt t\u1ef1 nhi\u00ean t\u1edbi chi ti\u1ebft l\u00fac tr\u01b0\u1edbc (\u201c${callbackAnchor.label}\u201d) n\u1ebfu th\u1eadt s\u1ef1 kh\u1edbp m\u1ea1ch \u2014 \u0111\u1eebng g\u01b0\u1ee3ng \u00e9p.`);
  }
  if (roleId.startsWith('companion')) {
    parts.push('Gi\u1eef m\u1ea1ch b\u1ea1n th\u00e2n th\u1eadt g\u1ecdn (1\u20132 c\u00e2u, ~20\u201395 k\u00fd t\u1ef1/bong b\u00f3ng, th\u1ec9nh tho\u1ea3ng ng\u1eafn h\u1eb3n 15\u201335 k\u00fd t\u1ef1); KH\u00d4NG chuy\u1ec3n sang gi\u1ecdng b\u00e1c s\u0129/HLV gi\u1ea3ng b\u00e0i 4\u20135 b\u01b0\u1edbc, KH\u00d4NG nh\u1eafc l\u1ea1i nguy\u00ean v\u0103n c\u00e2u anh v\u1eeba n\u00f3i.');
  } else {
    parts.push('KH\u00d4NG nh\u1eafc l\u1ea1i hay di\u1ec5n gi\u1ea3i l\u1ea1i c\u00e2u kh\u00e1ch/ng\u01b0\u1eddi d\u00f9ng v\u1eeba n\u00f3i \u2014 \u0111i th\u1eb3ng v\u00e0o c\u00e2u tr\u1ea3 l\u1eddi t\u1ef1 nhi\u00ean, ng\u1eafn g\u1ecdn nh\u01b0ng \u0111\u1ee7 \u00fd.');
  }
  return parts.join(' ');
}

// Companion Telegram Reaction selector (STRICTLY Telegram Bot API official free ReactionTypeEmoji only \u2014 NEVER '\u{1f602}' which returns REACTION_INVALID!)
const REACTION_NEGATIVE_OR_QUESTION_RE = /\?|(?:^|[^\p{L}\p{M}])(?:k\s+hi\u1ec3u|ko\s+hi\u1ec3u|kh\u00f4ng\s+hi\u1ec3u|ch\u01b0a\s+hi\u1ec3u|sao\s+l\u1ea1i|t\u1ea1i\s+sao|l\u00e0\s+sao|g\u00ec\s+th\u1ebf|j\s+th\u1ebf|ah|\u00e0|\u00e1|\u01a1|\u1edb|\u1ee7a|nh\u1ea7m|sai\s+r\u1ed3i|\u0111\u00e2u\s+ph\u1ea3i|ch\u01b0a\s+\u1ed5n|k\s+\u1ea5n\s+t\u01b0\u1ee3ng|ko\s+\u1ea5n\s+t\u01b0\u1ee3ng)(?=$|[^\p{L}\p{M}])/iu;
const REACTION_MEDIA_RE = /\[image|\[photo|\[media|g\u1eedi\s+\u1ea3nh|g\u00f3c\s+n\u00e0y|qu\u00e1n\s+n\u00e0y|nh\u00ecn\s+n\u00e0y|xem\s+n\u00e0y/iu;
const REACTION_FUNNY_RE = /(?:haha+|hehe+|hihi+|kkk+|:\)\)+|=\)\)+|v\u1ee1\s+m\u1ed3m|c\u01b0\u1eddi\s+x\u1ec9u|t\u1ebfu|l\u1ea7y|\u0111\u00f9a|tr\u00eau|\u0111\u1ea5u\s+ki\u1ebfm)/iu;
const REACTION_CHEEKY_SCOLD_RE = /(?<![\p{L}\p{M}])(?:l\u00e1o\s+nh\u00e1o|b\u1eaft\s+s\u00f3ng\s+ch\u1eadm|b\u1ecb\s+g\u00e0i|n\u00f3i\s+b\u1eeba|qu\u00ean\s+m\u1eb9|qu\u00ean\s+m\u1ea5t)(?![\p{L}\p{M}])/iu;
const REACTION_WARM_RE = /(?<![\p{L}\p{M}])(?:c\u1ea3m\s+\u01a1n|tks|thks|h\u1ee3p\s+l\u00fd|\u0111\u00fang\s+h\u01b0\u1edbng|hi\u1ec7u\s+qu\u1ea3\s+h\u01a1n|th\u00f4ng\s+minh|c\u0169ng\s+l\u00e0\s+1\s+c\u00e1ch|hay\s+(?:\u0111\u00f3|l\u1eafm|th\u1eadt|ph\u1ebft|qu\u00e1)|\u0111\u00f3ng\s+hay|x\u1ecbn\s+ph\u1ebft|\u1ed5n\s+ph\u1ebft|ok\s+\u0111\u1ec3|\u0111\u1ec3\s+a\s+th\u1eed|th\u00edch\s+th\u1eadt|y\u00ean\s+b\u00ecnh|ng\u1ee7\s+ngon|d\u1ec5\s+th\u01b0\u01a1ng|chu\u1ea9n\s+a|chu\u1ea9n\s+r|ti\u1ebfn\s+b\u1ed9|duy\u00ean\s+(?:m\u00e0|th\u1ebf|qu\u00e1|ph\u1ebft|gh\u00ea|l\u1eafm|th\u1eadt|\u0111\u1ea5y)|e\s+duy\u00ean|xinh\s+(?:n\u1eefa|qu\u00e1|gh\u00ea|th\u1ebf|th\u1eadt|l\u1eafm)|\u00e1nh\s+m\u1eaft|\u0111\u1eb9p\s+(?:n\u1eefa|qu\u00e1|th\u1eadt|l\u1eafm)|ng\u1eafm\s+a|kh\u00f4n\s+(?:\u0111\u1ea5y|ph\u1ebft|gh\u00ea|th\u1ebf)|th\u01b0\u01a1ng\s+(?:gh\u00ea|e|em|qu\u00e1)|nh\u1edb\s+(?:e|em|a|anh|gi\u1ecdng|qu\u00e1|gh\u00ea)|mu\u1ed1n\s+g\u1eb7p)(?![\p{L}\p{M}])/iu;
const REACTION_HYPE_RE = /(?<![\p{L}\p{M}])(?:\u0111\u00e1nh\s+pick|pickleball|ch\u1ed1t\s+\u0111\u01b0\u1ee3c|ngon\s+l\u00e0nh|\u0111\u1ec9nh\s+qu\u00e1|\u0111\u1ec9nh\s+cao|hay\s+nh\u1ea5t|n\u00e2ng\s+tr\u00ecnh|l\u00ean\s+tr\u00ecnh|th\u1eafng\s+r\u1ed3i|h\u1ebft\s+n\u01b0\u1edbc\s+ch\u1ea5m)(?![\p{L}\p{M}])/iu;
const REACTION_CARE_RE = /(?<![\p{L}\p{M}])(?:\u0111au\s+r\u0103ng|r\u0103ng\s+h\u01a1i\s+\u0111au|m\u1ec7t\s+qu\u00e1|o\u1ea3i\s+qu\u00e1|\u1ed1m|s\u1ed1t|\u0111au\s+\u0111\u1ea7u|haiza|haizz|ch\u00e1n\s+gh\u00ea|b\u00ed\s+b\u00e1ch|ch\u1eb3ng\s+c\u00f3\s+k\u00e8o|c\u00f4\s+\u0111\u01a1n)(?![\p{L}\p{M}])/iu;

export function selectCompanionReaction({
  incomingText = '',
  hasMedia = false,
  stance = 'collaborate',
  hardGuard = null,
  roleId = 'companion-lively',
  turnsSinceLastReaction = 99,
  drawByte = 0,
  customerRapport = null,
} = {}) {
  if (hardGuard === 'crisis' || stance === 'execute') return null;
  if (roleId === 'teammate') return null;
  if (roleId === 'service' || roleId === 'sales') {
    // Only returning/familiar guests on warm positive messages get a gentle respectful reaction (\u{1f64f}/\u2764\ufe0f/\u{1f44d}), cooldown >= 3 turns
    if (customerRapport?.tier !== 'familiar' || customerRapport?.seriousMode || turnsSinceLastReaction < 3) return null;
    const text = String(incomingText ?? '').normalize('NFC').trim();
    if (REACTION_NEGATIVE_OR_QUESTION_RE.test(text)) return null;
    if (REACTION_WARM_RE.test(text) || WARM_OPEN_TONE_RE.test(text)) {
      const roll = Math.abs(drawByte) % 100;
      if (roll < 65) {
        const choices = ['\u{1f64f}', '\u2764\ufe0f', '\u{1f44d}'];
        return choices[Math.abs(drawByte) % choices.length];
      }
    }
    return null;
  }
  // Cooldown: wait at least 2 turns between accompanying reactions so it feels natural (~30-40%) and never spammy
  if (turnsSinceLastReaction < 2) return null;

  const text = String(incomingText ?? '').normalize('NFC').trim();
  const roll = Math.abs(drawByte) % 100;
  const isNegativeOrQuestion = REACTION_NEGATIVE_OR_QUESTION_RE.test(text);

  if (hasMedia || (!isNegativeOrQuestion && REACTION_MEDIA_RE.test(text))) {
    if (roll < 85) {
      const choices = roleId === 'companion-flirty' ? ['\u2764\ufe0f', '\u{1f60d}'] : ['\u2764\ufe0f', '\u{1f525}', '\u{1f60d}'];
      return choices[Math.abs(drawByte) % choices.length];
    }
    return null;
  }
  // Explicit laugh/tease (e.g. "Hahaa", ":)))", "\u201c\u0110\u1ea5u ki\u1ebfm\u201d:))))") overrides casual "\u01a1" exclamation
  if (REACTION_FUNNY_RE.test(text) && !/\?/.test(text)) {
    if (roll < 85) {
      const choices = ['\u{1f923}', '\u{1f601}'];
      return choices[Math.abs(drawByte) % choices.length];
    }
    return null;
  }
  if (!isNegativeOrQuestion && REACTION_CHEEKY_SCOLD_RE.test(text)) {
    if (roll < 75) {
      const choices = ['\u{1f648}', '\u{1f601}'];
      return choices[Math.abs(drawByte) % choices.length];
    }
    return null;
  }
  if (REACTION_CARE_RE.test(text)) {
    if (roll < 75) {
      return roleId === 'companion-warm' || roleId === 'companion-flirty' ? '\u{1f917}' : '\u2764\ufe0f';
    }
    return null;
  }
  if (!isNegativeOrQuestion && REACTION_WARM_RE.test(text)) {
    if (roll < 80) {
      const choices = roleId === 'companion-flirty' ? ['\u2764\ufe0f', '\u{1f970}'] : ['\u2764\ufe0f', '\u{1f44d}', '\u{1f44c}'];
      return choices[Math.abs(drawByte) % choices.length];
    }
    return null;
  }
  if (!isNegativeOrQuestion && REACTION_HYPE_RE.test(text)) {
    if (roll < 75) {
      const choices = ['\u{1f525}', '\u{1f44f}', '\u{1f929}'];
      return choices[Math.abs(drawByte) % choices.length];
    }
    return null;
  }
  return null;
}
