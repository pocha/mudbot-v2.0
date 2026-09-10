import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.FIREBASE_API_KEY = "test-api-key";
process.env.FIREBASE_AUTH_DOMAIN = "test.firebaseapp.com";
process.env.FIREBASE_PROJECT_ID = "test-project";
process.env.FIREBASE_DATABASE_URL = "https://test-default-rtdb.firebaseio.com";
process.env.MINT_TOKEN_URL = "https://example.com/mintContainerToken";
process.env.ORCHESTRATOR_SHARED_KEY = "test-shared-key";
process.env.CONTAINER_IMAGE = "mudbot-container:test";
process.env.GEMINI_API_KEY = "test-gemini-key";

vi.mock("dotenv", () => ({ config: vi.fn() }));
vi.mock("firebase/app", () => ({ initializeApp: vi.fn() }));
vi.mock("firebase/auth", () => ({ getAuth: vi.fn(), signInWithCustomToken: vi.fn() }));
vi.mock("firebase/database", () => ({
  getDatabase: vi.fn(),
  ref: vi.fn(),
  onChildAdded: vi.fn(),
  remove: vi.fn().mockResolvedValue(undefined),
}));

const isContainerRunningMock = vi.fn();
const startContainerMock = vi.fn().mockResolvedValue(undefined);
const dispatchToContainerMock = vi.fn().mockResolvedValue(undefined);
vi.mock("./containerManager", () => ({
  isContainerRunning: isContainerRunningMock,
  startContainer: startContainerMock,
  dispatchToContainer: dispatchToContainerMock,
}));

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const { dispatchJob, processJob } = await import("./index");
const { remove } = await import("firebase/database");

function mockMintTokenSuccess(token = "custom-token-123") {
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ customToken: token }) });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("dispatchJob", () => {
  const executeJob = {
    uid: "uid-1",
    commandId: "cmd-1",
    type: "execute" as const,
    capabilityId: "cap-1",
    rawText: "convert 300 grams to ounces",
    params: { grams: 300 },
    createdAt: Date.now(),
  };

  it("cold case: starts a container before dispatching when none is running", async () => {
    isContainerRunningMock.mockResolvedValue(false);

    await dispatchJob(executeJob, "custom-token");

    expect(startContainerMock).toHaveBeenCalledWith("uid-1", "mudbot-container:test");
    expect(dispatchToContainerMock).toHaveBeenCalledWith(
      "uid-1",
      expect.objectContaining({ UID: "uid-1", JOB_TYPE: "execute", CAPABILITY_ID: "cap-1", PARAMS: JSON.stringify({ grams: 300 }) })
    );
    const startOrder = startContainerMock.mock.invocationCallOrder[0];
    const dispatchOrder = dispatchToContainerMock.mock.invocationCallOrder[0];
    expect(startOrder).toBeLessThan(dispatchOrder);
  });

  it("warm case: skips starting a container when one is already running", async () => {
    isContainerRunningMock.mockResolvedValue(true);

    await dispatchJob(executeJob, "custom-token");

    expect(startContainerMock).not.toHaveBeenCalled();
    expect(dispatchToContainerMock).toHaveBeenCalled();
  });

  it("build job: passes rawText and intent instead of capabilityId/params", async () => {
    isContainerRunningMock.mockResolvedValue(true);
    const buildJob = { ...executeJob, type: "build" as const, capabilityId: undefined, intent: "Convert a weight between grams and ounces" };

    await dispatchJob(buildJob, "custom-token");

    expect(dispatchToContainerMock).toHaveBeenCalledWith(
      "uid-1",
      expect.objectContaining({ JOB_TYPE: "build", RAW_TEXT: buildJob.rawText, INTENT: buildJob.intent })
    );
  });
});

describe("processJob", () => {
  const job = {
    uid: "uid-1",
    commandId: "cmd-1",
    type: "execute" as const,
    capabilityId: "cap-1",
    rawText: "convert 300 grams to ounces",
    params: {},
    createdAt: Date.now(),
  };
  const fakeRef = {} as never;

  it("removes the RTDB entry before dispatching (at-most-once ordering)", async () => {
    mockMintTokenSuccess();
    isContainerRunningMock.mockResolvedValue(true);

    await processJob(job, fakeRef);

    const removeOrder = vi.mocked(remove).mock.invocationCallOrder[0];
    const dispatchOrder = dispatchToContainerMock.mock.invocationCallOrder[0];
    expect(removeOrder).toBeLessThan(dispatchOrder);
  });

  it("catches a mintTokenFor failure without throwing", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403, text: async () => "forbidden" });

    await expect(processJob(job, fakeRef)).resolves.toBeUndefined();
    expect(dispatchToContainerMock).not.toHaveBeenCalled();
  });
});
