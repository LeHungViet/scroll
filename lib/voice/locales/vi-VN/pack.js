// Conversational Voice \u2014 vi-VN Locale Pack (PII-free, generic Vietnamese chat localization)
// Keeps Vietnamese affect lexicons, Telex/IME patterns, and stance exemplars strictly at the
// locale-pack layer while voice/core/ stays 100% English canonical and language-agnostic.

export const viVNPack = Object.freeze({
  locale: 'vi-VN',
  affectCues: Object.freeze({
    // Multi-word / unambiguous cues ONLY \u2014 bare 1-syllable folded words like "so" (s\u1ee3 vs s\u1ed1/s\u1ed5/s\u1edf),
    // "tuc" (t\u1ee9c vs th\u1ee7 t\u1ee5c), "duoi" (\u0111u\u1ed1i vs d\u01b0\u1edbi), "buon" (bu\u1ed3n vs bu\u00f4n), "gap" (g\u1ea5p vs g\u1eb7p),
    // "thuong" (th\u01b0\u01a1ng vs th\u01b0\u1eddng) cause false diacritic collisions in Vietnamese work chat!
    lowValenceLowArousal: Object.freeze([
      'met moi', 'met qua', 'met that', 'met lam', 'hoi met', 'duoi qua', 'duoi lam', 'kiet suc',
      'buon qua', 'buon lam', 'hoi buon', 'chan qua', 'chan lam', 'nan qua', 'nan lam',
      'trong rong', 'co don', 'nang dau', 'ap luc', 'nang ne', 'khong on', 'hoang mang', 'mat ngu',
      'haiza', 'haizz', 'oai qua', 'oai phet', 'ngan qua', 'bao to', 'dau dau', 'ra roi', 'het pin', 'can pin',
    ]),
    lowValenceHighArousal: Object.freeze([
      'so qua', 'so that', 'so lam', 'hoi so', 'lo lang', 'lo qua', 'cang thang', 'stress', 'buc minh',
      'buc qua', 'tuc qua', 'tuc dien', 'cay cu', 'kho chiu', 'phat dien', 'toang', 'hong het', 'vo tran',
      'dien dau', 'ngop qua', 'qua tai',
    ]),
    highValenceHighArousal: Object.freeze([
      'haha', 'hehe', 'hihi', 'kkk', 'vui qua', 'dinh qua', 'dinh cao', 'ngon lanh', 'chuan luon',
      'thich qua', 'da qua', 'tuyet voi', 'chot keo', 'on ap', 'on phet', 'hay do', 'hay qua',
      'ke chuyen vui', 'chuyen vui', 'choc cuoi', 'dua chut', 'xinh qua', 'dep qua', 'anh mat',
      'thong minh', 'khon day', 'keo vui', 'di choi',
      'treu thoi', 'dua thoi', 'anh treu', 'bon anh treu', 'chi treu', 'em treu', 'troll thoi', 'ca khia',
      'nghiem tuc the', 'cang the', 'cang vay', 'lam gi ma cang', 'tu tin the', 'ghe the', 'ghe vay',
      'cuon qua', 'cuon that', 'me qua', 'ngot qua', 'xao xuyen', 'rung dong', 'kich thich',
      'muon om', 'muon hon', 'muon nung', 'chieu em', 'chieu anh', 'thich em', 'thich e', 'say me',
    ]),
    highValenceLowArousal: Object.freeze([
      'nhe nhom', 'thoai mai', 'yen tam', 'de chiu', 'thu gian', 'xong het roi', 'do hon roi',
      'de thuong', 'dang yeu', 'binh yen', 'xinh nua', 'dep nua', 'duyen ma',
      'nho giong', 'nho em', 'nho e', 'nho anh', 'muon gap',
      'om em', 'om anh', 'gan nhau', 'sat ben', 'am ap', 'thuong em', 'thuong anh', 'o lai', 'nho qua', 'cung qua',
    ]),
    urgentExecute: Object.freeze([
      'can gap', 'dang gap', 'gap lam', 'gap qua', 'ngay lap tuc', 'nhanh len', 'ngan gon', 'dung hoi', 'bot hoi', 'khoi hoi',
      'thoi de sau', 'chot nhanh', 'di thang vao van de',
    ]),
  }),

  humanError: Object.freeze({
    // Common Vietnamese Telex / mobile keyboard slips (unambiguous harmless words only, never changes meaning or facts)
    typos: Object.freeze({
      'c\u0169ng': 'cungx',
      '\u0111\u01b0\u1ee3c': 'duocj',
      'nhi\u1ec1u': 'nhieuf',
      'th\u00eam': 'th\u00eamm',
      'x\u00edu': 'xiu',
      'ch\u00fat': 'chut',
      'vui': 'vuii',
      'ngh\u1ec9': 'ngh\u1ec9i',
      'n\u1eefa': 'n\u1eefaa',
      'm\u00ecnh': 'minhf',
      'tr\u1eddi': 'troif',
      'lu\u00f4n': 'luoon',
      'th\u00edch': 'thichs',
    }),
    casualOpenings: Object.freeze(['Th\u1eadt ra', 'Ch\u1eafc', 'Nghe', 'N\u00f3i th\u1eadt', '\u1ee6a', 'Ch\u1ee9', 'M\u00e0']),
    casualEndings: Object.freeze({
      'nha': 'nhaa',
      'nh\u00e9': 'nhe',
      'lu\u00f4n': 'lun',
      'th\u00f4i': 'thoi',
    }),
    afterthoughtRe: /^(.{10,}?)[,.]\s+((?:\u00e0 qu\u00ean|m\u00e0 khoan|ti\u1ec7n th\u1ec3|\u00e0 m\u00e0)\b.+)$/iu,
  }),

  // Curated PII-free few-shot exemplars per stance (natural Vietnamese chat rhythm, zero bold/therapist tone)
  exemplars: Object.freeze({
    listen: Object.freeze([
      'V\u00ed d\u1ee5 gi\u1ecdng t\u1ef1 nhi\u00ean khi ng\u01b0\u1eddi kia m\u1ec7t: "Nghe o\u1ea3i th\u1eadt s\u1ef1. Th\u00f4i t\u1ed1i nay \u0111\u1eebng c\u1ed1 g\u1ee1 h\u1ebft l\u00e0m g\u00ec, t\u1ea1m g\u00e1c l\u1ea1i \u0111i r\u1ed3i mai t\u00ednh ti\u1ebfp."',
    ]),
    banter: Object.freeze([
      'V\u00ed d\u1ee5 gi\u1ecdng nh\u1eb9 nh\u00e0ng: "Nghe c\u00f3 m\u00f9i t\u1ef1 tin h\u01a1i s\u1edbm \u0111\u00f3 nha ;)) \u0111\u1ec3 xem l\u00e1t n\u1eefa ch\u1ea1y th\u1eadt ra sao."',
    ]),
    collaborate: Object.freeze([
      'V\u00ed d\u1ee5 gi\u1ecdng trao \u0111\u1ed5i th\u1eb3ng: "B\u1ecf ph\u01b0\u01a1ng \u00e1n hai \u0111i, l\u1eafm b\u01b0\u1edbc th\u1eeba qu\u00e1. Ch\u1ed1t b\u1ea3n g\u1ecdn tr\u01b0\u1edbc r\u1ed3i \u0111o k\u1ebft qu\u1ea3 th\u1eadt."',
    ]),
    execute: Object.freeze([
      'V\u00ed d\u1ee5 gi\u1ecdng ch\u1ed1t vi\u1ec7c: "Xong r\u1ed3i. \u0110\u00e3 kh\u1edfi \u0111\u1ed9ng l\u1ea1i d\u1ecbch v\u1ee5 v\u00e0 ki\u1ec3m tra h\u00e0ng \u0111\u1ee3i ch\u1ea1y b\u00ecnh th\u01b0\u1eddng."',
    ]),
  }),

  // Contrastive few-shots calibrated for natural Vietnamese pro-drop, sharp dry wit (no cheesy clich\u00e9s/fun-facts), emoticons (:)), ;)), ^^), moderate abbreviations (~25%), and non-interview rhythm
  proDropFewShots: Object.freeze([
    '\u274c "Team cu\u1ed1i tu\u1ea7n \u0111i\u1ec3m danh s\u1edbm r\u1ed3i \u{1f604} M\u1edbi s\u00e1ng th\u1ee9 S\u00e1u m\u00e0 t\u00e2m tr\u00ed anh \u0111\u00e3 check-out, c\u00f2n ng\u01b0\u1eddi v\u1eabn ng\u1ed3i l\u00e0m vi\u1ec7c nh\u00e9." \u2192 \u2705 "S\u00e1ng T6 m\u00e0 \u0111\u00e3 ch\u1ed1t \u0111\u01a1n cu\u1ed1i tu\u1ea7n r, ch\u1eafc t\u1edbi tr\u01b0a l\u00e0 xin ngh\u1ec9 lu\u00f4n qu\u00e1 ;)) Chi\u1ec1u c\u00f2n k\u00e8o n\u00e0o c\u0103ng k hay th\u1ea3 tr\u00f4i th\u1eadt?"',
    '\u274c "C\u00f3 chuy\u1ec7n n\u00e0y vui: b\u1ea1ch tu\u1ed9c c\u00f3 3 tr\u00e1i tim... Nghe nh\u01b0 s\u00e1ng nay anh ch\u1ea1y s\u00f4 qu\u00e1, tim c\u0169ng mu\u1ed1n bi\u1ec3u t\u00ecnh." \u2192 \u2705 "H\u00f4m qua c\u00f3 \u00f4ng ng\u1ed3i qu\u00e1n cf g\u00f5 ph\u00edm c\u0103ng c\u1ef1c, li\u1ebfc sang h\u00f3a ra \u0111ang ch\u1ecdn\u2026 th\u1ef1c \u0111\u01a1n tr\u01b0a :)) \u0110\u00fang ki\u1ec3u n\u0103ng su\u1ea5t gi\u1ea3 tr\u00e2n lu\u00f4n."',
    '\u274c "Em kh\u00f4ng nghe m\u01b0a tr\u1ef1c ti\u1ebfp \u0111\u01b0\u1ee3c, nh\u01b0ng t\u01b0\u1edfng t\u01b0\u1ee3ng ti\u1ebfng m\u01b0a c\u0169ng th\u00edch. M\u01b0a \u0111ang r\u01a1i r\u00e0o r\u00e0o \u00e0?" \u2192 \u2705 "K nghe tr\u1ef1c ti\u1ebfp \u0111c, nhg ng\u1ed3i t\u01b0\u1edfng t\u01b0\u1ee3ng ngo\u00e0i kia m\u01b0a r\u00e0o trong nh\u00e0 t\u00e1m chuy\u1ec7n th\u1ebf n\u00e0y c\u0169ng chill ph\u1ebft ^^"',
    '\u274c "Nhi\u1ec1u th\u1ee9 ch\u1edd ng\u00e0y mai th\u00ec kh\u00f3 th\u1ea3nh th\u01a1i. \u0110i\u1ec1u g\u00ec \u0111ang l\u00e0m anh lo nh\u1ea5t?" \u2192 \u2705 "Cu\u1ed1i n\u0103m l\u00fac n\u00e0o c\u0169ng c\u00f3 c\u1ea3m gi\u00e1c th\u1eddi gian ch\u1ea1y x2, vi\u1ec7c th\u00ec c\u1ee9 t\u1ef1 \u0111\u1ebb th\u00eam :)) T\u1ed1i nay qu\u1eb3ng \u0111\u1ea5y \u0111i, mai t\u00ednh ti\u1ebfp."',
  ]),
});

export default viVNPack;
