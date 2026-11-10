import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { canEditText, validateTextEdit, FileExplorer, UploadNotification, UserFileExplorer } from "../src/user-files/UserFileExplorer";
import { getUserFileStore, type FileNode, type FileStore } from "../src/user-files/model";

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

test("booking file actions protect service folders and customers while admins can rename and delete documents", () => {
  const nodes: FileNode[] = [
    { id: "service", parentId: null, name: "Hotel", kind: "folder", defaultFolder: true, serviceKey: "hotel", size: 0, modifiedAt: 0 },
    { id: "custom", parentId: null, name: "Custom", kind: "folder", size: 0, modifiedAt: 0 },
    { id: "file", parentId: null, name: "Voucher.pdf", kind: "file", size: 14, modifiedAt: 0 },
  ];
  const store: FileStore = {
    getSnapshot: () => nodes, subscribe: () => () => {},
    createFolder() {}, move() {}, rename() {}, remove() {}, importEntries() {},
  };
  const admin = renderToStaticMarkup(createElement(FileExplorer, { store, canManage: true }));
  assert.match(admin, /Rename Voucher.pdf/);
  assert.match(admin, /Delete Voucher.pdf/);
  assert.match(admin, /Rename Custom/);
  assert.doesNotMatch(admin, /Move Hotel|Rename Hotel|Delete Hotel/);
  const customer = renderToStaticMarkup(createElement(FileExplorer, { store, canManage: false }));
  assert.match(customer, /Voucher.pdf/);
  assert.match(customer, /Open Hotel folder/);
  assert.doesNotMatch(customer, /Rename |Delete |Move |type="file"|draggable="true"/);
});

test("success and error upload toasts announce their outcome and retain the specific error", () => {
  const success = renderToStaticMarkup(createElement(UploadNotification, { message: "File uploaded successfully.", tone: "success", dismiss() {} }));
  assert.match(success, /role="status"/);
  assert.match(success, /File uploaded successfully/);
  const error = renderToStaticMarkup(createElement(UploadNotification, { message: "Voucher.pdf: Storage is temporarily busy. Retry this file.", tone: "error", dismiss() {} }));
  assert.match(error, /role="alert"/);
  assert.match(error, /aria-live="assertive"/);
  assert.match(error, /Voucher.pdf: Storage is temporarily busy. Retry this file/);
  assert.match(error, /aria-label="Dismiss notification"/);
});


test("version history remains readable to customers but edit actions are administrator-only", () => {
  const nodes:FileNode[]=[{id:"file",parentId:null,name:"instructions.txt",kind:"file",size:20,modifiedAt:0,version:2}];
  const store:FileStore={getSnapshot:()=>nodes,subscribe:()=>()=>{},createFolder(){},move(){},importEntries(){},history:async()=>({version:2,items:[]}),replace:async()=>{}};
  const admin=renderToStaticMarkup(createElement(FileExplorer,{store,canManage:true}));
  const customer=renderToStaticMarkup(createElement(FileExplorer,{store,canManage:false}));
  assert.match(admin,/Edit file and versions instructions.txt/);
  assert.match(customer,/Version history instructions.txt/);
  assert.doesNotMatch(customer,/Edit file and versions|Replace file|type="file"/);
});

test("text editing is restricted to bounded safe UTF-8 formats with JSON syntax validation",()=>{
  const node:FileNode={id:"file",parentId:null,name:"instructions.md",kind:"file",size:256*1024,modifiedAt:0};
  assert.equal(canEditText(node),true);assert.equal(canEditText({...node,size:node.size+1}),false);
  assert.equal(canEditText({...node,name:"letter.docx"}),false);assert.equal(canEditText({...node,name:"page.html"}),false);
  validateTextEdit("instructions.md","# Café\nLine two\tvalue");validateTextEdit("data.json",'{"ready":true}');
  assert.throws(()=>validateTextEdit("data.json",'{invalid}'),/valid JSON/);
  assert.throws(()=>validateTextEdit("notes.txt",""),/non-empty/);
  assert.throws(()=>validateTextEdit("notes.txt","a\u0000b"),/control characters/);
  assert.throws(()=>validateTextEdit("notes.txt","é".repeat(131073)),/256 KB/);
});
