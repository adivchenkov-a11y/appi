# FlyAPPI helper (userscript)

Userscript for instructors on flyappi.org. It runs inside your own logged-in browser
session and needs a userscript manager:

- iPhone / Mac Safari: **Userscripts** (App Store)
- Chrome / Firefox / Android (Kiwi): **Tampermonkey**

## What it does
Tap 🪂 on any flyappi.org page. Enter one or more license numbers (up to 20), tick the
target level for everyone or per pilot, press **Run**. Missing lower levels are issued
first, in order (APPI 1 → 2 → Dynamic soaring → 3 → 4, SIV → Advanced SIV); online
exams are sent, checklists ticked, and documents (e.g. BESAFE) uploaded from the
pilot's card.

## Install
Open this link in the browser that has the manager and confirm the installation:

https://raw.githubusercontent.com/adivchenkov-a11y/appi/main/userscript/flyappi-helper.user.js

## Updates
The script has `@updateURL` pointing at this repository, so the manager offers a new
version when `@version` here is higher than the installed one.
Tampermonkey checks about once a day; in Userscripts use "check for updates".
