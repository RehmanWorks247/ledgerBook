import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { money, dateLabel } from "../src/api";
import { navigateTo, subscribeToNavigation } from "../src/history";

test("client money formatting preserves integer precision, sign, and currency exponent", () => {
  assert.equal(
    money("900719925474099399", "PKR", 2),
    "PKR 9,007,199,254,740,993.99",
  );
  assert.equal(money("-1", "KWD", 3), "\u2212KWD 0.001");
  assert.equal(money("12345", "JPY", 0), "JPY 12,345");
  assert.equal(money("0", "USD", 2), "USD 0.00");
  assert.equal(dateLabel("2026-01-01"), "01 Jan 2026");
});

test("router preserves nested layouts, account parameters, deep links, and history events", async () => {
  let location = new URL("http://ledgerbook.test/o/acme/customers/customer-7");
  const target = new EventTarget();
  const history = [location.href];
  const fakeWindow = Object.assign(target, {
    get location() {
      return location;
    },
    history: {
      pushState(_state: unknown, _title: string, path: string) {
        location = new URL(path, location);
        history.push(location.href);
      },
      replaceState(_state: unknown, _title: string, path: string) {
        location = new URL(path, location);
        history[history.length - 1] = location.href;
      },
      back() {
        if (history.length > 1) history.pop();
        location = new URL(history[history.length - 1]);
        target.dispatchEvent(new Event("popstate"));
      },
    },
    scrollTo() {},
  });
  // Object.assign evaluates getters; keep location live as browser history changes it.
  Object.defineProperty(fakeWindow, "location", { get: () => location });
  Object.defineProperty(globalThis, "window", {
    value: fakeWindow,
    configurable: true,
  });
  try {
    const { BrowserRouter, Routes, Route, Outlet, NavLink, useParams } =
      await import("../src/router");
    const Guard = () => h("section", { "data-layout": "protected" }, h(Outlet));
    const Shell = () => h("main", { "data-org": useParams().orgId }, h(Outlet));
    const Detail = () =>
      h("p", null, `${useParams().orgId}/${useParams().customerId}`);
    const render = () =>
      renderToStaticMarkup(
        h(BrowserRouter, {
          children: h(Routes, {
            children: [
              h(Route, {
                key: "protected",
                element: h(Guard),
                children: h(Route, {
                  path: "/o/:orgId",
                  element: h(Shell),
                  children: [
                    h(Route, {
                      key: "index",
                      index: true,
                      element: h("p", null, "Overview"),
                    }),
                    h(Route, {
                      key: "customer",
                      path: "customers/:customerId",
                      element: h(Detail),
                    }),
                  ],
                }),
              }),
              h(Route, {
                key: "missing",
                path: "*",
                element: h("p", null, "Not found"),
              }),
            ],
          }),
        }),
      );
    assert.equal(
      render(),
      '<section data-layout="protected"><main data-org="acme"><p>acme/customer-7</p></main></section>',
    );
    const changes: string[] = [];
    const unsubscribe = subscribeToNavigation(() =>
      changes.push(window.location.pathname),
    );
    navigateTo("/o/acme");
    assert.match(render(), /<p>Overview<\/p>/);
    fakeWindow.history.back();
    assert.match(render(), /acme\/customer-7/);
    navigateTo("/o/second/customers/customer-8", { replace: true });
    assert.match(render(), /data-org="second"/);
    assert.match(render(), /second\/customer-8/);
    assert.deepEqual(changes, [
      "/o/acme",
      "/o/acme/customers/customer-7",
      "/o/second/customers/customer-8",
    ]);
    assert.throws(
      () => navigateTo("https://outside.example/"),
      /External navigation/,
    );
    const navigationHtml = renderToStaticMarkup(
      h(BrowserRouter, {
        children: h(NavLink, {
          to: "/o/second/customers",
          children: "Customers",
        }),
      }),
    );
    assert.match(navigationHtml, /class="active"/);
    assert.match(navigationHtml, /aria-current="page"/);
    assert.match(navigationHtml, /href="\/o\/second\/customers"/);
    navigateTo("/unknown");
    assert.equal(render(), "<p>Not found</p>");
    const count = changes.length;
    unsubscribe();
    navigateTo("/o/acme");
    assert.equal(
      changes.length,
      count,
      "unmount cleanup must remove navigation listeners",
    );
  } finally {
    Reflect.deleteProperty(globalThis, "window");
  }
});
