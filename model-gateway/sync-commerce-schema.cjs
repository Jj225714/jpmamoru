// Developer-only: keep Python publication validation aligned with public catalog parsing.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../web/src/services/commerce-policy-catalog.ts'), 'utf8');
const section = source.slice(source.indexOf('const strings:'), source.indexOf('// Reconstruct only public policy fields'));
const code = section.replace(/: Shape\b/g, '').replace(/\bas const\b/g, '');
const schema = vm.runInNewContext(code + '\nJSON.stringify(packShape, null, 2)');
fs.writeFileSync(path.join(__dirname, 'commerce-policy-schema.json'), schema + '\n');
