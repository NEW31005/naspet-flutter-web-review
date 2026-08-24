// 開発用: APIサーバー(tsx watch)とWeb(vite)を同時起動する。
import { spawn } from 'node:child_process';

const procs = [
  spawn('npx', ['tsx', 'watch', 'apps/server/src/index.ts'], { stdio: 'inherit' }),
  spawn('npm', ['run', 'dev', '-w', '@aibw/web'], { stdio: 'inherit' }),
];

const shutdown = () => {
  for (const p of procs) p.kill('SIGTERM');
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
for (const p of procs) p.on('exit', (code) => {
  if (code !== 0 && code != null) shutdown();
});
