import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ADMIN_REPLY_MAX_LENGTH,
  badgeLabel,
  countByStatus,
  messagesForView,
  normalizeAdminReply,
  parseInboxView,
  senderRoleLabel,
  type AdminMessageStatus,
} from "./admin-messages.ts";

const msg = (id: string, status: AdminMessageStatus, created_at: string) => ({ id, status, created_at });

const inbox = [
  msg("a", "open", "2026-10-01T08:00:00Z"),
  msg("b", "replied", "2026-10-03T08:00:00Z"),
  msg("c", "open", "2026-10-05T08:00:00Z"),
  msg("d", "closed", "2026-10-02T08:00:00Z"),
];

test("badgeLabel hides the badge when nothing is open", () => {
  assert.equal(badgeLabel(0), null);
  assert.equal(badgeLabel(null), null);
  assert.equal(badgeLabel(undefined), null);
  assert.equal(badgeLabel(-3), null);
  assert.equal(badgeLabel(Number.NaN), null);
});

test("badgeLabel shows the open count and caps at 99+", () => {
  assert.equal(badgeLabel(1), "1");
  assert.equal(badgeLabel(99), "99");
  assert.equal(badgeLabel(100), "99+");
});

test("countByStatus counts each tab, and All is everything", () => {
  assert.deepEqual(countByStatus(inbox), { open: 2, replied: 1, closed: 1, all: 4 });
  assert.deepEqual(countByStatus([]), { open: 0, replied: 0, closed: 0, all: 0 });
});

test("the badge count matches the Open tab count", () => {
  assert.equal(badgeLabel(countByStatus(inbox).open), "2");
});

test("messagesForView filters by tab, newest first", () => {
  assert.deepEqual(messagesForView(inbox, "open").map((m) => m.id), ["c", "a"]);
  assert.deepEqual(messagesForView(inbox, "closed").map((m) => m.id), ["d"]);
  assert.deepEqual(messagesForView(inbox, "all").map((m) => m.id), ["c", "b", "d", "a"]);
});

test("parseInboxView falls back to Open", () => {
  assert.equal(parseInboxView("replied"), "replied");
  assert.equal(parseInboxView(["all", "open"]), "all");
  assert.equal(parseInboxView(undefined), "open");
  assert.equal(parseInboxView("bogus"), "open");
});

test("normalizeAdminReply trims and enforces the 500-character limit", () => {
  assert.equal(normalizeAdminReply("  thanks, sorted  "), "thanks, sorted");
  assert.equal(normalizeAdminReply("   "), null);
  assert.equal(normalizeAdminReply("x".repeat(ADMIN_REPLY_MAX_LENGTH)), "x".repeat(500));
  assert.equal(normalizeAdminReply("x".repeat(ADMIN_REPLY_MAX_LENGTH + 1)), null);
});

test("senderRoleLabel names cooks and riders, everyone else is Partner", () => {
  assert.equal(senderRoleLabel("cook"), "Cook");
  assert.equal(senderRoleLabel("rider"), "Rider");
  assert.equal(senderRoleLabel("picker"), "Partner");
  assert.equal(senderRoleLabel(null), "Partner");
  assert.equal(senderRoleLabel(undefined), "Partner");
});
