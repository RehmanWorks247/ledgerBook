import { useMemo, useState } from "react";
import { Download } from "lucide-react";
import { useResource } from "../api";
import { ErrorNotice, Pagination } from "../components";
import { CompanyDialog } from "./CompanyDialog";
import type { CompanyExport } from "./model";
import { companyExportFilename, companySheets, sheetCellText } from "./spreadsheet";

export function CompanySpreadsheet({ organizationId, companyName, onClose }: { organizationId: string; companyName: string; onClose: () => void }) {
  const resource = useResource<CompanyExport>(`/organizations/${organizationId}/companies/export?${new URLSearchParams({ company_name: companyName })}`);
  const [sheetIndex, setSheetIndex] = useState(0), [page, setPage] = useState(1);
  const [downloading, setDownloading] = useState(false), [error, setError] = useState("");
  const sheets = useMemo(() => resource.data ? companySheets(resource.data) : [], [resource.data]);
  const sheet = sheets[sheetIndex];
  const pageSize = 100;
  async function download() {
    if (!resource.data || downloading) return;
    setDownloading(true); setError("");
    try {
      const { companyWorkbook } = await import("./workbook");
      const bytes = companyWorkbook(resource.data);
      const blob = new Blob([new Uint8Array(bytes)], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url; link.download = companyExportFilename(companyName);
      document.body.append(link); link.click(); link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not download this company. Please try again."); }
    finally { setDownloading(false); }
  }
  return <CompanyDialog title="Excel preview" description={`${companyName} · All company records and totals in SAR. Downloads include both sheets and every row, regardless of table filters.`} wide busy={downloading} onClose={onClose}>
    <div className="company-sheet-toolbar">
      <p role="status">{resource.loading ? "Loading company records…" : resource.data ? `${resource.data.total} ${resource.data.total === 1 ? "voucher" : "vouchers"} · 2 sheets` : ""}</p>
      <button type="button" className="button" disabled={!resource.data || downloading} onClick={() => void download()}><Download size={16} />{downloading ? "Preparing Excel…" : "Download Excel"}</button>
    </div>
    {(resource.error || error) && <ErrorNotice message={resource.error || error} />}
    {resource.error && <button type="button" className="button secondary" onClick={resource.refresh}>Try again</button>}
    {sheet && <>
      <div className="company-sheet-tabs" role="group" aria-label="Workbook sheets">{sheets.map((item, index) => <button key={item.name} type="button" aria-pressed={sheetIndex === index} onClick={() => { setSheetIndex(index); setPage(1); }}>{item.name}</button>)}</div>
      <div className="company-sheet-scroll" tabIndex={0} role="region" aria-label={`${sheet.name} spreadsheet preview`}>
        <table className="company-sheet-table">
          <caption className="sr-only">{companyName} — {sheet.name} sheet</caption>
          <thead><tr><th aria-label="Row number" />{sheet.headers.map((header, i) => <th scope="col" key={header}>{String.fromCharCode(65 + i)}</th>)}</tr></thead>
          <tbody>
            <tr className="company-sheet-headers"><th scope="row">1</th>{sheet.headers.map(header => <th scope="col" key={header}>{header}</th>)}</tr>
            {sheet.rows.slice((page - 1) * pageSize, page * pageSize).map((row, i) => <tr key={i}>
              <th scope="row">{(page - 1) * pageSize + i + 2}</th>
              {row.map((value, column) => <td key={column} className={typeof value === "string" ? "" : "amount align-right"}>{sheetCellText(value)}</td>)}
            </tr>)}
          </tbody>
        </table>
      </div>
      {!sheet.rows.length && <p className="company-sheet-empty">No vouchers yet. You can still download this company's summary.</p>}
      <Pagination page={page} total={sheet.rows.length} size={pageSize} onPage={setPage} />
    </>}
  </CompanyDialog>;
}
