#!/usr/bin/env bash
# Secret check before a commit: gitleaks (https://github.com/gitleaks/gitleaks) over the staged changes,
# values redacted in the output. Skip one line with a `gitleaks:allow` comment; a finding in text that
# cannot change goes to .gitleaksignore by its fingerprint.
# Enable: ln -s ../../tools/check-secrets.sh .git/hooks/pre-commit
command -v gitleaks >/dev/null || { echo "✗ gitleaks is not installed: secret check not run" >&2; exit 1; }
exec gitleaks git --staged --redact --no-banner --verbose --log-level warn "$(git rev-parse --show-toplevel)"
