import { test, expect } from './fixtures';

test('the mask follows the native content column and live X theme colors', async ({
  page,
  worker,
}) => {
  expect(worker.url()).toContain('chrome-extension:');
  await page.route('https://x.com/home', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><style>:root { --feed-bg:#000; --ink:#e7e9ea; --muted:#71767b; --accent:#1d9bf0 } body { margin:0; background:var(--feed-bg); color:var(--ink); font:15px sans-serif; overflow-anchor:none } main { width:min(600px,100%); margin:auto } article { padding:16px; font-family:serif; } time, [data-testid="tweetText"] { font:15px/20px Arial, sans-serif; } .content { margin-left:64px } .header { display:flex; justify-content:space-between } time { color:var(--muted) } a { color:var(--accent) } .body { min-height:300px }</style><main><article data-testid="tweet" data-post="990"><div class="content"><div class="header"><div data-testid="User-Name">Reader @reader</div><a href="/reader/status/990"><time>Now</time></a><button data-testid="caret">More</button></div><div class="body" data-testid="tweetText">BLOCK_TEXT <a href="/search?q=keyword">#keyword</a></div><div role="group"><button data-testid="reply">Reply</button></div></div></article><div id="following">Following post</div></main>`,
    }),
  );
  await page.goto('https://x.com/home');
  const slot = page.locator('[data-jev-hidden-slot]');
  await expect(slot.getByRole('button', { name: 'Show post', exact: true })).toBeVisible();
  const body = await page.locator('[data-testid="tweetText"]').boundingBox();
  const mask = await slot.boundingBox();
  expect(mask!.x).toBe(body!.x);
  expect(mask!.width).toBe(body!.width);
  const nativeFont = await page.locator('time').evaluate((e) => {
    const style = getComputedStyle(e);
    return { family: style.fontFamily, size: style.fontSize, line: style.lineHeight };
  });
  for (const element of [
    slot.locator('p'),
    slot.getByRole('button', { name: 'Show post', exact: true }),
  ]) {
    await expect(element).toHaveCSS('font-family', nativeFont.family);
    await expect(element).toHaveCSS('font-size', nativeFont.size);
    await expect(element).toHaveCSS('line-height', nativeFont.line);
  }
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

test('cropped multi-image media keeps recovery controls visible and clickable', async ({
  page,
  worker,
}) => {
  expect(worker.url()).toContain('chrome-extension:');
  await page.route('https://x.com/home', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><style>body{margin:0;font:15px/20px Arial}main{width:600px;margin:auto;overflow:hidden}article{padding:16px}.content{margin-left:64px}.media{display:grid;grid-template-columns:1fr 1fr;gap:2px}.photo{position:relative;height:200px;overflow:hidden}.photo img{position:absolute;width:1300px;height:700px;left:50%;top:50%;transform:translate(-50%,-50%)}.header{display:flex;justify-content:space-between}</style><main><article data-testid="tweet"><div class="content"><div class="header"><div data-testid="User-Name">Reader @reader</div><a href="/reader/status/991"><time>Now</time></a><button data-testid="caret">More</button></div><div data-testid="tweetText">BLOCK_TEXT</div><div class="media">${Array.from({ length: 4 }, () => '<div class="photo" data-testid="tweetPhoto"><img alt="" src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%221300%22 height=%22700%22/%3E"></div>').join('')}</div><div role="group"><button data-testid="reply">Reply</button></div></div></article><div id="following">Next post</div></main>`,
    }),
  );
  await page.goto('https://x.com/home');
  const slot = page.locator('[data-jev-hidden-slot]');
  const show = slot.getByRole('button', { name: 'Show post', exact: true });
  await expect(show).toBeVisible();
  const column = (await page.locator('.content').boundingBox())!;
  const mask = (await slot.boundingBox())!;
  expect(mask.x).toBe(column.x);
  expect(mask.width).toBe(column.width);
  const control = (await show.boundingBox())!;
  expect(control.x).toBeGreaterThanOrEqual(column.x);
  expect(control.x + control.width).toBeLessThanOrEqual(column.x + column.width);
  expect(
    await show.evaluate((button) => {
      const r = button.getBoundingClientRect();
      const root = button.getRootNode() as ShadowRoot;
      return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === root.host;
    }),
  ).toBe(true);
  const before = (await page.locator('#following').boundingBox())!.y;
  await show.click();
  await expect(page.locator('[data-testid="tweetText"]')).toBeVisible();
  expect((await page.locator('#following').boundingBox())!.y).toBe(before);
});
