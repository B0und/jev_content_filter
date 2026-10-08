import { test, expect } from './fixtures';

test('the mask follows the native content column and live X theme colors', async ({
  page,
  worker,
}) => {
  expect(worker.url()).toContain('chrome-extension:');
  await page.route('https://x.com/home', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><style>:root { --feed-bg:#000; --ink:#e7e9ea; --muted:#71767b; --accent:#1d9bf0 } body { margin:0; background:var(--feed-bg); color:var(--ink); font:15px sans-serif; overflow-anchor:none } main { width:min(600px,100%); margin:auto } article { padding:16px; } .content { margin-left:64px } .header { display:flex; justify-content:space-between } time { color:var(--muted) } a { color:var(--accent) } .body { min-height:300px }</style><main><article data-testid="tweet" data-post="990"><div class="content"><div class="header"><div data-testid="User-Name">Reader @reader</div><a href="/reader/status/990"><time>Now</time></a><button data-testid="caret">More</button></div><div class="body" data-testid="tweetText">BLOCK_TEXT <a href="/search?q=keyword">#keyword</a></div><div role="group"><button data-testid="reply">Reply</button></div></div></article><div id="following">Following post</div></main>`,
    }),
  );
  await page.goto('https://x.com/home');
  const slot = page.locator('[data-jev-hidden-slot]');
  await expect(slot.getByRole('button', { name: 'Show post', exact: true })).toBeVisible();
  const body = await page.locator('[data-testid="tweetText"]').boundingBox();
  const mask = await slot.boundingBox();
  expect(mask!.x).toBe(body!.x);
  expect(mask!.width).toBe(body!.width);
  const before = (await page.locator('#following').boundingBox())!.y;
  for (const theme of [
    { background: '#ffffff', ink: '#0f1419', muted: '#536471', accent: '#794bc4' },
    { background: '#15202b', ink: '#f7f9f9', muted: '#8b98a5', accent: '#ffad1f' },
    { background: '#000000', ink: '#e7e9ea', muted: '#71767b', accent: '#f91880' },
    { background: '#352f44', ink: '#faf0ca', muted: '#bcb8cd', accent: '#3ddc97' },
  ]) {
    await page.evaluate((theme) => {
      const style = document.documentElement.style;
      style.setProperty('--feed-bg', theme.background);
      style.setProperty('--ink', theme.ink);
      style.setProperty('--muted', theme.muted);
      style.setProperty('--accent', theme.accent);
    }, theme);
    const nativeMuted = await page.locator('time').evaluate((e) => getComputedStyle(e).color);
    const nativeAccent = await page
      .locator('[data-testid="tweetText"] a')
      .evaluate((e) => getComputedStyle(e).color);
    await expect(slot.locator('p')).toHaveCSS('color', nativeMuted);
    await expect(slot.getByRole('button', { name: 'Show post', exact: true })).toHaveCSS(
      'color',
      nativeAccent,
    );
    await expect(slot.locator('.notice')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    expect((await page.locator('#following').boundingBox())!.y).toBe(before);
  }
  await page.setViewportSize({ width: 390, height: 720 });
  await expect
    .poll(async () => (await slot.boundingBox())!.width)
    .toBe((await page.locator('[data-testid="tweetText"]').boundingBox())!.width);
});
