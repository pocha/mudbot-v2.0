import { describe, it, expect, vi, beforeEach } from "vitest";

const addMock = vi.fn().mockResolvedValue(undefined);
vi.mock("firebase-admin/firestore", () => ({
  getFirestore: () => ({ collection: () => ({ add: addMock }) }),
}));

const storeMemoryMock = vi.fn().mockResolvedValue("memory-1");
const shortlistCapabilitiesMock = vi.fn();
const decideFlowMock = vi.fn();
vi.mock("./ai", () => ({
  storeMemory: storeMemoryMock,
  shortlistCapabilities: shortlistCapabilitiesMock,
  decideFlow: decideFlowMock,
}));

const pushDispatchJobMock = vi.fn().mockResolvedValue("job-1");
const replyToCommandMock = vi.fn().mockResolvedValue(undefined);
vi.mock("./rtdb", () => ({ pushDispatchJob: pushDispatchJobMock, replyToCommand: replyToCommandMock }));

const { ingestCore, decisionMakerCore } = await import("./core");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ingestCore", () => {
  it("stores memory only — no LLM call on the passive path", async () => {
    const result = await ingestCore("uid-1", { rawText: "hey, do you have avocados today?" });

    expect(storeMemoryMock).toHaveBeenCalledWith("uid-1", {
      text: "hey, do you have avocados today?",
      kind: "chat",
      sourceJid: undefined,
      direction: undefined,
    });
    expect(decideFlowMock).not.toHaveBeenCalled();
    expect(result).toEqual({ status: "stored_only", memoryId: "memory-1" });
  });
});

describe("decisionMakerCore", () => {
  const candidates = [{ capabilityId: "cap-1", description: "Convert grams to ounces", paramsSchema: { grams: "number" } }];

  it("clarify: replies directly, no dispatch", async () => {
    shortlistCapabilitiesMock.mockResolvedValue([]);
    decideFlowMock.mockResolvedValue({ action: "clarify", clarifyQuestion: "How many grams?", intent: "unit conversion" });

    const result = await decisionMakerCore("uid-1", { rawText: "convert to ounces", commandId: "cmd-1" });

    expect(replyToCommandMock).toHaveBeenCalledWith("uid-1", "cmd-1", "How many grams?");
    expect(pushDispatchJobMock).not.toHaveBeenCalled();
    expect(result).toEqual({ status: "clarify", question: "How many grams?" });
  });

  it("execute: dispatches to the matched capability with extracted params", async () => {
    shortlistCapabilitiesMock.mockResolvedValue(candidates);
    decideFlowMock.mockResolvedValue({ action: "execute", capabilityId: "cap-1", params: { grams: 300 }, intent: "unit conversion" });

    const result = await decisionMakerCore("uid-1", { rawText: "convert 300 grams to ounces", commandId: "cmd-2" });

    expect(pushDispatchJobMock).toHaveBeenCalledWith(
      expect.objectContaining({ uid: "uid-1", commandId: "cmd-2", type: "execute", capabilityId: "cap-1", params: { grams: 300 } })
    );
    expect(result).toEqual({ status: "dispatched", type: "execute", capabilityId: "cap-1" });
  });

  it("create: dispatches a build job with the generalized intent", async () => {
    shortlistCapabilitiesMock.mockResolvedValue([]);
    decideFlowMock.mockResolvedValue({ action: "create", intent: "Convert a weight between grams and ounces" });

    const result = await decisionMakerCore("uid-1", { rawText: "convert 300 grams to ounces", commandId: "cmd-3" });

    expect(pushDispatchJobMock).toHaveBeenCalledWith(
      expect.objectContaining({ uid: "uid-1", commandId: "cmd-3", type: "build", intent: "Convert a weight between grams and ounces" })
    );
    expect(result).toEqual({ status: "dispatched", type: "build" });
  });
});
