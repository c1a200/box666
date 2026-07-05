import { Hono } from 'hono';

const FONTS: Record<string, string> = {
  'jetbrains-mono-latin-ext.woff2': 'font/woff2',
  'jetbrains-mono-latin.woff2': 'font/woff2',
  'outfit-latin-ext.woff2': 'font/woff2',
  'outfit-latin.woff2': 'font/woff2',
};

export function createStaticAssetsRouter(): Hono {
  const router = new Hono();

  router.get('/fonts/:name', async (c) => {
    const name = c.req.param('name');
    const contentType = FONTS[name];
    if (!contentType) return c.text('Not Found', 404);
    try {
      const fs = await import('fs');
      const path = await import('path');
      const data = await fs.promises.readFile(path.join(__dirname, 'static/fonts', name));
      return c.body(data, 200, {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=31536000, immutable',
      });
    } catch {
      return c.text('Not Found', 404);
    }
  });

  return router;
}
