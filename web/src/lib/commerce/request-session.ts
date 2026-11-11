import { useConfigStore } from "@/stores/use-config-store";
import { useServerConfigStore } from "@/services/server-config";

let accountEpoch = 0;
let observingAccount = false;
export function getCommerceAccountEpoch() {
    if (!observingAccount) {
        observingAccount = true;
        useServerConfigStore.subscribe((state, previous) => {
            if (state.user?.id !== previous.user?.id || state.teamRevision !== previous.teamRevision || (state.phase === "signed-out" && previous.phase !== "signed-out")) accountEpoch++;
        });
    }
    return accountEpoch;
}

/** A one-way invalidation latch: even A → B → A cannot revive an old request. */
export function captureCommerceRequestSession() {
    let valid = true;
    const stopConfig = useConfigStore.subscribe((state, previous) => {
        if (state.config !== previous.config) valid = false;
    });
    const stopAccount = useServerConfigStore.subscribe((state, previous) => {
        if (state.user?.id !== previous.user?.id || state.teamRevision !== previous.teamRevision || state.phase === "signed-out") valid = false;
    });
    return {
        isCurrent: () => valid,
        assertCurrent: () => { if (!valid) throw new Error("账号或模型配置已变化，旧识别结果已丢弃，请重新操作或手动填写。"); },
        dispose: () => { stopConfig(); stopAccount(); },
    };
}
