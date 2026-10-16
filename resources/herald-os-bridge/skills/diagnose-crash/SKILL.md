---
name: diagnose-crash
description: Explain why a program crashed from its crash report or core dump, and whether it is worth reporting
metadata:
  hermes:
    tags: [herald-os, crash, diagnostics, macos, linux]
---

# Diagnose a crash

Herald OS offers this when a program on the computer crashes and the person chooses "Ask Hermes".
The opening message says which program crashed, when, and where its report is. Your job: find out
what happened from the evidence, explain it in plain words, and say what to do next.

## 1. Gather the facts (all read-only)

- `system_logs action=crash_report report=<path or pid>` is the starting point. On macOS it returns
  the exception type and signal, the termination reason, the program's own last messages
  (`app_messages`) and the crashed thread's top frames; on Linux it returns `coredumpctl info`, which
  includes a stack trace when debug symbols are installed.
- No report named? `system_logs action=crashes` lists recent crashes; pick the program the person
  means, or ask.
- Context when it helps: `system_logs action=log minutes=15 level=any process=<name>` for what the
  program logged just before; `system_info` for memory pressure or a full disk; `system_processes
  action=find name=<name>` to see whether it is running again.

## 2. Read it like an engineer

- **EXC_BAD_ACCESS / SIGSEGV / SIGBUS**: the program touched memory it did not own. Usually a bug in
  the program or in something loaded into it (a plugin, extension, input method, driver). SIGBUS can
  also mean a file it had mapped went away (an ejected disk, a file replaced during an update).
- **EXC_CRASH (SIGABRT)**: the program stopped itself on purpose. `app_messages` or the frames
  (`abort`, `__assert_rtn`, `objc_exception_throw`) usually say why.
- **EXC_BREAKPOINT / SIGTRAP / SIGILL**: a deliberate trap, such as a Swift `fatalError`, a Rust
  panic or an index out of range.
- **SIGKILL from the system, jetsam, EXC_RESOURCE**: it was stopped for using too much memory or CPU.
- **Termination namespace CODESIGNING**: the app's signature is broken (a damaged or modified app);
  reinstalling fixes it.
- **Crash at launch** (frames in `dyld` or start-up code): a broken install or update, or a missing
  library.
- In the frames, the first one inside the program's own binary or a third-party library is the
  likely culprit. System libraries at the top (`libsystem_kernel`, `libobjc`, `libc.so`) only show
  where it stopped; look below them. A third-party name in the frames points at that component.

## 3. Tell the person

- Lead with one or two sentences in their words: what went wrong and where ("Safari stopped while a
  content-blocker extension was reading a page"). Say "the report shows" for facts and "probably" for
  inferences; never guess past the evidence.
- Say whether it is likely to happen again and what they can do: update the app, turn off the
  extension, reinstall, close something that is using the memory, free disk space. Offer to do the
  parts you can with your tools, and do them only when they say yes.
- Say whether it is worth reporting. It is when the crash is in the program's own code and it
  happens again or can be reproduced. Offer to draft the report: a summary, steps to reproduce, the
  environment (from `system_info`), the exception and the top frames. Replace the home folder with
  `~` and leave out anything personal. The person sends it; you never send a report anywhere.
- If the report is missing or unreadable, say so and tell them what to watch for next time.

## Norms

- Do not paste the raw report or long stack traces into the chat; quote the two or three lines that
  matter.
- Programs that crash often and do not matter to the person can be muted: the notification has a
  "Mute" button, or run `os_ui action=run command=crash.mute args={"app": "<name>"}`.
