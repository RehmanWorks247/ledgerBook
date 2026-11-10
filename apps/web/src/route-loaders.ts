// Share the same imports between React.lazy and sidebar preloading.
export const loadWorkspace = () => import("./pages/Workspace");
export const loadDashboard = () => import("./pages/Dashboard");
export const loadCustomers = () => import("./pages/Customers");
export const loadUsers = () => import("./pages/Users");
export const loadUserRecord = () => import("./pages/UserRecord");
export const loadAccess = () => import("./pages/Access");
export const loadCompanies = () => import("./companies/CompaniesPage");
export const loadSettings = () => import("./pages/Settings");
export const loadPaymentReviews = () => import("./payments/PaymentReviewPage");

const sidebarLoaders = {
  "customer-ledger": loadDashboard,
  customers: loadCustomers,
  "payment-reviews": loadPaymentReviews,
  users: loadUsers,
  access: loadAccess,
  companies: loadCompanies,
  settings: loadSettings,
};

export function preloadSidebarPage(path: string) {
  const segments = path.split("?")[0].split("/").filter(Boolean);
  const load = segments[2] === "users" && segments[3]
    ? loadUserRecord
    : sidebarLoaders[segments[2] as keyof typeof sidebarLoaders];
  // A speculative import failure must not interrupt the current page.
  if (load) void load().catch(() => undefined);
}

export function preloadSidebarPages(admin: boolean) {
  const loaders = admin ? Object.values(sidebarLoaders) : [loadUserRecord, loadSettings];
  for (const load of loaders) void load().catch(() => undefined);
}
