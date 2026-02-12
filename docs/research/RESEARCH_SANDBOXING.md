# Sandboxing Research: DeepAgents vs Virtual Files

This document evaluates the trade-offs between running a full agent environment ("DeepAgents") versus a minimal Virtual File System (VFS) environment within the sandbox.

## Context

*   **DeepAgents**: Implies running complex logic, potentially including an OS simulation, shell, or agent runtime, inside the sandbox.
*   **Just-Bash VFS**: Implies a lightweight environment that only provides file system access and basic execution primitives (like a shell), where the heavy lifting is done by the Host or the User Code.

## Evaluation

### 1. Security Surface Area

*   **DeepAgents**:
    *   **High Risk**: More code = more bugs. If the agent runtime has privileges (e.g. to network, storage), a compromise of the runtime compromises the sandbox.
    *   **Complexity**: Managing state, permissions, and communication for a full agent is complex.
*   **Just-Bash VFS**:
    *   **Low Risk**: Minimal API (read/write file, execute script). The attack surface is limited to the VFS interface and the JS engine.
    *   **Isolation**: Easier to reason about.

### 2. Performance

*   **DeepAgents**: Heavier startup time. Useful if the agent needs to be "close to the data" or run autonomously for long periods.
*   **Just-Bash VFS**: Instant startup (Local-First architecture). Better for "Preview" or "Repl" use cases.

### 3. Recommendation

For the `lofi-web-sandbox` architecture (Local-First), the **Just-Bash VFS** approach is superior.

*   **Why**: It aligns with the "Opaque Origin" model. We provide the *mechanism* (VFS, Execution) and let the *User Code* define the policy or agent logic.
*   **Hybrid**: If a DeepAgent is needed, it can be loaded *as user code* into the sandbox, rather than being part of the trusted infrastructure. This ensures that if the Agent is buggy, it only crashes its own sandbox.

## Conclusion

Keep the sandbox "dumb" and secure. Providing a robust Virtual File System (as per `RESEARCH_VFS_ACCESS.md`) is sufficient to enable powerful applications (including agents) to run on top, without baking them into the trusted base.
