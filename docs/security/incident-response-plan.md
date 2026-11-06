# Incident Response Plan

| | |
| --- | --- |
| **Owner** | Jorge Arturo Gómez Coello (Founder & Lead Developer) |
| **Status** | Draft — pending owner approval |
| **Last review** | 2026-11-05 |
| **Next review** | 2027-11-05, and after every S1 or S2 incident |
| **Last test** | See `docs/security/tabletop-exercise-2026-11.md` |

## 1. Purpose and scope

This plan describes how Humano SISU detects, contains, investigates and recovers from security incidents that affect the platform or Customer Data, and how affected clients are notified.

A **security incident** is any event that compromises, or may compromise, the confidentiality, integrity or availability of Customer Data or of the systems that process it. Examples: a leaked credential, an account used by someone who should not have access, data from one company visible to another, or a vendor reporting a breach.

## 2. Roles and contacts

Humano SISU is a small team. One person holds every role, and vendors provide escalation.

| Role | Who | Responsibility |
| --- | --- | --- |
| Incident lead | Jorge Arturo Gómez Coello — humanosisu@humanosisu.net | Declares the incident, decides severity, leads every phase, communicates with clients |
| Escalation: database, auth, storage | Supabase support (organization dashboard) | Platform-level investigation, backup restore |
| Escalation: hosting | Railway support (station.railway.com / dashboard) | Infrastructure investigation, deployment rollback |
| Escalation: email and SMS | Resend and Twilio support | Message delivery abuse, credential misuse |
| Client contact | The security or data protection contact named in each client's contract or DPA | Receives incident notifications |

If the incident lead is unavailable, the escalation contacts above are used directly, and clients are told about the delay.

## 3. Severity levels

| Level | Definition | Examples | Response target |
| --- | --- | --- | --- |
| **S1 — Critical** | Customer Data confirmed or highly likely exposed, altered or lost, or the platform is fully unavailable | Privileged key published, data of one company visible to another, database deleted | Start containment within 1 hour of detection |
| **S2 — High** | A credential or account is compromised without evidence of data access yet, or a core function is unavailable for a client | Admin account signed in from an unknown location, payroll cannot be calculated | Start containment within 4 hours |
| **S3 — Low** | Suspicious activity or vulnerability with no evidence of compromise | Repeated failed sign-ins, high-severity dependency alert, phishing email received | Review within 2 business days |

Severity can be raised or lowered at any time as the facts change.

## 4. Response phases

### 4.1 Detect and declare

Sources of detection: application logs (Railway), database and authentication logs (Supabase), the application audit log (`audit_logs`), dependency alerts in CI and GitHub, vendor notifications, and reports from clients or users.

When something looks like an incident:

1. Open an incident record (template in section 7) with the time it was detected and how.
2. Assign a severity level.
3. From this moment, write down every action with its time. The record is the evidence.

### 4.2 Contain

Stop the damage first, then investigate. Use the actions that apply:

- **Revoke sessions** of affected users: the super admin security page (`/app/admin/security`) or the user's session manager ("sign out of all sessions").
- **Disable accounts** that are compromised (Supabase Auth dashboard).
- **Rotate credentials** that may be exposed: Supabase API keys, `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`, `SESSION_SECRET`, `ENCRYPTION_KEY`, `ODOO_SECRETS_KEY`, Resend and Twilio keys. Update them in Railway environment variables and GitHub secrets, then redeploy.
- **Roll back the deployment** to the last good version from the Railway dashboard, or revert the commit and let CI/CD deploy it.
- **Disable an integration** (Odoo, attendance devices, email, SMS) by removing its key until it is safe.

### 4.3 Investigate

1. Establish the timeline: first and last malicious event, from logs and the audit log.
2. Identify what was accessed: which companies, which tables or files, which users.
3. Find the root cause: code defect, leaked credential, vendor issue, or human error.
4. Keep copies of the relevant logs with the incident record, because vendor logs expire.

### 4.4 Recover

1. Fix the root cause in code through the normal pull request and CI process, and deploy it through staging when time allows.
2. Restore data from Supabase backups if data was altered or lost, and check it with the affected client.
3. Confirm the fix: the attack path no longer works and monitoring shows normal activity.

### 4.5 Notify

- **Clients:** notify every client whose data was affected **without undue delay, and no later than 72 hours after confirming the incident**. Notification goes by email to the contact in the client's contract and includes the information in section 6.
- **Authorities:** the client, as data controller, decides whether authorities or employees must be notified. We provide the information they need for that.
- **Vendors:** if the incident started at a vendor or affects its service, report it to the vendor.

Clients receive updates at least every 24 hours until the incident is closed.

### 4.6 Learn

Within 5 business days after closing an S1 or S2 incident:

1. Write a short post-incident review: what happened, what worked, what did not.
2. Turn each improvement into a tracked task with a date.
3. Update this plan if a step was missing or wrong.

## 5. Scenario playbooks

### A. Privileged key leaked (for example, the Supabase service role key)

1. **S1.** Rotate the key immediately in Supabase, update Railway and GitHub secrets, redeploy.
2. Check where it leaked (commit, log, screenshot, chat) and remove it; a leaked key in git history stays valid until it is rotated.
3. Review database logs for requests made with the key from unknown sources since the leak.
4. Notify affected clients if the logs show data access.

### B. Administrator account compromised

1. **S2**, or **S1** if data was exported or changed.
2. Revoke all sessions of the account, disable it, and reset its password with the client's administrator.
3. Review the audit log for actions taken by the account: exports, permission changes, payroll changes.
4. Reverse unauthorized changes and notify the client.

### C. Data from one company visible to another

1. **S1.** Roll back to the last deployment where isolation worked, or disable the affected endpoint.
2. Find the defect: Row Level Security policy, query missing the company filter, or permission check.
3. Identify which records were exposed and to which users, using logs.
4. Notify every affected client; add a test that proves the fix.

### D. Vendor outage or vendor breach

1. **S2**, or **S1** if the vendor confirms Customer Data was exposed.
2. Follow the vendor's status page and advisories; rotate any credentials the vendor recommends.
3. Tell clients about the expected impact and timing.
4. If the vendor confirms our data was affected, handle it as an incident under this plan and record it in the vendor register.

## 6. Client notification contents

- What happened and when it was detected.
- Which data and which people (employees, users) were affected, or that this is still being determined.
- What we have done to contain it and what we are still doing.
- What the client should do (for example, reset passwords, warn employees about phishing).
- The contact for questions and when the next update will arrive.

## 7. Incident record template

```
Incident ID:        INC-YYYY-NN
Detected:           YYYY-MM-DD HH:MM (America/Tegucigalpa) — how
Severity:           S1 / S2 / S3 (changes with time)
Clients affected:
Data affected:
Timeline:           HH:MM — action — result
Root cause:
Fix:                PR / commit
Clients notified:   date, time, contact
Closed:             YYYY-MM-DD
Post-incident review and follow-up tasks:
```

Incident records are kept for at least 3 years.

## 8. Testing this plan

This plan is tested at least once a year with a tabletop exercise: a simulated incident walked through on paper, phase by phase. Each exercise is recorded in `docs/security/` with its date, scenario, findings and follow-up tasks.
