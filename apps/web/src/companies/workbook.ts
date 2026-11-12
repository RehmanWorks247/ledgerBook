import { strToU8, zipSync } from "fflate";
import type { CompanyExport } from "./model";
import { companySheets, sheetCellText, type CompanySheet, type SheetCell } from "./spreadsheet";

const xmlDeclaration = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const relationships = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
function xml(value: string): string {
  // eslint-disable-next-line no-control-regex -- XML 1.0 forbids these control characters.
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
function cell(value: SheetCell, reference: string, header = false): string {
  const text = sheetCellText(value);
  const isAmount = typeof value === "object";
  // Excel only retains 15 significant decimal digits. Preserve larger amounts as text.
  const numeric = typeof value === "number" || (isAmount && text.replace(/[-.]/g, "").replace(/^0+/, "").length <= 15);
  const style = header ? 1 : isAmount && numeric ? 2 : 0;
  return numeric
    ? `<c r="${reference}" s="${style}" t="n"><v>${text}</v></c>`
    : `<c r="${reference}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xml(text)}</t></is></c>`;
}
function worksheet(sheet: CompanySheet): string {
  if (sheet.rows.length > 1_048_575) throw new Error("This company exceeds Excel's row limit.");
  const lastColumn = String.fromCharCode(64 + sheet.headers.length);
  const rows = [sheet.headers, ...sheet.rows].map((row, index) => `<row r="${index + 1}">${row.map((value, column) =>
    cell(value, `${String.fromCharCode(65 + column)}${index + 1}`, index === 0)).join("")}</row>`).join("");
  return `${xmlDeclaration}<worksheet xmlns="${ns}"><dimension ref="A1:${lastColumn}${sheet.rows.length + 1}"/>
    <sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>
    <sheetFormatPr defaultRowHeight="20"/><cols>${sheet.widths.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join("")}</cols>
    <sheetData>${rows}</sheetData>${sheet.name === "Records" ? `<autoFilter ref="A1:${lastColumn}${sheet.rows.length + 1}"/>` : ""}</worksheet>`;
}

// Minimal OOXML package: https://learn.microsoft.com/en-us/office/open-xml/spreadsheet/structure-of-a-spreadsheetml-document
export function companyWorkbook(data: CompanyExport): Uint8Array {
  const sheets = companySheets(data);
  const moneyFormat = `"SAR" #,##0${data.currency_exponent ? `.${"0".repeat(data.currency_exponent)}` : ""}`;
  const files: Record<string, string> = {
    "[Content_Types].xml": `${xmlDeclaration}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>
      <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
      <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
      ${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`,
    "_rels/.rels": `${xmlDeclaration}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${relationships}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml": `${xmlDeclaration}<workbook xmlns="${ns}" xmlns:r="${relationships}"><sheets>${sheets.map((sheet, i) => `<sheet name="${sheet.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `${xmlDeclaration}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${relationships}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId3" Type="${relationships}/styles" Target="styles.xml"/></Relationships>`,
    "xl/styles.xml": `${xmlDeclaration}<styleSheet xmlns="${ns}"><numFmts count="1"><numFmt numFmtId="164" formatCode="${xml(moneyFormat)}"/></numFmts>
      <fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts>
      <fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF166534"/><bgColor indexed="64"/></patternFill></fill></fills>
      <borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
      <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
      <cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>
      <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`,
  };
  sheets.forEach((sheet, i) => { files[`xl/worksheets/sheet${i + 1}.xml`] = worksheet(sheet); });
  return zipSync(Object.fromEntries(Object.entries(files).map(([path, content]) => [path, strToU8(content)])), { level: 6 });
}
