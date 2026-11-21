import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";

export type DeploymentStage = "building" | "uploading" | "deploying" | "deployed" | "failed";
export interface DeploymentProgress { contractId: string; stage: DeploymentStage; percent: number; error?: string; }
export interface DeploymentTracker { readonly progress: DeploymentProgress; update(stage: DeploymentStage, error?: string): SorokitResult<DeploymentProgress>; onProgress(listener: (progress: DeploymentProgress) => void): () => void; }
const PERCENT: Record<DeploymentStage, number> = { building: 25, uploading: 50, deploying: 75, deployed: 100, failed: 100 };

export function createDeploymentTracker(contractId: string): SorokitResult<DeploymentTracker> {
  if (!contractId.trim()) return err(SorokitErrorCode.VALIDATION, "contractId is required");
  let current: DeploymentProgress = { contractId, stage: "building", percent: PERCENT.building };
  const listeners = new Set<(progress: DeploymentProgress) => void>();
  const tracker: DeploymentTracker = {
    get progress() { return { ...current }; },
    update(stage, error) { current = { contractId, stage, percent: PERCENT[stage], ...(error ? { error } : {}) }; for (const listener of listeners) { try { listener({ ...current }); } catch { /* observers cannot block deployment */ } } return ok({ ...current }); },
    onProgress(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
  return ok(tracker);
}

export function trackDeployment(contractId: string): SorokitResult<DeploymentProgress> {
  const tracker = createDeploymentTracker(contractId);
  return tracker.status === "error" ? tracker : ok(tracker.data.progress);
}
