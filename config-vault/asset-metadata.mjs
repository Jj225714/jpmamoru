const fail = () => { throw Object.assign(new Error('Invalid asset metadata'), { status: 400 }); };
const object = (value, keys) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) fail();
};
export const validLocalId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value) && !unsafe(value);
const unsafe = value => /(?:[a-z][a-z0-9+.-]*:\/\/|\b(?:https?|ftp|data|javascript|file):|\/\/|www\.|[<>`]|\b(?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]|\bbearer\s+|\bsk-[a-z0-9_-]{8,}|-----BEGIN|\b(?:eval|Function|require|fetch|alert)\s*\(|\b(?:import|export)\s+|\bfunction\s*\(|=>)/i.test(value);
function text(value, max) {
    if (typeof value !== 'string' || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) || unsafe(value)) fail();
    try { encodeURIComponent(value); } catch { fail(); }
    return value;
}
export function cleanAssetMetadata(value) {
    if (value === undefined) return { version: 1, kind: 'other' };
    object(value, ['version', 'kind', 'source', 'generation', 'referenceIds']);
    if (value.version !== 1 || !['original', 'white-background', 'generated', 'other'].includes(value.kind)) fail();
    const out = { version: 1, kind: value.kind };
    if (value.source !== undefined) {
        object(value.source, ['taskId', 'nodeId', 'localId']); out.source = {};
        for (const key of ['taskId', 'nodeId', 'localId']) if (value.source[key] !== undefined) {
            if (!validLocalId(value.source[key]) || unsafe(value.source[key])) fail();
            out.source[key] = value.source[key];
        }
    }
    if (value.generation !== undefined) {
        const g = value.generation; object(g, ['version', 'prompt', 'model', 'parameters']);
        if (g.version !== 1) fail();
        out.generation = { version: 1 };
        if (g.prompt !== undefined) out.generation.prompt = text(g.prompt, 4000);
        if (g.model !== undefined) {
            text(g.model, 128);
            const parts = g.model.split('::');
            const modelPart = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
            const channelPart = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;
            if (g.model.includes('//') || !(parts.length === 1 ? modelPart.test(parts[0]) : parts.length === 2 && channelPart.test(parts[0]) && modelPart.test(parts[1]))) fail();
            out.generation.model = g.model;
        }
        if (g.parameters !== undefined) {
            const ranges = { width: [1, 16384], height: [1, 16384], seed: [0, Number.MAX_SAFE_INTEGER], steps: [1, 1000], guidance: [0, 100], count: [1, 16] };
            const enums = { quality: ['low', 'medium', 'high', 'standard', 'hd', 'auto'], background: ['auto', 'white', 'transparent', 'unspecified'], format: ['png', 'jpeg', 'webp'] };
            object(g.parameters, [...Object.keys(ranges), ...Object.keys(enums), 'requestedSize']);
            const p = {};
            for (const [key, [min, max]] of Object.entries(ranges)) if (g.parameters[key] !== undefined) {
                const n = g.parameters[key];
                if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max || (key !== 'guidance' && !Number.isSafeInteger(n))) fail();
                p[key] = n;
            }
            for (const [key, values] of Object.entries(enums)) if (g.parameters[key] !== undefined) { if (!values.includes(g.parameters[key])) fail(); p[key] = g.parameters[key]; }
            // Append only when supplied, preserving canonical bytes/fingerprints for older inputs.
            if (g.parameters.requestedSize !== undefined) {
                const size = g.parameters.requestedSize;
                if (typeof size !== 'string' || size.length > 19) fail();
                if (size.includes('.')) {
                    const decimal = size.match(/^((?:0|[1-9][0-9]{0,4})(?:\.[0-9]{1,3})?):((?:0|[1-9][0-9]{0,4})(?:\.[0-9]{1,3})?)$/);
                    if (!decimal) fail();
                    // Exact thousandths avoid floating-point errors at the 1:3 / 3:1 boundaries.
                    const units = part => { const [whole, fraction = ''] = part.split('.'); return Number(whole) * 1000 + Number(fraction.padEnd(3, '0')); };
                    const a = units(decimal[1]); const b = units(decimal[2]);
                    if (a <= 0 || b <= 0 || a > 10000000 || b > 10000000 || a * 3 < b || a > b * 3) fail();
                } else if (size !== 'auto') {
                    const match = size.match(/^([1-9][0-9]{0,4})(:|x)([1-9][0-9]{0,4})$/);
                    const bound = match?.[2] === ':' ? 10000 : 16384;
                    if (!match || Number(match[1]) > bound || Number(match[3]) > bound) fail();
                }
                p.requestedSize = size;
            }
            out.generation.parameters = p;
        }
    }
    if (value.referenceIds !== undefined) {
        if (!Array.isArray(value.referenceIds) || value.referenceIds.length > 16 || !value.referenceIds.every(v => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v)) || new Set(value.referenceIds).size !== value.referenceIds.length) fail();
        out.referenceIds = [...value.referenceIds].sort();
    }
    if (Buffer.byteLength(JSON.stringify(out)) > 8192) fail();
    return out;
}

