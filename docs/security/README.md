# Security and Compliance Documents

Security and privacy documents of the Humano SISU platform. The git history of each file records when it was written, reviewed and changed.

**Customer Data** in these documents means personal data that a client loads into the platform about its employees and users: identification, contact, employment, payroll, banking and attendance data.

| Document | Purpose | Owner | Last review | Next review |
| --- | --- | --- | --- | --- |
| [Vendor register](vendor-register.md) | Third parties that handle Customer Data, minimum vendor requirements and the review process | Jorge Arturo Gómez Coello | 2026-11-05 | 2027-11-05 |
| [Incident response plan](incident-response-plan.md) | How incidents are detected, contained, investigated, recovered and notified | Jorge Arturo Gómez Coello | 2026-11-05 | 2027-11-05 |
| [Tabletop exercise — November 2026](tabletop-exercise-2026-11.md) | Annual test of the incident response plan | Jorge Arturo Gómez Coello | Pending run | November 2027 |

## Automated security checks

| Check | When | Where | Blocks release |
| --- | --- | --- | --- |
| Dependency vulnerability gate (`npm audit`, high and critical in production dependencies) | Every push and pull request | `scripts/ci/audit-gate.mjs` in `.github/workflows/ci-cd.yml` | Yes |
| Dependabot security updates | When an advisory affects a dependency | Repository settings (Code security) | No — opens a pull request |
| Dependabot version updates (npm, GitHub Actions) | Monthly, grouped | `.github/dependabot.yml` | No — opens a pull request |
| OWASP ZAP baseline scan (passive: crawls the site and inspects responses, sends no attacks) | Weekly, Monday 06:00 America/Tegucigalpa, and on demand | `.github/workflows/zap-baseline.yml`, rules in `.zap/rules.tsv` | No — report saved as the `zap-baseline-report` artifact |

The ZAP scan runs only when the repository variable `ZAP_TARGET_URL` is set (Settings → Secrets and variables → Actions → Variables). On 2026-11-05 no staging environment answered (`staging-humanosisu.net` does not resolve), so the target is still to be decided.

**Reviewing a ZAP report:** download the artifact from the workflow run, and for each alert either fix it or add it to `.zap/rules.tsv` with the reason. Once the first reports are clean, set `fail_action: true` in the workflow so new alerts fail the scan.

## Annual review checklist

- [ ] Run a tabletop exercise and record it in a new `tabletop-exercise-YYYY-MM.md`.
- [ ] Review every vendor in the vendor register (section 5).
- [ ] Review the incident response plan and update contacts.
- [ ] Update the "Last review" dates in this table.
