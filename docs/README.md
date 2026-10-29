# DHIS2-PT

DHIS2-PT is a project management application with a React/Vite frontend and a
TypeScript/Express authentication service.

## Project layout

| Directory | Purpose | Local URL |
| --- | --- | --- |
| `vite-2` | React frontend served by Vite | http://localhost:5173 |
| `auth-server` | Express authentication and authorization API | http://localhost:5000 |
| `drizzle` | PostgreSQL schema and Drizzle configuration | No standalone server |

The frontend sends `/api` requests through the Vite development proxy to the
auth service on port `5000`.

## Prerequisites

- Node.js 18 or newer
- npm
- PostgreSQL
- An existing database whose connection string can be supplied as
  `DATABASE_URL`

For local OTP email testing, either Docker with Mailpit or the auth service's
development-only file mailbox can be used.

## First-time setup

### 1. Configure PostgreSQL

Create or obtain a PostgreSQL database, then make sure the auth service schema
has been applied. The repository currently provides the Drizzle schema
definitions but does not include a migration command in the root project.

Apply the migrations in `drizzle/drizzle/` to the target database in
filename order — including `20260909103000_authorization_foundation`,
`20260911100000_project_membership_constraints`,
`20260914000000_phase_engine`, `20260915000000_document_requirements`, and
`20260916000000_requirement_name_case_insensitive` — before relying on the
project/authorization routes. Then verify tables, permissions, and role
grants. The first administrator must be bootstrapped via controlled SQL
(public registration creates Team Member accounts only); see
`AUTHENTICATION_AUTHORIZATION_CURRENT.md §5` for the procedure.

The connection string should have this form:

```text
postgresql://<user>:<password>@localhost:5432/<database>
```

### 2. Configure the auth service

In a terminal, from the repository root:

```bash
cd auth-server
copy .env.example .env       # Windows PowerShell
# cp .env.example .env       # macOS/Linux
```

Edit `auth-server/.env` and set at least:

```dotenv
DATABASE_URL=postgresql://<user>:<password>@localhost:5432/<database>
JWT_SECRET=replace_with_a_long_random_value
JWT_REFRESH_SECRET=replace_with_another_long_random_value
FRONTEND_URL=http://localhost:5173
ALLOWED_ORIGINS=http://localhost:5173
```

Install the dependencies:

```bash
npm install
```

### 3. Configure the frontend

The frontend does not require an environment variable for local development.
Its Vite configuration already proxies `/api` requests to
`http://localhost:5000`.

Install its dependencies from a second terminal:

```bash
cd vite-2
npm install
```

## Start the project

Run the auth service and frontend in separate terminals.

**Terminal 1 - auth service**

```bash
cd auth-server
npm run dev
```

**Terminal 2 - frontend**

```bash
cd vite-2
npm run dev
```

Open http://localhost:5173 in a browser. Verify that the backend is running by
opening http://localhost:5000/api/health; it should return a JSON response with
`"status":"ok"`.

## OTP email for local development

The auth service requires an OTP after password login. Choose one of these
development options in `auth-server/.env`.

### File mailbox (no Docker required)

```dotenv
OTP_EMAIL_PROVIDER=file
```

OTP messages are written to `auth-server/.local-mailbox`. This option is for
development only and is rejected in production.

### Mailpit

Start Mailpit:

```bash
docker run --name dhis2-pt-mailpit -p 1025:1025 -p 8025:8025 axllent/mailpit
```

Configure the SMTP provider:

```dotenv
OTP_EMAIL_PROVIDER=smtp
SMTP_HOST=127.0.0.1
SMTP_PORT=1025
SMTP_FROM_EMAIL=no-reply@localhost
```

Open http://localhost:8025 to view locally delivered OTP messages.

For a real email provider, configure `OTP_EMAIL_PROVIDER=resend`,
`RESEND_API_KEY`, and `RESEND_FROM_EMAIL` instead.

## Google Drive integration

Drive is configured in `auth-server/.env`. See `DRIVE_ENV_SETUP.md` for how to
create the OAuth or service-account credentials, find the Shared Drive/folder
IDs, and verify the setup. Use `DRIVE_DISABLED=true` to run locally without
Drive credentials. `DRIVE_API_TESTING.md` covers the endpoint test matrix.

## Password reset

The login page includes a password reset flow. Reset tokens are stored only as
SHA-256 hashes, expire after 60 minutes by default, and are invalidated after
one use or when a newer reset is requested. Successfully changing a password
also revokes all of the account's active refresh-token sessions. Configure
`PASSWORD_RESET_EXPIRY_MINUTES` to change the lifetime. Reset messages use the
same Resend, SMTP, or development-only file mailbox provider as login OTP
messages.

## Useful commands

### Auth service

```bash
cd auth-server
npm run dev        # development server with reload
npm run typecheck  # TypeScript validation
npm run build      # compile to dist/
npm start          # run the compiled service
npm run lint       # lint source files
```

### Frontend

```bash
cd vite-2
npm run dev        # Vite development server
npm run build      # type-check and production build
npm run preview    # preview the production build
npm run lint       # lint source files
```

## Troubleshooting

- **The frontend cannot reach the API:** make sure the auth service is running
  on port `5000`. The proxy target is configured in `vite-2/vite.config.ts`.
- **The auth service exits with a missing `DATABASE_URL` error:** create
  `auth-server/.env` from `.env.example` and set a valid PostgreSQL URL.
- **Login does not deliver an OTP:** use the file mailbox or start Mailpit as
  described above, then restart the auth service after changing `.env`.
- **Port already in use:** change `PORT` in `auth-server/.env` and update the
  frontend proxy target in `vite-2/vite.config.ts` to match.
- **API returns `401`:** missing/expired/invalid access token — sign in again
  via `POST /api/auth/login` → `POST /api/auth/verify-otp`. See
  `AUTHENTICATION_AUTHORIZATION_CURRENT.md §2`.
- **API returns `403`/`404` on a project/document route:** insufficient
  capability (`403` global) or non-leaking `404` for out-of-scope resources —
  check global permissions, project membership/manager assignment, and that
  the authorization migrations were applied. See
  `AUTHENTICATION_AUTHORIZATION_CURRENT.md §3`.
- **Active endpoint reference:** `PMS_APP_SPEC.md §15`
  (`/api/auth/*`, `/api/admin/*`, `/api/projects`, `/api/users`,
  `/api/projects/:projectId/phases/*`,
  `/api/projects/:projectId/requirements/*`); document upload,
  requirement status aggregation, publish, report, and Drive endpoints are
  not yet implemented.
