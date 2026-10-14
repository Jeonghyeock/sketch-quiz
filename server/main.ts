import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startServer } from './app.ts';

const distDir = fileURLToPath(new URL('../dist', import.meta.url));

const server = await startServer({
  port: Number(process.env.PORT ?? 3100),
  host: process.env.HOST,
  staticDir: existsSync(distDir) ? distDir : undefined,
});

console.log(`[server] http://localhost:${server.port}${existsSync(distDir) ? '' : ' (WebSocket only — run `npm run build` to serve the app)'}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await server.close();
    process.exit(0);
  });
}
