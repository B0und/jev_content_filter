import { expect, test } from './fixtures';

test('ordinary red backgrounds stay below the Porn cutoff in the production inference worker', async ({
  page,
  context,
  extensionId,
}) => {
  test.setTimeout(90_000);
  await page.goto('https://x.com/home');
  const images = await page.evaluate(() => {
    return ['solid', 'gradient', 'texture'].map((kind) => {
      const canvas = document.createElement('canvas');
      canvas.width = 679;
      canvas.height = 272;
      const context = canvas.getContext('2d')!;
      context.fillStyle = '#a71923';
      if (kind !== 'solid') {
        const gradient = context.createLinearGradient(0, 0, 679, 272);
        gradient.addColorStop(0, '#220a15');
        gradient.addColorStop(0.5, '#c83226');
        gradient.addColorStop(1, '#521722');
        context.fillStyle = gradient;
      }
      context.fillRect(0, 0, 679, 272);
      if (kind === 'texture') {
        context.fillStyle = 'rgba(255, 220, 200, 0.08)';
        for (let y = 0; y < 272; y += 7) context.fillRect(0, y, 679, 1);
      }
      return canvas.toDataURL('image/png').split(',')[1]!;
    });
  });
  for (let index = 0; index < images.length; index += 1) {
    await context.route(`https://pbs.twimg.com/media/red-control-${index}*`, (route) =>
      route.fulfill({ contentType: 'image/png', body: Buffer.from(images[index]!, 'base64') }),
    );
  }
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  for (let index = 0; index < images.length; index += 1) {
    const result = await popup.evaluate(
      (index) =>
        chrome.runtime.sendMessage({
          type: 'classify-image',
          url: `https://pbs.twimg.com/media/red-control-${index}?format=png`,
        }),
      index,
    );
    expect(result.ok).toBe(true);
    expect(result.warning).toBeUndefined();
    expect(result.scores.porn).toBeGreaterThanOrEqual(0);
    expect(result.scores.porn).toBeLessThan(0.6);
  }
});
