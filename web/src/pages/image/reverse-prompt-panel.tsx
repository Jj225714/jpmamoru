import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { App, Button, Input, Modal } from "antd";
import { useTranslation } from "react-i18next";
import { useConfigStore, useEffectiveConfig, getImageInputTextModelStatus } from "@/stores/use-config-store";
import { useServerConfigStore } from "@/services/server-config";
import { ReversePromptController } from "./reverse-prompt-controller";
import { reverseImagePrompt } from "./reverse-prompt-service";

type Props = { getPrompt: () => string; onApply: (text: string) => void };
export function ReversePromptPanel(props: Props) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    return (
        <>
            <Button size="small" onClick={() => setOpen(true)}>
                {t("reversePrompt.title")}
            </Button>
            <Modal title={t("reversePrompt.title")} open={open} onCancel={() => setOpen(false)} footer={null} destroyOnHidden>
                {open && <ReversePromptContent {...props} />}
            </Modal>
        </>
    );
}
function ReversePromptContent({ getPrompt, onApply }: Props) {
    const { t } = useTranslation();
    const { modal } = App.useApp();
    const config = useEffectiveConfig();
    const modelStatus = getImageInputTextModelStatus(config).status;
    const [controller] = useState(() => new ReversePromptController());
    const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
    const input = useRef<HTMLInputElement>(null);
    useLayoutEffect(() => {
        // Synchronous store subscriptions invalidate even batched A → B → A changes.
        const unsubscribeConfig = useConfigStore.subscribe((next, previous) => {
            if (next.config !== previous.config) controller.cancel();
        });
        const unsubscribeAccount = useServerConfigStore.subscribe((next, previous) => {
            if (next.user?.id !== previous.user?.id || (next.phase === "signed-out") !== (previous.phase === "signed-out")) controller.cancel();
        });
        const close = () => controller.cancel();
        window.addEventListener("pagehide", close);
        return () => {
            unsubscribeConfig();
            unsubscribeAccount();
            window.removeEventListener("pagehide", close);
            controller.cancel();
        };
    }, [controller]);
    useLayoutEffect(() => controller.cancel(), [controller, config]);
    function apply() {
        const result = controller.getSnapshot().result.trim();
        if (!result) return;
        const revision = controller.getRevision();
        const fill = () => {
            if (revision === controller.getRevision()) onApply(result);
        };
        if (!getPrompt().trim()) fill();
        else modal.confirm({ title: t("reversePrompt.confirmTitle"), content: t("reversePrompt.confirmBody"), okText: t("reversePrompt.replace"), cancelText: t("common.cancel"), onOk: fill });
    }
    return (
        <section aria-label={t("reversePrompt.title")} className="rounded-lg border border-stone-200 p-3 dark:border-stone-700 space-y-3">
            <p className="text-xs text-stone-500">{t("reversePrompt.hint")}</p>
            <input
                ref={input}
                aria-label={t("reversePrompt.upload")}
                type="file"
                accept="image/*"
                hidden
                onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (!file) return;
                    void controller.select(
                        () =>
                            new Promise<string>((resolve, reject) => {
                                if (!file.type.startsWith("image/") || file.size > 20 * 1024 * 1024) {
                                    reject();
                                    return;
                                }
                                const reader = new FileReader();
                                reader.onerror = reject;
                                reader.onload = () => resolve(String(reader.result));
                                reader.readAsDataURL(file);
                            }),
                    );
                }}
            />
            {state.image && <img src={state.image} alt={t("reversePrompt.preview")} className="max-h-40 max-w-full rounded object-contain" />}
            <div className="flex flex-wrap gap-2">
                <Button onClick={() => input.current?.click()}>{t("reversePrompt.upload")}</Button>
                <Button aria-label={t("reversePrompt.run")} loading={state.status === "running"} disabled={!state.image || state.status === "reading" || modelStatus !== "ready"} onClick={() => void controller.run((image, signal) => reverseImagePrompt(config, image, signal))}>
                    {t("reversePrompt.run")}
                </Button>
            </div>
            {modelStatus !== "ready" && (
                <p role="status" className="text-sm text-amber-700">
                    {t(`reversePrompt.${modelStatus}`)}
                </p>
            )}
            {state.error && (
                <p role="alert" className="text-sm text-red-600">
                    {t(state.error === "timeout" ? "reversePrompt.timeout" : state.error === "imageError" ? "reversePrompt.imageError" : "reversePrompt.failed")}
                </p>
            )}
            <Input.TextArea
                aria-label={t("reversePrompt.result")}
                placeholder={t("reversePrompt.result")}
                rows={4}
                value={state.result}
                disabled={state.status === "running" || state.status === "reading"}
                onChange={(event) => controller.setResult(event.target.value)}
            />
            <Button disabled={!state.result.trim() || state.status === "running"} onClick={apply}>
                {t("reversePrompt.apply")}
            </Button>
        </section>
    );
}
