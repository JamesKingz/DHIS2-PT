# Drive API Testing Guide (Module 6)

Backend: `auth-server` · Auth model: **service account + Shared Drive** · Drive API v3 via `googleapis`.

## 1. Prerequisites

1. Google Cloud: Drive API enabled; service-account JSON key downloaded.
2. MOH Shared Drive shared with the SA email as **Content Manager**.
3. `auth-server/.env` (never commit the key). See `DRIVE_ENV_SETUP.md` for how
   to obtain each value:
   ```env
   DRIVE_DISABLED=false
   DRIVE_SHARED_DRIVE_ID=<shared-drive-id>
   DRIVE_ROOT_FOLDER_ID=<optional parent folder inside the drive>
   GOOGLE_SERVICE_ACCOUNT_KEY_FILE=./secrets/drive-sa.json
   DRIVE_UPLOAD_MAX_BYTES=52428800
   ```
   Hosted envs can use `GOOGLE_SERVICE_ACCOUNT_JSON_B64` instead of the key file.
   Personal Gmail setups can use the OAuth keys (`GOOGLE_OAUTH_*`) instead.
4. DB migrated: `drizzle/drizzle/20260917000000_drive_folders/migration.sql` applied
   (`drive_folders` table).
5. Server running: `npm run dev` (port 5000 by default).
6. A valid bearer token: `POST /api/auth/login` → `POST /api/auth/verify-otp`
   → use `accessToken` as `Authorization: Bearer <token>`.
   The test user needs `project:view` (reads/uploads) and `phase:manage` (ensure).
   All Drive routes also enforce project membership via `requireProjectAccess`.

Set shell helpers for the examples below:

```bash
BASE=http://localhost:5000
TOKEN=<accessToken>
PID=<projectId>
PHASE=<phaseId>   # from GET /api/projects/$PID/phases
```

## 2. Endpoint matrix

| # | Method | Endpoint | Guard | Purpose |
|---|--------|----------|-------|---------|
| 1 | POST | `/api/projects/:projectId/drive/ensure` | `phase:manage` + PM | Create/verify project root + 7 phase subfolders (idempotent) |
| 2 | POST | `/api/projects/:projectId/drive/upload` (multipart `file` + `phaseId`) | `project:view` + member | Upload into a phase folder |
| 3 | GET | `/api/projects/:projectId/drive/files?phaseId=` | `project:view` + member | List files (one phase or all) |
| 4 | GET | `/api/projects/:projectId/drive/files/:fileId/content` | `project:view` + member | Download/proxy file stream |

## 3. Test sequence (happy path)

### 3.1 Ensure folders (run first)

```bash
curl -s -X POST "$BASE/api/projects/$PID/drive/ensure" \
  -H "Authorization: Bearer $TOKEN" | head -c 2000
```

* First call → `201 { message: "Drive folders created", driveFolderId, folders: [{phaseId, phaseName, driveFolderId}×7], created: true }`.
* Repeat → `200 { message: "Drive folders already linked", ..., created: false }`.
* Verify in the Shared Drive UI: `ProjectName/{Initiation,…,Closure}` exist.
* `folders[].driveFolderId` rows are persisted in `drive_folders`.

### 3.2 Upload a file

```bash
echo "hello drive" > /tmp/hello.txt
curl -s -X POST "$BASE/api/projects/$PID/drive/upload" \
  -H "Authorization: Bearer $TOKEN" \
  -F "phaseId=$PHASE" \
  -F "file=@/tmp/hello.txt;type=text/plain" | head -c 2000
```

* → `201 { message: "File uploaded to Drive", file: { driveFileId, name, mimeType, webViewLink, webContentLink, size } }`.
* Save `driveFileId` as `FID` for the download test.
* `drive.file.uploaded` audit row is written (check `activity_log`).

### 3.3 List files

```bash
# Single phase
curl -s "$BASE/api/projects/$PID/drive/files?phaseId=$PHASE" \
  -H "Authorization: Bearer $TOKEN" | head -c 2000

# All phases
curl -s "$BASE/api/projects/$PID/drive/files" \
  -H "Authorization: Bearer $TOKEN" | head -c 2000
```

* → `200 { files: [{ id, name, mimeType, webViewLink, modifiedTime, size, phaseId }] }`, newest first.

### 3.4 Download

```bash
curl -s -D /tmp/headers.txt -o /tmp/out.txt \
  "$BASE/api/projects/$PID/drive/files/$FID/content" \
  -H "Authorization: Bearer $TOKEN"
cat /tmp/headers.txt
```

* → `200` with `Content-Type`, `Content-Disposition: attachment; filename*=UTF-8''...`, proxied Drive bytes in body.

## 4. Negative / edge cases (with try-catch behavior)

| Test | Request | Expected |
|------|---------|----------|
| Bad project id | `POST /api/projects/not-a-uuid/drive/ensure` | `400 INVALID_RESOURCE_ID` (no Drive call, no quota burn) |
| Unlinked phase | upload with `phaseId` from another project, or before ensure | `404 DRIVE_NOT_LINKED` (non-leaking) |
| Missing file part | upload without `-F file=@…` | `400 VALIDATION_ERROR` (`file is required`) |
| Oversize file | file > `DRIVE_UPLOAD_MAX_BYTES`, or multer limit | `413 FILE_TOO_LARGE` |
| Blocked type | `evil.exe` or `application/x-msdownload` | `400 FILE_TYPE_BLOCKED` |
| Cross-project file id | `GET …/files/<other-project-file>/content` with own `PID` | `404 DRIVE_NOT_FOUND` (parent-chain check) |
| No token | omit `Authorization` | `401 Not authenticated` |
| Non-member | token for user outside the project | `403`/`404` via project guards |
| Drive disabled | `DRIVE_DISABLED=true` | `500 DRIVE_NOT_CONFIGURED` (generic, no key detail) |
| SA unshared / revoked | remove SA from Shared Drive, then ensure | `502 DRIVE_ACCESS_DENIED` |
| Drive deleted manually | delete root in Drive UI, then ensure | next ensure recreates root + missing phases |

Multer-specific: sending 2 files or a wrong field name → `400 VALIDATION_ERROR` (`Send exactly one file in the "file" field`).

## 5. Auto-provision on project creation

`POST /api/projects` triggers best-effort `ensureProjectStructure` after commit:

* Success → new project already has `driveFolderId` + 7 `drive_folders` rows.
* Drive down/misconfigured → project creation still returns `201`; server logs
  `[project:create] Drive provisioning deferred…`; retry via `POST …/drive/ensure`.
* Passing `driveFolderId` manually in the create body skips auto-provision.

## 6. Troubleshooting

* `DRIVE_NOT_CONFIGURED` — check key path exists, `DRIVE_SHARED_DRIVE_ID` set, `DRIVE_DISABLED=false`. Server logs only `keyFileExists`, never key content.
* `DRIVE_ACCESS_DENIED` — re-share the Shared Drive with the SA email; confirm `Content Manager` role.
* `DRIVE_UNAVAILABLE … Retry-After: 60` — quota/rate limit; wait and retry. Responses include `retryAfterSeconds` + `Retry-After` header.
* `DRIVE_NOT_LINKED` after migration — run ensure once per pre-existing project.
* Mid-download socket destroy — Drive stream failed; server already logged `[drive:api:stream]` with status; retry the download.
* Full Google error detail is server-log only (`[drive:<op>] failed…`); clients get stable `{ message, code }`.

## 7. Quick regression checklist

- [ ] ensure → 201 then 200 (idempotent)
- [ ] upload → 201 with `driveFileId` + links
- [ ] list (phase + all) shows the upload
- [ ] download returns exact bytes + headers
- [ ] bad UUID → 400 before any Drive call
- [ ] cross-project file id → 404
- [ ] oversize/blocked → 413/400
- [ ] project creation succeeds with Drive down (deferred + logged)
