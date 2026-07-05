import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { getHistory, subscribe } from '../core/log-buffer';
import type { AppConfig } from '../core/types';
import { verifyAdmin } from './admin-auth';

export function createLogViewerRouter(config: AppConfig): Hono {
  const router = new Hono();

  router.get('/admin/logs', (c) => {
    if (!verifyAdmin(c.req.raw, config)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    return streamSSE(c, async (stream) => {
      for (const entry of getHistory()) {
        await stream.writeSSE({ data: JSON.stringify(entry) });
      }

      const unsubscribe = subscribe((entry) => {
        if (stream.closed) return;
        stream.writeSSE({ data: JSON.stringify(entry) }).catch(() => {});
      });

      const heartbeat = setInterval(() => {
        if (stream.closed) return;
        stream.write(': ping\n\n').catch(() => {});
      }, 25_000);

      try {
        await new Promise<void>((resolve) => {
          stream.onAbort(() => resolve());
        });
      } finally {
        clearInterval(heartbeat);
        unsubscribe();
      }
    });
  });

  return router;
}
