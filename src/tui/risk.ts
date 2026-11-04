// A second look at a command before it runs: an approval one key away should
// not read the same for `rm -rf` as for `ls`. Patterns, so this catches the
// common ways to lose work; it warns and never decides for the user.

// One command of a chain: `[^;&|]*` keeps a flag on the next from counting for this one.
const RISKS: readonly [RegExp, string][] = [
  [/(?<![-\w])rm\s+(?:-\S+\s+)*-\S*[rRf]/, "Deletes files, which may not come back"],
  [/\bfind\b[^;&|]*\s-delete\b/, "Deletes files, which may not come back"],
  [/\bgit\s+reset\s+[^;&|]*--hard\b/, "Throws away uncommitted work"],
  [/\bgit\s+clean\s+[^;&|]*-\S*f/, "Deletes untracked files"],
  [
    // `restore --staged` only unstages.
    /\bgit\s+(?:checkout|restore(?![^;&|]*--staged))\s+(?:[^;&|]*\s)?(?:--\s|\.(?:\s|$))/,
    "Throws away uncommitted work",
  ],
  [/\bgit\s+push\b[^;&|]*(?:--force|\s-f\b)/, "Overwrites history on the remote"],
  [/\b(?:drop|truncate)\s+(?:table|database|schema)\b/i, "Destroys data in a database"],
  [/\b(?:mkfs\S*|dd\s+[^;&|]*\bof=)/, "Overwrites a disk or file directly"],
  [/\b(?:curl|wget)\b[^|]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/, "Runs a script from the network"],
  // Where a command would start: `grep sudo README` only reads about it.
  [/(?:^\s*|[;&|(]\s*)sudo\s/m, "Runs with root privileges"],
];

/** What could go wrong running `command`, in words for a warning, or null when nothing stands out. */
export function commandRisk(command: string): string | null {
  return RISKS.find(([pattern]) => pattern.test(command))?.[1] ?? null;
}
