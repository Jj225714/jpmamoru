/** Create the new public recipe catalog from public rules, never private workspace data. */
import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createCreativeRequirementPresets } from "../web/src/lib/commerce/creative-presets.ts";

const output = resolve(process.argv[2] || "../backups/commerce-creative-release-20260917");
const original = process.argv[3] ? JSON.parse(await readFile(resolve(process.argv[3]), "utf8")) : await (async () => {
    const response = await fetch("https://103.79.187.126/public-rules/catalog-visual-v2.json", { redirect: "error", signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`Catalog HTTP ${response.status}`);
    return response.json();
})();
if (original.revision !== "aoweisi-v4-3e62e18c1632" || original.policyPacks.length !== 1) throw new Error("Public source changed; review before publication");
const catalog = structuredClone(original);
const pack = catalog.policyPacks[0];
pack.requirementPresets = createCreativeRequirementPresets();
pack.templates = pack.requirementPresets.filter((preset: { stage: string }) => preset.stage === "marketing").map((preset: any) => ({ id: preset.id, category: preset.category, order: preset.order, title: preset.title, requirement: preset.prompt, slot: "marketing", chineseCopy: preset.chineseCopy, translationSeeds: preset.translationSeeds, requiredVariables: preset.requiredFacts, referenceIds: preset.referenceIds }));
pack.version = 5;
pack.creativeLibraryVersion = 1;
pack.name = "奥维斯平台商品推荐方案";
pack.sourceFileName = "奥维斯平台推荐方案";
pack.publishedAt = new Date().toISOString();
const digest = createHash("sha256").update(JSON.stringify({ requirements: pack.requirementPresets, source: original.revision })).digest("hex").slice(0, 12);
catalog.revision = `aoweisi-creative-v5-${digest}`;
catalog.publishedAt = pack.publishedAt;
pack.id = `server-aoweisi-creative-v5-${digest}`;
for (const ref of pack.references) {
    if (!ref.url.startsWith(`/public-rules/releases/${original.revision}/images/`)) throw new Error("Unexpected reference URL");
    ref.url = ref.url.replace(original.revision, catalog.revision);
}
const counts = Object.fromEntries(["地毯地垫类", "桌垫类", "洞洞板类", "收纳筐类"].map((category) => [category, pack.requirementPresets.filter((preset: { category: string }) => preset.category === category).length]));
if (Object.values(counts).join() !== "8,8,8,8" || pack.requirementPresets.filter((p: { enabledByDefault: boolean }) => p.enabledByDefault).length !== 16) throw new Error("Unexpected recipe inventory");
await mkdir(output, { recursive: true });
await writeFile(join(output, "catalog-v5.json"), JSON.stringify(catalog));
await writeFile(join(output, "catalog-v4-backup.json"), JSON.stringify(original));
console.log(JSON.stringify({ output, revision: catalog.revision, counts, enabledPerCategory: 4, references: pack.references.length }));
