/** Shared in-page buttons: filled surfaces avoid thin pill strokes at fractional positions. */
export const BUTTON_CSS = `
button {
  font: inherit; font-weight: 600; cursor: pointer;
  color: var(--button-ink); background: var(--button-soft);
  border: 0; border-radius: 9999px; padding: 6px 15px;
}
button:hover { background: var(--button-hover); }
button.primary { color: var(--button-on-accent); background: var(--button-accent); }
button.primary:hover { background: color-mix(in srgb, var(--button-accent) 88%, var(--button-ink)); }
button:focus-visible { outline: 2px solid var(--button-accent); outline-offset: 3px; }
button:disabled { opacity: .5; cursor: default; }
`;
