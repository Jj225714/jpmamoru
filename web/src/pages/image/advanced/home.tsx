import { useEffect, useRef, useState } from "react";
import { Alert, Button, Drawer, Empty } from "antd";
import { nanoid } from "nanoid";
import { AdvancedImageEditor } from "./editor";
import { listEditDocuments } from "@/services/image-editor-storage";
import { uploadImage } from "@/services/image-storage";
import type { EditImage, ImageEditDocument } from "@/types/image-editor";

export function AdvancedHome() {
    const [drafts, setDrafts] = useState<ImageEditDocument[]>([]);
    const [open, setOpen] = useState(false);
    const [error, setError] = useState("");
    const [editing, setEditing] = useState<{ sourceId: string; source?: EditImage }>();
    const input = useRef<HTMLInputElement>(null);
    useEffect(() => {
        void listEditDocuments()
            .then(setDrafts)
            .catch((e) => setError(e.message));
    }, [editing, open]);
    return (
        <div className="border-b border-violet-100 bg-violet-50/60 px-5 py-4 text-stone-800 dark:bg-violet-950/20 dark:text-stone-100">
            <div className="flex flex-wrap items-center gap-3">
                <div className="mr-auto">
                    <h1 className="text-lg font-semibold">高级通用生图</h1>
                    <p className="mt-1 text-sm text-stone-500">生成图片后分层编辑，支持抠图、消除、扩图、高清、原图文字编辑和复杂拆层。</p>
                </div>
                <Button onClick={() => input.current?.click()}>上传图片编辑</Button>
                <Button onClick={() => setOpen(true)}>我的编辑稿（{drafts.length}）</Button>
            </div>
            {error && <Alert title={error} type="error" closable onClose={() => setError("")} />}
            <input
                ref={input}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file)
                        void uploadImage(file)
                            .then((source) => setEditing({ sourceId: `upload-${nanoid()}`, source }))
                            .catch((e) => setError(e.message));
                    e.target.value = "";
                }}
            />
            <Drawer title="我的编辑稿 · 当前浏览器" open={open} onClose={() => setOpen(false)} size={440}>
                {!drafts.length ? (
                    <Empty description="生成或上传图片后进入分层编辑，即可自动保存编辑稿" />
                ) : (
                    drafts.map((doc) => (
                        <button
                            key={doc.id}
                            className="mb-3 block w-full rounded-xl border p-4 text-left hover:border-violet-400"
                            onClick={() => {
                                setOpen(false);
                                setEditing({ sourceId: doc.sourceId });
                            }}
                        >
                            <strong>{doc.title}</strong>
                            <div className="mt-2 text-sm text-stone-500">
                                {doc.width} × {doc.height} · {doc.layers.length} 个图层 · {new Date(doc.updatedAt).toLocaleString()}
                            </div>
                        </button>
                    ))
                )}
            </Drawer>
            {editing && <AdvancedImageEditor {...editing} onClose={() => setEditing(undefined)} />}
        </div>
    );
}
