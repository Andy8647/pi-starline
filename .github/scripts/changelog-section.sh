#!/usr/bin/env bash
#
# Print one version's section from CHANGELOG.md, for use as GitHub release notes.
#
#   .github/scripts/changelog-section.sh 0.2.1 [path/to/CHANGELOG.md]
#   .github/scripts/changelog-section.sh v0.2.1
#
# The section is everything between `## [0.2.1] - <date>` and the next `## `
# heading, with the link-reference definitions at the foot of the file dropped
# (they belong to the whole document, not to the last section) and surrounding
# blank lines trimmed.
#
# Exits non-zero, with the reason on stderr, when the version has no heading or
# its section is empty. The publish workflow runs this before it publishes to
# npm, so an undocumented release fails while it can still be fixed with a
# retagged commit rather than a version burnt on the registry.

set -euo pipefail

if [ $# -lt 1 ]; then
	echo "usage: $(basename "$0") <version> [changelog]" >&2
	exit 2
fi

version="${1#v}"
changelog="${2:-$(dirname "$0")/../../CHANGELOG.md}"

if [ ! -f "$changelog" ]; then
	echo "No changelog at ${changelog}." >&2
	exit 1
fi

section=$(
	awk -v want="## [${version}]" '
		# A "## " line either opens the section we want or closes it.
		/^## / {
			if (found) exit
			found = (index($0, want) == 1)
			next
		}
		# Link-reference definitions live at the foot of the file and would
		# otherwise be swept into whichever section comes last.
		found && /^\[[^]]+\]: / { next }
		found { print }
	' "$changelog"
)

# Command substitution has already eaten the trailing blank lines; this drops
# the leading ones, so the notes start at the first real line.
section=$(printf '%s\n' "$section" | sed -e '/./,$!d')

if [ -z "$(printf '%s' "$section" | tr -d '[:space:]')" ]; then
	echo "::error::CHANGELOG.md has no entry for ${version}. Add a '## [${version}] - YYYY-MM-DD' section describing what changed, then retag." >&2
	exit 1
fi

printf '%s\n' "$section"
