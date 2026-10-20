# Security policy

## Reporting a vulnerability

Report a suspected vulnerability **privately**, through GitHub's private vulnerability reporting: open the
repository's **Security** tab and choose **Report a vulnerability**, or go straight to
<https://github.com/MentalGear/web-sandbox/security/advisories/new>.

Do not open a public issue, pull request or discussion for a vulnerability.

Please include:
- the mode (`strict`, `worker` or `cooperative`) and the configuration that matters (`origins`, `capabilities`,
  `fetchBridge`, `allowAnimations`, and so on);
- the engine and its version (for example Chromium 127, Firefox 146, WebKit/Safari), and the operating system if the
  behavior differs by platform;
- a reproduction: the smallest guest code or markup, and the host page setup, that shows it.

## Supported versions

The current major line, **1.x**, is supported. Fixes are made on it.

## What is in scope

[docs/THREAT-MODEL.md](docs/THREAT-MODEL.md) states what the library defends, against whom, and what it leaves to the
embedder and the browser; a report is in scope if it breaks a property stated there. How findings are classified and
fixed is in [CONTRIBUTING.md, "Fixing a finding"](CONTRIBUTING.md#fixing-a-finding); availability findings are rated
under [CONTRIBUTING.md, "Availability findings"](CONTRIBUTING.md#availability-findings-owner-2026-10-20).
