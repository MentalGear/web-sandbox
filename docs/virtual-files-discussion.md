# Virtual Files Research
## Discussion with LLM

## Architecture Comparison: Host-Level SW vs. Iframe + Hub

### Legend
- sandboxRenderer : sandboxed iFrame to display/render user-content.
- Host SW / Router  : routes requests from sandboxRenderer to the virtualFilesHub via postMessage.
- virtualFilesHub: sandboxed iFrame that acts as hub and stores all virtual files.
- Host SW / vf Server : If a request is received

### Compare
| Attack Vector / Exposure      | sandboxRenderer & Host SW / vf Server | sandboxRenderer & Host SW / Router & virtualFilesHub            |
| :---------------------------- | :------------------------------------------ | :----------------------------------------- |
| **Credential Leakage**        | ⚠️ High: Same-origin cookies/auth sent      | ✅ None: Cross-origin isolation            |
| **Storage Hijacking**         | ⚠️ High: Access to Host LocalStorage/DB     | ✅ Blocked: Origin-based storage isolation |
| **XSS / DOM Breakout**        | ⚠️ Moderate: Relies on `sandbox` attributes | ✅ High: Browser-enforced origin boundary  |
| **Cache Poisoning**           | ⚠️ Risk: User files can overwrite App files | ✅ None: Dedicated SW and Cache storage    |
| **SW Logic Complexity**      | ⚠️ High: Must filter "real" vs "virtual"    | ✅ Clean: SW only handles virtual files    |
| **Implementation Effort**     | 🟢 Low: Single origin, no cross-domain comms| 🔴 High: Requires Hub/Iframe orchestration |
| **user access via url**    |  Host SW catches request and load virtual file in host-level context. Mitigation: block requests not coming from null origin | virtual files are transferred via post message from hub to sandboxRenderer, right ? so no direct url access by default |
| complextiy | ... | ... |
| origin | connection to same origin ? No, should be a subdomain as well | isolated origin |

----

### Gemini Code Assist Analysis

| Deep-Dive Factor              | Host-Level SW / vf Server                   | Iframe + Hub (Isolated Origin)             |
| :---------------------------- | :------------------------------------------ | :----------------------------------------- |
| **Process Isolation**         | ⚠️ Shared: Host and Virtual files likely share the same OS process. | ✅ Isolated: Site Isolation forces separate processes for different origins. |
| **Security Philosophy**       | **Secure by Logic**: Security depends on the correctness of your SW `fetch` filters. | **Secure by Design**: Security is enforced by the Browser's Same-Origin Policy. |
| **State Persistence**         | ⚠️ Risky: Virtual files must share IndexedDB/LocalStorage with the Host. Com: Is this really an issue, since the files are not executed - only stored. | ✅ Clean: Hub has its own dedicated storage quota and namespace. |
| **Blast Radius**              | 🔴 High: A bug in the Host SW can break the entire IDE/Editor. | 🟢 Low: A crash in the Hub or Sandbox only affects the preview. Com: However same Host SW issue: If there is Host SW tempering, files received from the hub could be made to be displayed on the host. So the Host SW here is also there issue. |
| **Scalability**               | ⚠️ Limited: Hard to run multiple concurrent "projects" with different dependencies. Com: Actually, it wouldnt be a problem is each virtual file path has it's unique /session_id | ✅ High: Each Hub/Sandbox pair is a completely independent container. |

#### Why the "Host SW" approach is usually avoided for IDEs:
1. **The "Null Origin" Fragility**: While you can check for `origin: null` or specific headers, this is "reactive" security. Browser extensions, future browser updates, or edge-case request types (like `<link rel="prefetch">`) might bypass these checks or leak information.
2. **Cookie/Auth Contamination**: Even with a sandbox, if the URL is on the same domain, the browser's network stack may still attempt to attach ambient credentials (cookies, client certificates) before the Service Worker even sees the request.
3. **Global Scope Pollution**: If the `sandboxRenderer` isn't perfectly configured, scripts served from the Host origin have a much easier time performing "Prototype Pollution" or accessing `window.parent` than scripts served from a completely different origin.
4. **Developer Experience (DX)**: Debugging a Service Worker that is simultaneously trying to serve the "IDE App" and the "User's Virtual App" is a nightmare. You'll see a mix of both in the Network tab, making it very difficult to trace which logic is failing.

**Conclusion**: The **Iframe + Hub** model is essentially "Web-Native Virtualization." It treats the user's code as a completely foreign entity, which is the only safe way to execute arbitrary code in a browser environment.

----

### Gemini Response to "Com:" Notes

#### 1. On State Persistence ("Is this really an issue if only stored?")
The risk isn't in the *storage* itself, but in the **Access Scope**. 
- In the **Host SW** model, if a virtual script is ever executed (e.g., a user previews their code), that script runs on the Host Origin. Because it's on the Host Origin, it has access to the *entire* IndexedDB/LocalStorage of your IDE. It could delete your settings, steal auth tokens, or corrupt other projects.
- In the **Hub** model, the storage is physically partitioned by the browser. Even if a virtual script goes rogue, it can only "see" the storage allocated to that specific subdomain.

#### 2. On Blast Radius ("Host SW is still a single point of failure")
You are 100% correct that the Host SW is always a "Trusted Component." However, there is a difference in **Functional Responsibility**:
- **Host SW / vf Server**: Acts as the *Logic Provider*. It must parse, validate, and serve content. The security depends on the *correctness* of your code.
- **Host SW / Router**: Acts as a *Data Pipe*. It doesn't need to "understand" the files; it just moves bytes from the Hub to the Sandbox. 
The "Hub" model follows the **Principle of Least Privilege**. We assume the Host SW might be buggy, so we move the sensitive execution logic (the actual serving of the virtual site) to a place where the browser's native security (SOP) acts as a second layer of defense. Com: The "sandboxRenderer" would be used in both instances to display the virtual files. If host sw is comprimised it could also be set to show virtual files at host level.

#### 3. On Scalability ("Unique /session_id solves collisions")
While `/session_id` solves the **Path Collision** problem, it doesn't solve the **Lifecycle Problem**:
- Service Workers are singletons per scope. If you have 3 tabs open with 3 different sessions, they all share **one** Service Worker instance.
- If Session A needs to update the Service Worker logic (e.g., a new version of the virtual server), it will force a restart/update for Session B and C.
- By using the **Hub (Iframe)** model, each project can potentially have its own unique subdomain/origin, giving it a completely independent Service Worker lifecycle that won't interfere with other open tabs.

----

### Gemini Response to "Com:" Notes (Round 2)

#### 4. On Storage Hijacking ("Is it an issue if only stored?")
The "High Risk" in the table refers to **Runtime Storage**, not the storage of the source code.
- If the `sandboxRenderer` runs a script served from the Host Origin, that script's `window.localStorage` is the **Host's LocalStorage**.
- Even if the script is "just a preview," a user could write `localStorage.clear()` or `db.deleteDatabase('ide-internal-state')`. 
- In the **Hub** model, the script runs on a unique origin, so its `localStorage` is an empty, isolated bucket.

#### 5. On Host SW as a Single Point of Failure ("Host SW tempering")
You are correct: the Host SW is the **Root of Trust**. If an attacker can compromise the Host SW, they control the data flow.
- However, the **Hub model** implements **Defense in Depth**. 
- In the "vf Server" model, a simple logic bug (e.g., a regex error in the URL filter) can accidentally expose host files.
- In the "Router" model, even if the Host SW is "tricked," the browser's **Same-Origin Policy (SOP)** still prevents the `sandboxRenderer` from reaching "up" into the Host's DOM or Storage because they are cross-origin. You aren't just relying on your code; you're relying on the browser's C++ engine to enforce the boundary.

#### 6. On Session IDs vs. Origins ("Unique /session_id solves collisions")
Path-based isolation (`/session_1/index.html`) is **Soft Isolation**. It prevents filename collisions, but it fails at **Origin-Scoped Features**:
- **Permissions**: If the user grants Camera access to `/session_1/`, `/session_2/` automatically has it too.
- **Cookies**: Both sessions share the same cookie jar.
- **Storage**: Both sessions share the same IndexedDB quota and namespace.
Only a unique **Origin** (subdomain) provides **Hard Isolation** for these browser features.

#### 7. On the Sandbox Renderer
> "If host sw is compromised it could also be set to show virtual files at host level."

Exactly. The goal of the Hub/Router architecture isn't to protect against a compromised Host SW (which is game over anyway), but to **prevent the Virtual Files from compromising the Host** via standard web vulnerabilities (XSS, CSRF, etc.) by ensuring they never share an execution context.