// SCROLL v1.5 — LEDGER: bảng theo dõi người-đọc XUYÊN-run.
// `local://` = CSV/MD (core, 0 dependency). Scheme ngoài (notion/sheets/excel) → ghi ledger.jsonl
// trong loopDir cho ADAPTER app-layer đẩy (SCROLL core KHÔNG nhúng SDK bên thứ ba).
import fs from 'node:fs';
import path from 'node:path';

export const LEDGER_HEADER = ['ts', 'loop', 'iteration', 'task', 'status', 'tries', 'proof', 'digest'];

function csvCell(v) { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }

// "local://runs/ledger.csv" → {scheme:'local', target:'runs/ledger.csv'}
export function parseLedger(spec) {
  if (!spec) return null;
  const m = String(spec).match(/^(\w+):\/\/(.*)$/);
  return m ? { scheme: m[1], target: m[2] } : { scheme: 'local', target: String(spec) };
}

// Append 1 dòng ledger. Luôn ghi ledger.jsonl (audit + adapter). `local` → ghi thẳng CSV/MD.
export function appendLedgerRow(ledgerSpec, cwd, loopDir, row) {
  const jsonlPath = path.join(loopDir, 'ledger.jsonl');
  fs.appendFileSync(jsonlPath, JSON.stringify(row) + '\n');
  const L = parseLedger(ledgerSpec);
  if (!L) return { jsonl: jsonlPath, external: false };
  if (L.scheme === 'local') {
    const p = path.resolve(cwd, L.target);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    if (/\.md$/.test(p)) {
      if (!fs.existsSync(p)) fs.writeFileSync(p, '| ' + LEDGER_HEADER.join(' | ') + ' |\n| ' + LEDGER_HEADER.map(() => '---').join(' | ') + ' |\n');
      fs.appendFileSync(p, '| ' + LEDGER_HEADER.map((h) => csvCell(row[h]).replace(/\|/g, '\\|')).join(' | ') + ' |\n');
    } else {
      if (!fs.existsSync(p)) fs.writeFileSync(p, LEDGER_HEADER.join(',') + '\n');
      fs.appendFileSync(p, LEDGER_HEADER.map((h) => csvCell(row[h])).join(',') + '\n');
    }
    return { local: p, external: false };
  }
  // notion/sheets/excel → adapter app-layer đọc ledger.jsonl + đẩy lên (proof = ảnh upload→URL→FILES).
  return { jsonl: jsonlPath, external: true, scheme: L.scheme, target: L.target };
}
