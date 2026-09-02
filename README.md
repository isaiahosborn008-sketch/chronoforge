# ChronoForge

A steel-and-bronze clockwork project planner built for your Android tablet. Two views:

- **Day Planner** — a vertical day timeline on the left, an item tray on the right. Create items with a duration and drag them onto the timeline to block out your day/week.
- **Projects** — multi-day project management. Set deadlines, break work into steps with estimated hours, mark steps off, log time, and organize projects into folders (Personal, School, or your own).

Everything is stored locally on the tablet (no account needed, works offline). Google Calendar sync is optional and needs a one-time setup (see below).

This is a **PWA** (Progressive Web App) — a set of web files, not a pre-built `.apk`. That gives you three ways to get it onto your tablet, from quickest to most "app-like."

---

## Option A — Fastest: just open it (good for trying it out)

1. Copy the whole `chronoforge` folder onto your tablet (USB transfer, or a cloud drive/Send-to-device).
2. Open `index.html` with Chrome on the tablet (long-press it in a file manager → Open with → Chrome).

This works immediately, but Chrome restricts a couple of things when a page is opened straight from a file: it won't install as an offline app icon, and Google Calendar sign-in **will not work** (Google requires a real https address). Use Option B for the full experience.

---

## Option B — Recommended: install it as a real app icon (PWA)

This gets you an app icon on the home screen, full-screen (no browser bar), offline use, and working Google Calendar sync. It takes about 5 minutes and is free.

1. **Host the files somewhere with https.** The easiest free option is GitHub Pages:
   - Create a free GitHub account if you don't have one, and a new repository (e.g. `chronoforge`).
   - Upload all the files in this folder to that repository (drag-and-drop works on github.com, or use `git push`).
   - In the repo, go to **Settings → Pages**, set Source to the `main` branch, root folder, and save. GitHub gives you a URL like `https://yourname.github.io/chronoforge/`.
   - (Any static host works the same way — Netlify, Vercel, Cloudflare Pages, etc. — GitHub Pages is just free and simple.)
2. On the tablet, open that URL in **Chrome**.
3. Tap the **⋮** menu → **Add to Home screen** (Chrome may also show an automatic "Install app" banner).
4. Launch ChronoForge from the home screen icon — it opens full-screen like a native app and keeps working without internet.

## Option C — A true installable `.apk` file (for "sideloading" in the strictest sense)

If you specifically want an `.apk` file to install like any other sideloaded Android app:

1. Complete Option B first (you need the https URL).
2. Go to **[pwabuilder.com](https://www.pwabuilder.com)**, paste your GitHub Pages URL, and click "Start."
3. PWABuilder scores your PWA (manifest + service worker are already included) and lets you **Package for Android** → download a signed `.apk`.
4. Transfer that `.apk` to your tablet and install it (you may need to allow "Install unknown apps" for your file manager/browser in Android Settings).

---

## Setting up Google Calendar sync (optional)

The app can pull your real Google Calendar events onto the timeline (shown as dashed blocks) as a read-only, one-way sync. Because this is your own self-hosted app rather than a published one, Google requires you to create your own free OAuth credential:

1. Go to **[console.cloud.google.com](https://console.cloud.google.com)** and create a new project (any name).
2. **APIs & Services → Library** → search "Google Calendar API" → Enable.
3. **APIs & Services → OAuth consent screen** → choose **External**, fill in the required fields (app name, your email), and add your own Google account as a **Test user**.
4. **APIs & Services → Credentials → Create Credentials → OAuth client ID** → Application type **Web application**.
5. Under **Authorized JavaScript origins**, add your hosted URL from Option B (e.g. `https://yourname.github.io`) — no trailing slash or path.
6. Copy the generated **Client ID** (looks like `xxxxx.apps.googleusercontent.com`).
7. In ChronoForge, open **Settings** (gear icon, top right) → paste the Client ID under Google Calendar Sync → **Connect & Sync**.

Google Calendar sync only works when the app is opened from that https address — it will refuse to run from a local file or from an installed `.apk` package's own origin. If you went with Option C, keep using the Option B URL in your regular browser whenever you want to sync; the installed app icon can still be used for offline planning.

---

## Using the app

**Day Planner**
- Use the arrows or the week strip to pick a day.
- Tap **+** next to "Unscheduled Items" to add something with a name and duration.
- Drag an item by its grip handle (⠿) from the tray onto the timeline to block out time for it. Drag an existing block to move it; drag its bottom edge to resize.
- "Top Priority" auto-lists your most urgent project steps (see below) with a quick **+** to drop them straight into the tray.

**Projects**
- **+ New Project** to create one, assign it to a folder, and set a deadline.
- Add steps with an estimated number of hours. Check a step off when it's done, or tap **+ Log** to log time manually.
- Tap the ⏱ on a step to push it into today's tray so you can drag it onto your timeline.
- **If you block out time for a step and that time passes**, ChronoForge automatically logs it against the step — no manual entry needed. The step's progress bar and logged hours update on their own.
- Each project shows a glowing priority LED — blue/green (on track), amber (urgent — needs several hours/day to hit the deadline), or red/pulsing (overdue) — calculated from remaining estimated hours vs. days left until the deadline.

**Folders**
- Manage Folders (Projects view) to rename, recolor, add, or remove folders like Personal / School / anything else you need.

---

## Notes

- Data lives in the browser's local storage on that specific device/installation. It is private to the tablet and is not backed up automatically — if you reinstall or clear browser data it will be lost, so it's worth occasionally exporting (Settings, or a browser backup) if this becomes something you rely on daily.
- Because it's a single self-contained set of files, it's easy to hand off, re-host, or extend later.
