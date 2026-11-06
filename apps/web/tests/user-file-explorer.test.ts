import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { UserFileExplorer } from "../src/user-files/UserFileExplorer";
import { getUserFileStore } from "../src/user-files/model";

test("record files stay browsable in view-only mode while file management is admin-only", () => {
  const props = { viewerId: "viewer", organizationId: "org", userId: "record" };
  const store = getUserFileStore(
    JSON.stringify([props.viewerId, props.organizationId, props.userId]),
  );
  store.createFolder(null, "Signed agreements");
  const render = (canManage: boolean, userId = props.userId) =>
    renderToStaticMarkup(
      createElement(UserFileExplorer, { ...props, userId, canManage }),
    );

  const view = render(false);
  assert.match(view, /Open Signed agreements folder/);
  assert.match(view, /View only/);
  assert.doesNotMatch(
    view,
    /type="file"|draggable="true"|Move Signed agreements|Add files|New folder/,
  );

  const admin = render(true);
  assert.match(admin, /Move Signed agreements/);
  assert.match(admin, /Add files/);
  assert.match(admin, /New folder/);
  assert.match(admin, /draggable="true"/);
  assert.doesNotMatch(render(true, "another-record"), /Signed agreements/);
});
