// A second look at a command before it runs: an approval one key away should
// not read the same for `rm -rf` as for `ls`. Patterns, so this catches the
// common ways to lose work; it warns and never decides for the user.

const RISKS: readonly [RegExp, string][] = [
  [/\brm\s+(?:-\S+\s+)*-\S*[rRf]/, "Deletes files, which may not come back"],
  [/\bfind\b.*\s-delete\b/, "Deletes files, which may not come back"],
  [/\bgit\s+reset\s+.*--hard\b/, "Throws away uncommitted work"],
  [/\bgit\s+clean\s+.*-\S*f/, "Deletes untracked files"],
  [/\bgit\s+(?:checkout|restore)\s+(?:.*\s)?(?:--\s|\.(?:\s|$))/, "Throws away uncommitted work"],
  [/\bgit\s+push\b.*(?:--force|\s-f\b)/, "Overwrites history on the remote"],
  [/\b(?:drop|truncate)\s+(?:table|database|schema)\b/i, "Destroys data in a database"],
  [/\b(?:mkfs\S*|dd\s+.*\bof=)/, "Overwrites a disk or file directly"],
  [/\b(?:curl|wget)\b[^|]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/, "Runs a script from the network"],
  [/\bsudo\b/, "Runs with root privileges"],
];

/** What could go wrong running `command`, in words for a warning, or null when nothing stands out. */
export function commandRisk(command: string): string | null {
  return RISKS.find(([pattern]) => pattern.test(command))?.[1] ?? null;
}
