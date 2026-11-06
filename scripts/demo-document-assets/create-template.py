"""Rebuild the neutral, personal-data-free sample PDF background using ReportLab.

Run with a Python environment containing reportlab:
  python scripts/demo-document-assets/create-template.py
The seeder itself does not require Python; it consumes the checked-in template.
"""
from pathlib import Path
from reportlab.pdfgen import canvas
from reportlab.lib.colors import HexColor
from reportlab.lib.pagesizes import A4

destination = Path(__file__).with_name("template.pdf")
page = canvas.Canvas(str(destination), pagesize=A4, pageCompression=0, invariant=1)
page.setTitle("LedgerBook sample document background")
page.setAuthor("LedgerBook demo data")
width, height = A4
page.setFillColor(HexColor("#102f3c"))
page.rect(0, height - 106, width, 106, fill=1, stroke=0)
page.setFillColor(HexColor("#b8d8d1"))
page.setFont("Helvetica", 9)
page.drawString(40, height - 30, "LEDGERBOOK DEMONSTRATION COLLECTION")
page.setFillColor(HexColor("#ffffff"))
page.setFont("Helvetica-Bold", 21)
page.drawString(40, height - 59, "SAMPLE HORIZON JOURNEYS")
page.setFont("Helvetica", 10)
page.drawString(40, height - 81, "Fictional travel agency  |  Sample itinerary and service documents")
page.setFillColor(HexColor("#fff0c2"))
page.rect(0, height - 142, width, 36, fill=1, stroke=0)
page.setFillColor(HexColor("#654900"))
page.setFont("Helvetica-Bold", 11)
page.drawString(40, height - 128, "SAMPLE / NOT VALID FOR TRAVEL")
page.setStrokeColor(HexColor("#d6dfe2"))
page.setLineWidth(0.6)
page.line(40, 52, width - 40, 52)
page.setFillColor(HexColor("#5c6b72"))
page.setFont("Helvetica", 8)
page.drawString(40, 36, "Fictitious passengers and reservations. No tickets, visas or travel services have been issued.")
page.drawString(40, 23, "Prepared only for demonstrating LedgerBook booking documents and payment review.")
page.setFont("Helvetica-Bold", 8)
page.drawRightString(width - 40, 23, "SAMPLE  |  1 / 1")
page.showPage()
page.save()
