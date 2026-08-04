#!/usr/bin/env bash
#
# PreToolUse(Bash) guard for this private fork of Sienci-Labs/gsender.
#
# Enforces the "never contribute upstream" rule in CLAUDE.md by denying:
#   - git push to any remote other than `origin`
#   - git remote add / set-url (only `origin` -> marcinobel/gsender may exist)
#   - gh pr create without an explicit --repo marcinobel/gsender
#   - any writing `gh` command aimed at Sienci-Labs/*
#
# Reading upstream (fetch, ls-remote, gh ... view/list) stays allowed.
#
# Reads the PreToolUse payload on stdin, emits a permissionDecision on stdout.

set -uo pipefail

OWN_REPO='marcinobel/gsender'
UPSTREAM_RE='[Ss]ienci-[Ll]abs'

payload=$(cat)
cmd=$(printf '%s' "$payload" | jq -r '.tool_input.command // empty' 2>/dev/null)
[ -z "$cmd" ] && exit 0

deny() {
	jq -n --arg r "$1" '{
		hookSpecificOutput: {
			hookEventName: "PreToolUse",
			permissionDecision: "deny",
			permissionDecisionReason: $r
		}
	}'
	exit 0
}

# Collapse newlines / line continuations so multi-line commands parse as one line.
norm=$(printf '%s' "$cmd" | tr '\n\t' '  ' | sed 's/\\ / /g')

# ---------------------------------------------------------------- git push ---
# Inspect every `git push ...` invocation in the command (handles && ; | chains).
while IFS= read -r seg; do
	[ -z "$seg" ] && continue
	# Drop the leading `git ... push`, keep the arguments.
	args=$(printf '%s' "$seg" | sed -E 's/^git[[:space:]]+([-][^[:space:]]+[[:space:]]+)*push[[:space:]]*//')
	remote=""
	skip_next=0
	take_next=0
	for tok in $args; do
		if [ "$skip_next" = 1 ]; then skip_next=0; continue; fi
		if [ "$take_next" = 1 ]; then remote="$tok"; break; fi
		case "$tok" in
			--repo=*) remote="${tok#--repo=}"; break ;;
			--repo) take_next=1; continue ;;
			-o|--push-option|--receive-pack|--exec) skip_next=1; continue ;;
			-*) continue ;;
			*) remote="$tok"; break ;;
		esac
	done
	# No remote given -> git's default, which in this repo is origin.
	[ -z "$remote" ] && continue
	if [ "$remote" != "origin" ]; then
		deny "BLOCKED by .claude/hooks/block-upstream-contributions.sh: 'git push $remote ...' targets a remote other than origin. This checkout is a private fork of Sienci-Labs/gsender and nothing may be pushed out of $OWN_REPO. See the hard rule at the top of CLAUDE.md."
	fi
done < <(printf '%s' "$norm" | grep -Eo 'git[[:space:]]+([-][^[:space:]]+[[:space:]]+)*push[^;&|]*')

# -------------------------------------------------------------- git remote ---
if printf '%s' "$norm" | grep -Eq 'git[[:space:]]+remote[[:space:]]+(add|rename)'; then
	deny "BLOCKED by .claude/hooks/block-upstream-contributions.sh: adding or renaming a git remote is not allowed. Only 'origin' -> $OWN_REPO may exist in this fork. See the hard rule at the top of CLAUDE.md."
fi
if printf '%s' "$norm" | grep -Eq 'git[[:space:]]+remote[[:space:]]+set-url'; then
	if ! printf '%s' "$norm" | grep -q "$OWN_REPO"; then
		deny "BLOCKED by .claude/hooks/block-upstream-contributions.sh: 'git remote set-url' may only point origin at $OWN_REPO. See the hard rule at the top of CLAUDE.md."
	fi
fi

# ------------------------------------------------------------- gh pr create ---
# `gh pr create` in a fork defaults to opening the PR against the PARENT repo,
# so require an explicit --repo pointing at our own fork.
if printf '%s' "$norm" | grep -Eq 'gh[[:space:]]+pr[[:space:]]+create'; then
	if ! printf '%s' "$norm" | grep -Eq -- "--repo[= ]+$OWN_REPO"; then
		deny "BLOCKED by .claude/hooks/block-upstream-contributions.sh: 'gh pr create' in a fork defaults to opening the PR against Sienci-Labs/gsender. Pull requests upstream are forbidden; for a PR inside your own fork pass --repo $OWN_REPO explicitly. See the hard rule at the top of CLAUDE.md."
	fi
fi

# ------------------------------------------------- any gh write vs upstream ---
if printf '%s' "$norm" | grep -Eq "gh[[:space:]]" && printf '%s' "$norm" | grep -Eq "$UPSTREAM_RE"; then
	# Read-only gh verbs against upstream are fine (comparing, rebasing, reading issues).
	if ! printf '%s' "$norm" | grep -Eq 'gh[[:space:]]+[a-z-]+[[:space:]]+(view|list|status|diff|checks|clone|download)'; then
		deny "BLOCKED by .claude/hooks/block-upstream-contributions.sh: this 'gh' command writes to Sienci-Labs/*. Issues, PRs, comments and reviews on the upstream project are forbidden; only read-only commands (view/list/status/diff/checks/clone/download) are allowed. See the hard rule at the top of CLAUDE.md."
	fi
fi

exit 0
