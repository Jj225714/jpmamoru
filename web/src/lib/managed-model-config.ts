// Compatibility helpers for stored legacy data. Access-code mode is permanently retired.
import type { AiConfig, ModelCapability } from "@/stores/use-config-store";
export const MANAGED_BASE_URL = "/api/managed";
export const MANAGED_CHANNEL_ID = "managed";
export const managedEnabled = () => false;
export const managedPrincipalId = (): string | undefined => undefined;
export const managedModels = (): Array<{ name: string; capability: ModelCapability }> => [];
export const managedModel = (_value?: string, _capability?: ModelCapability) => "";
export const withManagedModelConfig = (config: AiConfig): AiConfig => config;
export function managedEvent(_name: string) {}
export function managedResponseStatus(_status: number, _payload?: unknown) {}
export async function queueManagedImage<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    return work();
}
