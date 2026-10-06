import { test, expect } from './fixtures';

test('popup has an intrinsic size when Chrome starts with a tiny viewport', async ({
  page,
  extensionId,
}) => {
  // Chrome measures an action popup from its content. Viewport-relative caps
  // must not make that content retain the initial, tiny measurement viewport.
  await page.setViewportSize({ width: 10, height: 20 });
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(page.getByRole('switch', { name: 'Enable filtering', exact: true })).toBeAttached();
  const size = await page.locator('.popup').evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return { width: bounds.width, height: bounds.height };
  });
  expect(size).toEqual({ width: 400, height: 560 });
});
