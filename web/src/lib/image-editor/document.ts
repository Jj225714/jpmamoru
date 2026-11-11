import { nanoid } from "nanoid";
import type { EditImage, EditLayer, ImageEditDocument } from "@/types/image-editor";

export function imageLayer(image: EditImage, name = "图片"): EditLayer {
    return { id: nanoid(), name, kind: "image", image, x: 0, y: 0, width: image.width, height: image.height, rotation: 0, opacity: 1, visible: true, locked: false };
}
export function newDocument(sourceId: string, image: EditImage): ImageEditDocument {
    return { version: 1, id: nanoid(), sourceId, title: "未命名设计", revision: 0, updatedAt: Date.now(), width: image.width, height: image.height, background: "#ffffff", original: image, layers: [{ ...imageLayer(image, "原始图片"), role: "source" }] };
}
export function revise(previous: ImageEditDocument, next: ImageEditDocument): ImageEditDocument {
    return { ...next, revision: previous.revision + 1, updatedAt: Date.now() };
}
export function expandDocument(doc: ImageEditDocument, left: number, top: number, right: number, bottom: number, background: EditImage): ImageEditDocument {
    return {
        ...doc,
        width: doc.width + left + right,
        height: doc.height + top + bottom,
        layers: [
            { ...imageLayer(background, "扩图背景"), role: "background", width: doc.width + left + right, height: doc.height + top + bottom, locked: true },
            ...doc.layers.map((layer) => ({ ...layer, x: layer.x + left, y: layer.y + top, visible: layer.role === "background" || layer.role === "source" ? false : layer.visible })),
        ],
    };
}
export function splitLayers(doc: ImageEditDocument, target: EditLayer, images: EditImage[]): ImageEditDocument {
    const groupId = nanoid();
    return {
        ...doc,
        layers: doc.layers.flatMap((layer) =>
            layer.id !== target.id
                ? [layer]
                : [
                      { ...layer, visible: false, name: layer.name + "（原图备份）" },
                      ...images.map((image, index) => ({
                          ...imageLayer(image, `拆分图层 ${index + 1}`),
                          groupId,
                          ...(index === 0 && (layer.role === "source" || layer.role === "background") ? { role: "background" as const } : {}),
                          x: layer.x,
                          y: layer.y,
                          width: layer.width,
                          height: layer.height,
                          rotation: layer.rotation,
                          opacity: layer.opacity,
                      })),
                  ],
        ),
    };
}
export function validUpscale(width: number, height: number, scale: number) {
    return [2, 4].includes(scale) && Math.max(width, height) * scale <= 4096;
}
export function matchesRevision(doc: ImageEditDocument, candidate: { documentId: string; revision: number }) {
    return doc.id === candidate.documentId && doc.revision === candidate.revision;
}
