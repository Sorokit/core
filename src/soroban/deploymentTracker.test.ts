import { describe, expect, it } from "vitest";
import { createDeploymentTracker, trackDeployment } from "./deploymentTracker";

describe("deployment tracker", () => {
  it("reports stage progress to subscribers", () => {
    const result = createDeploymentTracker("CABC");
    expect(result.status).toBe("ok");
    if (result.status === "error") return;
    const seen: string[] = [];
    result.data.onProgress((progress) => seen.push(progress.stage));
    result.data.update("uploading");
    result.data.update("deployed");
    expect(seen).toEqual(["uploading", "deployed"]);
    expect(trackDeployment("CABC").data?.stage).toBe("building");
  });
});
