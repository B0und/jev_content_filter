// Pure DOM helpers for discovering X posts. No state, no classification —
// every function takes its inputs and returns data.
export interface ArticleContent {
  id: string;
  handle: string;
  author: string;
  text: string;
  urls: string[];
  previewUrl: string;
  previewText: string;
}

/**
 * Canonical identity for a twimg image URL. X rewrites normal media images
 * between size variants while the feed scrolls (`name=small` ↔
 * `name=120x120`, the legacy `:small` suffix, extension vs `format=`
 * spelling). Every `/media/` variant names the same underlying image, so
 * normal media snapshots must ignore those volatile parameters. Card-image
 * URLs require their `name` variant to address the stored asset; when X
 * supplies a card URL without one, default to the fetchable `small` variant.
 *
 * The result stays directly fetchable — twimg requires `format=` (a bare
 * media path 404s) — so identity, cache keys, and the image download all
 * agree on one URL. Host is lowercased (DNS is case-insensitive); the path is
 * not, because twimg media ids are case-sensitive.
 */
export function canonicalMediaUrl(url: string): string {
  if (!url) return '';
  let parsed: URL;
  try {
    parsed = new URL(url, location.origin);
  } catch {
    return url;
  }
  // Strip the legacy ":small" size suffix first: it hides the extension.
  const sized = parsed.pathname.replace(/:(?:thumb|small|medium|large|orig)$/i, '');
  const suffixFormat = sized.match(/\.(jpe?g|png|webp|gif|avif)$/i)?.[1];
  const path = sized.replace(/\.(?:jpe?g|png|webp|gif|avif)$/i, ''); // folded into format
  const isMediaPath = path.startsWith('/media/');
  const isCardPath = path.startsWith('/card_img/');
  const params = new URLSearchParams(parsed.search);
  const format = params.get('format') ?? suffixFormat;
  params.delete('format');
  // `/media/` uses name only for a volatile size variant. Card-image URLs
  // require their name variant to address the actual stored asset.
  if (isMediaPath) params.delete('name');
  else if (isCardPath && !params.has('name')) params.set('name', 'small');
  if (format) params.set('format', format.toLowerCase());
  params.sort();
  const query = params.toString();
  return `${parsed.protocol}//${parsed.hostname.toLowerCase()}${path}${query ? `?${query}` : ''}`;
}

export function headerCarets(article: HTMLElement): HTMLElement[] {
  return Array.from(article.querySelectorAll<HTMLElement>('[data-testid="caret"]')).filter(
    (caret) =>
      !caret
        .closest('article[data-testid="tweet"]')
        ?.parentElement?.closest('article[data-testid="tweet"]'),
  );
}

/**
 * Read everything we filter on from one (top-level) tweet article. Media
 * URLs are canonicalized (see canonicalMediaUrl): X rewrites their size
 * params constantly, and the caller treats any snapshot difference as a
 * content change, so raw srcs would make every scroll pass look like an edit.
 */
export function readArticle(article: HTMLElement): ArticleContent | null {
  const link =
    article.querySelector<HTMLAnchorElement>('a[href*="/status/"]:has(time)') ??
    article.querySelector<HTMLAnchorElement>('a[href*="/status/"]');
  const href = link?.getAttribute('href') ?? '';
  const idMatch = href.match(/\/([^/]+?)\/status\/(\d+)/);
  const id = idMatch?.[2] ?? link?.getAttribute('href')?.match(/\/status\/(\d+)/)?.[1];
  if (!id) return null;
  const previewImage = article.querySelector<HTMLImageElement>(
    '[data-testid="card.wrapper"] img[src*="pbs.twimg.com"]',
  );
  return {
    id,
    handle: idMatch?.[1] ?? '',
    author: article.querySelector('[data-testid="User-Name"]')?.textContent?.trim() ?? '',
    text: Array.from(
      article.querySelectorAll('[data-testid="tweetText"]'),
      (node) => node.textContent?.trim() ?? '',
    ).join('\n'),
    urls: [
      ...new Set(
        Array.from(article.querySelectorAll<HTMLImageElement>('img[src*="pbs.twimg.com/media"]'))
          .filter((img) => !img.closest('[data-testid="card.wrapper"]'))
          .map((img) => canonicalMediaUrl(img.currentSrc || img.src)),
      ),
    ],
    previewUrl: previewImage ? canonicalMediaUrl(previewImage.currentSrc || previewImage.src) : '',
    previewText: article.querySelector('[data-testid="card.wrapper"]')?.textContent?.trim() ?? '',
  };
}

/**
 * Put the icon after the ⋯ button in the post header; posts without
 * a caret fall back to a right-aligned row under the content.
 */
export function insertHost(article: HTMLElement, host: HTMLElement): void {
  const caret = headerCarets(article)[0];
  if (caret?.parentElement) {
    host.dataset.jevSpot = 'header';
    caret.parentElement.insertBefore(host, caret.nextSibling);
  } else {
    host.dataset.jevSpot = 'below';
    article.append(host);
  }
}

export function sameUrls(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((url, i) => url === b[i]);
}
