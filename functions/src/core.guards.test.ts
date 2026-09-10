import { describe, it, expect, vi, beforeEach } from "vitest";

// Segregated from core.test.ts on purpose — this covers the fallback guard
// against a hallucinated capabilityId, not a happy path.

vi.mock("firebase-admin/firestore", () => ({
  getFirestore: () => ({ collection: () => ({ add: vi.fn().mockResolvedValue(undefined) }) }),
}));
vi.mock("./memory/firestoreRetriever", () => ({ storeMemory: vi.fn() }));

const shortlistCapabilitiesMock = vi.fn();
vi.mock("./capabilities/registry", () => ({ shortlistCapabilities: shortlistCapabilitiesMock }));

const decideFlowMock = vi.fn();
vi.mock("./flows/decide", () => ({ decideFlow: decideFlowMock }));

const pushDispatchJobMock = vi.fn().mockResolvedValue("job-1");
const replyToCommandMock = vi.fn().mockResolvedValue(undefined);
vi.mock("./rtdb", () => ({ pushDispatchJob: pushDispatchJobMock, replyToCommand: replyToCommandMock }));

const { decisionMakerCore } = await import("./core");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("decisionMakerCore — hallucinated capabilityId guard", () => {
  it("falls back to build when decideFlow names an id that was never shortlisted", async () => {
    shortlistCapabilitiesMock.mockResolvedValue([{ capabilityId: "cap-real", description: "real one", paramsSchema: {} }]);
    decideFlowMock.mockResolvedValue({ action: "execute", capabilityId: "cap-made-up", params: {}, intent: "something" });

    const result = await decisionMakerCore("uid-1", { rawText: "do the thing", commandId: "cmd-1" });

    expect(pushDispatchJobMock).toHaveBeenCalledWith(expect.objectContaining({ type: "build", intent: "something" }));
    expect(result).toEqual({ status: "dispatched", type: "build" });
  });

  it("falls back to build when decideFlow says execute but no candidates were shortlisted at all", async () => {
    shortlistCapabilitiesMock.mockResolvedValue([]);
    decideFlowMock.mockResolvedValue({ action: "execute", capabilityId: "cap-anything", params: {}, intent: "something" });

    const result = await decisionMakerCore("uid-1", { rawText: "do the thing", commandId: "cmd-2" });

    expect(pushDispatchJobMock).toHaveBeenCalledWith(expect.objectContaining({ type: "build" }));
    expect(result).toEqual({ status: "dispatched", type: "build" });
  });
});
