// main.ts — entrypoint: the trial lifecycle. Binds an ephemeral port, tells
// the environment where the forge listens, then waits until the harness
// reports the trial is done and exits 0. Node stdlib only.
//
// Local mode (no MAKEFUN_ENV_URL): listens on $PORT (default 8901) and
// serves until killed, so the kit's local runner can dial it directly.
import { createForge } from './app.ts';

const ENV_URL = process.env.MAKEFUN_ENV_URL;

async function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function trialMode(): Promise<number> {
  const forge = createForge();
  const port = await new Promise<number>((resolve, reject) => {
    forge.server.once('error', reject);
    forge.server.listen(0, '127.0.0.1', () => {
      const addr = forge.server.address();
      if (addr && typeof addr === 'object') resolve(addr.port);
      else reject(new Error('could not determine listen port'));
    });
  });
  console.log(`github-core-clone-01-v2 forge listening on 127.0.0.1:${port}`);
  const base = ENV_URL!.replace(/\/$/, '');
  const res = await postJson(`${base}/register`, { port });
  if (!res.ok) {
    console.error(`register failed: HTTP ${res.status}`);
    forge.server.close();
    return 1;
  }
  for (;;) {
    await sleep(500);
    try {
      const state = (await (await fetch(`${base}/done`)).json()) as { done?: boolean };
      if (state.done === true) break;
    } catch {
      // The environment may not be ready yet; keep polling.
    }
  }
  console.log('trial done, shutting down');
  forge.server.close();
  return 0;
}

async function localMode(): Promise<number> {
  const forge = createForge();
  const port = Number(process.env.PORT ?? 8901);
  await new Promise<void>((resolve, reject) => {
    forge.server.once('error', reject);
    forge.server.listen(port, '127.0.0.1', () => resolve());
  });
  console.log(`github-core-clone-01-v2 forge listening on 127.0.0.1:${port} (local mode)`);
  return new Promise<number>(() => {
    // Serve until killed.
  });
}

process.exitCode = await (ENV_URL ? trialMode() : localMode());
