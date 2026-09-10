import { describe, it, expect, vi, beforeEach } from "vitest";

const getCapabilityMock = vi.fn();
vi.mock("./registry", () => ({ getCapability: getCapabilityMock, registerCapability: vi.fn() }));

const runCapabilityCodeMock = vi.fn();
vi.mock("./runCode", () => ({ runCapabilityCode: runCapabilityCodeMock }));

const createCapabilityContextMock = vi.fn();
vi.mock("./capabilityContext", () => ({ createCapabilityContext: createCapabilityContextMock }));

const replyToCommandMock = vi.fn().mockResolvedValue(undefined);
vi.mock("./reply", () => ({ replyToCommand: replyToCommandMock }));

// Executor must never touch the LLM module — Decision Maker already
// extracted params before dispatch, see executor.ts's top comment.
const generateTextMock = vi.fn();
vi.mock("./gemini", () => ({ generateText: generateTextMock, embedText: vi.fn(), stripFences: vi.fn() }));

const { runExecutor } = await import("./executor");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("runExecutor", () => {
  it("fetches the capability by id, runs it with the given params, and replies with the result", async () => {
    getCapabilityMock.mockResolvedValue({ code: "export default async (params, ctx) => `${params.grams}g`" });
    const fakeCtx = { uid: "uid-1" };
    createCapabilityContextMock.mockReturnValue(fakeCtx);
    runCapabilityCodeMock.mockResolvedValue("300g");

    await runExecutor("uid-1", "cmd-1", "cap-1", { grams: 300 });

    expect(getCapabilityMock).toHaveBeenCalledWith("uid-1", "cap-1");
    expect(runCapabilityCodeMock).toHaveBeenCalledWith(expect.any(String), { grams: 300 }, fakeCtx);
    expect(replyToCommandMock).toHaveBeenCalledWith("uid-1", "cmd-1", "300g");
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it("stringifies a non-string result before replying", async () => {
    getCapabilityMock.mockResolvedValue({ code: "..." });
    createCapabilityContextMock.mockReturnValue({});
    runCapabilityCodeMock.mockResolvedValue({ ounces: 10.58 });

    await runExecutor("uid-1", "cmd-2", "cap-1", {});

    expect(replyToCommandMock).toHaveBeenCalledWith("uid-1", "cmd-2", JSON.stringify({ ounces: 10.58 }));
  });
});
