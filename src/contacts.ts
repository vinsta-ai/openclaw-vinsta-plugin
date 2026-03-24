import { readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type VinstaContact = {
  handle: string;
  name?: string;
  nickname?: string;
  notes?: string;
  addedAt: string;
  lastContactedAt?: string;
};

export function getContactsFilePath(): string {
  return join(homedir(), ".openclaw", "vinsta-contacts.json");
}

export async function readContacts(): Promise<VinstaContact[]> {
  try {
    const raw = await readFile(getContactsFilePath(), "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function writeContacts(contacts: VinstaContact[]): Promise<void> {
  const filePath = getContactsFilePath();
  const tmpPath = filePath + ".tmp";
  await writeFile(tmpPath, JSON.stringify(contacts, null, 2) + "\n", "utf8");
  await rename(tmpPath, filePath);
}

export function upsertContact(
  contacts: VinstaContact[],
  partial: Partial<VinstaContact> & { handle: string },
): VinstaContact[] {
  const normalizedHandle = partial.handle.toLowerCase().replace(/^@/, "");
  const index = contacts.findIndex(
    (c) => c.handle.toLowerCase() === normalizedHandle,
  );

  if (index >= 0) {
    const existing = contacts[index];
    const merged: VinstaContact = {
      ...existing,
      ...Object.fromEntries(
        Object.entries(partial).filter(([, v]) => v !== undefined),
      ),
      handle: normalizedHandle,
    };
    const updated = [...contacts];
    updated[index] = merged;
    return updated;
  }

  const newContact: VinstaContact = {
    handle: normalizedHandle,
    name: partial.name,
    nickname: partial.nickname,
    notes: partial.notes,
    addedAt: new Date().toISOString(),
    lastContactedAt: partial.lastContactedAt,
  };

  return [...contacts, newContact];
}

export function removeContact(
  contacts: VinstaContact[],
  handle: string,
): VinstaContact[] {
  const normalizedHandle = handle.toLowerCase().replace(/^@/, "");
  return contacts.filter(
    (c) => c.handle.toLowerCase() !== normalizedHandle,
  );
}

export function searchContacts(
  contacts: VinstaContact[],
  query: string,
): VinstaContact[] {
  const lowerQuery = query.toLowerCase();
  return contacts.filter((c) => {
    return (
      c.handle.toLowerCase().includes(lowerQuery) ||
      (c.name && c.name.toLowerCase().includes(lowerQuery)) ||
      (c.nickname && c.nickname.toLowerCase().includes(lowerQuery)) ||
      (c.notes && c.notes.toLowerCase().includes(lowerQuery))
    );
  });
}
