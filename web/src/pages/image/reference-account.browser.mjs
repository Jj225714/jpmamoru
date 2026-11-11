import { chromium } from 'playwright';
import fs from 'node:fs/promises';
const browser = await chromium.launch({ headless: true });
try {
 const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
 await page.goto('http://127.0.0.1:3011/image');
 await page.locator('input[type=file]').first().waitFor({ state: 'attached' });
 const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
 for (const transition of ['B', 'ABA', 'logout']) {
  await page.evaluate(async () => {
   const { useServerConfigStore: store } = await import('/src/services/server-config.ts');
   window.accountStore = store;
   store.setState({ user: { id: 'A', username: 'A', role: 'member' }, phase: 'ready' });
   const descriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
   window.restoreImageSrc = () => Object.defineProperty(HTMLImageElement.prototype, 'src', descriptor);
   Object.defineProperty(HTMLImageElement.prototype, 'src', { ...descriptor, set(value) {
    if (String(value).startsWith('blob:') && !window.releaseOldUpload) {
     const image = this; window.releaseOldUpload = () => { descriptor.set.call(image, value); window.releaseOldUpload = null; window.restoreImageSrc(); };
    } else descriptor.set.call(this, value);
   }});
  });
  await page.locator('input[type=file]').first().setInputFiles({ name: 'old-account.png', mimeType: 'image/png', buffer: png });
  await page.getByText('old-account.png: 读取/上传中', { exact: true }).waitFor();
  await page.evaluate(transition => {
   window.accountStore.setState({ user: { id: 'B', username: 'B', role: 'member' }, phase: 'ready' });
   if (transition === 'ABA') window.accountStore.setState({ user: { id: 'A', username: 'A', role: 'member' } });
   if (transition === 'logout') window.accountStore.setState({ user: null, phase: 'signed-out' });
   window.releaseOldUpload();
  }, transition);
  await page.waitForTimeout(500);
  if (await page.getByText(/old-account.png/).count() || await page.locator('img[alt="old-account.png"]').count()) throw Error(`old upload leaked: ${transition}`);
 }
 await fs.mkdir('test-results/reference-account', { recursive: true });
 await page.screenshot({ path: 'test-results/reference-account/after-switch.png' });
 console.log('PASS real /image upload flow with synthetic account A->B, A->B->A and logout; delayed old image never enters UI.');
} finally { await browser.close(); }
