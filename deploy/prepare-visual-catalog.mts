/** Produce a public-only release from the already-public catalog, never workspace data. */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { correctedPresetVisual } from "../web/src/lib/commerce/requirement-visuals.ts";

const output = resolve(process.argv[2] || "../backups/commerce-visual-release-20260917");
const response = await fetch("https://103.79.187.126/public-rules/catalog.json", { redirect: "error" });
if (!response.ok) throw new Error(`Catalog HTTP ${response.status}`);
const original = await response.json();
if (original.revision !== "aoweisi-v3-e39a32a62f12" || original.policyPacks.length !== 1) throw new Error("Public source changed; review before publishing");
const catalog = structuredClone(original);
const pack = catalog.policyPacks[0];
const counts = Object.fromEntries(["地毯地垫类", "桌垫类", "洞洞板类", "收纳筐类"].map((category) => [category, pack.requirementPresets.filter((preset: { category: string }) => preset.category === category).length]));
if (Object.values(counts).join() !== "11,11,9,9" || pack.references.length !== 87) throw new Error("Unexpected public rule inventory");
pack.requirementPresets = pack.requirementPresets.map(correctedPresetVisual);
pack.version = 4;
pack.publishedAt = new Date().toISOString();
// Content digest excludes volatile publication timestamp and old revision paths.
const digest = createHash("sha256").update(JSON.stringify({ requirements: pack.requirementPresets, source: original.revision })).digest("hex").slice(0, 12);
catalog.revision = `aoweisi-v4-${digest}`;
catalog.publishedAt = pack.publishedAt;
pack.id = `server-aoweisi-visual-v4-${digest}`;
for (const ref of pack.references) {
    if (!ref.url.startsWith(`/public-rules/releases/${original.revision}/images/`)) throw new Error("Unexpected reference URL");
    ref.url = ref.url.replace(original.revision, catalog.revision);
}
await mkdir(output, { recursive: true });
await writeFile(join(output, "catalog-v4.json"), JSON.stringify(catalog));
await writeFile(join(output, "catalog-v3-backup.json"), JSON.stringify(original));
await writeFile(join(output, "rule-audit.json"), JSON.stringify(pack.requirementPresets.map((preset: Record<string, unknown>) => ({ id: preset.id, category: preset.category, order: preset.order, stage: preset.stage, layout: preset.layout, visualKind: preset.visualKind, visualMode: preset.visualMode, variantScope: preset.variantScope, requiredFacts: preset.requiredFacts, needsReview: preset.needsReview })), null, 2));
console.log(JSON.stringify({ output, revision: catalog.revision, counts, references: pack.references.length, layouts: [...new Set(pack.requirementPresets.map((preset: { layout: string }) => preset.layout))] }));
