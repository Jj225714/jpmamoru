import type { ReactNode } from "react";
// Legacy exports retained for old imports; neither requests nor login UI are created.
export function ManagedModelAccess({ children }: { children: ReactNode }) {
    return <>{children}</>;
}
export function scrubManagedCredentialQuery() {
    const url = new URL(window.location.href);
    for (const key of [...url.searchParams.keys()]) {
        if (["code", "accesscode", "access_code"].includes(key.toLowerCase())) url.searchParams.delete(key);
    }
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}
