import { describe, it, expect, vi, beforeEach } from "vitest";

const generateTextMock = vi.fn();
const stripFencesMock = vi.fn((text: string) => text);
vi.mock("./gemini", () => ({ generateText: generateTextMock, embedText: vi.fn(), stripFences: stripFencesMock }));

const runCapabilityCodeMock = vi.fn();
vi.mock("./runCode", () => ({ runCapabilityCode: runCapabilityCodeMock }));

vi.mock("./capabilityContext", () => ({ createCapabilityContext: vi.fn().mockReturnValue({ uid: "uid-1" }) }));

const registerCapabilityMock = vi.fn().mockResolvedValue("cap-new");
vi.mock("./registry", () => ({ registerCapability: registerCapabilityMock, getCapability: vi.fn() }));

const replyToCommandMock = vi.fn().mockResolvedValue(undefined);
vi.mock("./reply", () => ({ replyToCommand: replyToCommandMock }));

const { runCreator } = await import("./creator");

const validResponse = 'PARAMS_SCHEMA: {"grams":"number"}\nCODE:\nexport default async (params, ctx) => `${params.grams}g`';

beforeEach(() => {
  vi.clearAllMocks();
  stripFencesMock.mockImplementation((text: string) => text);
});

describe("runCreator", () => {
  it("succeeds on the first attempt: registers under the generalized intent and replies with the result", async () => {
    generateTextMock.mockResolvedValue(validResponse);
    runCapabilityCodeMock.mockResolvedValue("300g");

    await runCreator("uid-1", "cmd-1", "convert 300 grams to ounces", "Convert a weight between grams and ounces");

    expect(generateTextMock).toHaveBeenCalledTimes(1);
    expect(registerCapabilityMock).toHaveBeenCalledWith("uid-1", {
      description: "Convert a weight between grams and ounces",
      code: expect.stringContaining("export default"),
      paramsSchema: { grams: "number" },
    });
    expect(replyToCommandMock).toHaveBeenCalledWith("uid-1", "cmd-1", "300g");
  });

  it("falls back to rawText as the description when no intent is provided", async () => {
    generateTextMock.mockResolvedValue(validResponse);
    runCapabilityCodeMock.mockResolvedValue("300g");

    await runCreator("uid-1", "cmd-1", "convert 300 grams to ounces");

    expect(registerCapabilityMock).toHaveBeenCalledWith(
      "uid-1",
      expect.objectContaining({ description: "convert 300 grams to ounces" })
    );
  });

  it("retries after a failed attempt and succeeds on the second, feeding the error back into the prompt", async () => {
    generateTextMock.mockResolvedValueOnce(validResponse).mockResolvedValueOnce(validResponse);
    runCapabilityCodeMock.mockRejectedValueOnce(new Error("ReferenceError: x is not defined")).mockResolvedValueOnce("300g");

    await runCreator("uid-1", "cmd-1", "convert 300 grams to ounces");

    expect(generateTextMock).toHaveBeenCalledTimes(2);
    expect(generateTextMock.mock.calls[1][0]).toContain("ReferenceError: x is not defined");
    expect(replyToCommandMock).toHaveBeenCalledWith("uid-1", "cmd-1", "300g");
  });

  it("gives up gracefully after exhausting all attempts, without registering anything", async () => {
    generateTextMock.mockResolvedValue(validResponse);
    runCapabilityCodeMock.mockRejectedValue(new Error("still broken"));

    await runCreator("uid-1", "cmd-1", "do something impossible");

    expect(generateTextMock).toHaveBeenCalledTimes(3);
    expect(registerCapabilityMock).not.toHaveBeenCalled();
    expect(replyToCommandMock).toHaveBeenCalledWith(
      "uid-1",
      "cmd-1",
      "I couldn't figure out how to do that yet — flagging this for the owner to look at."
    );
  });
});
