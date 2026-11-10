import {
  ChevronRight,
  FolderOpen,
  FolderSearch,
} from "lucide-react";
import { dateLabel, useResource, type Customer } from "../api";
import { Badge, ErrorNotice, TableSkeleton, Pagination } from "../components";
import { Link, Navigate } from "../router";
import { useOrganization } from "../state";
import { useDirectoryFilters } from "./directory-filters";

const statusFilters = [
  { value: "all", label: "All users" },
  { value: "active", label: "Active" },
  { value: "archived", label: "Archived" },
];

type DirectoryResponse = {
  items: (Customer & { created_date?: string })[];
  page: number;
  page_size: number;
  total: number;
  time_zone?: string;
};

export function UserDirectory() {
  const member = useOrganization();
  if (member.role !== "admin")
    return <Navigate to={`/o/${member.organization_id}`} replace />;
  return (
    <Directory key={member.organization_id} orgId={member.organization_id} />
  );
}

function Directory({ orgId }: { orgId: string }) {
  const { search, setSearch, status, setStatus, dates, setDate, setPage, params, clear, invalidDates, filtered } = useDirectoryFilters();
  const { data, error, loading, refresh } = useResource<DirectoryResponse>(
    `/organizations/${orgId}/customers?${params}`, { cache: true },
  );

  return (
    <div className="user-directory">
      <header className="user-directory-cover">
        <div>
          <h1>Customer records</h1>
        </div>
      </header>

      <section className="panel" aria-label="User directory" aria-busy={loading}>
        <div className="record-filters" role="search" aria-label="Filter customer records">
          <label className="record-filter-search">Search customers<input type="search" value={search} maxLength={160} placeholder="ID, name, email, phone or date" onChange={event => setSearch(event.target.value)} /></label>
          <label className="record-filter-select">Account status<select value={status} onChange={event => setStatus(event.target.value)}>{statusFilters.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label className="record-filter-date">Added from<input type="date" value={dates.start} max={dates.end || undefined} onChange={event => setDate("start", event.target.value)} aria-invalid={invalidDates || undefined} /></label>
          <label className="record-filter-date">Added to<input type="date" value={dates.end} min={dates.start || undefined} onChange={event => setDate("end", event.target.value)} aria-invalid={invalidDates || undefined} /></label>
        </div>
        <div className="record-filter-summary"><p role="status">{loading ? "Searching…" : data ? `${data.total} customer${data.total === 1 ? "" : "s"}${data.time_zone ? ` · Dates in ${data.time_zone}` : ""}` : "Customer records"}</p>{filtered && <button type="button" className="text-link" onClick={clear}>Clear filters</button>}</div>

        {invalidDates ? <div className="record-filter-error"><ErrorNotice message="Added from must be on or before added to." /></div> : error ? (
          <div className="user-directory-error">
            <ErrorNotice message={error} />
            <button className="button secondary" onClick={refresh}>
              Try again
            </button>
          </div>
        ) : !data ? (
          <TableSkeleton columns={["User", "Account status", "Date added"]} label="Loading customer records" />
        ) : data.items.length ? (
          <>
            <div
              className="user-directory-columns user-directory-grid"
              aria-hidden="true"
            >
              <span>User</span>
              <span>Account status</span>
              <span className="user-directory-date">Date added</span>
            </div>
            <ul className="user-directory-list">
              {data.items.map((user) => (
                <li key={user.id}>
                  <Link
                    className="user-directory-row user-directory-grid"
                    to={`/o/${orgId}/users/${user.id}`}
                  >
                    <span className="user-directory-person">
                      <span
                        className="user-directory-avatar"
                        aria-hidden="true"
                      >
                        {user.name
                          .trim()
                          .split(/\s+/)
                          .slice(0, 2)
                          .map((part) => Array.from(part)[0])
                          .join("")
                          .toUpperCase()}
                      </span>
                      <span className="user-directory-identity">
                        <strong>{user.name}</strong>
                        <small>{user.customer_code} · {user.email}</small>
                      </span>
                    </span>
                    <span>
                      <Badge value={user.status} />
                    </span>
                    <span className="user-directory-date">
                      <span className="sr-only">Date added </span>
                      {user.created_date || user.created_at ? dateLabel(user.created_date || user.created_at!) : "—"}
                    </span>
                    <ChevronRight
                      className="user-directory-arrow"
                      size={16}
                      aria-hidden="true"
                    />
                  </Link>
                </li>
              ))}
            </ul>
            <Pagination
              page={data.page}
              total={data.total}
              size={data.page_size}
              onPage={setPage}
            />
          </>
        ) : (
          <div className="empty user-directory-empty">
            <span className="empty-icon" aria-hidden="true">
              {filtered ? <FolderSearch size={28} /> : <FolderOpen size={28} />}
            </span>
            <h2>{filtered ? "No matching users" : "No user records yet"}</h2>
            <p>
              {filtered
                ? "Try another ID, name, contact detail, date or account status."
                : "Customer accounts appear here with their own file space. Try the explorer with a sample record."}
            </p>
            {filtered ? (
              <button
                className="text-link"
                onClick={clear}
              >
                Clear filters
              </button>
            ) : (
              <Link
                className="button secondary"
                to={`/o/${orgId}/users/sample`}
              >
                Explore a sample record <ChevronRight size={14} />
              </Link>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
