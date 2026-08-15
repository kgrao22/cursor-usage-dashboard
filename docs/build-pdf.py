#!/usr/bin/env python3
"""
Markdown -> styled HTML -> PDF.

The Markdown in this folder is the source of truth and lives with the code so it
stays current. The PDFs are what actually get sent to people who are not going
to browse a Git repository.

    pip install markdown --break-system-packages
    python3 docs/build-pdf.py

Requires Chromium (for printing). Falls back to wkhtmltopdf if absent.
"""

import subprocess
import sys
import shutil
from pathlib import Path

try:
    import markdown
except ImportError:
    sys.exit("Missing dependency: pip install markdown --break-system-packages")

DOCS = Path(__file__).parent
DOCUMENTS = [
    ("ARCHITECTURE.md", "How the Cursor Spend Dashboard Works"),
    ("PROJECT-REFERENCE.md", "Cursor Spend Dashboard — Project Reference"),
]

CSS = """
@page { size: A4; margin: 18mm 16mm 20mm; }
* { box-sizing: border-box; }
body {
  font: 10.5pt/1.65 system-ui, -apple-system, "Segoe UI", sans-serif;
  color: #0b0b0b; margin: 0; max-width: 100%;
  -webkit-print-color-adjust: exact; print-color-adjust: exact;
}
h1 { font-size: 22pt; font-weight: 650; letter-spacing: -0.02em;
     margin: 0 0 4pt; line-height: 1.2; }
h2 { font-size: 14pt; font-weight: 640; margin: 22pt 0 7pt;
     padding-bottom: 4pt; border-bottom: 1.5px solid #e1e0d9;
     break-after: avoid; letter-spacing: -0.01em; }
h3 { font-size: 11.5pt; font-weight: 640; margin: 15pt 0 5pt; break-after: avoid; }
p { margin: 0 0 8pt; }
ul, ol { margin: 0 0 9pt; padding-left: 17pt; }
li { margin-bottom: 3.5pt; }
strong { font-weight: 640; }
em { color: #52514e; }
a { color: #2a78d6; text-decoration: none; }

hr { border: 0; border-top: 1px solid #e1e0d9; margin: 18pt 0; }

table { width: 100%; border-collapse: collapse; margin: 9pt 0 13pt;
        font-size: 9.2pt; break-inside: avoid; }
th { text-align: left; font-weight: 640; background: #f4f4f1;
     border-bottom: 1.5px solid #c3c2b7; padding: 5.5pt 7pt; }
td { border-bottom: 1px solid #e1e0d9; padding: 5.5pt 7pt; vertical-align: top; }
tr:nth-child(even) td { background: #fbfbf9; }

code { font-family: ui-monospace, "SF Mono", Menlo, monospace;
       font-size: 8.8pt; background: #f0efec; padding: 1.5pt 4pt;
       border-radius: 3px; }
pre { background: #f4f4f1; border: 1px solid #e1e0d9; border-radius: 6px;
      padding: 9pt 11pt; overflow-x: auto; break-inside: avoid; margin: 9pt 0 13pt; }
pre code { background: none; padding: 0; font-size: 8.6pt; line-height: 1.5; }

blockquote { margin: 11pt 0; padding: 9pt 13pt; background: #f4f4f1;
             border-left: 3px solid #eb6834; border-radius: 0 6px 6px 0;
             break-inside: avoid; }
blockquote p:last-child { margin-bottom: 0; }

img { max-width: 100%; height: auto; display: block; margin: 13pt auto; }

.doc-footer { margin-top: 26pt; padding-top: 9pt; border-top: 1px solid #e1e0d9;
              color: #898781; font-size: 8.5pt; }
"""

HTML = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>{title}</title>
<style>{css}</style></head>
<body>{body}
<div class="doc-footer">Cursor Spend Dashboard · MIT licensed · github.com/kgrao22/cursor-usage-dashboard</div>
</body></html>"""


def find_chromium():
    """Chromium on PATH, a Playwright-managed build, or a Google Chrome install."""
    for name in ("chromium", "chromium-browser", "google-chrome", "chrome"):
        found = shutil.which(name)
        if found:
            return found
    for pattern in (
        "/opt/pw-browsers/chromium-*/chrome-linux/chrome",
        "/opt/pw-browsers/chromium*/chrome-linux/chrome",
        str(Path.home() / ".cache/ms-playwright/chromium-*/chrome-linux/chrome"),
    ):
        matches = sorted(Path("/").glob(pattern.lstrip("/")))
        if matches:
            return str(matches[-1])
    return None


def build(md_name, title):
    src = DOCS / md_name
    if not src.exists():
        print(f"  skip {md_name} (not found)")
        return None

    body = markdown.markdown(
        src.read_text(encoding="utf-8"),
        extensions=["tables", "fenced_code", "attr_list", "sane_lists"],
    )
    html_path = DOCS / f".{src.stem}.tmp.html"
    html_path.write_text(HTML.format(title=title, css=CSS, body=body), encoding="utf-8")

    pdf_path = DOCS / f"{src.stem}.pdf"
    chromium = find_chromium()

    if chromium:
        subprocess.run(
            [
                chromium, "--headless", "--disable-gpu", "--no-sandbox",
                "--no-pdf-header-footer",
                f"--print-to-pdf={pdf_path}", f"file://{html_path}",
            ],
            check=True, capture_output=True,
        )
    elif shutil.which("wkhtmltopdf"):
        subprocess.run(["wkhtmltopdf", str(html_path), str(pdf_path)],
                       check=True, capture_output=True)
    else:
        sys.exit("No PDF renderer found (need chromium or wkhtmltopdf)")

    html_path.unlink(missing_ok=True)
    print(f"  {pdf_path.name}  ({pdf_path.stat().st_size // 1024} KB)")
    return pdf_path


if __name__ == "__main__":
    print("Building PDFs:")
    for name, title in DOCUMENTS:
        build(name, title)
