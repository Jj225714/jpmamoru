import localforage from "localforage";
import { imageToDataUrl, resolveImageUrl, uploadImage } from "./image-storage";
import { newDocument } from "@/lib/image-editor/document";
import type { EditImage, ImageEditDocument } from "@/types/image-editor";

const store = localforage.createInstance({ name: "infinite-canvas", storeName: "image_edit_documents" });
let writes: Promise<unknown> = Promise.resolve();
export function saveEditDocument(doc: ImageEditDocument) {
    const snapshot = structuredClone(doc);
    const operation = writes.catch(() => undefined).then(() => store.setItem(doc.sourceId, snapshot));
    writes = operation;
    return operation;
}
export async function listEditDocuments() {
    const docs: ImageEditDocument[] = [];
    await store.iterate<ImageEditDocument, void>((doc) => {
        if (doc.version === 1) docs.push(doc);
    });
    return docs.sort((a, b) => b.updatedAt - a.updatedAt);
}
export async function loadEditDocument(sourceId: string, source?: EditImage) {
    let doc = await store.getItem<ImageEditDocument>(sourceId);
    if (!doc) {
        if (!source) throw new Error("编辑稿不存在");
        // An independent file prevents deleting generation history from breaking a draft.
        const original = await uploadImage(await imageToDataUrl(source));
        doc = newDocument(sourceId, original);
        await saveEditDocument(doc);
    }
    if (doc.version !== 1) throw new Error("此编辑稿版本不受支持");
    const hydrate = async (image?: EditImage) => (image ? { ...image, url: await resolveImageUrl(image.storageKey, image.url) } : undefined);
    return { ...doc, original: (await hydrate(doc.original))!, layers: await Promise.all(doc.layers.map(async (l) => ({ ...l, image: await hydrate(l.image), maskBase: await hydrate(l.maskBase) }))) };
}
