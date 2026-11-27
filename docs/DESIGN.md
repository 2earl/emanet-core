# Vehicle recovery platform: names, Turkish law, design and plan

Status: decided 2026-11-25 (§11); P1 starts when the repository exists. Three applications: **X** for creditors (banks, asset management
companies), **Z** for field agents, **Y** for 2earl admins and support. Turkish and English from day
one, on the existing i18n engine.

Confidence tags: [Kesin] verified in a source listed at the end; [Muhtemel] strong inference;
[Tahmin] gap filled by judgement, needs a Turkish lawyer or accountant to confirm.

---

## 0. Read this first: what blocks building

1. **We never seize anything; the police do.** A creditor gets the enforcement office (icra
   dairesi) to put a *yakalama şerhi* on the vehicle's registration. Police or gendarmerie who see
   the vehicle pull it from traffic, a tow truck takes it to a custodian car park (*yediemin
   otoparkı*), and the vehicle is handed to the nearest enforcement office within three working
   days (İİK 88/7). [Kesin] Our product finds vehicles and reports them; agents never touch, tow,
   block or confront.
2. **155 no longer exists as a separate line.** Since 2021 all emergency numbers, 155 included,
   are merged into **112** in all 81 provinces. [Kesin] The app must say 112. Whether reporting a
   parked vehicle with a seizure order belongs on the emergency line at all is a question for a
   lawyer or the police; the alternative is the local police station's own number. [Tahmin]
3. **Police plate cameras already catch the easy cases.** 4,183 plate-recognition (PTS) points
   alert police automatically when a vehicle with a seizure order passes, anywhere in Turkey.
   [Kesin] Agents add value mostly for **parked or hidden vehicles**: at home addresses, in car
   parks, off main roads. Design and pricing should centre on that, not on spotting in traffic.
4. **Bank secrecy.** Banking Law 5411 art. 73 forbids banks to disclose customer secrets except to
   bodies the law authorises; the same duty binds their outsourcing providers (*destek hizmeti
   kuruluşu*) and their staff. [Kesin] Breaches are criminal (Banking Law 159, TCK 239). [Kesin]
   So a bank can give us debtor data only by contracting us as an outsourcing provider under BDDK's
   outsourcing regulation, with the risk analysis, due diligence and annual reviews it requires
   (Bankaların Destek Hizmeti Almalarına İlişkin Yönetmelik). [Kesin for the regulation; Muhtemel
   that it applies to this service] Asset management companies are BDDK-licensed too. [Kesin]
   Expect each partner's legal team to audit us before onboarding.
5. **Data residency is in conflict with our current stack.** BDDK requires banks to keep primary
   and secondary systems in Turkey [Kesin for banks]; partners will very likely ask the same of an
   outsourcing provider holding their customer data. [Muhtemel] Cloudflare D1 cannot pin data to
   Turkey [Tahmin, from Cloudflare's published jurisdictions]. KVKK allows transfers abroad with
   the Board's standard contracts, notified to the Authority within five working days [Kesin],
   but a bank's own rules will probably be stricter than KVKK. **Decision needed:** host X, Y, Z
   data in Turkey (Turkish cloud or VPS, Cloudflare in front only for TLS and WAF), or confirm with
   the first partner that standard contracts suffice.
6. **A Turkish company is needed.** Contracts with Turkish banks, e-invoices (e-Fatura) with VAT
   (KDV), a Turkish corporate bank account with an API, VERBİS registration and agent payouts all
   assume a Turkish legal entity. The owner is in Berlin; 2earl's current set-up does not cover
   this. [Muhtemel]
7. **Agents must not follow people.** Persistent stalking (*ısrarlı takip*) has been a crime of its
   own since 27 May 2022 (TCK 123/A), punishable by six months to two years in prison. [Kesin]
   Agents look for vehicles, never for people. The app must enforce this through its rules, the
   data it shows, and how long it shows it.
8. **The market exists.** "Intelligence companies" have paid tipsters for vehicles with seizure
   orders since at least 2019, with rewards of up to about 10,000 TL. [Kesin] Our edge has to be
   trust: KYC-verified agents, evidence chains, creditor APIs, and clean accounting.

Owner actions before code: §11.

---

## 1. Names

Constraints from Turkish law and practice:
- No words that suggest a public authority: *Polis, Emniyet, Jandarma, İcra, Devlet, Resmi,
  Adli*. They mislead debtors and the public.
- No *Dedektif* or *İstihbarat*: Turkey has no licensed private-detective profession, and
  "intelligence" suggests the state. [Tahmin]
- No *Avcı* (hunter) or *Haciz* in the agent product. The press calls this business "seized-car
  hunters"; agents wearing that label invite confrontation.
- The name must be pronounceable in English and checkable at TÜRKPATENT (trademark) and in .com.tr.

**Chosen by the owner: Emanet** ("entrusted"; the goal of every case is a vehicle entrusted to custody)

| App | Turkish | English | Address (proposal) |
| --- | --- | --- | --- |
| X, creditors | Emanet Kurumsal | Emanet for Creditors | emanet-kurumsal.2earl.com |
| Z, agents | Emanet Saha | Emanet Field | emanet-saha.2earl.com |
| Y, admins | Emanet Merkez | Emanet Control | emanet-merkez.2earl.com (staff only) |

Known risk: people may confuse it with *adli emanet*, the state's custody of evidence, and a
debtor may take an agent for an official. Mitigations:
- Never use the name alone in public-facing places. Always "Emanet Saha", or the 2earl mark beside it.
- Never use *Adli*, *Resmi* or a crest.
- Every page footer and the agent's call script say "Emanet is a private service, not a public
  authority" (TR/EN).
- Agents introduce themselves as private persons, never as Emanet staff.

Considered and set aside: Bulgu ("finding"), Tespit ("detection", generic and hard to register).

Trademark and domain availability not checked [Tahmin]: run a TÜRKPATENT search for classes 9, 35,
36 and 42 before committing.

---

## 2. The legal process the product follows

```
Creditor (bank / VYŞ / their law firm)
  1 enforcement file at icra dairesi → haciz + yakalama şerhi on the vehicle record   [outside us]
  2 adds vehicle to Emanet Kurumsal (with icra dairesi + dosya no)                    [X]
Agent
  3 claims the vehicle, searches near the given places                               [Z]
  4 sees it → photo with GPS and time, in-app only                                   [Z]
  5 calls 112 (or the local station) and reports plate + location                    [Z]
Police
  6 check the record; if the şerh is active, men from traffic, call a tow truck
  7 police report (tutanak); tow truck report; yediemin intake receipt
  8 vehicle at yediemin → handed to nearest icra within 3 working days (İİK 88/7)
Agent
  9 photographs: vehicle at the scene, tow truck report, yediemin receipt, vehicle at yediemin [Z]
2earl
 10 admin verifies evidence → "Teslim edildi" (delivered to custody)                 [Y]
 11 creditor notified (webhook / API), invoiced                                      [X, Y]
 12 creditor pays → admin issues payout order → agent paid                           [Y]
```

Word for the final state: **"Otoparka teslim edildi" / "Delivered to custody"**. That is what
actually happened and what the evidence proves. Avoid *yakalandı* (captured) in the agent UI: it is
the police's act, not ours.

Edge cases the design handles:
- **The şerh was lifted** (the debt was paid or restructured) after the vehicle was listed: police
  find nothing, and the agent wasted time. So creditors must re-confirm active cases (§4.3), and
  cases expire if they don't.
- **A third party has the vehicle** (spouse, company): police still seize it, and the third party
  can claim it back in court (*istihkak*). [Kesin] Not ours to judge; just record it.
- **The owner reports it themselves**, after stripping parts, to buy it back cheaply at auction.
  [Kesin, reported by NTV] Evidence photos at discovery protect the creditor; agents are paid
  only for vehicles found in a condition the partner accepts (configurable).
- **Private property** (a gated site's car park): agents never enter; they report the location and
  the police decide.

---

## 3. Architecture

**Each app has its own repository and its own address under 2earl.com.** The data and rules live
once, in a core service that the three apps call.

| Repository | Address | What it is |
| --- | --- | --- |
| 2earl/emanet-core | none (Service Bindings only) | D1 database, migrations, rules, ledger, crons |
| 2earl/emanet-kurumsal | emanet-kurumsal.2earl.com | Creditors' web app and `/api/v1`, webhooks |
| 2earl/emanet-saha | emanet-saha.2earl.com | Agents' PWA (later a native shell for NFC) |
| 2earl/emanet-merkez | emanet-merkez.2earl.com | Staff console |

- **Why a core service.** Three apps writing the same tables would each need the same invariants:
  one open claim per vehicle, balanced journal entries, the no-oracle rule. Logic copied three
  times drifts. The core owns the schema and the rules.
- **Least privilege.** The core exposes three RPC entrypoints (`PartnerApi`, `FieldApi`,
  `ControlApi`), and each app is bound to its own only. The agents' app cannot call
  `confirmDelivery`; the creditors' app cannot list hunts.
- **Addresses.** One level under 2earl.com: Cloudflare's free certificate covers `*.2earl.com`
  but not deeper names. [Muhtemel] The hosts are Turkish to match the product names; every app
  serves both languages. All three are `noindex`, like login and mcp; only 2earl.com is for
  search engines.
- **Identity**: login.2earl.com, already in place.
  - Creditor companies are **login organizations**: created by global admins, joined by email
    invitation (phase 11). QR codes and invite links are the same invitation, encoded differently.
    Emanet Kurumsal asks for the `organizations` scope, so the token carries the person's
    organizations and their role in each.
  - Emanet Merkez needs the person's staff role. Login gets a small `StaffDirectory` RPC
    entrypoint, bound only by emanet-merkez. Admin and support may sign in; only admin confirms
    deliveries and orders payouts.
  - Agents are ordinary 2earl users who pass Emanet's KYC.
  - Login's service registry gets an `emanet` entry, so deleting an account or downloading one's
    data reaches Emanet. Agents' financial records are kept for the legal retention period and
    anonymised otherwise.
- **Agent mobile**: start as a PWA (camera, geolocation, offline queue for photos). Moving to a
  native app (Expo or React Native) is required only for **NFC reading of the Turkish ID card's
  chip**, which browsers cannot do. [Muhtemel]
- **Hosting**: Cloudflare (Workers, D1, R2), decided in §11. The pilot partner is asked whether
  KVKK standard contracts suffice. The SQL stays plain SQLite, so a move to Turkish hosting is a
  port, not a rewrite.
- **Files** (photos, reports): R2, never public, served through short-lived signed URLs, with
  every read logged.

## 4. Data model (core; partners' extras go into custom fields)

Money is integer kuruş, currency TRY. Every table has `created_at` and `updated_at`, plus soft
deletion where records must survive for audit. Every change goes to an append-only `audit_events`.

### 4.1 Partners and access
```
partners            id, org_id (login), kind (bank | vys | law_firm | leasing | other),
                    legal_name, tax_office, vkn, kep_address, e_invoice (bool), status,
                    contract_ref, data_residency_terms, created_by
partner_members     partner_id, user_id, role (owner | operator | finance | viewer)
api_keys            id, partner_id, name, prefix, hash (argon2id/HMAC), scopes[],
                    ip_allowlist[], expires_at, last_used_at, revoked_at
webhooks            id, partner_id, url (https only), secret_ref, events[], active,
                    failure_count, disabled_at
webhook_deliveries  id, webhook_id, event_id, attempt, status_code, next_retry_at
```

### 4.2 Vehicles: one row per physical vehicle
```
vehicles            id, vin (şasi no, normalised, UNIQUE), make, model, year, colour,
                    body_type, fuel, engine_no?, attributes (json), created_at
vehicle_plates      vehicle_id, plate (normalised, e.g. 34ABC123), valid_from, valid_to
                    UNIQUE(plate) WHERE valid_to IS NULL
```
The VIN is the identity, not the plate. Turkish plates can move between vehicles and change over
time. [Muhtemel] So:
- Plates are history rows. A partner adding a vehicle with a known VIN and a new plate closes the
  old plate row.
- A known plate with a different VIN is a conflict that goes to the Y review queue, never an
  automatic merge.
- When a partner has no VIN, the case is accepted as `pending_identity` and does not reach agents
  until a VIN arrives or an admin confirms it.

### 4.3 Cases: one creditor's claim on one vehicle
```
cases               id, partner_id, vehicle_id, external_ref (partner's own id),
                    icra_office, icra_file_no, serh_date, legal_basis (rehin | haciz),
                    status, fee_kurus (resolved from price list, frozen at creation),
                    attributes (json), last_confirmed_at, expires_at, closed_reason
                    UNIQUE(partner_id, external_ref)
                    UNIQUE(partner_id, vehicle_id) WHERE status IN active states
case_places         case_id, kind (owner_home | work | last_seen | other), address,
                    district, city, lat?, lng?, note, visibility
```
Case status: `draft → active → claimed → reported → towed → delivered → invoiced → paid` with side
exits `withdrawn` (the partner removed it), `expired` (not re-confirmed), `rejected` (evidence
failed) and `disputed`.

**Uniqueness across partners.** Two creditors can each have a seizure order on the same vehicle.
The vehicle is one row and the claims are separate cases:
- Agents see one **hunt** per vehicle, never one per partner.
- On delivery, every partner with an active case is notified.
- Billing per case is the default: each partner pays its own fee. The agent is paid once,
  following a configurable rule (highest fee, or a fixed table). **Owner decision**, §11.
- **No existence oracle.** When partner B adds a VIN that partner A already has, B gets exactly the
  response it would get for a new vehicle. Telling B that another creditor is chasing the same
  vehicle would itself leak a customer secret.

**Freshness.** Each case carries `last_confirmed_at`. Partners re-confirm by API or in bulk at
least every N days (default 14, set in Y per partner). Unconfirmed cases expire and drop out of
agents' lists. This protects agents and the police from chasing lifted orders, and protects us
from calls on vehicles that should not be taken.

### 4.4 Custom fields: tables, objects and forms that grow per partner
```
field_definitions   id, scope (global | partner:<id>), entity (vehicle | case | place),
                    key, label_tr, label_en, type (text|number|date|enum|bool|phone|money),
                    enum_values, required, validation (json schema fragment),
                    visibility (partner | admin | agent_after_claim), pii (bool), order,
                    deprecated_at
```
- Values live in the entity's `attributes` json and are validated on every write against the
  definitions in force.
- Forms, CSV templates and the API's JSON Schema (`GET /v1/schema`) are generated from these
  definitions. Onboarding a partner with new fields is configuration in Y, not a migration.
- Fields marked `pii` are encrypted at rest. Nothing reaches agents unless its visibility is
  `agent_after_claim`.

### 4.5 Agents
```
agents              user_id, status (applied | kyc_pending | active | suspended | banned),
                    tckn_hash, legal_name (from ID chip), birth_date, city, phone_verified,
                    iban, iban_verified_at, tax_profile (individual | sole_trader | company),
                    vkn?, rating, max_active_claims, created_at
kyc_checks          agent_id, kind (id_nfc | liveness | iban | criminal_record | address),
                    provider, result, evidence_ref, reviewed_by, reviewed_at
claims              id, vehicle_id, agent_id, claimed_at, expires_at, released_at,
                    release_reason (expired | released | delivered | revoked)
                    UNIQUE(vehicle_id) WHERE released_at IS NULL
cooldowns           agent_id, vehicle_id, until
sightings           id, claim_id, lat, lng, accuracy_m, taken_at (device), received_at,
                    photo_refs[], note
evidence            id, claim_id, kind (scene | police_report | tow_report | yediemin_receipt |
                    yediemin_vehicle), file_ref, sha256, exif_time, exif_gps, status,
                    reviewed_by
```

### 4.6 Money: double-entry, the only way to get "fully functional accounting"
```
ledger_accounts     id, code, name, kind (asset | liability | revenue | expense),
                    owner (partner:<id> | agent:<id> | platform)
journal_entries     id, occurred_at, kind, case_id?, memo, created_by     -- immutable
journal_lines       entry_id, account_id, debit_kurus, credit_kurus       -- Σdebit = Σcredit
price_lists         id, partner_id, valid_from, rules (json: make/model/year/segment → fee)
payout_rules        id, valid_from, rules (json: fee share or fixed table, by segment)
invoices            id, partner_id, number, issued_at, net, kdv, total, e_invoice_uuid,
                    status, pdf_ref
invoice_lines       invoice_id, case_id, net, kdv_rate
receipts            id, partner_id, amount, value_date, bank_ref, matched_invoice_id,
                    source (manual | bank_api)
payouts             id, agent_id, case_id, gross, withholding, net, status
                    (queued | approved | sent | failed), approved_by, bank_ref, document_ref
```
Entries per delivered case:
- **Delivered**: Dr Partner receivable / Cr Revenue (net) + Cr KDV payable. Dr Agent fee expense /
  Cr Agent payable (gross) / Cr Withholding payable, if any.
- **Partner pays**: Dr Bank / Cr Partner receivable.
- **Payout**: Dr Agent payable / Cr Bank.

Rules:
- Corrections are reversing entries, never edits.
- Fees are frozen on the case when it is created, so a later price change can't move an amount
  that has already been invoiced.

---

## 5. Emanet Kurumsal (X): creditors

**Onboarding** (`src/onboarding.ts`, `src/contract.ts`, `src/mail.ts`)

```
invited ─(link opened with the invited address)→ in_progress ─(agreement accepted)→ signed
signed ─(another staff member approves)→ approved = active partner
signed ─(staff send it back for changes)→ in_progress (acceptance cleared)
invited | in_progress | signed ─(staff)→ cancelled | rejected
invited | in_progress ─(14 days)→ expired ─(staff send a new link)→ invited | in_progress
```

1. Staff invite a company in Y: name, kind, contact name and address, language (Turkish or
   English), the proposed price list and re-confirmation days. One open invitation per address.
2. The core emails a link to Kurumsal (`/join/<secret>`, valid 14 days). Only the email has the
   secret; the database keeps its SHA-256. A new link (staff "Send again", or the day-3 and day-7
   reminders) replaces the old one.
3. The contact signs in with login. Kurumsal asks login whether that account has the invited
   address, verified (`OrganizationProvisioning.hasAddress`); only then does the core give the
   onboarding to the account, and only to the first one.
4. The contact creates the company's login organization from Kurumsal (login's
   `OrganizationProvisioning.create`, owner = the contact) or picks one they own. One company per
   organization.
5. The contact gives the company's details (legal name, address, tax office, VKN, MERSİS, KEP,
   signatory, billing and operations contacts, e-invoice) and uploads documents to R2
   `emanet-documents`: signature circular and tax certificate expected, trade registry gazette
   and others optional.
6. Kurumsal shows the agreement rendered with those details and the price list (Annex 2). The
   signatory confirms they may bind the company and accepts. The core re-renders it and refuses
   if the version or SHA-256 differs from what was shown, then keeps the exact text, its hash,
   the signer's name, title, IP and time. A receipt with the hash goes to the contact; a note to
   staff.
7. Another staff member than the one who invited checks the details and documents in Y and
   approves: in one D1 batch the partner is created active with the details, the price list and
   the agreement's version and time, and the onboarding is closed. The contact is emailed. Staff
   can instead send it back for changes (the acceptance is cleared) or reject it with a reason.

The agreement (`src/contract.ts`, version `CONTRACT_VERSION`) is a draft for a lawyer to review.
Its provider details (`PROVIDER`) are placeholders until 2earl's company details are filled in.
A new version applies to companies that accept after it ships; signed text never changes.

**Vehicles**
- Add a vehicle by form, by CSV/XLSX upload (dry-run preview, row-level errors, idempotent on
  `external_ref`), or by API.
- Withdraw a vehicle, with a reason. A withdrawn case goes straight off agents' lists.
- Re-confirm cases in bulk.

**Price list**
- Partners set fees by make, model, year band and segment, with a default.
- 2earl can set a floor per segment, configured in Y.

**Status and reports**
- Each case shows its timeline (states and times only), evidence once delivered, and the invoice.
  Agent identities are never shown.
- Reports: recovery rate, time to find, cost per vehicle, by city and segment. Exportable.

**API, `/v1`, OpenAPI published**
- `POST /v1/cases` (header `Idempotency-Key`), `GET /v1/cases/{id}`, `GET /v1/cases?status=&since=`
  (cursor), `POST /v1/cases/{id}/confirm`, `POST /v1/cases/{id}/withdraw`, `GET /v1/schema`,
  `GET /v1/invoices`.
- API keys are scoped (`cases:write`, `cases:read`, `invoices:read`), stored hashed, shown once,
  optionally limited by IP allowlist, with per-key rate limits. OAuth client credentials through
  login is the better long-term option for banks; it is planned, not v1.

**Webhooks**
- Events: `case.delivered`, `case.expired`, `case.rejected`, `invoice.issued`.
- Signed with HMAC-SHA256 over the timestamp and body, rejected outside a five-minute replay window.
- Retries with backoff for 24 hours, then the webhook is disabled and an alert sent.
- A delivery log shows every attempt, with redelivery from the UI.

**Security**
- Partners can only ever read their own cases; tests enforce this on every endpoint.
- Every API call goes to the audit log.

**Other useful features**
- Notify the partner if an agent's sighting suggests the vehicle has left its usual area
  (aggregated, without agent detail).
- Users with the partner's "finance" role see invoices only, not vehicles.

---

## 6. Emanet Saha (Z): agents

**Joining (KYC)**
1. Sign up through login (email code, Google or passkey). Phone verified by SMS.
2. Identity: NFC read of the T.C. ID card's chip plus a liveness selfie matched to the chip photo.
   NFC is the method the central bank now prefers for remote identity checks by payment
   institutions [Kesin]; we adopt it as a benchmark. Use a vendor; we never store raw biometric
   templates.
3. IBAN must be in the agent's own name, checked against the chip's name. The method depends on
   the bank: a name check through our bank's API if it offers one, otherwise a one-off test
   transfer with a code the agent reads back. [Tahmin]
4. Criminal record: an e-Devlet barcoded *adli sicil* certificate, verified by its barcode. It is
   special-category data under KVKK, so it needs a legal basis and short retention.
5. Tax profile: individual (we document payment with a *gider pusulası*, and the bank statement can
   stand in for it when we pay by bank) [Kesin], sole trader or company (they invoice us).
   Withholding rates come from the accountant. [Tahmin]
6. Training, a short test on the rules of conduct, then acceptance of the agent agreement. After
   that an admin approves the agent in Y.

**Searching**
- Map and list of open hunts near the agent: plate, make, model, colour, rough area (district or
  neighbourhood), and the fee the agent will earn.
- No owner names, no debt amounts, ever.

**Claiming**
- Tap to claim. The claim lasts T hours (configured in Y) with at most K active claims per agent.
- While the claim is active, the agent sees the case's places at street level: copy the address,
  open in Google Maps or Apple Maps, get directions.
- The places screen carries the agent's ID as a watermark, and screenshots are blocked where the
  platform allows it.
- When a claim expires or is released, a cooldown of C hours stops the same agent re-claiming that
  vehicle.

**Found**
- Photo inside the app only (no gallery uploads), with GPS, accuracy and server time.
- Then the call-112 screen: what to say (plate, location, "a vehicle with a seizure order"), a
  button to call, and the rules: don't touch, don't wait at the owner's door, leave if it gets
  confrontational.

**After the police come**
- Step-by-step uploads: tow truck report, police report if handed over, yediemin receipt, vehicle
  at the yediemin. Each upload shows the next step.
- Status follows what the admin verifies: Under review → Delivered to custody → Payment ordered →
  Paid.

**Earnings**: balance, history, documents (gider pusulası or receipts), tax summary.

**Safety and anti-fraud**
- Geofence check: the sighting must be within X km of a case place or plausibly in traffic.
- Photos are hashed so reuse is detected.
- Ratings, and strikes for false reports.
- Collusion signals: the same agent repeatedly finding the same debtor's vehicles, or reports
  suspiciously soon after claiming.
- Rate limits on viewing places.

---

## 7. Emanet Merkez (Y): admins and support

- **Live board**:
  - Feed of new cases.
  - Feed of reports awaiting review, oldest first.
  - Map of active claims.
  - Counters for SLA breaches.
- **Review queue**:
  - Evidence side by side, with EXIF and GPS against the case places.
  - Approve "delivered", or reject with a reason.
  - Approving notifies partners (webhook) and posts the journal entries.
- **Configuration**:
  - Claim length T, cooldown C, max claims K.
  - Re-confirm window N per partner.
  - Fee floors and payout rules.
  - Custom field definitions.
  - Invitation templates in TR and EN.
- **Partners**: invite, activate, suspend; contracts; price lists; API key and webhook health.
- **Agents**: KYC queue, suspend or ban, strikes, ratings, payout block.
- **Money**:
  - **Receivables**: invoices, receipts, ageing.
  - **Payouts**:
    1. The partner's payment is matched.
    2. "Pay" is ordered, by an admin only.
    3. A second admin approves payouts above a threshold.
    4. The payout is sent to the bank (API or bulk file).
    5. The bank's reference is recorded.
  - **Journal**: trial balance; exports for the accountant; KDV and withholding totals per period.
- **Bank integration**: depends on the bank chosen. Turkish banks offer corporate APIs to Turkish
  legal entities that are their customers and sign an API agreement. [Kesin, İş Bankası's
  catalogue]
  - v1: upload the bank statement (CSV or MT940) and auto-match by amount and reference; payouts
    exported as a bulk EFT file.
  - v2: the bank's API for account movements and FAST/EFT payouts.
- **Audit**: every admin action is logged and attributed. Support has read-only access.

**Money flow and licensing.** We sell partners a finding service and buy agents' reporting
services; two separate contracts. We must never collect money "on behalf of" agents: that looks
like a payment service, which needs a licence under Law 6493. [Muhtemel] Contracts and invoices
must follow this structure.

---

## 8. Privacy (KVKK) design

**Roles**
- Partners are the data controllers for debtor data; we process it for them.
- For agents' data, we are the data controller.
- Both roles need VERBİS registration, a privacy notice (*aydınlatma metni*) and retention rules.

**Minimisation**
- Debtor names and debt amounts are not needed at all; X doesn't ask for them.
- Addresses are seen by the claiming agent only, for the claim's lifetime.

**Retention**
- Case places are deleted 30 days after a case closes.
- Evidence is kept as long as the partner contract requires, plus the statutory period for
  invoices.
- KYC evidence is deleted after verification; the results stay.

**Biometrics**: the liveness selfie is special-category data (KVKK art. 6). Process it with
explicit consent or another art. 6 basis, through a vendor, and keep no templates. [Kesin that
art. 6 governs; Tahmin on the exact basis]

**Transfers abroad**: if any of it is hosted outside Turkey, use the Board's standard contracts and
notify the Authority within five working days. [Kesin]

---

## 9. Turkish and English

- The i18n engine already in login and promptshare (English source, catalogue per locale, `{n}`
  patterns) is reused in all three apps.
- Custom field labels are stored in both languages.
- Agent rules, privacy notices and contracts: the Turkish text is authoritative; the English is a
  courtesy translation.

---

## 10. Phases

| Phase | Scope | Exit |
| --- | --- | --- |
| P0 | Owner: lawyer (BDDK, KVKK, 112 question), accountant, bank with corporate API, trademark, pilot partner's view on hosting | Answers recorded |
| P1 | emanet-core: schema, cases, claims, custom fields, ledger, audit (**built, 33 tests**); infra (D1, R2); login: `emanet` service, `StaffDirectory` | Core deployed |
| P2 | X: onboarding, cases (form, CSV, API), price lists, webhooks, statuses | A pilot partner can load vehicles |
| P3 | Z: PWA, KYC (vendor), search, claim/SLA, sightings, evidence flow | A pilot agent can complete a case |
| P4 | Y: live board, review queue, configuration, partner and agent admin | End-to-end case without money |
| P5 | Ledger, invoices (e-Fatura via a GİB-licensed integrator), receipts, payouts, statement import | One case invoiced and paid out |
| P6 | Native agent app (NFC), bank API, OAuth client credentials, reports | Scale |

P1 and P2 can start as soon as the repository exists and the hosting decision is made.
Everything is built to the same standard as login (tests, CI, docs, threat model).

---

## 11. Decisions

Decided by the owner on 2026-11-25:

1. **Legal entity**: an existing Turkish company the owner controls signs with partners and agents.
   Its trade name, VKN and KEP address go into the partner and agent contracts and the invoices.
2. **Hosting**: build on Cloudflare (Workers, D1, R2) and ask the pilot bank whether KVKK standard
   contracts are enough. Storage stays behind an interface so a move to Turkish hosting is a port,
   not a rewrite. No real partner data before that answer.
3. **Name**: Emanet (§1), with the mitigations listed there. Trademark search at TÜRKPATENT still
   to do.
4. **Several creditors on one vehicle**: each creditor with an active case pays its own fee. The
   agent is paid once, by the payout rule of the highest fee.

Still open:
- Repositories: the owner creates `2earl/emanet-core`, `2earl/emanet-kurumsal`,
  `2earl/emanet-saha` and `2earl/emanet-merkez` (empty, public, like the others).
- Pilot partner: one bank or asset management company, to shape fields and the contract.
- Lawyer: the outsourcing contract (BDDK), KVKK documents, and whether 112 is the right line.
- Accountant: withholding on agent payments; e-Fatura integrator.

---

## Sources

- İİK 88/7, vehicles handed to icra within 3 working days: av-saimincekas.com (İİK text)
- Police seizure process, yediemin: hukukihaber.net; hukukcularevi.com
- 112 single emergency number since 2021: milliyet.com.tr; hurriyet.com.tr
- PTS plate cameras alert on seized vehicles: aa.com.tr
- Banking Law 73 and sharing regulation: lexpera.com.tr; whitecase.com; dergipark.org.tr
- BDDK outsourcing regulation: alomaliye.com, muhasebetr.com (RG 28106, 5 Nov 2011)
- Asset management companies regulation (RG 27 Aug 2025): alomaliye.com; lexpera.com.tr
- KVKK transfers abroad, standard contracts (2024): kvkk.gov.tr; erdem-erdem.av.tr
- TCK 123/A persistent stalking: kadimhukuk.com.tr; kulacoglu.av.tr
- Tipster market for seized vehicles: hurriyet.com.tr (2019); otoyakalama.com
- Owners stripping vehicles before reporting: ntv.com.tr
- Gider pusulası and bank statements for payments to non-registered persons: muhasebenews.com
- TCMB remote identity: NFC as preferred method: paratic.com
- İş Bankası corporate API conditions: isbank.com.tr (API catalogue)
