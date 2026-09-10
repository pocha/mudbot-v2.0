import { describe, it, expect, vi, beforeEach } from "vitest";

const execFileMock = vi.fn();
vi.mock("node:child_process", () => ({ execFile: execFileMock }));

const { isContainerRunning, startContainer, dispatchToContainer } = await import("./containerManager");

function mockExecFileSuccess(stdout = "", stderr = "") {
  execFileMock.mockImplementation((_cmd, _args, _opts, cb) => cb(null, stdout, stderr));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("isContainerRunning", () => {
  it("returns true when docker ps reports the container name", async () => {
    mockExecFileSuccess("mudbot-uid-1\n");
    await expect(isContainerRunning("uid-1")).resolves.toBe(true);
    expect(execFileMock).toHaveBeenCalledWith(
      "docker",
      ["ps", "--filter", "name=^mudbot-uid-1$", "--format", "{{.Names}}"],
      {},
      expect.any(Function)
    );
  });

  it("returns false when docker ps reports nothing", async () => {
    mockExecFileSuccess("");
    await expect(isContainerRunning("uid-1")).resolves.toBe(false);
  });
});

describe("startContainer", () => {
  it("runs docker run -d with the container's name, memory limit, and image", async () => {
    mockExecFileSuccess();
    await startContainer("uid-1", "mudbot-container:latest");
    expect(execFileMock).toHaveBeenCalledWith(
      "docker",
      ["run", "-d", "--name", "mudbot-uid-1", "--memory", "512m", "mudbot-container:latest"],
      {},
      expect.any(Function)
    );
  });
});

describe("dispatchToContainer", () => {
  it("runs docker exec against the user's container with the given env vars", async () => {
    mockExecFileSuccess();
    await dispatchToContainer("uid-1", { UID: "uid-1", JOB_TYPE: "execute" });
    expect(execFileMock).toHaveBeenCalledWith(
      "docker",
      ["exec", "-e", "UID=uid-1", "-e", "JOB_TYPE=execute", "mudbot-uid-1", "node", "lib/index.js"],
      expect.objectContaining({ timeout: expect.any(Number) }),
      expect.any(Function)
    );
  });
});
