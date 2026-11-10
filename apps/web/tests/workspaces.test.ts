import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { setTokenProvider } from "../src/api";
import { WorkspaceFields } from "../src/workspaces/WorkspaceFields";
import { deleteWorkspace, validateWorkspaceFields, workspaceBadgeStyle, workspaceFields } from "../src/workspaces/model";

test("workspace customization normalizes fields and enforces name, description, and color limits", () => {
  const valid = { name: "  Northstar Travel  ", description: "  Northern office  ", color: "#ABCDEF" };
  assert.deepEqual(validateWorkspaceFields(valid), { name: "Northstar Travel", description: "Northern office", color: "#abcdef" });
  assert.throws(() => validateWorkspaceFields({ ...valid, name: "   " }), /Enter a workspace name/);
  assert.throws(() => validateWorkspaceFields({ ...valid, name: "a".repeat(161) }), /160 characters/);
  assert.throws(() => validateWorkspaceFields({ ...valid, description: "a".repeat(1001) }), /1000 characters/);
  assert.throws(() => validateWorkspaceFields({ ...valid, color: "red; background:url(evil)" }), /valid workspace color/);
  assert.equal(validateWorkspaceFields({ ...valid, name: "a".repeat(160), description: "a".repeat(1000) }).name.length, 160);
});

test("workspace badges accept only hex colors and use readable foregrounds", () => {
  assert.deepEqual(workspaceBadgeStyle("#ffffff"), { backgroundColor: "#ffffff", color: "#000000" });
  assert.deepEqual(workspaceBadgeStyle("#000000"), { backgroundColor: "#000000", color: "#ffffff" });
  for (const color of [undefined, null, "url(https://example.com)", "var(--danger)", "#fff", "#ffffff;background:red"]) {
    assert.equal(workspaceBadgeStyle(color), undefined);
  }
});

test("workspace form escapes names and descriptions and exposes only requested customization", () => {
  const html = renderToStaticMarkup(createElement(WorkspaceFields, {
    value: workspaceFields({ name: "<img src=x onerror=alert(1)>", description: "<script>evil</script>" }), onChange() {},
  }));
  assert.match(html, /&lt;img/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<img|<script|Contact email|Contact phone|Website|Address/);
  assert.match(html, /Workspace name/);
  assert.match(html, /Description/);
  assert.match(html, /Workspace color/);
  assert.match(html, /maxLength="160"/);
  assert.match(html, /maxLength="1000"/);
});

test("workspace deletion requires the exact name and submits a versioned authenticated scope", async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  const workspace = { id: "workspace-id", name: "Northstar Travel", version: 7 };
  setTokenProvider(async () => "admin-token");
  globalThis.fetch = async (input, options) => {
    requests++;
    assert.equal(String(input), "/api/organizations/workspace-id");
    assert.equal(options?.method, "DELETE");
    assert.equal(new Headers(options?.headers).get("Authorization"), "Bearer admin-token");
    assert.deepEqual(JSON.parse(String(options?.body)), { confirmation_name: "Northstar Travel", expected_version: 7 });
    return Response.json({ id: "workspace-id", deleted: true, files_pending: 2 });
  };
  try {
    for (const confirmation of ["", "northstar travel", "Northstar Travel ", "Another workspace"]) {
      await assert.rejects(deleteWorkspace(workspace, confirmation), /workspace name exactly/);
    }
    assert.equal(requests, 0);
    const result = await deleteWorkspace(workspace, "Northstar Travel");
    assert.equal(requests, 1);
    assert.equal(result.files_pending, 2);
    globalThis.fetch = async () => Response.json({ message: "Workspace changed. Reload before deleting." }, { status: 409 });
    await assert.rejects(deleteWorkspace(workspace, "Northstar Travel"), /Workspace changed/);
  } finally {
    globalThis.fetch = originalFetch;
    setTokenProvider(async () => null);
  }
});
