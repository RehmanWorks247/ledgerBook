import type { ReactNode } from "react";
import { ArrowDownLeft, ArrowUpRight, BookOpen, ChevronLeft, ChevronRight, RotateCcw } from "lucide-react";
import { useTheme } from "./theme";
export function Brand() {
  const { theme } = useTheme();
  const dark = theme === "dark";
  return (
    <span className="brand">
      <img
        className={`brand-logo${dark ? " brand-logo-dark" : ""}`}
        src={dark ? "/branding/umrah-packages-logo-dark-transparent.png" : "/branding/umrah-packages-source.png"}
        alt="Umrah Packages UK"
        width={dark ? 320 : 526}
        height={dark ? 146 : 368}
      />
    </span>
  );
}
export function ErrorNotice({ message }: { message?: string }) {
  return message ? (
    <div className="notice error" role="alert">
      {message}
    </div>
  ) : null;
}
export function Loading({ full = false }: { full?: boolean }) {
  return (
    <div className={`loading ${full ? "full" : ""}`} role="status">
      <span className="spinner" />
      <span>Loading your account…</span>
    </div>
  );
}

export function TableSkeleton({ columns = ["", "", "", ""], rows = 6, label = "Loading table" }: {
  columns?: string[]; rows?: number; label?: string;
}) {
  return <div className="table-skeleton" role="status" aria-label={label}>
    <span className="sr-only">{label}…</span>
    <div className="table-scroll" aria-hidden="true">
      <table><thead><tr>{columns.map((column, index) => <th key={index}>{column || <span className="skeleton skeleton-label" />}</th>)}</tr></thead>
        <tbody>{Array.from({ length: rows }, (_, row) => <tr key={row}>
          {columns.map((_, column) => <td key={column}><span className={`skeleton skeleton-line skeleton-width-${(row + column) % 3}`} />{column === 0 && <span className="skeleton skeleton-caption" />}</td>)}
        </tr>)}</tbody>
      </table>
    </div>
  </div>;
}

export function DashboardSkeleton() {
  return <div className="dashboard-skeleton" role="status" aria-label="Loading overview">
    <span className="sr-only">Loading overview…</span>
    <div className="stats-grid" aria-hidden="true">{Array.from({ length: 4 }, (_, index) => <div className="stat-card" key={index}>
      <span className="skeleton skeleton-label" /><span className="skeleton skeleton-value" /><span className="skeleton skeleton-line" />
    </div>)}</div>
    <div className="skeleton-panels" aria-hidden="true">{[0, 1].map(index => <div className="panel" key={index}>
      <div className="panel-heading"><span className="skeleton skeleton-label" /></div>
      {Array.from({ length: 3 }, (_, row) => <div className="skeleton-panel-row" key={row}><span className="skeleton skeleton-line" /><span className="skeleton skeleton-caption" /></div>)}
    </div>)}</div>
  </div>;
}

export function FormSkeleton() {
  return <div className="form-skeleton" role="status" aria-label="Loading settings">
    <span className="sr-only">Loading settings…</span>
    <div aria-hidden="true">{[0, 1, 2].map(index => <div className="skeleton-field" key={index}><span className="skeleton skeleton-label" /><span className="skeleton skeleton-input" /></div>)}</div>
  </div>;
}

export function PageSkeleton() {
  return <div className="page-skeleton" role="status" aria-label="Loading page">
    <span className="sr-only">Loading page…</span>
    <div aria-hidden="true">
      <div className="page-heading"><div><span className="skeleton skeleton-title" /><span className="skeleton skeleton-line" /></div></div>
      <div className="panel"><div className="panel-heading"><span className="skeleton skeleton-input" /></div><TableSkeleton /></div>
    </div>
  </div>;
}

export function Empty({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <BookOpen size={27} />
      </span>
      <h3>{title}</h3>
      <p>{detail}</p>
    </div>
  );
}
export function Badge({ value }: { value: string }) {
  const Icon = value === "payment" ? ArrowDownLeft : value === "charge" ? ArrowUpRight : value === "reversal" ? RotateCcw : null;
  return (
    <span className={`badge badge-${value.toLowerCase()}`}>
      {Icon && <Icon size={12} aria-hidden="true" />}
      {value.replaceAll("_", " ")}
    </span>
  );
}
export function PageHeading({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        {eyebrow && <span className="eyebrow">{eyebrow}</span>}
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}
export function Stat({
  label,
  value,
  detail,
  icon,
  primary = false,
  tone = "neutral",
  valueClassName = "",
}: {
  label: string;
  value: string;
  detail: string;
  icon: ReactNode;
  primary?: boolean;
  tone?: "neutral" | "success" | "danger" | "warning" | "info" | "violet";
  valueClassName?: string;
}) {
  return (
    <article className={`stat-card stat-${tone} ${primary ? "primary-stat" : ""}`}>
      <div className="stat-label">
        {label}
        <span className="stat-icon">{icon}</span>
      </div>
      <strong className={`stat-value ${valueClassName}`}>{value}</strong>
      <p>{detail}</p>
    </article>
  );
}
export function Pagination({
  page,
  total,
  size,
  onPage,
}: {
  page: number;
  total: number;
  size: number;
  onPage: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / size));
  return (
    <div className="pagination">
      <span>
        {total === 0
          ? "No results"
          : `${(page - 1) * size + 1}–${Math.min(page * size, total)} of ${total}`}
      </span>
      <div>
        <button
          className="icon-button"
          disabled={page <= 1}
          aria-label="Previous page"
          onClick={() => onPage(page - 1)}
        >
          <ChevronLeft size={17} />
        </button>
        <span>
          Page {page} of {pages}
        </span>
        <button
          className="icon-button"
          disabled={page >= pages}
          aria-label="Next page"
          onClick={() => onPage(page + 1)}
        >
          <ChevronRight size={17} />
        </button>
      </div>
    </div>
  );
}
