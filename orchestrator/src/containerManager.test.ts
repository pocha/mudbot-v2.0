import { describe, it, expect, vi, beforeEach } from "vitest";

const execFileMock = vi.fn();
vi.mock("node:child_process", () => ({ execFile: execFileMock }));

const { isContainerRunning, startContainer, dispatchToContainer, checkDockerReady } = await import("./containerManager");

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

describe("checkDockerReady", () => {
  it("resolves when the daemon is up and the image is present", async () => {
    execFileMock.mockImplementation((_cmd, args, _opts, cb) => {
      if (args[0] === "info") cb(null, "", "");
      else cb(null, "sha256abcdef\n", "");
    });
    await expect(checkDockerReady("mudbot-container:latest")).resolves.toBeUndefined();
  });

  it("throws a clear error when the daemon isn't running", async () => {
    execFileMock.mockImplementation((_cmd, args, _opts, cb) => {
      if (args[0] === "info") cb(new Error("connect ECONNREFUSED"), "", "");
      else cb(null, "", "");
    });
    await expect(checkDockerReady("mudbot-container:latest")).rejects.toThrow(/doesn't seem to be running/);
  });

  it("throws a clear error when the image is missing", async () => {
    execFileMock.mockImplementation((_cmd, args, _opts, cb) => {
      if (args[0] === "info") cb(null, "", "");
      else cb(null, "", "");
    });
    await expect(checkDockerReady("mudbot-container:latest")).rejects.toThrow(/not found locally/);
  });
});
