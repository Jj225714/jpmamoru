import { chromium } from 'playwright';
import fs from 'node:fs/promises';
const browser = await chromium.launch({ headless: true });
try {
 const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
 await page.goto('http://127.0.0.1:3011');
 await page.waitForTimeout(1500);
 await page.evaluate(async () => {
  const reactModule = await import('/node_modules/.vite/deps/react.js');
  const React = reactModule.default || reactModule;
  const dom = await import('/node_modules/.vite/deps/react-dom_client.js');
  const createRoot = dom.createRoot || dom.default.createRoot;
  const { ReferenceOrderButtons, moveReferenceById } = await import('/src/pages/image/reference-order.tsx');
  document.getElementById('root').style.display = 'none';
  const host = document.createElement('div'); document.body.append(host);
  function Harness() {
   const [items, setItems] = React.useState([{ id: 'A' }, { id: 'B' }, { id: 'C' }]);
   return React.createElement('div', { className: 'flex gap-2 bg-stone-100 p-8 dark:bg-stone-950' }, items.map((item, index) => React.createElement('div', { key: item.id, 'data-card': item.id, className: 'w-44 overflow-hidden rounded-md border border-stone-300' },
    React.createElement('div', { className: 'flex h-24 items-center justify-center bg-stone-200 text-2xl' }, item.id),
    React.createElement(ReferenceOrderButtons, { index, total: items.length, onMove: offset => setItems(current => moveReferenceById(current, item.id, offset)) }))));
  }
  createRoot(host).render(React.createElement(Harness));
 });
 const order = () => page.locator('[data-card]').evaluateAll(nodes => nodes.map(n => n.dataset.card).join(''));
 const check = async expected => { if (await order() !== expected) throw Error(`Expected ${expected}, got ${await order()}`); };
 const card = page.locator('[data-card="C"]');
 await card.getByRole('button', { name: /前移/ }).click(); await check('ACB');
 const forward = card.getByRole('button', { name: /前移/ });
 await forward.focus(); await page.keyboard.press('Enter'); await check('CAB');
 await page.keyboard.press('Enter'); await check('CAB');
 if (await forward.getAttribute('aria-disabled') !== 'true') throw Error('First boundary not disabled');
 await page.keyboard.press('Tab'); await page.keyboard.press('Space'); await check('ACB');
 await page.keyboard.press('Space'); await check('ABC');
 await page.keyboard.press('Space'); await check('ABC');
 const size = await forward.boundingBox(); if (size.height < 44 || size.width < 44) throw Error('Small target');
 await fs.mkdir('test-results/reference-order', { recursive: true });
 await page.evaluate(() => document.documentElement.classList.remove('dark'));
 await page.waitForTimeout(300);
 await page.screenshot({ path: 'test-results/reference-order/light.png' });
 await page.evaluate(() => document.documentElement.classList.add('dark'));
 await page.screenshot({ path: 'test-results/reference-order/dark.png' });
 console.log('PASS: mouse, Enter, Tab/Space, repeated reorder, both boundaries, 44px targets; light/dark screenshots.');
} finally { await browser.close(); }
