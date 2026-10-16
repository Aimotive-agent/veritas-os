"""Documents for ``system_documents``: what a PDF or a photo of a page says, the facts a filing needs
(kind, vendor, date, number, total) and the folders a person already files into.

The host adapters extract the text (PDFKit and Vision on macOS; pdftotext, the Hermes runtime's own
converter and tesseract on Linux). Everything here works on that text, on PDF bytes or on folder
listings and never runs a program, so it is tested with fixture strings on any platform. The hints
are heuristics for the agent to check against the text, not answers."""

from __future__ import annotations

import hashlib
import os
import re
import struct
import zlib
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Iterable, Sequence

PDF_EXTENSIONS = frozenset({".pdf"})
IMAGE_EXTENSIONS = frozenset({".png", ".jpg", ".jpeg", ".heic", ".heif", ".tif", ".tiff", ".webp", ".bmp", ".gif"})
# A page with fewer characters than this is a picture of text (a scan) or blank: it needs OCR.
EMPTY_PAGE_CHARS = 20
MAX_DOCUMENT_BYTES = 50 * 1024 * 1024


@dataclass
class DocumentText:
    """What a host read from one document: one string per page read, in page order."""

    pages: list[str]
    page_count: int
    ocr_pages: list[int] = field(default_factory=list)  # 1-based pages whose text came from OCR.
    engine: str = ""
    notes: list[str] = field(default_factory=list)


def document_type(path: Path) -> str | None:
    """``pdf``, ``image`` or None for anything this tool does not read."""
    suffix = path.suffix.lower()
    if suffix in PDF_EXTENSIONS:
        return "pdf"
    if suffix in IMAGE_EXTENSIONS:
        return "image"
    return None


def collect_documents(targets: Sequence[Path], limit: int) -> tuple[list[Path], list[dict[str, str]]]:
    """The files to read: each target file, and the PDFs and images directly inside each target folder
    (newest first, hidden files left out). Returns ``(files, skipped)`` with a reason per skipped path."""
    files: list[Path] = []
    skipped: list[dict[str, str]] = []
    seen: set[Path] = set()

    def add(path: Path) -> None:
        if path in seen:
            return
        seen.add(path)
        if len(files) >= limit:
            skipped.append({"path": str(path), "reason": "over the limit for one call; read it in another call"})
        else:
            files.append(path)

    for target in targets:
        if target.is_dir():
            entries: list[tuple[float, Path]] = []
            try:
                with os.scandir(target) as listing:
                    for entry in listing:
                        if entry.name.startswith(".") or document_type(Path(entry.name)) is None:
                            continue
                        try:
                            if entry.is_file():
                                entries.append((entry.stat().st_mtime, Path(entry.path)))
                        except OSError:
                            continue
            except OSError as exc:
                skipped.append({"path": str(target), "reason": exc.strerror or str(exc)})
                continue
            for _, path in sorted(entries, key=lambda item: item[0], reverse=True):
                add(path)
        elif target.is_file():
            if document_type(target) is None:
                skipped.append({"path": str(target), "reason": "not a PDF or an image; read it with read_file"})
            else:
                add(target)
        else:
            skipped.append({"path": str(target), "reason": "does not exist"})
    return files, skipped


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def join_pages(doc: DocumentText, max_chars: int) -> tuple[str, bool]:
    """The pages as one text with a header per page, cut at ``max_chars``; returns ``(text, truncated)``."""
    parts = []
    for number, text in enumerate(doc.pages, start=1):
        label = f"--- page {number}{' (OCR)' if number in doc.ocr_pages else ''} ---"
        parts.append(f"{label}\n{text.strip()}")
    joined = "\n".join(parts)
    if len(joined) <= max_chars:
        return joined, False
    return joined[: max(0, max_chars - 1)].rstrip() + "…", True


def split_pdftotext(stdout: str) -> list[str]:
    """``pdftotext`` output -> one string per page (pages end with a form feed)."""
    pages = stdout.split("\f")
    if pages and not pages[-1].strip():
        pages.pop()
    return pages


def plain_text(markdown: str) -> str:
    """Markdown (what anydoc returns) as plain lines: no heading marks, bold or table rules."""
    text = re.sub(r"^[ \t]{0,3}#{1,6}[ \t]+", "", markdown, flags=re.MULTILINE)
    text = re.sub(r"(\*\*|__)(.+?)\1", r"\2", text)
    text = re.sub(r"^[ \t]*\|?[ \t]*:?-{3,}[-|: \t]*$", "", text, flags=re.MULTILINE)
    return re.sub(r"[ \t]*\|[ \t]*", "  ", text)


def text_with_python(path: Path, max_pages: int) -> DocumentText:
    """PDF text without poppler: the Hermes runtime's own document converter (anydoc, which returns
    the whole document as one block and names the pages that are scans) or pypdf, when importable."""
    count = count_pdf_pages(path.read_bytes()) or 1
    try:
        import anydoc  # type: ignore[import-not-found]
    except Exception:  # noqa: BLE001 - optional: any import failure means "not available".
        anydoc = None
    if anydoc is not None:
        try:
            text = anydoc.to_markdown(str(path))
        except Exception as exc:  # noqa: BLE001 - anydoc raises its own error types.
            scanned = list(getattr(exc, "pages", None) or [])
            if not scanned:
                raise RuntimeError(f"{type(exc).__name__}: {exc}") from exc
            # Every page is a picture of text: return empty pages for OCR to fill.
            total = int(getattr(exc, "page_count", None) or count)
            return DocumentText(pages=[""] * min(total, max_pages), page_count=total, engine="anydoc")
        notes = ["Page breaks are not known here: the text is the whole document."] if count > 1 else []
        return DocumentText(pages=[plain_text(text)], page_count=count, engine="anydoc", notes=notes)
    try:
        from pypdf import PdfReader  # type: ignore[import-not-found]
    except Exception:  # noqa: BLE001
        raise RuntimeError("No PDF text reader is installed: install poppler-utils (pdftotext).") from None
    reader = PdfReader(str(path))
    return DocumentText(pages=[page.extract_text() or "" for page in reader.pages[:max_pages]], page_count=len(reader.pages), engine="pypdf")


def count_pdf_pages(data: bytes) -> int | None:
    """Page count from the page tree's ``/Count`` (the largest one is the root), else page objects."""
    counts = [int(m) for m in re.findall(rb"/Type\s*/Pages\b[^>]*?/Count\s+(\d+)", data)]
    counts += [int(m) for m in re.findall(rb"/Count\s+(\d+)[^>]*?/Type\s*/Pages\b", data)]
    if counts:
        return max(counts)
    pages = len(re.findall(rb"/Type\s*/Page\b(?!s)", data))
    return pages or None


# ---------------------------------------------------------------------------------------------
# Hints: kind, dates, amounts, numbers, vendor.
# ---------------------------------------------------------------------------------------------

_KIND_SIGNALS: tuple[tuple[str, int, re.Pattern[str]], ...] = (
    ("invoice", 3, re.compile(r"\btax invoice\b", re.I)),
    ("invoice", 2, re.compile(r"\b(invoice|rechnung|factura|facture|fattura)\b", re.I)),
    ("invoice", 2, re.compile(r"\binvoice\s*(no\b|number|num\b|nr\b|#|date)", re.I)),
    ("invoice", 1, re.compile(r"\b(amount due|balance due|total due|due date|payment terms|bill(ed)? to|remit to)\b", re.I)),
    ("receipt", 3, re.compile(r"\breceipt\b", re.I)),
    ("receipt", 1, re.compile(r"\b(paid by|payment received|thank you for your (purchase|order)|change due|eftpos)\b", re.I)),
    ("statement", 3, re.compile(r"\b((account|bank|card) statement|statement period|statement of account)\b", re.I)),
    ("statement", 2, re.compile(r"\b(opening|closing) balance\b", re.I)),
    ("quote", 3, re.compile(r"\b(quote|quotation|estimate)\b", re.I)),
    ("quote", 1, re.compile(r"\bvalid (until|for)\b", re.I)),
    ("credit note", 4, re.compile(r"\bcredit (note|memo)\b", re.I)),
    ("payslip", 3, re.compile(r"\b(pay ?slip|pay stub|earnings statement|payroll)\b", re.I)),
    ("payslip", 2, re.compile(r"\b(gross pay|net pay|year to date)\b", re.I)),
    ("contract", 2, re.compile(r"\b(agreement|contract)\b", re.I)),
    ("contract", 1, re.compile(r"\b(hereinafter|the parties|signature)\b", re.I)),
    ("order", 2, re.compile(r"\border (confirmation|summary)\b", re.I)),
)


def classify(text: str) -> tuple[str, str, list[str]]:
    """``(kind, confidence, signals)``: invoice, receipt, statement, quote, credit note, payslip,
    contract, order or other; confidence high, medium or low."""
    scores: dict[str, int] = {}
    signals: list[str] = []
    for kind, weight, pattern in _KIND_SIGNALS:
        match = pattern.search(text)
        if match:
            scores[kind] = scores.get(kind, 0) + weight
            signals.append(match.group(0).strip().lower())
    if not scores:
        return "other", "low", []
    ranked = sorted(scores.items(), key=lambda item: item[1], reverse=True)
    kind, best = ranked[0]
    runner_up = ranked[1][1] if len(ranked) > 1 else 0
    if best < 2:
        return "other", "low", signals[:4]
    confidence = "high" if best >= 4 and runner_up * 2 <= best else "medium" if best >= 3 else "low"
    return kind, confidence, list(dict.fromkeys(signals))[:4]


_MONTHS = {"jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6, "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12}
_MONTH = r"(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?"
_DATE_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("ymd", re.compile(r"\b((?:19|20)\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b")),
    ("dmy_text", re.compile(rf"\b(\d{{1,2}})(?:st|nd|rd|th)?[ \-]+{_MONTH}[ \-,]+((?:19|20)\d{{2}})\b", re.I)),
    ("mdy_text", re.compile(rf"\b{_MONTH} +(\d{{1,2}})(?:st|nd|rd|th)?,? +((?:19|20)\d{{2}})\b", re.I)),
    ("numeric", re.compile(r"\b(\d{1,2})([/.\-])(\d{1,2})\2((?:19|20)\d{2}|\d{2})\b")),
)
_DATE_LABELS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("due", re.compile(r"\b(due|payable by|pay by|expir\w*|valid until)\b", re.I)),
    ("issued", re.compile(r"\b(invoice date|date of issue|issue date|issued|tax point|bill date|receipt date|dated?|datum|fecha)\b", re.I)),
    ("period", re.compile(r"\b(period|from|between|to)\b", re.I)),
)
_US_HINTS = re.compile(r"\bUSD\b|US\$|\bsales tax\b", re.I)


def _line_bounds(text: str, start: int) -> tuple[int, int]:
    begin = text.rfind("\n", 0, start) + 1
    end = text.find("\n", start)
    return begin, len(text) if end < 0 else end


def _label(text: str, start: int, end: int, labels: Sequence[tuple[str, re.Pattern[str]]], floor: int = 0) -> str:
    """The label written just before a value on its line, or on the line above when the value stands alone."""
    begin, stop = _line_bounds(text, start)
    before = text[max(begin, floor):start]
    for name, pattern in labels:
        if pattern.search(before[-48:]):
            return name
    if not before.strip() and not text[end:stop].strip() and begin > 0:
        above_begin, _ = _line_bounds(text, begin - 1)
        above = text[above_begin:begin - 1]
        for name, pattern in labels:
            if pattern.search(above[-48:]):
                return name
    return ""


def find_dates(text: str, day_first: bool | None = None) -> list[dict[str, Any]]:
    """Dates written in the text, normalised to ISO 8601, with the label before them (issued, due,
    period). Numeric dates where day and month could swap are read day first unless the text looks
    American (USD, sales tax), and are marked ambiguous."""
    if day_first is None:
        day_first = not _US_HINTS.search(text)
    taken: list[tuple[int, int]] = []
    found: list[tuple[int, dict[str, Any]]] = []
    for kind, pattern in _DATE_PATTERNS:
        for match in pattern.finditer(text):
            if any(match.start() < end and start < match.end() for start, end in taken):
                continue
            ambiguous = False
            try:
                if kind == "ymd":
                    year, month, day = int(match[1]), int(match[2]), int(match[3])
                elif kind == "dmy_text":
                    day, month, year = int(match[1]), _MONTHS[match[2][:3].lower()], int(match[3])
                elif kind == "mdy_text":
                    month, day, year = _MONTHS[match[1][:3].lower()], int(match[2]), int(match[3])
                else:
                    first, second, year = int(match[1]), int(match[3]), int(match[4])
                    year = year + 2000 if year < 100 else year
                    if match[2] == "." or first > 12:
                        day, month = first, second
                    elif second > 12:
                        day, month = second, first
                    else:
                        day, month = (first, second) if day_first else (second, first)
                        ambiguous = first != second
                value = date(year, month, day)
            except (ValueError, KeyError):
                continue
            if not 1990 <= value.year <= 2100:
                continue
            taken.append((match.start(), match.end()))
            entry: dict[str, Any] = {"date": value.isoformat(), "text": match.group(0), "label": _label(text, match.start(), match.end(), _DATE_LABELS)}
            if ambiguous:
                entry["ambiguous"] = True
            found.append((match.start(), entry))
    out: list[dict[str, Any]] = []
    for _, entry in sorted(found, key=lambda item: item[0]):
        if not any(e["date"] == entry["date"] and e["label"] == entry["label"] for e in out):
            out.append(entry)
    return out


_CODES = r"USD|AUD|NZD|CAD|EUR|GBP|JPY|INR|CHF|SGD|HKD|SEK|NOK|DKK|BRL|MXN|ZAR|CNY"
_SYMBOLS = r"US\$|AU?\$|NZ\$|CA?\$|HK\$|S\$|R\$|[$€£¥₹]"
_NUMBER = r"\d{1,3}(?:[,.\u00a0 ]\d{3})+(?:[.,]\d{1,2})?(?!\d)|\d+(?:[.,]\d{1,2})?(?!\d)"
_AMOUNT = re.compile(
    rf"(?:(?P<sym>{_SYMBOLS})|\b(?P<code>{_CODES})\b)\s?(?P<num>{_NUMBER})"
    rf"|(?<![\d.,])(?P<num2>{_NUMBER})\s?(?:(?P<sym2>€)|\b(?P<code2>{_CODES})\b)"
)
_AMOUNT_LABELS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("due", re.compile(r"\b(amount due|balance due|total due|amount payable|total payable|due now|please pay)\b", re.I)),
    ("subtotal", re.compile(r"\b(sub-?total|net amount|net total|amount before tax|net)\b", re.I)),
    ("total", re.compile(r"\b(grand total|invoice total|total amount|total|summe|gesamtbetrag|importe total|montant total)\b", re.I)),
    ("tax", re.compile(r"\b(tax|gst|vat|hst|pst|mwst|ust)\b", re.I)),
    ("paid", re.compile(r"\b(paid|payment received|amount paid)\b", re.I)),
    ("balance", re.compile(r"\bbalance\b", re.I)),
)
_SYMBOL_NAMES = {"$": "$", "US$": "USD", "A$": "AUD", "AU$": "AUD", "NZ$": "NZD", "C$": "CAD", "CA$": "CAD", "HK$": "HKD", "S$": "SGD", "R$": "BRL", "€": "EUR", "£": "GBP", "¥": "JPY", "₹": "INR"}


def parse_number(raw: str) -> Decimal | None:
    """``1,234.56``, ``1.234,56``, ``1 234,56``, ``89,90`` or ``560`` -> Decimal (pure; tested)."""
    text = raw.replace("\u00a0", "").replace(" ", "")
    if re.fullmatch(r"\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+,\d{1,2}", text):
        text = text.replace(".", "").replace(",", ".")
    else:
        text = text.replace(",", "")
    try:
        return Decimal(text)
    except InvalidOperation:
        return None


def format_money(amount: Decimal, currency: str) -> str:
    """``$560.00``, ``€89.90``, ``AUD 1,234.50``: symbols lead, codes are followed by a space."""
    number = f"{amount:,.2f}"
    return f"{currency}{number}" if currency and not currency.isalpha() else f"{currency} {number}".strip()


def find_amounts(text: str) -> list[dict[str, Any]]:
    """Money written with a currency symbol or code, in reading order, each with the label before it
    on its line (due, total, subtotal, tax, paid, balance)."""
    out: list[dict[str, Any]] = []
    previous_end = 0
    for match in _AMOUNT.finditer(text):
        raw = match["num"] or match["num2"]
        value = parse_number(raw)
        if value is None:
            continue
        currency = match["sym"] or match["sym2"] or match["code"] or match["code2"] or ""
        begin, _ = _line_bounds(text, match.start())
        label = _label(text, match.start(), match.end(), _AMOUNT_LABELS, floor=previous_end if previous_end > begin else 0)
        previous_end = match.end()
        out.append({"amount": f"{value:.2f}", "currency": currency, "text": match.group(0).strip(), "label": label, "_value": value})
    return out


def pick_total(amounts: Sequence[dict[str, Any]]) -> dict[str, Any] | None:
    """The document's total: the largest amount labelled total or due (so a paid invoice keeps its
    total), else the largest amount that is not tax, a subtotal, a payment or a balance."""
    labelled = [a for a in amounts if a["label"] in ("due", "total")]
    pool = labelled or [a for a in amounts if a["label"] not in ("tax", "subtotal", "paid", "balance")] or list(amounts)
    if not pool:
        return None
    best = max(pool, key=lambda a: a["_value"])
    return {"amount": best["amount"], "currency": best["currency"], "text": best["text"], "formatted": format_money(best["_value"], best["currency"])}


_NUMBER_LABEL = re.compile(
    r"\b(?P<label>tax invoice|invoice|inv|rechnung|factura|facture|fattura|receipt|order|reference|ref|credit note|quote|quotation|bill|document)"
    r"[ \t]*(?P<marker>no\.?|number|num\.?|nr\.?|n[°º]\.?|#|id|nummer)?[ \t]*[:#.]?[ \t]*"
    r"(?P<value>(?=[A-Z0-9/-]*\d)[A-Z0-9][A-Z0-9/_.-]{0,30})",
    re.I,
)
_INVOICE_LABELS = frozenset({"tax invoice", "invoice", "inv", "rechnung", "factura", "facture", "fattura"})
_DATE_LIKE = re.compile(r"^(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4})$")


def find_numbers(text: str) -> list[dict[str, str]]:
    """Invoice, receipt, order and reference numbers: ``{label, value}`` in reading order."""
    out: list[dict[str, str]] = []
    for match in _NUMBER_LABEL.finditer(text):
        value = match["value"].rstrip(".,;:/-_")
        if not value or _DATE_LIKE.match(value):
            continue
        has_marker = bool(match["marker"])
        if not has_marker and not (re.search(r"[A-Za-z]", value) or "-" in value or "/" in value or len(value) >= 5):
            continue
        if not has_marker and re.fullmatch(r"(19|20)\d{2}", value):
            continue
        label = match["label"].lower()
        if not any(entry["value"] == value for entry in out):
            out.append({"label": label, "value": value})
    return out


_LEGAL = r"(?:pty\.?\s*ltd\.?|pty\.?\s*limited|pte\.?\s*ltd\.?|ltd\.?|limited|llc|l\.l\.c\.|inc\.?|incorporated|corp\.?|corporation|co\.|company|gmbh|ag|s\.a\.|sas|sarl|b\.v\.|bv|n\.v\.|plc|llp|oy|ab|aps|s\.r\.l\.|spa)"
_COMPANY = re.compile(rf"^(?P<name>[A-Za-z0-9][\w&'.\- ]{{0,60}}?\s{_LEGAL})(?=[\s,]|$)", re.I)
_SHORTEN = re.compile(r",?\s+(?:pty\.?\s*ltd\.?|pty\.?\s*limited|pte\.?\s*ltd\.?|ltd\.?|limited|llc|l\.l\.c\.|inc\.?|incorporated|gmbh|s\.a\.|b\.v\.|plc|llp)$", re.I)
_VENDOR_LABEL = re.compile(r"^(?:from|supplier|vendor|seller|sold by|issued by|billed by|payable to|pay to|make (?:cheques|checks) payable to)\s*[:\-]?\s*(?P<name>.+)$", re.I)
_CUSTOMER_LABEL = re.compile(r"^(bill(ed)? to|invoice to|ship(ped)? to|sold to|deliver(ed)? to|customer|client|attn|attention|recipient)\b", re.I)
_NOT_A_NAME = re.compile(r"^(tax invoice|invoice|receipt|statement|account statement|quote|quotation|estimate|credit note|page \d|total|subtotal|description|item|qty|quantity|amount|date|due|terms|summary|thank you)\b", re.I)


_GENERIC_LEAD = frozenset({"invoice", "tax", "receipt", "statement", "quote", "bill", "from", "by"})


def _looks_like_name(line: str) -> bool:
    words = line.split()
    if not 1 <= len(words) <= 6 or not 2 <= len(line) <= 60 or _NOT_A_NAME.match(line):
        return False
    if "@" in line or "://" in line or line.lower().startswith("www."):
        return False
    # "Attendees: Sam" is a labelled field and "1. Launch moves" a list item, not who wrote it.
    if re.match(r"^[\w ]{1,24}:", line) or re.match(r"^(\d+[.)]|[-•*])\s", line):
        return False
    return sum(ch.isdigit() for ch in line) <= 2 and sum(ch.isalpha() for ch in line) >= 2


def _tidy_name(name: str) -> str:
    name = re.split(r",\s|\s[-–|]\s", name.strip(), maxsplit=1)[0]
    return re.sub(r"\s+", " ", name).strip(" .:;-")


def _trim_company(name: str) -> str:
    """Drop what precedes a company name on its line (an ABN, a phone number, "Invoice from"): keep
    the words before the legal suffix that carry no digits."""
    kept: list[str] = []
    for word in reversed(name.split()):
        if any(ch.isdigit() for ch in word) or word.endswith(":"):
            break
        kept.append(word)
    kept.reverse()
    while len(kept) > 2 and kept[0].lower() in _GENERIC_LEAD:
        kept.pop(0)
    return " ".join(kept) or name


def vendor_candidates(text: str, limit: int = 3) -> list[tuple[str, int]]:
    """Who issued the document, best first: ``(name, score)``. Names after a vendor label, names with a
    company suffix and the first lines score; the bill-to block (the customer) is left out, and a name
    matching the e-mail or web domain scores higher."""
    lines = [re.sub(r"\s+", " ", line).strip() for line in text.splitlines()]
    lines = [line for line in lines if line]
    domains = {d.lower() for d in re.findall(r"[\w.+-]+@([\w-]+)\.", text)} | {d.lower() for d in re.findall(r"\bwww\.([\w-]+)\.", text, re.I)}
    scores: dict[str, int] = {}
    customer_lines = 0
    for index, line in enumerate(lines[:80]):
        if _CUSTOMER_LABEL.match(line):
            customer_lines = 2 if re.match(r"^\S+(\s\S+)?\s*:?\s*$", line) else 0
            continue
        if customer_lines:
            customer_lines -= 1
            continue
        name, score = None, 0
        labelled = _VENDOR_LABEL.match(line)
        company = _COMPANY.match(line)
        if labelled:
            name, score = labelled["name"], 4
        elif company:
            name, score = _trim_company(company["name"]), 3
        elif index < 3 and _looks_like_name(line):
            name, score = line, 3 - index
        if not name:
            continue
        name = _tidy_name(name)
        if not name or not _looks_like_name(name) and not company:
            continue
        squashed = re.sub(r"[^a-z0-9]", "", name.lower())
        if squashed and any(d.startswith(squashed[:6]) or squashed.startswith(d) for d in domains):
            score += 2
        if index == 0:
            score += 1
        scores[name] = max(scores.get(name, 0), score)
    return sorted(scores.items(), key=lambda item: item[1], reverse=True)[:limit]


def short_vendor(name: str) -> str:
    """The vendor for a file name: long legal suffixes dropped (``Pty Ltd``, ``GmbH``, ``LLC``)."""
    return _SHORTEN.sub("", name).strip() or name


def safe_filename(name: str, limit: int = 120) -> str:
    """A file name every desktop accepts: no slashes, colons or control characters, single spaces."""
    cleaned = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "-", name)
    cleaned = re.sub(r"\s+", " ", cleaned).strip(" .")
    return cleaned[:limit].rstrip(" .")


_NAMED_KINDS = frozenset({"invoice", "receipt", "statement", "quote", "credit note", "payslip", "order"})
_MONEY_KINDS = frozenset({"invoice", "receipt", "quote", "credit note", "order"})


def suggest_name(hints: dict[str, Any], extension: str) -> str | None:
    """``YYYY-MM-DD Vendor kind NUMBER TOTAL.ext`` from the hints, or None when there is too little to
    go on (the person's own convention, when they have one, wins over this)."""
    kind = hints.get("kind")
    if kind not in _NAMED_KINDS or not (hints.get("date") or hints.get("vendor")):
        return None
    parts = [hints.get("date") or "", short_vendor(hints["vendor"]) if hints.get("vendor") else "", kind, hints.get("number") or ""]
    total = hints.get("total")
    if total and kind in _MONEY_KINDS:
        parts.append(total["formatted"])
    return safe_filename(" ".join(p for p in parts if p)) + extension.lower()


def detect_fields(text: str) -> dict[str, Any]:
    """Everything the agent needs to identify and name a document, read from its text."""
    kind, confidence, signals = classify(text)
    dates = find_dates(text)
    amounts = find_amounts(text)
    numbers = find_numbers(text)
    vendors = vendor_candidates(text)
    issued = next((d for d in dates if d["label"] == "issued"), None) or next((d for d in dates if d["label"] not in ("due", "period")), None)
    if issued is None and kind == "statement":
        # A statement is known by the end of its period.
        issued = next((d for d in reversed(dates) if d["label"] == "period"), None)
    due = next((d for d in dates if d["label"] == "due"), None)
    number = next((n["value"] for n in numbers if n["label"] in _INVOICE_LABELS), None)
    if number is None and kind != "invoice":
        number = next((n["value"] for n in numbers if n["label"] == kind), None)
    total = pick_total(amounts)
    codes = [a["currency"] for a in amounts if a["currency"].isalpha()]
    currency = codes[0] if codes else _SYMBOL_NAMES.get(total["currency"], total["currency"]) if total else None
    return {
        "kind": kind,
        "confidence": confidence,
        "signals": signals,
        "vendor": vendors[0][0] if vendors and vendors[0][1] >= 3 else None,
        "vendor_candidates": [name for name, _ in vendors],
        "date": issued["date"] if issued else None,
        "date_ambiguous": bool(issued and issued.get("ambiguous")),
        "due_date": due["date"] if due else None,
        "number": number,
        "total": total,
        "currency": currency or None,
        "dates": dates[:5],
        "amounts": [{k: v for k, v in a.items() if k != "_value"} for a in amounts[:6]],
        "numbers": numbers[:4],
    }


# ---------------------------------------------------------------------------------------------
# The pictures inside a scanned PDF (OCR on Linux when no PDF renderer is installed).
# ---------------------------------------------------------------------------------------------

@dataclass
class PageImage:
    data: bytes
    extension: str  # .jpg, .jp2, .pgm, .ppm, .pbm or .tif: formats tesseract reads.
    width: int
    height: int


_OBJ = re.compile(rb"(\d+)\s+(\d+)\s+obj\b")
_MIN_PAGE_PIXELS = 200


def _balanced_dict(data: bytes, start: int) -> int | None:
    """Index just past the ``>>`` closing the dictionary that opens at ``start``."""
    depth, i, size = 0, start, len(data)
    while i < size - 1:
        if data[i] == 0x28:  # "(": a literal string may contain "<<" or ">>".
            nesting, i = 1, i + 1
            while i < size and nesting:
                if data[i] == 0x5C:
                    i += 2
                    continue
                nesting += 1 if data[i] == 0x28 else -1 if data[i] == 0x29 else 0
                i += 1
            continue
        pair = data[i:i + 2]
        if pair == b"<<":
            depth, i = depth + 1, i + 2
            continue
        if pair == b">>":
            depth, i = depth - 1, i + 2
            if depth == 0:
                return i
            continue
        i += 1
    return None


def _int_entry(dictionary: bytes, key: bytes, default: int | None = None) -> int | None:
    match = re.search(rb"/" + key + rb"\s+(-?\d+)\b(?!\s+\d+\s+R)", dictionary)
    return int(match[1]) if match else default


def _sub_dict(dictionary: bytes, key: bytes) -> bytes:
    """The nested dictionary under ``key`` (``/DecodeParms << ... >>``), or empty bytes."""
    match = re.search(rb"/" + key + rb"\s*\[?\s*<<", dictionary)
    if not match:
        return b""
    start = match.end() - 2
    end = _balanced_dict(dictionary, start)
    return dictionary[start:end] if end else b""


def _filters(dictionary: bytes) -> list[str]:
    """The ``/Filter`` names in order (a single name or an array)."""
    match = re.search(rb"/Filter\s*(\[[^\]]*\]|/\w+)", dictionary)
    return [name.decode() for name in re.findall(rb"/(\w+)", match[1])] if match else []


def _resolve_int(data: bytes, dictionary: bytes, key: bytes) -> int | None:
    """A direct integer entry, or an indirect one (``/Length 12 0 R``) looked up in its object."""
    ref = re.search(rb"/" + key + rb"\s+(\d+)\s+(\d+)\s+R", dictionary)
    if ref:
        target = re.search(rb"(?<!\d)" + ref[1] + rb"\s+" + ref[2] + rb"\s+obj\s*(\d+)\s*endobj", data)
        return int(target[1]) if target else None
    return _int_entry(dictionary, key)


def _components(data: bytes, dictionary: bytes) -> int | None:
    if re.search(rb"/ColorSpace\s*/DeviceGray|/ColorSpace\s*/G\b|/ColorSpace\s*/CalGray", dictionary):
        return 1
    if re.search(rb"/ColorSpace\s*/DeviceRGB|/ColorSpace\s*/RGB\b|/ColorSpace\s*/CalRGB", dictionary):
        return 3
    if re.search(rb"/ColorSpace\s*/DeviceCMYK", dictionary):
        return 4
    icc = re.search(rb"/ColorSpace\s*\[\s*/ICCBased\s+(\d+)\s+(\d+)\s+R", dictionary)
    if icc:
        target = re.search(rb"(?<!\d)" + icc[1] + rb"\s+" + icc[2] + rb"\s+obj\s*<<(.{0,400}?)>>", data, re.S)
        if target:
            return _int_entry(target[1], b"N")
    return None


def _unpredict(raw: bytes, columns: int, colors: int, predictor: int) -> bytes | None:
    """Undo PNG row predictors (PDF ``/Predictor`` 10-15) for 8-bit samples."""
    if predictor < 10:
        return raw if predictor <= 1 else None
    stride = columns * colors
    out = bytearray()
    previous = bytearray(stride)
    for row_start in range(0, len(raw), stride + 1):
        kind = raw[row_start]
        row = bytearray(raw[row_start + 1:row_start + 1 + stride])
        if len(row) < stride:
            break
        for i in range(stride):
            left = row[i - colors] if i >= colors else 0
            up = previous[i]
            corner = previous[i - colors] if i >= colors else 0
            if kind == 1:
                row[i] = (row[i] + left) & 0xFF
            elif kind == 2:
                row[i] = (row[i] + up) & 0xFF
            elif kind == 3:
                row[i] = (row[i] + ((left + up) >> 1)) & 0xFF
            elif kind == 4:
                p = left + up - corner
                pa, pb, pc = abs(p - left), abs(p - up), abs(p - corner)
                row[i] = (row[i] + (left if pa <= pb and pa <= pc else up if pb <= pc else corner)) & 0xFF
        out += row
        previous = row
    return bytes(out)


def ccitt_tiff(data: bytes, width: int, height: int, k: int, black_is_1: bool) -> bytes:
    """Wrap CCITT fax data from a PDF in a one-strip TIFF (Group 4 when ``k`` < 0, else Group 3)."""
    compression = 4 if k < 0 else 3
    # TIFF fax decoders write black runs as 1 bits; BlackIs1 in a PDF inverts how they are drawn.
    entries = [(256, 4, width), (257, 4, height), (258, 3, 1), (259, 3, compression), (262, 3, 1 if black_is_1 else 0), (273, 4, 0), (277, 3, 1), (278, 4, height), (279, 4, len(data))]
    if compression == 3:
        entries.append((292, 4, 1 if k > 0 else 0))
    entries.sort()
    header_size = 8 + 2 + 12 * len(entries) + 4
    body = bytearray(b"II*\x00" + struct.pack("<I", 8) + struct.pack("<H", len(entries)))
    for tag, kind, value in entries:
        value = header_size if tag == 273 else value
        packed = struct.pack("<HHI", tag, kind, 1) + (struct.pack("<HH", value, 0) if kind == 3 else struct.pack("<I", value))
        body += packed
    body += struct.pack("<I", 0)
    return bytes(body) + data


def page_images(pdf: bytes, limit: int) -> list[PageImage]:
    """The pictures a scanned PDF is made of, in file order, as files tesseract reads: JPEG and JPEG
    2000 as stored, 8-bit grey or RGB and 1-bit Flate data as PGM, PPM or PBM, CCITT fax data wrapped
    in a TIFF. Small pictures (logos), masks and JBIG2 data are skipped."""
    masks = {int(n) for n in re.findall(rb"/(?:SMask|Mask)\s+(\d+)\s+\d+\s+R", pdf)}
    images: list[PageImage] = []
    for match in _OBJ.finditer(pdf):
        if len(images) >= limit:
            break
        start = match.end()
        while start < len(pdf) and pdf[start] in b" \t\r\n":
            start += 1
        if pdf[start:start + 2] != b"<<" or int(match[1]) in masks:
            continue
        end = _balanced_dict(pdf, start)
        if end is None:
            continue
        dictionary = pdf[start:end]
        if not re.search(rb"/Subtype\s*/Image\b", dictionary) or re.search(rb"/ImageMask\s+true", dictionary):
            continue
        stream = re.match(rb"\s*stream\r?\n", pdf[end:end + 32])
        if not stream:
            continue
        data_start = end + stream.end()
        length = _resolve_int(pdf, dictionary, b"Length")
        if length is None or pdf[data_start + length:data_start + length + 20].lstrip()[:9] != b"endstream":
            stop = pdf.find(b"endstream", data_start)
            if stop < 0:
                continue
            length = len(pdf[data_start:stop].rstrip(b"\r\n"))
        raw = pdf[data_start:data_start + length]
        width, height = _int_entry(dictionary, b"Width", 0) or 0, _int_entry(dictionary, b"Height", 0) or 0
        if width < _MIN_PAGE_PIXELS or height < _MIN_PAGE_PIXELS:
            continue
        filters = _filters(dictionary)
        parms = _sub_dict(dictionary, b"DecodeParms")
        try:
            while len(filters) > 1 and filters[0] in ("FlateDecode", "Fl"):
                raw, filters = zlib.decompress(raw), filters[1:]
        except zlib.error:
            continue
        last = filters[-1] if filters else ""
        if last in ("DCTDecode", "DCT"):
            images.append(PageImage(raw, ".jpg", width, height))
        elif last == "JPXDecode":
            images.append(PageImage(raw, ".jp2", width, height))
        elif last in ("CCITTFaxDecode", "CCF"):
            k = _int_entry(parms, b"K", 0) or 0
            black = bool(re.search(rb"/BlackIs1\s+true", parms))
            images.append(PageImage(ccitt_tiff(raw, _int_entry(parms, b"Columns", width) or width, _int_entry(parms, b"Rows", height) or height, k, black), ".tif", width, height))
        elif last in ("FlateDecode", "Fl"):
            bits = _int_entry(dictionary, b"BitsPerComponent", 8) or 8
            colors = 1 if bits == 1 else _components(pdf, dictionary)
            predictor = _int_entry(parms, b"Predictor", 1) or 1
            try:
                pixels = zlib.decompress(raw)
            except zlib.error:
                continue
            if bits == 8 and colors in (1, 3):
                pixels = _unpredict(pixels, width, colors, predictor)
                if pixels is None or len(pixels) < width * height * colors:
                    continue
                magic = b"P5" if colors == 1 else b"P6"
                images.append(PageImage(magic + b"\n%d %d\n255\n" % (width, height) + pixels[: width * height * colors], ".pgm" if colors == 1 else ".ppm", width, height))
            elif bits == 1 and predictor <= 1:
                row = (width + 7) // 8
                if len(pixels) < row * height:
                    continue
                # PDF grey: a 0 bit is black; PBM: a 1 bit is black.
                inverted = bytes(b ^ 0xFF for b in pixels[: row * height])
                images.append(PageImage(b"P4\n%d %d\n" % (width, height) + inverted, ".pbm", width, height))
    return images


# ---------------------------------------------------------------------------------------------
# Where this person files documents.
# ---------------------------------------------------------------------------------------------

FILING_WORDS = re.compile(r"\b(invoices?|receipts?|bills|financ(e|es|ial)|accounts|accounting|bookkeeping|tax(es)?|expenses?|statements?|paperwork|payslips?)\b", re.I)
_SKIP_DIRS = frozenset({"Library", "Applications", "node_modules", "__pycache__", "venv", "site-packages", "Music", "Movies", "Pictures", "Videos", "Photos"})
# Folders macOS shows as single files (apps, photo and music libraries): never filing places.
_BUNDLES = (".app", ".photoslibrary", ".musiclibrary", ".tvlibrary", ".imovielibrary", ".fcpbundle", ".lrlibrary", ".bundle", ".framework", ".pkg", ".xcodeproj")
_YEAR = re.compile(r"^(?:FY\s?)?(?:19|20)\d{2}(?:\s?[-–/]\s?(?:\d{2}|\d{4}))?$", re.I)
_MONTH_FOLDER = re.compile(rf"^(?:(?:19|20)\d{{2}}[-_ .](?:0?[1-9]|1[0-2])\b|(?:0?[1-9]|1[0-2])[-_ .]?\s*{_MONTH}|{_MONTH}$)", re.I)
_MAX_VISITS = 4000
_MAX_PLACES = 12


def parse_user_dirs(text: str, home: Path) -> dict[str, Path]:
    """``~/.config/user-dirs.dirs`` (``XDG_DOCUMENTS_DIR="$HOME/Dokumente"``) -> name -> folder."""
    out: dict[str, Path] = {}
    for match in re.finditer(r'^XDG_([A-Z]+)_DIR="?([^"\n]+)"?', text, re.M):
        out[match[1].lower()] = Path(match[2].replace("$HOME", str(home)))
    return out


def default_roots(home: Path | None = None) -> list[tuple[Path, int]]:
    """Where documents usually live, with how deep to look: Documents, Desktop and the cloud drives
    three levels down, the home folder itself one level."""
    home = home or Path.home()
    xdg: dict[str, Path] = {}
    try:
        xdg = parse_user_dirs((home / ".config" / "user-dirs.dirs").read_text(encoding="utf-8"), home)
    except OSError:
        pass
    deep = [xdg.get("documents", home / "Documents"), xdg.get("desktop", home / "Desktop"), home / "Library" / "Mobile Documents" / "com~apple~CloudDocs",
            home / "Dropbox", home / "OneDrive", home / "Google Drive", home / "Nextcloud"]
    # Recent macOS keeps Dropbox, Google Drive and OneDrive under ~/Library/CloudStorage.
    try:
        with os.scandir(home / "Library" / "CloudStorage") as listing:
            deep += sorted(Path(entry.path) for entry in listing if entry.is_dir() and not entry.name.startswith("."))
    except OSError:
        pass
    roots = [(path, 3) for path in dict.fromkeys(deep) if path.is_dir()]
    return [*roots, (home, 1)] if home.is_dir() else roots


def describe_place(folder: Path) -> dict[str, Any]:
    """A filing folder: how it is organised (by year, by month, by vendor or topic, or flat), its
    subfolders and its newest file names (to copy the naming convention)."""
    subfolders: list[str] = []
    direct_files = 0
    try:
        with os.scandir(folder) as listing:
            for entry in listing:
                if entry.name.startswith("."):
                    continue
                if entry.is_dir(follow_symlinks=False):
                    subfolders.append(entry.name)
                elif entry.is_file():
                    direct_files += 1
    except OSError:
        pass
    subfolders.sort()
    years = [name for name in subfolders if _YEAR.match(name)]
    months = [name for name in subfolders if _MONTH_FOLDER.match(name)]
    if years and len(years) * 2 >= len(subfolders):
        layout = "by year"
    elif months and len(months) * 2 >= len(subfolders):
        layout = "by month"
    elif subfolders:
        layout = "by vendor or topic"
    else:
        layout = "flat"
    files: list[tuple[float, str]] = []
    for root, dirs, names in os.walk(folder):
        depth = len(Path(root).relative_to(folder).parts)
        dirs[:] = [d for d in dirs if not d.startswith(".")] if depth < 2 else []
        for name in names:
            if name.startswith("."):
                continue
            try:
                files.append((os.stat(os.path.join(root, name)).st_mtime, str(Path(root, name).relative_to(folder))))
            except OSError:
                continue
        if len(files) > 2000:
            break
    newest = [name for _, name in sorted(files, reverse=True)[:6]]
    return {"path": str(folder), "layout": layout, "subfolders": subfolders[:20], "files": direct_files, "samples": newest}


def find_places(roots: Iterable[tuple[Path, int]], skip: Any = None) -> dict[str, Any]:
    """Folders named like a filing place (Invoices, Receipts, Finances, Bills, Tax, Statements, ...)
    under the roots, each described. ``skip(path)`` returns True for folders never to enter."""
    places: list[dict[str, Any]] = []
    searched: list[str] = []
    visits = 0
    seen: set[str] = set()
    for root, max_depth in roots:
        searched.append(str(root))
        for current, dirs, _ in os.walk(root):
            visits += 1
            depth = len(Path(current).relative_to(root).parts)
            keep = []
            for name in sorted(dirs):
                path = Path(current, name)
                if name.startswith(".") or name in _SKIP_DIRS or name.lower().endswith(_BUNDLES) or os.path.islink(path):
                    continue
                if skip is not None and skip(path):
                    continue
                if FILING_WORDS.search(name) and str(path) not in seen and len(places) < _MAX_PLACES:
                    seen.add(str(path))
                    places.append(describe_place(path))
                keep.append(name)
            dirs[:] = keep if depth + 1 < max_depth else []
            if visits >= _MAX_VISITS:
                break
        if visits >= _MAX_VISITS:
            break
    note = None if places else "No folders named like Invoices, Receipts, Finances, Bills, Tax or Statements; ask the person where these go before creating one."
    if visits >= _MAX_VISITS:
        note = "Stopped after looking through many folders; pass roots to search a specific place."
    return {"places": places, "searched": searched, "note": note}


__all__ = [
    "DocumentText", "EMPTY_PAGE_CHARS", "IMAGE_EXTENSIONS", "MAX_DOCUMENT_BYTES", "PDF_EXTENSIONS", "PageImage",
    "ccitt_tiff", "classify", "collect_documents", "count_pdf_pages", "default_roots", "describe_place",
    "detect_fields", "document_type", "find_amounts", "find_dates", "find_numbers", "find_places", "format_money",
    "join_pages", "page_images", "parse_number", "parse_user_dirs", "pick_total", "plain_text", "safe_filename", "sha256_file",
    "short_vendor", "split_pdftotext", "suggest_name", "text_with_python", "vendor_candidates",
]
