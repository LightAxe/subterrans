# Security Policy

## Supported Versions

Subterrans is in pre-1.0 development. Only the `main` branch receives security fixes. Once we tag releases, this table will list supported ranges.

## Reporting a Vulnerability

**Please do not open public issues for security-sensitive bugs.**

Use **GitHub's Private Vulnerability Reporting** on this repository:

1. Go to the repository's **Security** tab.
2. Click **Report a vulnerability**.
3. Fill out the private advisory form with as much detail as you can provide.

This routes the report directly to the maintainers through an authenticated, private channel — your email is never exposed and we get a GitHub notification.

## What to Include

- A clear description of the issue and its impact.
- Steps to reproduce (seed, inputs, save-file snippet — whatever applies).
- Affected commit SHA or version if known.
- Proof-of-concept if you have one.
- Your suggested severity (CVSS or plain language is fine).

## What to Expect

- **Initial acknowledgement**: within 7 days.
- **Triage and preliminary assessment**: within 14 days.
- **Fix or mitigation plan**: communicated privately before any public disclosure.
- **Credit**: if you want it, we'll credit you in the advisory and release notes; if not, we'll keep your report anonymous.

Subterrans is a small, early-stage project — responses may be slower than a commercial product. Thanks for your patience.

## Scope

**In scope:**

- Code in this repository (game client, simulation, save/load, any server components if added later).
- Save-file parsing (e.g. crafted save files causing RCE or denial-of-service in the client).
- Dependency vulnerabilities with a working impact path into this codebase.

**Out of scope:**

- The surrounding website infrastructure, marketing site, and account/login systems — those are separate projects and have their own reporting channels.
- Vulnerabilities in upstream dependencies without a demonstrated impact on Subterrans; please report those to the upstream project first.
- Social engineering, physical attacks, or anything requiring prior compromise of a user's device.

## Safe Harbor

We will not pursue legal action against researchers who:

- Make a good-faith effort to follow this policy.
- Avoid privacy violations, data destruction, or service disruption.
- Give us reasonable time to fix the issue before public disclosure.

Thanks for helping keep Subterrans and its players safe.
