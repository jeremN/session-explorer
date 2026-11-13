// UI kit of the viewer: small helpers that return HTML strings or wire a primitive of ui.css.
// No framework: the DOM holds the state (aria-pressed, data-tone), the helpers only read and render it.
import { esc } from './adapt.mjs';

/** A status pill. tone: 'positive' | 'warning' | 'negative' | 'info' | 'neutral'. */
export const pill = (text, tone = 'neutral') => '<span class="pill" data-tone="' + tone + '">' + esc(text) + '</span>';

/** One stat tile of a .stat-grid. The value is HTML; escape it before you pass it. */
export const stat = (label, value) => '<div class="stat"><dt>' + esc(label) + '</dt><dd>' + value + '</dd></div>';

/**
 * Wire a .seg group: add the thumb, and keep it under the button with aria-pressed="true".
 * The existing click handlers keep setting aria-pressed; a MutationObserver moves the thumb,
 * so no handler has to know about the thumb.
 */
export function wireSeg(seg) {
	const thumb = document.createElement('span');
	thumb.className = 'seg-thumb';
	thumb.setAttribute('aria-hidden', 'true');
	seg.prepend(thumb);
	const sync = () => {
		const on = seg.querySelector(':scope > button[aria-pressed="true"]');
		thumb.style.setProperty('--x', (on ? on.offsetLeft : 0) + 'px');
		thumb.style.setProperty('--w', (on ? on.offsetWidth : 0) + 'px');
	};
	new MutationObserver(sync).observe(seg, { subtree: true, attributes: true, attributeFilter: ['aria-pressed'] });
	// The width of a button changes when the web font arrives.
	new ResizeObserver(sync).observe(seg);
	sync();
}
