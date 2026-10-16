---
name: file-documents
description: Find documents such as invoices among badly named files, read them, name them clearly and file them where the person keeps them, with a plan they approve and an undo
metadata:
  hermes:
    tags: [herald-os, files, documents, invoices, ocr]
---

# File documents

Use this when the person asks to find, rename, sort or file documents: "find the invoice from Acme
in my Downloads, rename it properly and put it where it belongs", "file the invoices in this
folder", "sort out these scans", "where did the plumber's invoice go?". Names like scan0001.pdf,
document(3).pdf or IMG_2231.pdf say nothing about the file: read the documents themselves.

## 1. Find the candidates

- The folder is the one they name ("my Downloads" is ~/Downloads). "This folder" or "this file" is
  what is on screen: spoken requests carry it in the conversation context ("Screen: the Files page
  shows …"); otherwise `os_ui action=state` returns it under `files` (folder and selected file).
- `system_documents action=read path=<folder>` reads every PDF and image directly inside the folder,
  scans and photos of documents through OCR on this computer. Pass `paths` for several files.
  Documents past the limit come back under `skipped`: read them in a second call.
- Searching the whole computer for a word: `system_find_files kind=pdf text=Acme` first. On macOS
  Spotlight looks inside PDFs (not inside scans); on Linux it matches names only, so read the likely
  folders (Downloads, Desktop, Documents) instead.

## 2. Identify the right document

- Each document comes back with its text and `hints`: kind, vendor, date (issued), due_date, number,
  total, currency, and a `suggested_name`. Hints are guesses: confirm them in the text. The vendor
  is who issued the document, never the bill-to customer; the date is the invoice date, not the due
  date.
- Receipts, statements, quotes, payslips and contracts are not invoices: leave files that do not
  match alone unless they asked to sort everything.
- `date_ambiguous`: 03/09/2026 is 3 September or 9 March. Use the document's other dates, its
  country (currency, address) or ask.
- Files listed together under `duplicates` are byte-for-byte copies: file one and offer to move
  the other to the Trash (that always asks). Same vendor, number and total but different files is
  the same invoice twice (an emailed copy and a scan, say): ask which to keep.
- Several matches for "the invoice from Acme": choose by what they said (the latest, the amount, the
  month) or ask, naming two or three by date and total. No match: say what you found instead ("two
  receipts and a bank statement, no invoice from Acme").

## 3. Name it

- Follow the person's convention when their filed documents show one (the `samples` from
  `system_documents action=places`, such as `2026-08-02 Telstra invoice 9921 $89.00.pdf`): the same
  date format, word order and whether the amount is included.
- No convention to follow: `YYYY-MM-DD Vendor kind number total.ext`, for example
  `2026-09-14 Acme Corp invoice INV-1234 $560.00.pdf`. `suggested_name` has this shape already.
  Leave out what is not known rather than guess, keep the extension, and use short vendor names
  (no "Pty Ltd" or "GmbH").

## 4. Find where it belongs

- `system_documents action=places` lists the folders documents are already filed in (Invoices,
  Receipts, Finances, Bills, Tax, Statements and the like under Documents, Desktop, the home folder
  and cloud drives), each with its `layout`, subfolders and newest files.
- Follow the structure: by year means the year of the document's date; by vendor or topic means the
  matching subfolder (invoices with invoices, receipts with receipts); flat means the folder itself.
  A place they name ("put it in my tax folder") wins.
- In a by-year layout you may create the missing year folder (one level, same pattern). Anything
  bigger, or no filing place at all: ask where these should go and suggest one (for example
  ~/Documents/Invoices/2026). Never invent a new folder tree on your own.

## 5. Plan, approve, apply

- One `system_files action=batch` call: `mkdir` first when needed, then a `move` per document with
  `to` set to the new full path (moving and renaming in one step). Run it with `dry_run=true`. The
  plan says where each file lands; `problems` lists clashes, because nothing is ever overwritten. A
  clash with a file already filed: read both with `system_documents` and compare `sha256` (equal
  means it is already filed); otherwise make the name unique (add the number, or " (2)").
- Typed conversation: show the plan as "old name -> new name in folder" lines and ask before
  applying. Spoken conversation: say it in a sentence or two ("I'll rename scan0001 to the Acme
  invoice of 14 September and put it in Invoices 2026; say yes to go ahead"), then apply. The
  approval card is their confirmation, and in a spoken conversation they answer it by saying "yes"
  or "no": do not ask for a yes in a turn of its own before showing the card.
- Apply with the same operations and `dry_run=false`. The person approves the card. A denial means
  stop and ask what they want instead; do not retry around it.

## 6. Report and undo

- Say what moved where in one or two sentences and show it:
  `os_ui action=run command=files.show args={"path": "<new path>"}` opens Files with the file
  selected.
- "Undo that", "put it back" or "that's wrong" means `system_files action=undo`: the tool replays
  the exact reverse of the last batch you applied in this conversation and asks again (`undo_id`
  from an earlier result picks another; `dry_run=true` shows it first). Never retype the paths.
  Folders you created stay where they are: mention them. Undoing a copy moves the copy to the Trash.
- A batch that stopped partway returns `applied` and an `undo_id` for the part that ran: say what
  was done and offer to undo it (`action=undo`) or finish the rest.

## Norms

- Read-only until the plan is approved: never move or rename a file to look at it.
- Never delete. Duplicates go to the Trash only when the person agrees.
- Do not paste whole documents into the chat: quote the line that matters (the total, the number).
- Invoices are private: do not save their contents to memory. Saving how the person likes documents
  named or filed is useful; offer it after the first filing.
- On Linux, scans are read with tesseract and PDF text with pdftotext when poppler-utils is
  installed (the runtime's own converter otherwise). When a result says something is not installed,
  tell the person the package it names.
