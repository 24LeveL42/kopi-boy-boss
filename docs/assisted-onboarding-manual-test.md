# Assisted onboarding: manual test plan

Hand tests for HQ setting up a shop for an owner without Google or email,
and the owner claiming it with one tap. Run them in order. Each step says
what to do and what you should see.

**Rules for this test**

- Use only new drafts whose name starts with **TEST** and a **spare mobile
  number you control** (it needs WhatsApp). Never touch KS Bakery or a real
  merchant. TEST Parata (beatit969) stays as it is.
- The owner's claim gives the test kitchen a real founding number. Run part
  F when no real approvals are expected, and clean up (part H) straight away.
- Write down as you go: the draft id (from the address bar), the claim time
  and the kitchen id.

Placeholders: `<SPARE-MOBILE>` is your spare number (8 digits);
`<DRAFT-ID>` is the draft's id.

---

## A. Install (once)

1. In the Supabase SQL editor, run `docs/supabase-assisted-onboarding.sql`.
   - [ ] It finishes with no error. A "Stopped: …" message means nothing was installed; send it to me.
2. Run `docs/supabase-assisted-onboarding-live-test.sql` with `PUT-ADMIN-ID`
   replaced by your admin user id.
   - [ ] It ends with the error `TEST OK, rolled back: …`. That error means it passed.
   - [ ] If it says `permission denied to set role`, send me the message.
3. Run the live test again.
   - [ ] Same `TEST OK` result: it left nothing behind.
4. Run `select count(*) from public.assisted_shops;`.
   - [ ] `0`.

## B. Boss: create the draft

1. Open Boss and check the sidebar.
   - [ ] **Assisted onboarding** appears below Merchants and addresses.
2. Open it.
   - [ ] "No assisted shops yet" and a **New assisted shop** button.
3. Tap **New assisted shop** and fill in: business name `TEST Assisted Hawker`,
   category Hawker, cuisine Chinese, owner name `Test Owner`, owner mobile
   `+65 <SPARE-MOBILE>` (with spaces), and no UEN, address or postal code.
   - [ ] **Create draft** opens the draft page.
   - [ ] The mobile is saved as 8 digits.
   - [ ] There's no PayNow field anywhere; a note says the owner adds it after claiming.
4. Validation: try each of these on the draft page, one at a time, and tap **Save draft**.
   - [ ] Mobile `71234567`: "Owner mobile must be a Singapore mobile number…"
   - [ ] UEN `12345`: "That UEN doesn't look right…"
   - [ ] Postal code `31012`: "Postal code must be 6 digits."
   - [ ] Empty business name: the form refuses it.
5. Duplicate check: create a second draft with the same `<SPARE-MOBILE>`.
   - [ ] "There's already an open draft for this owner's mobile number…"
6. Back on the list:
   - [ ] The draft shows as **Draft**, with the owner and mobile.
   - [ ] Searching for the owner's name finds it.
7. Stale edit: open the draft in two tabs. Change the description in tab 1
   and save, then change something in tab 2 and save.
   - [ ] Tab 2 says "Not saved: this draft was changed after you opened it…" and offers **Reload the page**.
   - [ ] Nothing was overwritten.

## C. Boss: HQ photo upload (kitchen-photos/assisted/<shop_id>/)

1. On the draft page, use **Shop photo > Upload photo** with a JPG under 5 MB.
   - [ ] The thumbnail appears.
   - [ ] The link box shows `…/storage/v1/object/public/kitchen-photos/assisted/<DRAFT-ID>/<random>.jpg`.
2. Tap **Save draft**.
   - [ ] "Saved."
   - [ ] History shows **Edited the draft** with `hero_image: (empty) → https://…`.
3. In the Supabase dashboard, open **Storage > kitchen-photos > assisted > `<DRAFT-ID>`**.
   - [ ] The file is there.
   - [ ] Nothing new appeared in any kitchen's own folder.
4. Menu: add `Test Noodles`, price `4.50`, and upload a PNG as its photo.
   - [ ] "Added "Test Noodles" to the draft menu."
   - [ ] The photo is in the same `assisted/<DRAFT-ID>/` folder.
5. Refused before upload:
   - [ ] A GIF: "Use a JPG, PNG or WebP photo."
   - [ ] A photo over 5 MB: "That photo is over 5 MB…"
   - [ ] Nothing reaches Storage either time.
6. Refused by the database: make a second draft, `TEST Assisted Photo
   Cancel` (another spare number), and open it in two tabs. Cancel it in tab 1
   with a reason. Then upload a photo in tab 2.
   - [ ] "Upload failed: … row-level security …".
   - [ ] After a reload, tab 1 is read-only with no upload button.
7. After the claim in part F:
   - [ ] The kitchen's photo and the dish photo are the same `assisted/` links.
   - [ ] They show in Partner `/kitchen`, and in the Customer app once the shop is live.
8. Cleanup, in part H: HQ can only add photos, never delete them.

## D. Boss: menu and readiness

1. Add a second item, `Test Hidden`, then tap **Hide**.
   - [ ] It moves to "Hidden: not copied to the shop (1)".
   - [ ] **Show again** brings it back; hide it again.
2. Claim link section (no address or UEN yet):
   - [ ] "Before you can send a link, add:" lists Pickup address, Postal code and Business UEN.
   - [ ] **Create claim link** is greyed out.
3. Fill in the address `Blk 1 Test Lane #01-01`, a **real** postal code (the
   Partner app looks it up on the owner's first save), and UEN `53123456A`. Save.
   - [ ] The list is gone and **Create claim link** is enabled.
4. Home Cook check: change the category to Home Cook, clear the UEN and save.
   - [ ] The list doesn't ask for a UEN.
   - [ ] Set it back to Hawker with UEN `53123456A` and save.

## E. Boss: the claim link

1. Tap **Create claim link**.
   - [ ] A box says "Claim link for Test Owner: shown once" with the link
     `https://partners.kopi-boy.com/claim#<43 characters>` and the expiry (48 hours, Singapore time).
   - [ ] The list below shows one **Live** link, "not sent".
2. Tap **Copy**.
   - [ ] "Copied", and the pasted text is the same link.
3. Tap **Send on WhatsApp to <SPARE-MOBILE>**.
   - [ ] WhatsApp opens to +65 `<SPARE-MOBILE>` with the message filled in: greeting, shop name, link, expiry, "Please don't forward it", and the PayNow line.
   - [ ] Back in Boss: "WhatsApp opened…".
   - [ ] The link row says "sent …"; the history shows **Opened WhatsApp to send the link**.
   - [ ] Send the message to yourself.
4. Tap **Done, hide the link**, then reload the page.
   - [ ] The link is not shown anywhere. Only its row (Live, sent) remains.
5. Replace: tap **Create a new link**, then **Yes, replace the live link**.
   - [ ] A new link is shown once.
   - [ ] The old row is **Revoked** with "(replaced by a new link)".
   - [ ] Opening the old link from step 3 must fail (checked in part F).
6. Revoke: on the live row tap **Revoke**.
   - [ ] **Revoke link** stays greyed out until a reason is typed.
   - [ ] With the reason `test revoke`, the row shows **Revoked (test revoke)**.
7. Create one more link and send it on WhatsApp. This is the one the owner uses.
8. History check, newest first:
   - [ ] Created the draft, edits, items, links created, sent and revoked, each with the admin's name.
   - [ ] The owner mobile appears masked, never in full.
   - [ ] No link, token or hash appears anywhere.

## F. Partner: the owner's claim (after the Partner claim page is built)

Use a phone or a private browser window, **signed out** of Kopi Boy. The
exact wording is up to the Partner page; what matters is the outcome.

1. Open the **old** (replaced) link from E3.
   - [ ] A refusal that says the link is no longer valid and to ask HQ for a new one (status `revoked`).
   - [ ] Nothing about the shop is shown.
2. Open the revoked link from E6.
   - [ ] The same refusal.
3. Open the live link from E7.
   - [ ] The `#…` part disappears from the address bar straight away.
   - [ ] The page shows the shop details HQ entered: name, category, cuisine, halal, photo, address, the mobile masked, and the visible menu only (`Test Noodles`, not `Test Hidden`).
   - [ ] The **full Terms of Use** and **full Privacy Policy** are on the page itself, not just as links, along with the partner terms sentence.
   - [ ] Right above the button, a statement says what tapping means: claiming the shop and agreeing to both.
4. Tap **I acknowledge**.
   - [ ] You are signed in with no Google, email or code.
   - [ ] You land on `/kitchen` with an "Add your PayNow to go live" prompt.
5. Look around `/kitchen` before saving:
   - [ ] The business name, menu, photo and address are what HQ entered.
   - [ ] The partner terms box is ticked and locked.
   - [ ] The PayNow field is empty.
   - [ ] Saving without PayNow is refused.
6. In Boss, open the draft.
   - [ ] Status **Claimed**, with "partner terms acknowledged …" and a link to the merchant's kitchen.
   - [ ] The draft is read-only; the history shows **Owner claimed the shop** with the time, privacy policy `2026-10-v1`, "1 menu item copied" and the device.
7. In Boss, open the merchant's kitchen (Merchants and addresses).
   - [ ] It's listed and not live.
   - [ ] On its edit page, **Live** can't be ticked; the note says the owner hasn't added PayNow yet.
8. Tap the WhatsApp link again on the phone.
   - [ ] A refusal saying the link has already been used (status `used`).
   - [ ] A second tap never makes a second account.
9. On the phone, add a PayNow number in `/kitchen` and save.
   - [ ] The save works and the shop goes live.
   - [ ] The "Your kitchen is live!" pop-up shows on the dashboard.
   - [ ] **Untick Live straight away in Boss.**
10. Boss again:
    - [ ] The kitchen's edit page now allows Live.
    - [ ] Unticking Live and saving works.
11. Rate limit: in another private window, open the claim page with a made-up
    token (`https://partners.kopi-boy.com/claim#AAAA…`, 43 characters) and reload it 11 times.
    - [ ] After 10 tries, a "too many tries, try again later" refusal (status `rate_limited`, HTTP 429).

## G. Not allowed

1. Sign in to Boss with a non-admin account and open `/merchants/assisted`.
   - [ ] "Not authorized".
2. In the Supabase SQL editor, run, as one script:
   `begin; set local role authenticated; select token_hash from public.assisted_claim_tokens; rollback;`
   - [ ] "permission denied for table assisted_claim_tokens". Only the database functions read it.

## H. Cleanup (straight after F)

1. Boss > Partners > **Delete test partner** for `TEST Assisted Hawker`, typing the name.
   - [ ] It removes the subscription, menu, kitchen, application and profile.
2. Supabase Dashboard > **Authentication > Users**: search by the **user id**
   (the kitchen id, also `assisted_shops.claimed_user_id`) and delete the user.
   The email is a random placeholder, so search by id, not email.
3. Storage > kitchen-photos > **assisted > `<DRAFT-ID>`** (and the cancelled
   draft's folder): delete the test photos.
4. Optional: remove the drafts, their items and their links:
   `delete from public.assisted_shops where business_name like 'TEST Assisted%';`.
   The history rows stay; they are append-only by design.
5. Founding number: if the test claim took the highest number, the next real approval reuses it.
   If a real approval came in between, a gap stays.
   - [ ] Check Boss > Subscriptions.
