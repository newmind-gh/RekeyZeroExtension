# Governance

## Model

RekeyZero is currently owner-maintained. The maintainer is listed in [MAINTAINERS.md](MAINTAINERS.md) and has final responsibility for repository access, releases, security response, and project direction.

## Decisions

Routine changes are decided through review and documented technical evidence. Contributors should seek practical consensus, but the maintainer makes the final decision when consensus is not reached or safety, compatibility, legal, or security constraints apply.

Material architecture decisions must be explained in the relevant pull request or issue. Accepted decisions may be superseded by later reviewed changes.

## Contributions and triage

- Issues are triaged by impact, reproducibility, scope, and security risk.
- Pull requests require passing applicable checks and maintainer approval.
- Security reports follow [SECURITY.md](SECURITY.md), not the public issue tracker.
- Control-adapter changes require synthetic fixtures, explicit permissions, and documented failure behavior.
- Inactive proposals may be closed and reopened when new evidence or an implementer is available.

## Releases

Releases use semantic versioning where practical. The maintainer authorizes releases from a reviewed commit after tests, dependency checks, secret scans, and package verification pass. Breaking changes require release notes and a migration path when one is feasible.

PR and main CI validate changes automatically. The maintainer authorizes publication by pushing a version tag for a reviewed commit; the Release workflow validates and publishes that tagged version.

## Security and conflicts of interest

Security response is owned by the maintainer through **rekeyzero@outlook.com**. Reviewers must disclose material conflicts of interest and step back when an independent reviewer is available.

## Maintainer changes

New maintainers are appointed based on sustained, trusted contributions and demonstrated judgment in security and compatibility matters. Departing maintainers should transfer repository access, release credentials, and unresolved security reports through a private, documented handover.

## Project name

Source-code licensing does not automatically grant rights to use the RekeyZero name, logos, or product identity to imply endorsement. A separate trademark policy may be added before a public release.
