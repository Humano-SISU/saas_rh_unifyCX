# Tabletop Exercise — November 2026

| | |
| --- | --- |
| **Plan tested** | `docs/security/incident-response-plan.md` |
| **Date run** | _YYYY-MM-DD_ |
| **Duration** | _minutes_ |
| **Participants** | Jorge Arturo Gómez Coello (incident lead) |
| **Scenario** | Playbook A — privileged key leaked |

A tabletop exercise walks through a simulated incident on paper. Nothing is changed in production. The goal is to find gaps in the plan before a real incident does.

## How to run it (about 60 minutes)

1. Block one hour without interruptions. Open the incident response plan and this file.
2. Read each injection below only when you reach it, not before.
3. For each question, write what you would do, **where** you would do it (which dashboard, which file), and how long it would take. If you are not sure where something is, open the dashboard and check — that is a finding.
4. Do not rotate any real key. Stop at the screen where you would do it.
5. Fill in the findings and follow-up tasks at the end, then commit this file.

## Scenario

> Tuesday, 10:15 (America/Tegucigalpa). A GitHub email warns that a secret was detected in a commit pushed 3 days ago to a branch of `saas_rh_unifyCX`. The secret is the Supabase service role key of production. The branch is private, but a contractor was given read access last month.

### Injection 1 — Detect and declare (10 min)

- What severity do you assign, and why?
- Where do you open the incident record, and what do you write first?
- How do you confirm which key it is and whether it is still valid?

| Answer | Where | Time |
| --- | --- | --- |
| | | |

### Injection 2 — Contain (15 min)

> You confirm the key is valid and is the production key.

- List every place the key must be replaced (Supabase, Railway services, GitHub secrets, local `.env` files, cron services).
- In what order do you do it so the application keeps working?
- How do you remove the key from git history, and why is rotating it still required?

| Answer | Where | Time |
| --- | --- | --- |
| | | |

### Injection 3 — Investigate (15 min)

> Supabase logs show 40 requests with the service role key from an IP address that is not Railway, two days ago, reading the `employees` table of two companies.

- How do you find which companies and which records were read?
- What logs do you save, and where, before they expire?
- What is the root cause, and who else had access to the branch?

| Answer | Where | Time |
| --- | --- | --- |
| | | |

### Injection 4 — Notify (10 min)

- Which clients do you notify, through which contact, and by when (72-hour limit)?
- Draft the first lines of the notification using section 6 of the plan.
- What do you tell the clients they should do?

| Answer | Where | Time |
| --- | --- | --- |
| | | |

### Injection 5 — Learn (10 min)

- What would have stopped this incident earlier?
- What step in the plan was missing, unclear or wrong?

| Answer |
| --- |
| |

## Results

**Overall result:** _Plan worked as written / Plan worked with gaps / Plan did not work_

### Findings

| # | Finding | Severity (High / Medium / Low) |
| --- | --- | --- |
| 1 | | |

### Follow-up tasks

| # | Task | Owner | Due |
| --- | --- | --- | --- |
| 1 | | | |

### Changes made to the incident response plan

- _None / list of changes with commit_
