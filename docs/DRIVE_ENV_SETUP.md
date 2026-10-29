# Google Drive Environment Setup (First-Time Walkthrough)

A step-by-step guide for someone who has never configured Google Drive API
access before. It shows exactly where each value in the
`#VALUES FOR DRIVE INTEGRATION` block of `auth-server/.env` comes from.

The backend supports two modes. Follow **one** track end to end:

- **Track A — OAuth (personal Gmail):** easiest, works with a normal My Drive
  folder, no Google Workspace needed.
- **Track B — Service account + Shared Drive:** for Google Workspace
  organisations that want everything owned by a shared drive instead of a
  person.

If you only want to run the app locally without Drive, skip both and set
`DRIVE_DISABLED=true`.

## 0. What you will end up with

| `.env` key | Where it comes from | Looks like |
| --- | --- | --- |
| `DRIVE_DISABLED` | Your choice | `false` or `true` |
| `GOOGLE_OAUTH_CLIENT_ID` | Google Cloud → Credentials → OAuth client | `1234567890-abc123.apps.googleusercontent.com` |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Same OAuth client | `GOCSPX-xxxxxxxxxxxxxxxx` |
| `GOOGLE_OAUTH_REFRESH_TOKEN` | OAuth Playground | `1//04...` (long string) |
| `DRIVE_ROOT_FOLDER_ID` | Google Drive folder URL | `1hRGSKM1koi4_o2JCV0R8Kzpvs75UYamN` |
| `DRIVE_SHARED_DRIVE_ID` | Shared Drive URL | `0AJ...` or similar long ID |
| `GOOGLE_SERVICE_ACCOUNT_KEY_FILE` | Downloaded service-account JSON | path to `.json` |
| `GOOGLE_CLIENT_EMAIL` | `client_email` inside that JSON | `name@project.iam.gserviceaccount.com` |
| `GOOGLE_PRIVATE_KEY` | `private_key` inside that JSON | `-----BEGIN PRIVATE KEY-----\n...` |
| `GOOGLE_SERVICE_ACCOUNT_JSON_B64` | Base64 of the JSON (hosted only) | long `eyJ...` string |
| `DRIVE_UPLOAD_MAX_BYTES` | Your choice | `52428800` (50 MB) |

`GOOGLE_CLIENT_EMAIL` and `GOOGLE_PRIVATE_KEY` are **not read by the server
directly**. They are the `client_email` and `private_key` fields inside the
service-account JSON. Keep them only if another tool needs them; the server
uses `GOOGLE_SERVICE_ACCOUNT_KEY_FILE` or `GOOGLE_SERVICE_ACCOUNT_JSON_B64`.

## 1. Common prerequisite: enable the Google Drive API

Do this once per Google Cloud project, for either track.

1. Sign in to the Google account that will own the credentials.
2. Open <https://console.cloud.google.com/>.
3. At the top of the page, click the project selector and either pick an
   existing project or click **New project**.
   - Name it something like `dhis2-pt`.
   - Click **Create**, then make sure the new project is selected.
4. Open the navigation menu (☰) → **APIs & Services** → **Library**.
5. Search for **Google Drive API** and open it.
6. Click **Enable**. If it already says **Manage**, the API is already on.

> The Drive API must be enabled in the same Cloud project that owns the OAuth
> client or service account. Enabling it in a different project is a common
> first-time mistake.

---

# Track A — OAuth for personal Gmail

This mode uploads files as the Google user who authorises the app. That user
must own (or have edit access to) the Drive folder used for projects.

## A1. Create the OAuth consent screen

1. In the Cloud project, go to **APIs & Services → OAuth consent screen**.
   (Newer consoles show this under **Google Auth Platform**.)
2. If asked, click **Get started** / **Configure consent screen**.
3. Fill in:
   - **App name:** `DHIS2-PT` (anything recognisable)
   - **User support email:** your email
   - **Audience / User type:** `External` for personal Gmail. (`Internal` only
     works inside a Google Workspace organisation.)
   - **Developer contact email:** your email
4. Save. If the console asks for scopes, you can skip adding them here; the
   OAuth Playground will request the Drive scope later.
5. While the app is in **Testing**, only test users you add can authorise it.
   Add your own account under **Audience → Test users**.
6. Publishing status:
   - **Testing** is fine for a quick trial, but refresh tokens expire after
     **7 days**.
   - For long-lived tokens, click **Publish app** / set the app to
     **In production**. A personal-use app requesting only Drive scopes does
     not normally require Google verification.

## A2. Create the OAuth client → `GOOGLE_OAUTH_CLIENT_ID` + `..._SECRET`

1. Go to **APIs & Services → Credentials**.
2. Click **+ Create credentials → OAuth client ID**.
3. Application type: **Web application**.
4. Name: `dhis2-pt-local` (anything).
5. Under **Authorized redirect URIs**, click **+ Add URI** and paste exactly:

   ```text
   https://developers.google.com/oauthplayground
   ```

   This is required so the OAuth Playground can receive the authorisation
   code. If it is missing or has a typo, Google shows
   `Error 400: redirect_uri_mismatch`.
6. Click **Create**. A dialog shows:
   - **Client ID** → copy to `GOOGLE_OAUTH_CLIENT_ID`
   - **Client secret** → copy to `GOOGLE_OAUTH_CLIENT_SECRET`

You can reopen the client later from the Credentials page if you lose the
values. The secret can also be reset there.

## A3. Get the refresh token → `GOOGLE_OAUTH_REFRESH_TOKEN`

The OAuth Playground performs the one-time sign-in and gives you a refresh
token you can reuse from the server.

1. Open <https://developers.google.com/oauthplayground>.
2. Click the **gear icon** (⚙, top right). Set:
   - **OAuth flow:** `Server-side`
   - **Access type:** `Offline` (this is what produces a refresh token)
   - **Use your own OAuth credentials:** checked
   - **OAuth Client ID:** paste your `GOOGLE_OAUTH_CLIENT_ID`
   - **OAuth Client secret:** paste your `GOOGLE_OAUTH_CLIENT_SECRET`
   - Close the settings panel.
3. In the **Step 1 — Select & authorize APIs** box on the left, scroll to the
   bottom to **Input your own scopes** and enter:

   ```text
   https://www.googleapis.com/auth/drive
   ```

4. Click **Authorize APIs**.
5. Sign in with the Google account that owns the Drive folder. If you see
   **Google hasn't verified this app**, click **Continue** (it is your own
   app), then **Allow** the Drive permission.
6. You are redirected back to the Playground. In **Step 2 — Exchange
   authorization code for tokens**, click
   **Exchange authorization code for tokens**.
7. In the response panel, find **Refresh token** and copy it to
   `GOOGLE_OAUTH_REFRESH_TOKEN`.

If you do not see a refresh token:

- Revoke the app at <https://myaccount.google.com/permissions>, then repeat
  from step 2 with **Access type: Offline**.
- Make sure you used the same client ID/secret as the server.
- Re-running the flow while an old grant still exists can omit the refresh
  token; revoking first forces a new one.

The access token shown in the Playground is temporary and is **not** used by
the server. Only the refresh token goes in `.env`.

## A4. Create/get the folder → `DRIVE_ROOT_FOLDER_ID`

1. Open <https://drive.google.com/> signed in as the same account used in
   step A3.
2. Create a folder, for example `DHIS2-PT Projects`.
3. Open the folder. The browser URL is:

   ```text
   https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUvWxYz
   ```

4. Copy the part after `/folders/` (here
   `1AbCdEfGhIjKlMnOpQrStUvWxYz`) to `DRIVE_ROOT_FOLDER_ID`.

The server creates one subfolder per project inside this folder. Because
uploads run as the authorised user, this folder can be in My Drive; no
sharing is needed.

## A5. Resulting `.env` for Track A

```env
DRIVE_DISABLED=false
GOOGLE_OAUTH_CLIENT_ID=1234567890-abc123.apps.googleusercontent.com
GOOGLE_OAUTH_CLIENT_SECRET=GOCSPX-xxxxxxxxxxxxxxxx
GOOGLE_OAUTH_REFRESH_TOKEN=1//04xxxxxxxxxxxxxxxx
DRIVE_ROOT_FOLDER_ID=1AbCdEfGhIjKlMnOpQrStUvWxYz
DRIVE_UPLOAD_MAX_BYTES=52428800
```

Leave `DRIVE_SHARED_DRIVE_ID`, `GOOGLE_SERVICE_ACCOUNT_KEY_FILE`, and
`GOOGLE_CLIENT_EMAIL`/`GOOGLE_PRIVATE_KEY` empty in this mode.

---

# Track B — Service account + Shared Drive

Use this for Google Workspace. A service account is a robot Google account;
it has no My Drive storage, so files must live in a Shared Drive.

## B1. Create the service account

1. In the Cloud project, go to **IAM & Admin → Service Accounts**.
2. Click **+ Create service account**.
3. **Service account name:** `dhis2-pt-drive`. The console fills in an ID like
   `dhis2-pt-drive`; the resulting email will look like
   `dhis2-pt-drive@your-project.iam.gserviceaccount.com`.
4. Click **Create and continue**. You do **not** need to grant project IAM
   roles for Drive access; Drive permissions are granted by sharing the drive.
5. Click **Done**.

Note the service account email shown in the list. This is the value for
`GOOGLE_CLIENT_EMAIL` and the email you will share the Shared Drive with.

## B2. Download the JSON key → `GOOGLE_SERVICE_ACCOUNT_KEY_FILE`

1. Click the service account you just created.
2. Open the **Keys** tab.
3. Click **Add key → Create new key**.
4. Choose **JSON** and click **Create**.
5. A `.json` file downloads automatically. Move it somewhere safe inside the
   server, for example:

   ```text
   auth-server/dhis2-pt-drive-key.json
   ```

6. Set the path relative to the `auth-server` working directory:

   ```env
   GOOGLE_SERVICE_ACCOUNT_KEY_FILE=./dhis2-pt-drive-key.json
   ```

Open the JSON in a text editor. It contains the other two values:

- `client_email` → `GOOGLE_CLIENT_EMAIL`
- `private_key` → `GOOGLE_PRIVATE_KEY` (keep the `\n` sequences and the quotes;
  copy the whole string). These two keys are informational for the server;
  the JSON file is what is actually read.

Never commit this file. It is already ignored if it matches the repo's
`.gitignore` patterns; double-check with `git status`.

### Hosted environment alternative → `GOOGLE_SERVICE_ACCOUNT_JSON_B64`

If the server cannot mount a file (for example some PaaS hosts), base64-encode
the JSON and put the result in `GOOGLE_SERVICE_ACCOUNT_JSON_B64` instead of
using a path.

Windows PowerShell:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes(".\dhis2-pt-drive-key.json"))
```

Linux:

```bash
base64 -w 0 dhis2-pt-drive-key.json
```

macOS:

```bash
base64 -i dhis2-pt-drive-key.json | tr -d '\n'
```

The output must be one continuous string. If the command wraps lines, join
them before pasting.

## B3. Create the Shared Drive → `DRIVE_SHARED_DRIVE_ID`

Requires a Google Workspace account. Personal Gmail cannot create Shared
Drives.

1. Open <https://drive.google.com/>.
2. In the left sidebar, click **Shared drives**. (If you do not see it, your
   account is not a Workspace account or the admin disabled Shared Drives.)
3. Click **+ New** and create one, for example `DHIS2-PT`.
4. Open the Shared Drive. The URL looks like:

   ```text
   https://drive.google.com/drive/u/0/shared-drives/0AJdEfGhIjKlMnOpQrSt
   ```

5. Copy the part after `/shared-drives/` (here `0AJdEfGhIjKlMnOpQrSt`) to
   `DRIVE_SHARED_DRIVE_ID`.

Do **not** use a folder URL (`/folders/...`) here. A folder ID and a Shared
Drive ID are different things and using the wrong one causes
`DRIVE_NOT_FOUND`.

## B4. Share the Shared Drive with the service account

The service account cannot see the drive until it is added as a member.

1. Inside the Shared Drive, click **Manage members** (or the ⚙ / dropdown →
   **Manage members**).
2. In **Add people, groups, or email addresses**, paste the service account
   email from B1 (`dhis2-pt-drive@your-project.iam.gserviceaccount.com`).
3. Set its role to **Content manager**. Viewer/Commenter is not enough; the
   server must create folders and upload files.
4. Uncheck **Notify people** (a robot has no inbox) and click **Share** /
   **Send**.

If this step is skipped, Drive calls fail with `DRIVE_ACCESS_DENIED`.

## B5. Optional root folder → `DRIVE_ROOT_FOLDER_ID`

By default the server creates project folders at the root of the Shared
Drive. To group them inside a folder instead:

1. Create a folder inside the Shared Drive, for example `Projects`.
2. Open it. Copy the ID from
   `https://drive.google.com/drive/folders/<FOLDER_ID>`.
3. Set `DRIVE_ROOT_FOLDER_ID=<FOLDER_ID>`.

The service account inherits access through the Shared Drive membership, so
you do not need to share this folder separately.

## B6. Resulting `.env` for Track B

```env
DRIVE_DISABLED=false
DRIVE_SHARED_DRIVE_ID=0AJdEfGhIjKlMnOpQrSt
DRIVE_ROOT_FOLDER_ID=1AbCdEfGhIjKlMnOpQrStUvWxYz
GOOGLE_SERVICE_ACCOUNT_KEY_FILE=./dhis2-pt-drive-key.json
GOOGLE_CLIENT_EMAIL=dhis2-pt-drive@your-project.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n..."
DRIVE_UPLOAD_MAX_BYTES=52428800
```

Leave `GOOGLE_OAUTH_*` empty in this mode.

---

## 2. Remaining key: `DRIVE_DISABLED`

- `false` — Drive enabled. The server validates credentials on startup in
  production and will refuse to start if required values are missing.
- `true` — Drive disabled. All Drive endpoints return
  `500 DRIVE_NOT_CONFIGURED`. Useful for local development, tests, and demos
  without Google credentials.

## 3. Verify the setup

1. Restart the auth server so it reloads `.env`:

   ```bash
   cd auth-server
   npm run dev
   ```

2. Log in and get an access token:
   `POST /api/auth/login` → `POST /api/auth/verify-otp`.
3. Create a project (`POST /api/projects`), then provision its folders:

   ```bash
   curl -s -X POST "$BASE/api/projects/$PID/drive/ensure" \
     -H "Authorization: Bearer $TOKEN"
   ```

4. Expected first response: `201` with a project folder ID and seven phase
   folders. Calling it again returns `200` with `created: false`.
5. Open Google Drive and confirm the project folder with its seven phase
   subfolders exists.

See `DRIVE_API_TESTING.md` for upload/list/download and negative-case tests.

## 4. First-time mistakes checklist

| Symptom | Likely cause |
| --- | --- |
| `Error 400: redirect_uri_mismatch` | The OAuth client does not list `https://developers.google.com/oauthplayground` exactly. |
| No refresh token in Playground | Access type was not `Offline`, or an old grant exists; revoke access and retry. |
| Works for a week, then `DRIVE_NOT_CONFIGURED` | OAuth consent screen is still in **Testing**; publish the app or regenerate the token. |
| `DRIVE_NOT_CONFIGURED` at startup | Required keys missing, typo in key names, or `DRIVE_DISABLED=true`. |
| `Invalid Drive service-account credentials: failed to parse JSON` | Key path points to the wrong file, or the file was edited/invalid. |
| `Service account key file not found` | Path is relative to `auth-server`, not the repo root. |
| `DRIVE_ACCESS_DENIED` | Service account not added to the Shared Drive, or role below **Content manager**. |
| `DRIVE_NOT_FOUND` | Used a folder ID as `DRIVE_SHARED_DRIVE_ID`, or wrong folder ID. |
| `403` creating folders | Drive API not enabled in the same Cloud project, or the authorising account cannot edit the folder. |
| Service account upload fails but listing works | Service accounts have no My Drive quota; use a Shared Drive or Track A. |
| `401`/`invalid_grant` after regenerating credentials | Old refresh token still in `.env`, or the OAuth client secret was rotated. Update both and restart. |

## 5. Security

- Never commit `auth-server/.env`, the service-account JSON, or OAuth secrets.
- If a secret was pasted into a chat, ticket, or commit, rotate it: reset the
  OAuth client secret and delete/create a new service-account key.
- Prefer `GOOGLE_SERVICE_ACCOUNT_JSON_B64` or a mounted file over a key file
  committed into the source tree.
- Grant the service account the minimum role needed: **Content manager** on the
  Shared Drive.
