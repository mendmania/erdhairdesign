# ERD Hair Design

A complete first version of a single-calendar hair salon website. It includes a responsive customer website, a four-step booking flow, guest reservations, verified accounts, and an admin workspace. Built with native JavaScript, CSS, Node.js, and SQLite, with no runtime packages to install.

## Run locally

Use Node.js **22.16 or newer**. SQLite is bundled with Node; on Node 22 it prints an experimental-feature notice.

```sh
npm run dev
```

Open [localhost:3000](http://localhost:3000). The SQLite database is created automatically in `data/salon.sqlite`. `npm start` runs the server without file watching. Refresh the browser after frontend edits.

Copy `.env.example` to `.env` to customize configuration. Defaults are EUR, Europe/Belgrade salon time, and a local-only server at `127.0.0.1:3000`. The services, prices, and weekly hours are starter content; configure the service menu and hours in the admin workspace before using the app with clients. The salon photo is a remote Unsplash placeholder, and fonts load from Google Fonts.

The supplied **01-modern** brand set is stored unchanged in `public/brand`. The website uses the black horizontal logo in its header/footer, the stacked black logo in account dialogs, and the white mark on the booking photo. Supplied favicons, Apple touch icon, and app icons are wired into the page and `site.webmanifest`. Social previews use the supplied light sharing image, with absolute URLs generated from `APP_URL`; no deployment hostname is hardcoded. The alternate white logos, dark sharing image, and social profile image are retained for later use. These supplied assets contain branding, not salon photography.

## Languages

Use the **EN · English / SQ · Shqip** selector in the header. The choice is remembered in this browser; new visitors start in Albanian (Shqip), regardless of browser language. An explicitly saved English choice is respected. New team email settings and email requests without a language also default to Albanian; existing team email preferences are preserved. Booking, accounts, the studio, admin operations, validation messages, and verification emails support both languages. Switching languages keeps the selected appointment and unsaved form values.

Admins can enter optional Albanian service names and descriptions in **Services & prices**. Empty translations fall back to the original service text. Untouched starter services receive Albanian translations during migration; custom content is preserved. New bookings snapshot both service names so later edits do not change appointment history. Client names, notes, contact details, and custom vacation labels remain as entered.

UI translations are in `public/locales/sq.js`. The `h` template helper translates static copy and keeps interpolated data opaque; canonical service categories, role names, IDs, and API values remain unchanged. Date formatting includes a fallback for embedded browsers without Albanian locale data. Verification email language follows the language selected when a code is requested. Client confirmation emails retain the reservation language, including renewed repeats; team emails use the super admin’s email language setting.

## Your admin account

The verified account **mendmania@gmail.com** is the protected super admin. Other admins cannot see this account in the registered-client list; administrator and notification-recipient lists are visible only to the super admin. Existing verified accounts with that email are promoted automatically on startup; a new account must verify its email before receiving this role. Refresh after deployment, sign in, and open **Salon admin** in the footer or [the admin workspace](https://tregubio.com/admin).

Only the super admin sees **Administrators** and can grant or revoke admin access for other registered, verified users. Access changes invalidate that person's existing sessions; they sign in again to use their new role. The owner cannot be removed, demoted, or have its identity changed through the application. SQLite triggers also reject ordinary deletion/demotion queries. These protections do not supersede an infrastructure operator who can replace code or alter the database schema.

Administrators can manage:

- **Navigation and forms:** desktop navigation groups daily work and salon settings; phones use a section picker and appointment-view selector with counts. Date selection shows visits on that date; searching from Today searches all visits. Phone search ignores spacing and punctuation. Unsaved hours, rules, email language, time-off entries, and administrator email entries survive section changes and the panel’s Refresh button, with a **Reset changes** control. Drafts stay only in memory and are cleared by a browser reload or signing out. Save buttons remain reachable while scrolling.
- **Manual reservations:** choose **New reservation** from any workspace section. Search for a registered client by name, email, or phone, or enter only a guest’s name. Phone and email are optional under **Add contact details**; adding email sends a confirmation. Choose a service, date, available time, and optional notes; the total stays visible above **Confirm reservation**. The reservation is immediately confirmed, blocks the shared calendar, and can be cancelled or completed like any other visit. No account or email verification is needed for a guest; existing-account bookings appear in **My visits** and count as a manual approval. These are one-off visits, respect hours/time off/prices, and retain the one-active-visit limit for registered accounts.
- **Notifications:** each administrator has an unread badge and an inbox for new reservations (including renewed repeats) and cancellations. **View reservation** opens the exact appointment, including cancelled visits. Read status is personal; marking all read leaves later arrivals unread. The panel refreshes alerts every 30 seconds while visible.
- **Reservation emails:** every verified administrator receives an email for each new reservation, including manual bookings they create and renewed repeats. This is automatic for existing and newly added administrators, regardless of older recipient selections. Pending requests include a large **Confirm reservation** button that opens the exact reservation in the admin workspace. Sign in if needed and choose **Approve** to confirm and email the client. Already-confirmed reservations use **View reservation**. Cancellation emails go to the other verified administrators. The super admin can choose the team email language and retry failed delivery in **Notifications → Email notification settings**. Clients and guests who provide an email receive a confirmation when a request is approved or a reservation is immediately confirmed (including manual and automatically approved repeat bookings). Admin-created guests without an email receive no client email. Guest confirmation emails link to the studio and explain how to request changes through the salon; account confirmations link to My visits. Confirmation means the appointment is secured; it does not mark the visit completed.
- **Appointments:** start with today’s schedule or jump to requests, visits ready to complete, upcoming visits, and history. Search by client, email, phone, or service and filter by date. Client contact links and notes are visible on each appointment. Declines, cancellations, and completion of repeating visits have a confirmation step.
- **Working hours:** the shared salon's weekly shifts and optional outside-hours request window. Copy Monday to Tuesday–Friday, then save to apply the changes.
- **Time off:** inclusive date ranges for vacations, holidays, or single days. Time off blocks every new booking, including outside-hours requests. Existing active appointments must be resolved first; they are never silently cancelled.
- **Services & prices:** add, edit, or remove services, with duration, category, description, and separate in-hours/outside-hours prices. Removed services disappear from the menu; existing appointments retain their agreed details and history. Starter services are not restored on restart.
- **Booking rules:** automatic approval, the initial approval count, and outside-hours review.

There are no default accounts or shared admin passwords. For local database maintenance, `npm run admin -- your@email.com` still promotes a verified account; it preserves the protected owner's super-admin role. The site uses one shared salon calendar, not individual stylist calendars.

## Booking behavior

- **Step 1:** choose a service; prices and duration are visible up front.
- **Step 2:** choose a date, available time, and an optional repeat interval.
- **Step 3:** book as a guest with name and email (phone and notes optional), or create/sign in to an account and verify its email. Guest details remain filled when moving between steps or changing language. Passwords may contain 6–200 characters, with no composition requirement.
- **Step 4:** review the agreed price and submit. Pay at the salon; there is no online payment collection.
- A registered client may have **one pending or confirmed appointment** at a time. The server and a SQLite unique index enforce this.
- Public guest requests always need admin approval, even when auto-approval is enabled. They are one-off bookings, do not create an account, and are limited to one active guest reservation per email. The public endpoint is rate-limited to 10 requests per 15 minutes per client address. Guests contact the salon to change or cancel; matching an existing account email does not grant access to that account.
- The salon has **one shared calendar**. Pending and confirmed appointments both reserve their entire duration, preventing overlaps even across different services.
- The first **two manually approved appointments** are reviewed by the admin. Approval is counted when the admin approves the request; cancelling later does not subtract that approval. After two approvals, later in-hours requests confirm automatically by default.
- The admin can turn automatic approval off, change the threshold, or use **0** to skip initial manual approvals. Rule changes apply to new requests.
- **Outside-hours appointments** use each service’s separate outside-hours price. They require manual approval by default, even for returning clients; that rule can also be disabled.
- Weekly shifts determine regular availability. Requests outside shifts—including closed days—are available only inside the admin’s configurable request window. The whole service must fit. Time slots start every 30 minutes, up to 90 days ahead, in the salon timezone.
- All appointment prices are calculated by the server. If a price changes during checkout, the client must return to date selection and accept the new price.
- Clients can check statuses and cancel in **My visits**. Admins can approve, decline, cancel, and mark confirmed visits complete after their end time. Expired appointments remain visible for the admin to resolve or the client to cancel.

### Repeating visits

A repeat is one active appointment, renewed **after the admin marks the previous visit complete**. Supported intervals are 1, 2, 4, 6, or 8 weeks. Each renewal uses the same weekday, time, service, and notes, and follows the current approval rules.

Future repeats do not reserve an entire series of slots in advance. If the next slot conflicts, working hours no longer allow it, the service is removed, the salon is on vacation, or the price changes, renewal pauses with an explanation on the completed visit. The client can then make a new booking. Cancelling the active appointment stops its repeat schedule. Late completion skips elapsed occurrences and schedules the next future occurrence.

## Live email and production

Pushes to `main` run tests, publish immutable salon and deployment images, and request a production release on the generated `salon-production` branch. Flux pulls the request from inside the cluster, takes a database backup, and deploys the application. GitHub verifies the exact revision and public assets before marking production successful. Pull requests only test/build. Activate once with `node scripts/setup-ci.mjs --kubeconfig /path/to/owner-kubeconfig`; see the [automatic release setup](infra/k3s/README.md#automatic-production-releases). No Kubernetes credential or inbound API access is needed by GitHub runners.

For the existing k3s server that hosts `rruge.com`, use the [salon k3s deployment runbook](infra/k3s/README.md). It includes a pinned Docker image build, persistent SQLite storage, health checks, and an additive route through the shared Caddy edge. The verified cluster now has the salon namespace and retained storage foundation. The deployment helper is implemented and the tested AMD64 image is published to GHCR; the app is live at [tregubio.com](https://tregubio.com) through the shared Caddy edge and Cloudflare. Brevo authentication and the sender were validated from k3s; inbox delivery still needs a real registration test.

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

Booking notification jobs are saved in SQLite in the same transaction as the reservation. A background worker uses the existing `BREVO_API_KEY`, `EMAIL_FROM`, and `APP_URL`; no separate email service is needed. Each recipient receives an individual HTML email with an ivory, green and gold design and a plain-text alternative. Reservation emails include the client name, service, salon date/time, status, and a link to the admin workspace, the client’s My visits page, or the public studio page for guests. Account pages require sign-in. Verification emails share the same design. Notes and phone numbers are not included. Failures retry with increasing delays, up to eight attempts; the super admin can inspect queued/failed counts and retry failed emails in **Notifications**. Jobs survive restarts. Delivery rechecks administrator access and skips stale new-reservation emails for cancelled/completed visits and client confirmations for visits that are no longer confirmed. An email already being sent cannot be recalled. When email is unconfigured locally, jobs remain queued and no messages are sent. Email language settings apply to future events. Past inbox items and pre-existing confirmed appointments are not emailed retroactively. Queue counts and retries include both team and client emails.

The worker reuses a stable UUID for each recipient’s [Brevo idempotency key](https://developers.brevo.com/docs/heterogenous-versions-batch-emails). This reduces duplicate sends after short network interruptions; delivery is not guaranteed exactly once after a provider’s deduplication window expires. Provider acceptance is recorded as sent; it does not confirm inbox delivery.

Passwords use salted scrypt hashes. Sessions use random, hashed server-side tokens with HttpOnly, SameSite cookies and Secure cookies in production. Verification codes expire after 10 minutes, allow five attempts, and have a one-minute resend cooldown. Mutations enforce origin checks; admin endpoints enforce role and verification server-side. Booking creation and changes use SQLite transactions.

Email covers verification, administrator reservation/cancellation alerts, and client reservation confirmations. Other appointment updates remain available in My visits; password recovery, multiple stylists, date-specific shift overrides, and payments can be added later. Replace starter branding, imagery, and service content with the salon’s real details before launch.

## Verification

```sh
npm run check
npm test
```

The tests cover guest booking and approval emails, optional admin contact details, email queue migrations, shorter passwords, HTTP registration/sign-in/sign-out, email verification limits, Brevo request formatting and delivery failures, protected-owner migrations, admin delegation and session revocation, service management, vacation conflicts and recurring closures, permissions, price updates, conflicts, the two-approval threshold, repeat renewal and pause behavior, cancellation, timezone/DST handling, and production configuration. Tests use isolated in-memory databases, mocked email delivery, and local temporary HTTP ports; no real emails are sent. In a restrictive sandbox, permit local listening ports to run the API tests.

The customer registration-to-booking flow and admin approval/settings screens were also checked in the browser, with a 390px mobile layout and no horizontal overflow.

## Visual design and mobile booking

The interface takes its charcoal, muted gold and editorial typography direction from Epic Agency. It uses Inter for controls and Bodoni Moda for display headings. Service cards open availability directly; filters appear only for menus larger than six services. Only available times are shown, with explicit week navigation and optional recurring visits in a disclosure.

Main actions and time slots have 52px or larger targets. Form text remains at least 16px to avoid input-triggered mobile zoom; pinch zoom remains available. Mobile booking actions stay in view, and page transitions respect reduced-motion preferences. Update the asset version in index.html and module imports when publishing interface changes so Cloudflare/browser caches pick them up.

## Page URLs and navigation

Pages use `/book`, `/services`, `/studio`, `/appointments`, and `/admin`. Admin sections also have direct links: `/admin/working-hours`, `/admin/time-off`, `/admin/services`, `/admin/booking-rules`, `/admin/notifications`, and `/admin/team`. Each path supports direct loads and browser refresh. Old `/#book` style links are converted in the browser.

Normal internal links use browser history without reloading the document. Back/Forward and opening links in another tab work normally. Booking selections update the relevant controls and summary while retaining the page shell, header, photos and unsaved details. The server uses an explicit page allowlist; unknown pages, assets, and API routes remain 404 responses.

## Files

```text
server.mjs             HTTP server, API routes, security headers, static assets
lib/store.mjs          SQLite schema and starter data
lib/auth.mjs           Passwords, sessions, registration, email verification
lib/booking.mjs        Availability, bookings, repeat rules, settings validation
lib/admin.mjs          Administrator access, vacations, service management
lib/notifications.mjs  Admin inbox, client confirmations, durable email queues and worker
lib/email-templates.mjs Shared premium HTML email layout and verification template
lib/roles.mjs          Reserved owner identity and role checks
public/index.html     Website shell
public/routes.js      Shared page allowlist and clean URL mappings
public/app.js         Customer flow, account dialogs, admin workspace
public/style.css      Responsive design and reduced-motion-aware animations
scripts/admin.mjs     Local-only admin promotion command
tests/                Domain and HTTP integration tests
```
