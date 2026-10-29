# Authentication & Authorization — Current State

**Last verified:** 2026-09-15 against `auth-server/src/**` (Express + TypeScript + Drizzle + PostgreSQL) — Module 4 requirements routes included
**Supersedes:** the removed 2026-09-07 (`..._STATUS.md`) and 2026-09-09 (`AUTHORIZATION_PROGRESS.md`) snapshots. This is the single current authentication/authorization document.
**Scope:** `auth-server/src/routes/*.routes.ts`, `controllers/*`, `services/auth.service.ts`, `token.service.ts`, `otp.service.ts`, `authorization.service.ts`, `authorization.policy.ts`, `middleware/*`, `types/auth.types.ts`, `test/authorization.policy.test.js`.

---

## 1. Dependencies — up to date, two decisions outstanding

Verified against `auth-server/package.json` on 2026-09-11:

| Package | Pinned | Latest (Sep 2026) | Verdict |
|---|---|---|---|
| `express` | `^5.2.1` | 5.x | ✅ current |
| `helmet` | `^8.3.0` | 8.3.0 | ✅ current |
| `jsonwebtoken` | `^9.0.3` | 9.0.3 | ✅ current |
| `bcrypt` | `^6.0.0` | 6.0.0 | ✅ current |
| `express-rate-limit` | `^8.7.0` | 8.x | ✅ current |
| `cors`, `cookie-parser`, `morgan`, `pg@^8.23`, `nodemailer@^10`, `resend@^6.26`, `dotenv@^17` | various | current majors | ✅ current |
| `typescript` | `^7.0.2` | 7.x | ✅ current |
| `drizzle-orm` | `1.0.0-rc.4` | stable `0.45.2` / RC track Jul 2026 | ⚠️ intentional RC — newer than stable, pre-release risk |
| `joi` | `^18.2.8` | 18.x | ⚠️ installed but **unused** — validation is hand-rolled |
| `overrides: tar, qs` | — | — | ✅ security-hardened, keep |

Decisions: (a) stay on Drizzle RC vs pin stable `0.45.x`; (b) adopt `joi`/shared schemas or remove the dependency.

---

## 2. Authentication — complete and current

Source: `routes/auth.routes.ts`, `controllers/auth.controller.ts`, `services/auth.service.ts`, `token.service.ts`, `otp.service.ts`, `middleware/auth.middleware.ts`.

| Method | Endpoint | Access | Notes |
|---|---|---|---|
| `POST` | `/api/auth/register` | public, rate-limited | Team Member only; 8-char letters+numbers; `409` on duplicate; `auth.service.ts:54` |
| `POST` | `/api/auth/login` | public, rate-limited (5/15m) | Verifies password → issues OTP challenge, no tokens yet; `auth.controller.ts:43` |
| `POST` | `/api/auth/verify-otp` | public, OTP-limited (30/15m) | 6-digit code → access + refresh JWT; `otp.service.ts:199` |
| `POST` | `/api/auth/resend-otp` | public, OTP-limited | Cooldown-gated re-issue; `otp.service.ts:172` |
| `POST` | `/api/auth/refresh` | httpOnly cookie | Rotates refresh in same `familyId`; `token.service.ts:91` |
| `POST` | `/api/auth/logout` | public with refresh cookie | Revokes refresh `jti`, clears cookie; `token.service.ts:156` |
| `POST` | `/api/auth/forgot-password` | public, rate-limited | Generic response (no enumeration); `auth.service.ts:214` |
| `POST` | `/api/auth/reset-password` | public, rate-limited | Single-use hashed token, revokes all refresh sessions |
| `POST` | `/api/auth/change-password` | `protect` | Verifies current password, revokes refresh sessions; forces re-login |
| `GET` | `/api/auth/me` | `protect` | Reloads active user from DB; `auth.controller.ts:157` |
| `GET` | `/api/health` | public | `app.ts:29` (`{ status:'ok', service:'auth' }`) |

Implementation notes (all verified in source):

- `bcrypt` cost 12 (`BCRYPT_SALT_ROUNDS`); email trim/lowercase; `SafeUser { id:uuid, fullName, email, role, roleDisplayName, roles[], permissions[] }` — hash never returned.
- OTP: `crypto.randomInt` 6-digit, stored as `HMAC-SHA256(challengeId:code)` with `OTP_HMAC_SECRET`; 10 min expiry, 5 attempts, 60 s resend cooldown, 5 sends/15 min per email **and** per IP; `SELECT ... FOR UPDATE` + `timingSafeEqual`; typed `OtpError { code, statusCode, retryAfterSeconds }`.
- Tokens: access 15 m (`JWT_EXPIRES_IN`), refresh 7 d / 30 d `rememberMe`; claims `sub, email, role, roles, fullName, jti, familyId, tokenType`; `issuer dhis2-pt-auth`, `audience dhis2-pt`; refresh stored as SHA-256 hash + `jti`/`familyId`/expiry/UA/IP; reuse of revoked token revokes entire family.
- Cookies: `httpOnly`, `path /api/auth`, `sameSite`/`secure` from env, `maxAge` 7 d / 30 d.
- Hardening: `helmet`, fail-closed CORS with credentials, `cookieParser`, `express.json({limit:'10mb'})`, login/forgot/reset + OTP + registration rate limiters.
- Password reset: `crypto.randomBytes(32)` raw token, SHA-256 stored, 60 min expiry; new request invalidates priors; transactional password update + `usedAt` + full refresh revocation.

---

## 3. Authorization — project routes now wired; documents/phases/reports pending

Canonical roles (`types/auth.types.ts`): `administrator`, `project_manager`, `team_member`, `document_approver`.
14 permissions (`PERMISSION_NAMES`): `user:manage`, `role:manage`, `project:view`, `project:create`, `project:manage`, `project:member:manage`, `project:publish`, `phase:manage`, `document:view`, `document:upload`, `document:delete`, `document:approve`, `report:view`, `report:create`.

Policy + guards (`services/authorization.policy.ts`, `services/authorization.service.ts`, `middleware/authorization.middleware.ts`, `middleware/permission.middleware.ts`, re-exported via `middleware/authorize.middleware.ts`):

- Pure `canAccessProject` / `canAccessDocument` with administrator bypass; permission + ownership/membership checks; UUID `normalizeResourceId`; 404-masking to avoid leaking resource existence.
- Database-authoritative: every protected check reloads global roles + permissions from PostgreSQL; JWT `roles`/`permissions` claims are UX-only.
- Audit: denied global permission checks and admin user/role mutations recorded via `audit.service.ts`.

Route coverage (verified 2026-09-11):

| Route group | File | Status |
|---|---|---|
| `GET/PATCH/POST/DELETE /api/admin/users*` | `routes/admin.routes.ts:8-29` (`protect` + `requirePermission(user:manage / role:manage)`) | ✅ wired |
| `GET /api/projects`, `POST /api/projects` | `routes/project.routes.ts:15-16` (`requirePermission(project:view / project:create)`) | ✅ wired — **new since 2026-09-07 docs** |
| `GET /api/projects/:projectId`, `GET /:projectId/members` | `routes/project.routes.ts:18-36` (`requirePermission(project:view)` + `requireProjectAccess(view)`) | ✅ wired — **new since 2026-09-07 docs** |
| `PATCH /api/projects/:projectId`, `PUT /:projectId/members` | `routes/project.routes.ts:24-42` (`requirePermission(project:manage / project:member:manage)` + `requireProjectManager()`) | ✅ wired — **new since 2026-09-07 docs** |
| `GET /api/users` (assignable) | `routes/project-users.routes.ts:8` (`requirePermission(project:manage)`) | ✅ wired |
| `GET /:projectId/phases`, `GET /:projectId/phases/current` | `routes/project.routes.ts` (`requirePermission(project:view)` + `requireProjectAccess(view)`) | ✅ wired — **Phase Engine (Module 3)** |
| `POST /:projectId/phases/ensure`, `PATCH /:projectId/phases/:phaseId` | `routes/project.routes.ts` (`requirePermission(phase:manage)` + `requireProjectAccess(phaseManage)`) | ✅ wired — **Phase Engine (Module 3)** |
| `GET /:projectId/requirements`, `GET /:projectId/phases/:phaseId/requirements` | `routes/project.routes.ts` (`requirePermission(project:view)` + `requireProjectAccess(view)`) | ✅ wired — **Document Requirements (Module 4)** |
| `POST /:projectId/phases/:phaseId/requirements`, `PATCH /:projectId/requirements/:requirementId`, `DELETE /:projectId/requirements/:requirementId`, `POST /:projectId/requirements/ensure` | `routes/project.routes.ts` (`requirePermission(phase:manage)` + `requireProjectAccess(phaseManage)`) | ✅ wired — **Document Requirements (Module 4)** |
| Document upload/list/version/delete/approve | no `document.routes.ts` in `src/routes/` | ❌ guards exist (`requireDocumentAccess`), no routes yet |
| Publish, reports | no publish/report routes in `src/routes/` | ❌ policy types exist (`publish`, `reportView/Create`), no routes yet |

Phase Engine notes: `POST /api/projects` auto-generates the 7 standard phases
(`services/phase.constants.ts: STANDARD_PHASES`, pure transition helpers
`resolveCompletion`/`resolveReopen`); completion is linear (only `current`
completes, only most-recently-completed reopens); `projects.currentPhase`
syncs on generate/complete/reopen; `POST .../phases/ensure` backfills
pre-Phase-Engine projects idempotently; `phase.generated/completed/reopened`
audit events recorded.

Tests: `test/authorization.policy.test.js` covers administrator bypass, manager scope, member restrictions, document-delete ownership, phase-manage gating; `test/phase.transitions.test.js` covers seed order, linear completion, final-phase completion, reopen rules; `test/requirement-templates.test.js` covers the Module 4 standard template, category seed mapping, and name/sort-order validation (13 tests total, run via `npm test`). No DB-backed route integration tests yet.

---

## 4. Known gaps / risks (unchanged, still valid)

1. Access tokens survive logout, deactivation, and password change until expiry — refresh revocation is immediate; add denylist / shorter TTL / version if immediate invalidation is required.
2. No per-account failed-password counter / lockout (request rate-limit only).
3. No email verification on registration — accounts active immediately.
4. Validation hand-rolled and duplicated; `joi` unused; frontend/backend rules aligned only by convention.
5. Audit partial: login/OTP/refresh/reset/membership/document/phase/report mutations not all in `activity_log`; no retention cleanup job for expired OTP / revoked refresh rows.
6. Administrator bootstrap is manual SQL (see §5) — public registration cannot create administrators.
7. Migrations `drizzle/drizzle/20260909103000_authorization_foundation`,
   `20260911100000_project_membership_constraints`,
   `20260914000000_phase_engine`, `20260915000000_document_requirements`,
   and `20260916000000_requirement_name_case_insensitive` must be applied in
   the deployment DB before Module 2–4 routes are relied upon.

---

## 5. Operations checklist

1. Apply migrations in order, then verify tables/permissions/role grants.
2. Bootstrap first administrator (controlled SQL, bcrypt hash generated locally — never commit plaintext):
   ```sql
   INSERT INTO users (full_name, email, password_hash)
   VALUES ('Initial Administrator', 'admin@example.org', '<bcrypt-hash>')
   ON CONFLICT (email) DO NOTHING;
   INSERT INTO user_roles (user_id, role_id)
   SELECT u.id, r.id FROM users u JOIN roles r ON r.name = 'administrator'
   WHERE u.email = 'admin@example.org'
   ON CONFLICT DO NOTHING;
   ```
3. Verify admin can complete password + OTP login; remove temp DB access; rotate operator credentials.
4. Implement document/phase/report routes reusing `requireDocumentAccess` / `requireProjectManager` — do not duplicate SQL policy in controllers; do not trust frontend permissions or JWT claims.
5. Add DB-backed integration tests per capability matrix (401 missing/invalid token; 403 insufficient capability; cross-project ID tampering denied; admin bypass; PM isolation; membership revocation immediacy; non-leaking 404s).
6. Update `PMS_APP_SPEC.md §15` once Module 2 endpoint contracts settle.

---

## Appendix A — document history

The 2026-09-07 `AUTHENTICATION_AUTHORIZATION_STATUS.md` and 2026-09-09
`AUTHORIZATION_PROGRESS.md` snapshots were removed; this file replaces both.
Their only still-relevant caveat was that project guards had not been wired,
which §3 now records as done.

`PMS_APP_SPEC.md` §§4–5/9–13 contain legacy prototype contracts
(`/api/login`, numeric ids, `System Analyst` roles); see `PMS_APP_SPEC.md §15`
for the active contract.
