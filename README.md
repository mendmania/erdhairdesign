# ERD Hair Design

A complete first version of a single-calendar hair salon website. It includes a responsive customer website, a four-step booking flow, verified accounts, and an admin workspace. Built with native JavaScript, CSS, Node.js, and SQLite, with no runtime packages to install.

## Run locally

Use Node.js **22.16 or newer**. SQLite is bundled with Node; on Node 22 it prints an experimental-feature notice.

```sh
npm run dev
```

Open [localhost:3000](http://localhost:3000). The SQLite database is created automatically in `data/salon.sqlite`. `npm start` runs the server without file watching. Refresh the browser after frontend edits.

Copy `.env.example` to `.env` to customize configuration. Defaults are EUR, Europe/Belgrade salon time, and a local-only server at `127.0.0.1:3000`. The services, prices, and weekly hours are starter content; edit prices and hours in the admin workspace before using the app with clients. The salon photo is a remote Unsplash placeholder, and fonts load from Google Fonts.

## Your admin account

1. Use **Sign in → Create an account** to register.
2. Verify your email. With no email provider configured in development, the verification dialog clearly displays a local test code; **no email is sent**.
3. Grant your verified account admin access from the repository:

   ```sh
   npm run admin -- your@email.com
   ```

4. Refresh the browser, then choose **Salon admin** in the footer or **Your account → Salon workspace**.

There are no default accounts, shared admin passwords, or public admin registration endpoints. The command requires local database access and will not grant access to an unverified account.

## Booking behavior

- **Step 1:** choose a service; prices and duration are visible up front.
- **Step 2:** choose a date, available time, and an optional repeat interval.
- **Step 3:** create an account or sign in, verify email, and provide a name, phone number, and optional notes.
- **Step 4:** review the agreed price and submit. Pay at the salon; there is no online payment collection.
- A client may have **one pending or confirmed appointment** at a time. The server and a SQLite unique index enforce this.
- The salon has **one shared calendar**. Pending and confirmed appointments both reserve their entire duration, preventing overlaps even across different services.
- The first **two manually approved appointments** are reviewed by the admin. Approval is counted when the admin approves the request; cancelling later does not subtract that approval. After two approvals, later in-hours requests confirm automatically by default.
- The admin can turn automatic approval off, change the threshold, or use **0** to skip initial manual approvals. Rule changes apply to new requests.
- **Outside-hours appointments** use each service’s separate outside-hours price. They require manual approval by default, even for returning clients; that rule can also be disabled.
- Weekly shifts determine regular availability. Requests outside shifts—including closed days—are available only inside the admin’s configurable request window. The whole service must fit. Time slots start every 30 minutes, up to 90 days ahead, in the salon timezone.
- All appointment prices are calculated by the server. If a price changes during checkout, the client must return to date selection and accept the new price.
- Clients can check statuses and cancel in **My visits**. Admins can approve, decline, cancel, and mark confirmed visits complete after their end time. Expired appointments remain visible for the admin to resolve or the client to cancel.

### Repeating visits

A repeat is one active appointment, renewed **after the admin marks the previous visit complete**. Supported intervals are 1, 2, 4, 6, or 8 weeks. Each renewal uses the same weekday, time, service, and notes, and follows the current approval rules.

Future repeats do not reserve an entire series of slots in advance. If the next slot conflicts, working hours no longer allow it, or the price changes, renewal pauses with an explanation on the completed visit. The client can then make a new booking. Cancelling the active appointment stops its repeat schedule. Late completion skips elapsed occurrences and schedules the next future occurrence.

## Live email and production

For the existing k3s server that hosts `rruge.com`, use the [salon k3s deployment runbook](infra/k3s/README.md). It includes a pinned Docker image build, persistent SQLite storage, health checks, and an additive route through the shared Caddy edge. Deployment is prepared but has not been applied; the hostname, authorized cluster access, and Brevo credentials are still needed.

Email verification uses the [Brevo transactional email API](https://developers.brevo.com/reference/send-transac-email). In Brevo, enable transactional email, verify your sender and authenticate its domain, then create an **API key** under **SMTP & API → API Keys**. This integration uses the HTTP API, so an SMTP key or SMTP password is not needed. Add these values to the git-ignored `.env` file:

```dotenv
NODE_ENV=production
APP_URL=https://your-salon-domain.com
BREVO_API_KEY=your_brevo_api_key
EMAIL_FROM=ERD Hair Design <bookings@your-salon-domain.com>
HOST=127.0.0.1
PORT=3000
DATABASE_PATH=./data/salon.sqlite
```

Run `npm start` behind an HTTPS reverse proxy on that domain. Production fails to start without an HTTPS `APP_URL`, sender, and API key. Verification codes are never returned to the browser or printed in production. Live provider delivery requires your configuration and has not been exercised with real emails in this repository.

`EMAIL_FROM` accepts `ERD Hair Design <bookings@your-salon-domain.com>` or a plain verified sender address. Once `BREVO_API_KEY` is set, development also sends real verification emails through Brevo and stops displaying local test codes. Restart the server after updating `.env`. Delivery errors leave the account unverified so the client can retry using **Send again**.

Use persistent storage for the SQLite database and back it up. Run a single application instance for this starter. Built-in rate limits use the direct connection address by default. The k3s package enables `TRUST_PROXY=true` only with its isolated ingress and Caddy configuration, which overwrites `X-Erd-Client-IP` with the client address. Leave this setting false for direct/public application listeners.

Passwords use salted scrypt hashes. Sessions use random, hashed server-side tokens with HttpOnly, SameSite cookies and Secure cookies in production. Verification codes expire after 10 minutes, allow five attempts, and have a one-minute resend cooldown. Mutations enforce origin checks; admin endpoints enforce role and verification server-side. Booking creation and changes use SQLite transactions.

This initial scope includes **verification email only**. Appointment updates are displayed in My visits; automated appointment emails, password recovery, multiple stylists, holidays/date-specific shift overrides, and payments can be added later. Replace starter branding, imagery, and service content with the salon’s real details before launch.

## Verification

```sh
npm run check
npm test
```

The tests cover HTTP registration/sign-in/sign-out, email verification limits, Brevo request formatting and delivery failures, permissions, price updates, conflicts, the two-approval threshold, repeat renewal and pause behavior, cancellation, timezone/DST handling, and production configuration. Tests use isolated in-memory databases, mocked email delivery, and local temporary HTTP ports; no real emails are sent. In a restrictive sandbox, permit local listening ports to run the API tests.

The customer registration-to-booking flow and admin approval/settings screens were also checked in the browser, with a 390px mobile layout and no horizontal overflow.

## Files

```text
server.mjs             HTTP server, API routes, security headers, static assets
lib/store.mjs          SQLite schema and starter data
lib/auth.mjs           Passwords, sessions, registration, email verification
lib/booking.mjs        Availability, bookings, repeat rules, settings validation
public/index.html     Website shell
public/app.js         Customer flow, account dialogs, admin workspace
public/style.css      Responsive design and reduced-motion-aware animations
scripts/admin.mjs     Local-only admin promotion command
tests/                Domain and HTTP integration tests
```
