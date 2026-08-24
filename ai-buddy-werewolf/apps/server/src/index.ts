/** APIサーバー起動 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MatchManager } from './matches.js';
import { createServer } from './http.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const rootDir = path.resolve(here, '..', '..', '..');

/** .env があれば環境変数へ読み込む(依存なしの素朴なパーサー) */
function loadDotEnv(): void {
  const file = path.join(rootDir, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const key = m[1];
    let value = m[2] ?? '';
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv();
const port = Number(process.env.AIBW_PORT ?? 8787);
const manager = new MatchManager(rootDir);
const server = createServer(rootDir, manager);
server.listen(port, () => {
  console.log(`[aibw] APIサーバー起動: http://localhost:${port}`);
  console.log(`[aibw] ルート: ${rootDir}`);
  console.log(
    `[aibw] ANTHROPIC_API_KEY: ${process.env.ANTHROPIC_API_KEY ? '設定あり(Live可)' : '未設定(モックのみ)'}`,
  );
});
