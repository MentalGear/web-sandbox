# Security policy

## Reporting a vulnerability

Report a suspected vulnerability **privately**, through GitHub's private vulnerability reporting: open the
repository's **Security** tab and choose **Report a vulnerability**, or go straight to
<https://github.com/MentalGear/web-sandbox/security/advisories/new>.

Do not open a public issue, pull request or discussion for a vulnerability. The repository owner turns private
vulnerability reporting on in the repository's settings; until it is on, the **Report a vulnerability** button is
missing, and a report waits for the owner to enable it rather than going public.

Please include:
- the mode (`strict`, `worker` or `cooperative`) and the configuration that matters (`origins`, `capabilities`,
  `fetchBridge`, `allowAnimations`, and so on);
- the engine and its version (for example Chromium 127, Firefox 146, WebKit/Safari), and the operating system if the
  behavior differs by platform;
- a reproduction: the smallest guest code or markup, and the host page setup, that shows it.

## Supported versions

There are no releases yet (the package is private), so the **`main` branch** is what is supported: fixes are made on
it. A release line is named here once one exists.

## What is in scope

[docs/THREAT-MODEL.md](docs/THREAT-MODEL.md) states what the library defends, against whom, and what it leaves to the
embedder and the browser; a report is in scope if it breaks a property stated there. How findings are classified and
fixed is in [CONTRIBUTING.md, "Fixing a finding"](CONTRIBUTING.md#fixing-a-finding); availability findings are rated
under [CONTRIBUTING.md, "Availability findings"](CONTRIBUTING.md#availability-findings-owner-2026-10-20).
