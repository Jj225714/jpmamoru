// Isolated real-browser regression: no external APIs, account or real credentials.
// Run from web/: node src/components/layout/channel-editor-drawer.e2e.mjs
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ChannelEditorDrawer } from '/src/components/layout/channel-editor-drawer.tsx';
import { useConfigStore } from '/src/stores/use-config-store.ts';
import { captureLocalTeamSettings, applyTeamSettings } from '/src/services/settings-data.ts';
import '/src/i18n';
const root = createRoot(document.getElementById('root'));
let channel;
window.editorTest = {
  saved: null,
  open(value) { channel = value; this.render(true); },
  render(open) { root.render(React.createElement(ChannelEditorDrawer, {open, channel, onClose: () => this.render(false), onSave: value => { this.saved = structuredClone(value); channel = value; } })); },
  async memberRead() {
    useConfigStore.setState({config: {...useConfigStore.getState().config, channels:[this.saved], textModel:'test::text'}});
    const team = captureLocalTeamSettings();
    team.policyPack.id = 'server-aoweisi-team-v1-test';
    team.policyPack.status = 'published';
    // JSON transport and applying a published envelope must retain the flag.
    const received = JSON.parse(JSON.stringify(team));
    useConfigStore.setState({config: {...useConfigStore.getState().config, channels:[]}});
    await applyTeamSettings(received, 1);
    this.open(useConfigStore.getState().config.channels[0]);
  }
};
`;
const server = await createServer({
    configFile: false, root, resolve: { alias: { '@': resolve(root, 'src') } },
    server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
    plugins: [react(), {
        name: 'channel-editor-test',
        resolveId(id) { if (id === 'virtual:channel-editor-test') return '\0channel-editor-test'; },
        load(id) { if (id === '\0channel-editor-test') return entry; },
        configureServer(vite) {
            vite.middlewares.use(async (req, res, next) => {
                if (req.url !== '/__editor_test') return next();
                res.setHeader('Content-Type', 'text/html');
                res.end(await vite.transformIndexHtml('/__editor_test', '<div id="root"></div><script type="module" src="/@id/virtual:channel-editor-test"></script>'));
            });
        },
    }],
});
let browser;
try {
    await server.listen();
    console.log('Test server ready');
    browser = await chromium.launch({ headless: true });
    console.log('Browser ready');
    const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
    page.setDefaultTimeout(30000);
    const errors = [];
    page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__editor_test`, {waitUntil:'domcontentloaded', timeout:30000});
    await page.waitForFunction(() => Boolean(window.editorTest));
    const fixture = { id:'test', name:'Test', baseUrl:'https://example.test', apiKey:'test-only-key', apiFormat:'openai', models:[{name:'text',capability:'text'},{name:'image',capability:'image',supportsImageInput:true}] };
    await page.evaluate(value => window.editorTest.open(value), fixture);
    const control = page.getByLabel('text 支持图片输入', { exact: true });
    const row = control.locator('xpath=ancestor::label');
    await control.waitFor();
    assert.match(await row.innerText(), /未确认/);
    assert.equal(await page.getByLabel('image 支持图片输入', { exact:true }).count(), 0);
    const choose = async label => {
        await control.click();
        await page.locator('.ant-select-dropdown:visible .ant-select-item-option-content').getByText(label, {exact:true}).click();
    };
    const save = async () => {
        await page.getByRole('button', { name:/^保\s*存$/ }).click();
        await page.waitForFunction(() => Boolean(window.editorTest.saved));
        return page.evaluate(() => window.editorTest.saved);
    };
    await choose('支持');
    let saved = await save();
    assert.equal(saved.models[0].supportsImageInput, true);
    assert.equal('supportsImageInput' in saved.models[1], false);
    await page.evaluate(() => window.editorTest.open(window.editorTest.saved));
    await control.waitFor();
    assert.match(await row.innerText(), /支持/);
    await page.evaluate(() => window.editorTest.memberRead());
    await control.waitFor();
    assert.match(await row.innerText(), /支持/);
    await choose('不支持');
    saved = await save();
    assert.equal(saved.models[0].supportsImageInput, false);
    await page.evaluate(() => window.editorTest.open(window.editorTest.saved));
    await choose('未确认');
    saved = await save();
    assert.equal('supportsImageInput' in saved.models[0], false);
    await page.evaluate(() => window.editorTest.open(window.editorTest.saved));
    await choose('支持');
    await page.getByRole('button', {name:/^取\s*消$/}).click();
    await page.evaluate(() => window.editorTest.open(window.editorTest.saved));
    assert.match(await row.innerText(), /未确认/);
    await choose('支持');
    const modelRow = page.locator('div.rounded-md').filter({has: control});
    await modelRow.locator('.ant-segmented-item').nth(0).click();
    assert.equal(await control.count(), 0);
    const imageRow = page.locator('div.rounded-md').filter({has: page.getByText('text', {exact:true})});
    await imageRow.locator('.ant-segmented-item').nth(2).click();
    assert.match(await row.innerText(), /未确认/);
    assert.deepEqual(errors, []);
    console.log('PASS: unknown/support/unsupported, save/reopen, member application, non-text cleanup, cancel, capability changes');
} finally {
    await browser?.close();
    await server.close();
}
