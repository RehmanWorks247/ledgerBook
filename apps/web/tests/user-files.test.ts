import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clearUserFileStores,
  entriesFromFiles,
  getUserFileStore,
  readDroppedEntries,
} from "../src/user-files/model";

test("folder moves preserve their children and reject cycles or duplicate names atomically", () => {
  const store = getUserFileStore("admin/org/moves");
  const find = (name: string) =>
    store.getSnapshot().find((node) => node.name === name)!;
  const documents = find("Documents").id;
  const receipts = find("Receipts").id;
  store.createFolder(documents, "2026");
  const year = find("2026").id;
  const receipt = new File(["Receipt"], "Shop.pdf");
  store.importEntries(year, entriesFromFiles([receipt]));

  const before = store.getSnapshot();
  assert.throws(() => store.move(documents, year), /subfolders/);
  assert.throws(() => store.move(year, year), /itself/);
  assert.throws(() => store.move(year, find("Shop.pdf").id), /Choose a folder/);
  assert.throws(
    () => store.createFolder(null, " documents "),
    /already exists/,
  );
  assert.equal(store.getSnapshot(), before);

  store.move(year, receipts);
  assert.equal(find("2026").parentId, receipts);
  assert.equal(find("Shop.pdf").parentId, year);
  store.createFolder(null, "2026");
  assert.throws(() => store.move(year, null), /already exists/);
  assert.equal(find("Shop.pdf").file, receipt);
});

test("folder selections preserve the relative tree and imported name conflicts keep both copies", () => {
  const store = getUserFileStore("admin/org/import");
  function selectedFile(name: string) {
    const file = new File(["data"], name, { lastModified: 123 });
    Object.defineProperty(file, "webkitRelativePath", {
      value: "Documents/2025/" + name,
    });
    return file;
  }
  const file = selectedFile("Invoice.pdf");
  const entries = entriesFromFiles([file, selectedFile("Invoice.PDF")]);
  store.importEntries(null, entries);
  const nodes = store.getSnapshot();
  const renamed = nodes.find((node) => node.name === "Documents (2)")!;
  const year = nodes.find((node) => node.name === "2025")!;
  assert.equal(year.parentId, renamed.id);
  assert.deepEqual(
    nodes.filter((node) => node.parentId === year.id).map((node) => node.name),
    ["Invoice.pdf", "Invoice (2).PDF"],
  );
  const invoice = nodes.find((node) => node.file === file)!;
  assert.equal(invoice.size, 4);
  assert.equal(invoice.modifiedAt, 123);
});

test("drop reads all directory batches including empty subfolders and ordinary files", async () => {
  const file = new File(["Entry"], "entry.txt");
  function directory(name: string, batches: unknown[][]) {
    return {
      name,
      isDirectory: true,
      createReader: () => ({
        readEntries: (callback: (entries: unknown[]) => void) =>
          callback(batches.shift()!),
      }),
    };
  }
  const folder = directory("History", [
    [
      {
        name: file.name,
        isFile: true,
        file: (callback: (f: File) => void) => callback(file),
      },
    ],
    [directory("Drafts", [[]])],
    [],
  ]);
  const transfer = {
    items: [
      { kind: "file", webkitGetAsEntry: () => folder },
      { kind: "file", getAsFile: () => file },
    ],
  } as unknown as DataTransfer;
  const entry = { kind: "file", name: file.name, file };
  assert.deepEqual(await readDroppedEntries(transfer), [
    {
      kind: "folder",
      name: "History",
      children: [entry, { kind: "folder", name: "Drafts", children: [] }],
    },
    entry,
  ]);
  assert.deepEqual(
    await readDroppedEntries({ files: [file] } as unknown as DataTransfer),
    [entry],
  );
});

test("record state survives navigation but is separate for each record and cleared session", () => {
  const key = "admin/org/first";
  const first = getUserFileStore(key);
  first.createFolder(null, "Private");
  const hasPrivate = (recordKey: string) =>
    getUserFileStore(recordKey)
      .getSnapshot()
      .some((node) => node.name === "Private");
  assert.equal(hasPrivate(key), true);
  assert.equal(hasPrivate("admin/org/second"), false);
  assert.equal(hasPrivate("someone-else/org/first"), false);
  clearUserFileStores();
  first.createFolder(null, "Late drop");
  assert.equal(hasPrivate(key), false);
  assert.equal(getUserFileStore(key).getSnapshot().length, 3);
});
