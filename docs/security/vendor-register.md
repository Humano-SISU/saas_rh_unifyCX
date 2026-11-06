# Vendor Register and Vendor Risk Management

| | |
| --- | --- |
| **Owner** | Jorge Arturo Gómez Coello (Founder & Lead Developer) |
| **Last review** | 2026-11-05 |
| **Next review** | 2027-11-05, or earlier when a vendor is added or changes how it handles data |

This register lists every third party that stores, processes or transmits Customer Data for the Humano SISU platform, and defines the minimum requirements and the review process for those vendors.

"Customer Data" means personal data that a client loads into the platform about its employees and users (see `docs/security/README.md`).

## 1. Minimum requirements for vendors

A vendor may receive Customer Data only if it meets all of the following:

1. **Independent assurance:** a current SOC 2 Type II report or ISO/IEC 27001 certification.
2. **Data Processing Agreement:** a DPA (or equivalent terms) that limits processing to our instructions, includes Standard Contractual Clauses or an equivalent mechanism for cross-border transfers, and lists its own sub-processors.
3. **Encryption:** data encrypted in transit (TLS) and at rest.
4. **Breach notification:** a contractual commitment to notify us of security incidents affecting our data.
5. **Data minimization:** the vendor receives only the data its function needs (see the "Data received" column).
6. **Access control:** our accounts with the vendor are protected with multi-factor authentication.

A vendor that does not meet a requirement can be used only after the risk is written down in section 4 with a mitigation and a date to resolve it.

## 2. Vendors that process Customer Data

| Vendor | Service | Data received | Location | Assurance | DPA | Risk |
| --- | --- | --- | --- | --- | --- | --- |
| **Supabase** | PostgreSQL database, authentication, file storage | All Customer Data | United States (AWS) — **region to confirm** | SOC 2 Type II, annual audit ([source](https://supabase.com/docs/guides/security/soc-2-compliance)) | Available in the organization dashboard (Legal Documents) — **status to confirm** | High |
| **Railway** | Application hosting, scheduled jobs, Redis queue | All Customer Data in transit through the application; queued jobs for attendance device sync (employee name and code) | United States — **region to confirm** | SOC 2 Type II and SOC 3 ([source](https://docs.railway.com/enterprise/compliance), report at trust.railway.com) | Self-service DPA, terms at railway.com/legal/dpa — **status to confirm** | High |
| **Resend** | Transactional email | Recipient email addresses, email content (one-time codes, notifications, attendance reports with employee names) | United States | SOC 2 Type II, period 2025-02-01 to 2026-02-01 ([source](https://resend.com/security/soc-2)) | Pre-signed DPA, effective on sign-up ([source](https://resend.com/docs/knowledge-base/downloading-documents)) | Medium |
| **Twilio** | SMS one-time codes for phone sign-in (through Supabase Auth) | Phone number and one-time code | United States | ISO/IEC 27001, 27017, 27018; SOC 2 Type II ([source](https://www.twilio.com/en-us/legal/security-overview)) | Data Protection Addendum included in the customer agreement ([source](https://www.twilio.com/en-us/legal/data-protection-addendum)) | Low |
| **GitHub** | Source code hosting and CI/CD | No Customer Data. Holds source code and deployment secrets | United States | SOC 2 Type II and ISO/IEC 27001 (per GitHub compliance reports — **to confirm**) | GitHub Data Protection Agreement — **to confirm** | Medium (access to secrets) |

## 3. Vendors that do not receive Customer Data

These are listed so the register is complete. They do not need a DPA for Customer Data.

| Vendor | Service | What it receives | Notes |
| --- | --- | --- | --- |
| **Groq** | AI drafting of job-description text | Job title and task text typed by the user. No employee personal data | Prompt built in `lib/ai/mtp-improver.ts`. SOC 2 Type II reported by Groq — **to confirm** |
| **Google Analytics 4 / Google Ads** | Website analytics | Page views and device data, only after the visitor accepts cookies | Loaded by `components/marketing/MarketingAnalytics.tsx` after consent |
| **Meta Pixel** | Website analytics | Same as above | Same as above |
| **SendGrid** (Twilio) | Alternate email provider supported by the code | Nothing while it is not the active provider | Active provider is configured in `lib/notification-providers.ts` |
| **WhatsApp Business API** (Meta / Twilio) | Messaging integration present in the code | Nothing: not in use | `lib/whatsapp-service.ts` is not called by any route. Must be reviewed before it is enabled |

## 4. Open risks and actions

| # | Risk | Action | Owner | Due |
| --- | --- | --- | --- | --- |
| 1 | Hosting regions for Supabase and Railway not recorded | Record the region of each production project in section 2 | Jorge | 2026-11-12 |
| 2 | DPA status for Supabase, Railway and GitHub not recorded | Accept or sign each DPA and record the date and link here | Jorge | 2026-11-12 |
| 3 | MFA status on vendor accounts not recorded | Enable MFA on GitHub (and require it for the `Humano-SISU` organization), Supabase, Railway, the domain/DNS provider and the company email, then record the date below | Jorge | 2026-11-12 |
| 4 | Analytics scripts load on every route, including the signed-in application, once a visitor accepts cookies | Limit analytics to public marketing pages | Jorge | To schedule |

### MFA status of vendor accounts

| Account | MFA enabled | Date checked |
| --- | --- | --- |
| GitHub (personal account and `Humano-SISU` org requirement) | | |
| Supabase | | |
| Railway | | |
| Domain / DNS provider | | |
| Company email (`humanosisu@humanosisu.net`) | | |

## 5. Review process

**When a vendor is added**, before it receives Customer Data:

1. Confirm it meets the requirements in section 1, and keep the link to its certification and DPA.
2. Decide the minimum data it needs and write it in the "Data received" column.
3. Add it to section 2 with a risk level.

**Every year**, and when a vendor reports an incident or changes its terms:

1. Check that each certification is still current (report period or certificate date).
2. Check that the DPA is still accepted and read the vendor's current sub-processor list.
3. Check that MFA is still enabled on our accounts.
4. Remove vendors that are no longer used and delete our data from them.
5. Update "Last review" at the top of this document. The git history of this file is the record of each review.

**Risk levels:** *High* — stores or can read all Customer Data. *Medium* — receives part of the Customer Data, or holds credentials that give access to it. *Low* — receives one or two data points needed for a single function.

**Business continuity:** we do not impose our own continuity plan on vendors. We rely on vendors whose SOC 2 reports cover availability. Our own business continuity and disaster recovery plan is not written yet.
