import { useEffect, useState } from "react";

export function useDirectoryFilters() {
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [status, updateStatus] = useState("all");
  const [dates, setDates] = useState({ start: "", end: "" });
  const [appliedDates, setAppliedDates] = useState(dates);
  const [page, setPage] = useState(1);
  useEffect(() => {
    if (search.trim() === query) return;
    const timer = window.setTimeout(() => { setQuery(search.trim()); setPage(1); }, 220);
    return () => window.clearTimeout(timer);
  }, [search, query]);
  const invalidDates = Boolean(dates.start && dates.end && dates.start > dates.end);
  function setDate(name: "start" | "end", value: string) {
    const next = { ...dates, [name]: value };
    setDates(next);
    if (!next.start || !next.end || next.start <= next.end) { setAppliedDates(next); setPage(1); }
  }
  function setStatus(value: string) { updateStatus(value); setPage(1); }
  function clear() {
    setSearch(""); setQuery(""); updateStatus("all");
    setDates({ start: "", end: "" }); setAppliedDates({ start: "", end: "" }); setPage(1);
  }
  const params = new URLSearchParams({ search: query, status, page: String(page), page_size: "25" });
  if (appliedDates.start) params.set("start", appliedDates.start);
  if (appliedDates.end) params.set("end", appliedDates.end);
  return { search, setSearch, query, status, setStatus, dates, setDate, page, setPage, params, clear,
    invalidDates, filtered: Boolean(search || status !== "all" || dates.start || dates.end) };
}
