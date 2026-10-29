import type { ReactNode } from "react";
import { BookOpen, ChevronLeft, ChevronRight } from "lucide-react";
export function Brand({ light = false }: { light?: boolean }) {
  return (
    <span className={`brand ${light ? "brand-light" : ""}`}>
      <span className="brand-mark">
        <BookOpen size={22} strokeWidth={2} />
      </span>
      LedgerBook<span className="brand-dot">.</span>
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
      <span>Loading your workspace…</span>
    </div>
  );
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
  return (
    <span className={`badge badge-${value.toLowerCase()}`}>
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
  eyebrow: string;
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        <p>{description}</p>
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
}: {
  label: string;
  value: string;
  detail: string;
  icon: ReactNode;
  primary?: boolean;
}) {
  return (
    <article className={`stat-card ${primary ? "primary-stat" : ""}`}>
      <div className="stat-label">
        {label}
        <span className="stat-icon">{icon}</span>
      </div>
      <strong className="stat-value">{value}</strong>
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
