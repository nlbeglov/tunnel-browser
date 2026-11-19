// The ⋮ menu page (main/appMenu.ts lays it over the window): items under the button, opening
// leftwards like Chrome's; a submenu opens to the left of it when there is room. Mouse and
// keyboard: arrows move, Enter chooses, ← / → open and close a submenu, Esc closes.

import type { AppMenuEntry, AppMenuItem, AppMenuShow } from '../shared/types';
import { flag } from './format';

declare global {
  interface Window {
    menu: { onShow(cb: (d: AppMenuShow) => void): () => void; choose(id: string): void; close(): void };
  }
}

const root = document.getElementById('root')!;
let sub: { panel: HTMLElement; host: HTMLButtonElement } | null = null;

const SVG = 'http://www.w3.org/2000/svg';
function chevron(): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  const p = document.createElementNS(SVG, 'path');
  p.setAttribute('d', 'M9 18l6-6-6-6');
  svg.append(p);
  return svg;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function itemButton(item: AppMenuItem): HTMLButtonElement {
  const b = el('button', 'mi');
  b.setAttribute('role', 'menuitem');
  b.disabled = !!item.disabled;
  if (item.color || item.country) {
    const icon = el('span', 'mi-icon');
    if (item.color) {
      const dot = el('span', 'mi-dot');
      dot.style.setProperty('--c', item.color);
      icon.append(dot);
    }
    const f = flag(item.country);
    if (f) icon.append(el('span', 'mi-flag', f));
    b.append(icon);
  }
  b.append(el('span', 'mi-label', item.label));
  if (item.note) b.append(el('span', 'mi-note', item.note));
  if (item.accel) b.append(el('span', 'mi-accel', item.accel));
  if (item.sub) {
    b.setAttribute('aria-haspopup', 'menu');
    b.setAttribute('aria-expanded', 'false');
    const more = el('span', 'mi-more');
    more.append(chevron());
    b.append(more);
  }
  return b;
}

function panel(entries: AppMenuEntry[], level: number): HTMLElement {
  const p = el('div', 'app-menu');
  p.setAttribute('role', 'menu');
  p.tabIndex = -1;
  for (const entry of entries) {
    if (entry === 'separator') {
      p.append(el('div', 'mi-sep'));
      continue;
    }
    const b = itemButton(entry);
    if (entry.sub) {
      const open = () => openSub(b, entry.sub!);
      b.addEventListener('click', () => {
        open();
        firstItem(sub?.panel)?.focus();
      });
      b.addEventListener('mouseenter', open);
    } else {
      b.addEventListener('click', () => window.menu.choose(entry.id));
      // Hovering another item of the main menu closes the open submenu.
      if (level === 0) b.addEventListener('mouseenter', closeSub);
    }
    p.append(b);
  }
  return p;
}

function items(p?: HTMLElement): HTMLButtonElement[] {
  return p ? [...p.querySelectorAll<HTMLButtonElement>('.mi:not(:disabled)')] : [];
}
function firstItem(p?: HTMLElement) {
  return items(p)[0];
}

function closeSub() {
  if (!sub) return;
  sub.host.classList.remove('open');
  sub.host.setAttribute('aria-expanded', 'false');
  sub.panel.remove();
  sub = null;
}

function openSub(host: HTMLButtonElement, entries: AppMenuEntry[]) {
  if (sub?.host === host) return;
  closeSub();
  const p = panel(entries, 1);
  p.style.visibility = 'hidden';
  root.append(p);
  const main = host.closest('.app-menu')!.getBoundingClientRect();
  const row = host.getBoundingClientRect();
  const w = p.offsetWidth;
  // Leftwards, like the menu itself; to the right only when there is no room on the left.
  const left = main.left - w + 4 >= 8 ? main.left - w + 4 : main.right - 4;
  p.style.left = `${Math.max(8, left)}px`;
  p.style.top = `${Math.max(8, Math.min(row.top - 7, innerHeight - p.offsetHeight - 8))}px`;
  p.style.visibility = '';
  host.classList.add('open');
  host.setAttribute('aria-expanded', 'true');
  sub = { panel: p, host };
}

function show(d: AppMenuShow) {
  closeSub();
  root.replaceChildren();
  const backdrop = el('div', 'menu-backdrop');
  backdrop.addEventListener('mousedown', () => window.menu.close());
  const main = panel(d.items, 0);
  root.append(backdrop, main);
  // Its right edge under the button's, inside the window.
  main.style.right = `${Math.max(8, innerWidth - d.right)}px`;
  main.style.top = `${Math.max(8, Math.min(d.top, innerHeight - main.offsetHeight - 8))}px`;
  main.focus();
}

document.addEventListener('keydown', (e) => {
  const mainPanel = root.querySelector<HTMLElement>('.app-menu');
  if (!mainPanel) return;
  const current = document.activeElement instanceof HTMLButtonElement ? document.activeElement : null;
  const inSub = !!(sub && current && sub.panel.contains(current));
  const list = items(inSub ? sub!.panel : mainPanel);
  const at = current ? list.indexOf(current) : -1;
  // The submenu opens to the left of the menu, or to the right when it had to.
  const subLeft = sub ? sub.panel.getBoundingClientRect().left < mainPanel.getBoundingClientRect().left : true;
  const toSub = subLeft ? 'ArrowLeft' : 'ArrowRight';
  const fromSub = subLeft ? 'ArrowRight' : 'ArrowLeft';
  if (e.key === 'Escape') {
    e.preventDefault();
    if (inSub) {
      const host = sub!.host;
      closeSub();
      host.focus();
    } else window.menu.close();
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!list.length) return;
    const step = e.key === 'ArrowDown' ? 1 : -1;
    list[at < 0 ? (step > 0 ? 0 : list.length - 1) : (at + step + list.length) % list.length].focus();
  } else if (e.key === toSub && current?.getAttribute('aria-haspopup') && !inSub) {
    e.preventDefault();
    current.click();
  } else if (e.key === fromSub && inSub) {
    e.preventDefault();
    const host = sub!.host;
    closeSub();
    host.focus();
  } else if (e.key === 'Tab') {
    e.preventDefault();
  }
});

window.menu.onShow(show);
