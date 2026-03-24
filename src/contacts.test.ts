import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  upsertContact,
  removeContact,
  searchContacts,
  getContactsFilePath,
  type VinstaContact,
} from "./contacts.js";

describe("getContactsFilePath", () => {
  it("returns a path ending in vinsta-contacts.json inside .openclaw", () => {
    const p = getContactsFilePath();
    assert.ok(p.endsWith(".openclaw/vinsta-contacts.json"), `unexpected path: ${p}`);
    assert.ok(p.startsWith("/"), "path should be absolute");
  });
});

describe("upsertContact", () => {
  const base: VinstaContact[] = [
    { handle: "alice", name: "Alice", addedAt: "2026-01-01T00:00:00.000Z" },
  ];

  it("inserts a new contact when handle is absent", () => {
    const result = upsertContact(base, { handle: "bob", name: "Bob" });
    assert.equal(result.length, 2);
    assert.equal(result[1].handle, "bob");
    assert.equal(result[1].name, "Bob");
    assert.ok(result[1].addedAt);
  });

  it("merges into an existing contact by handle", () => {
    const result = upsertContact(base, { handle: "alice", nickname: "Ali" });
    assert.equal(result.length, 1);
    assert.equal(result[0].name, "Alice");
    assert.equal(result[0].nickname, "Ali");
  });

  it("normalizes handle by lowering case and stripping @", () => {
    const result = upsertContact([], { handle: "@Bob" });
    assert.equal(result[0].handle, "bob");
  });

  it("matches existing contacts case-insensitively", () => {
    const result = upsertContact(base, { handle: "ALICE", notes: "friend" });
    assert.equal(result.length, 1);
    assert.equal(result[0].notes, "friend");
  });

  it("does not overwrite existing fields with undefined", () => {
    const result = upsertContact(base, {
      handle: "alice",
      name: undefined,
      nickname: "A",
    });
    assert.equal(result[0].name, "Alice");
    assert.equal(result[0].nickname, "A");
  });

  it("does not mutate the original array", () => {
    const result = upsertContact(base, { handle: "bob" });
    assert.equal(base.length, 1);
    assert.equal(result.length, 2);
  });

  it("preserves addedAt when merging", () => {
    const result = upsertContact(base, { handle: "alice", notes: "updated" });
    assert.equal(result[0].addedAt, "2026-01-01T00:00:00.000Z");
  });
});

describe("removeContact", () => {
  const contacts: VinstaContact[] = [
    { handle: "alice", addedAt: "2026-01-01T00:00:00.000Z" },
    { handle: "bob", addedAt: "2026-01-01T00:00:00.000Z" },
  ];

  it("removes a contact by handle", () => {
    const result = removeContact(contacts, "alice");
    assert.equal(result.length, 1);
    assert.equal(result[0].handle, "bob");
  });

  it("handles @ prefix and case insensitivity", () => {
    const result = removeContact(contacts, "@BOB");
    assert.equal(result.length, 1);
    assert.equal(result[0].handle, "alice");
  });

  it("returns all contacts if handle not found", () => {
    const result = removeContact(contacts, "charlie");
    assert.equal(result.length, 2);
  });

  it("does not mutate the original array", () => {
    const result = removeContact(contacts, "alice");
    assert.equal(contacts.length, 2);
    assert.equal(result.length, 1);
  });
});

describe("searchContacts", () => {
  const contacts: VinstaContact[] = [
    {
      handle: "sarah-doe",
      name: "Sarah Doe",
      nickname: "girlfriend",
      notes: "designer",
      addedAt: "2026-01-01T00:00:00.000Z",
    },
    {
      handle: "bob-smith",
      name: "Bob Smith",
      addedAt: "2026-01-01T00:00:00.000Z",
    },
    {
      handle: "alice",
      addedAt: "2026-01-01T00:00:00.000Z",
    },
  ];

  it("matches on handle substring", () => {
    const result = searchContacts(contacts, "sarah");
    assert.equal(result.length, 1);
    assert.equal(result[0].handle, "sarah-doe");
  });

  it("matches on name substring", () => {
    const result = searchContacts(contacts, "Smith");
    assert.equal(result.length, 1);
    assert.equal(result[0].handle, "bob-smith");
  });

  it("matches on nickname", () => {
    const result = searchContacts(contacts, "girlfriend");
    assert.equal(result.length, 1);
    assert.equal(result[0].handle, "sarah-doe");
  });

  it("matches on notes", () => {
    const result = searchContacts(contacts, "designer");
    assert.equal(result.length, 1);
    assert.equal(result[0].handle, "sarah-doe");
  });

  it("is case-insensitive", () => {
    const result = searchContacts(contacts, "BOB");
    assert.equal(result.length, 1);
    assert.equal(result[0].handle, "bob-smith");
  });

  it("returns empty array for no matches", () => {
    const result = searchContacts(contacts, "charlie");
    assert.equal(result.length, 0);
  });

  it("can match across multiple contacts", () => {
    const result = searchContacts(contacts, "doe");
    assert.equal(result.length, 1);

    // "a" appears in "sarah-doe", "Sarah Doe", "bob-smith" (no), "alice"
    const resultA = searchContacts(contacts, "a");
    assert.ok(resultA.length >= 2);
  });
});
