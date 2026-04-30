#!/usr/bin/env python3
"""Normalize a URL or hostname into a stable site_id."""

from __future__ import annotations

import sys
from urllib.parse import urlparse


def normalize_site_id(value: str) -> str:
    raw = (value or '').strip().lower()
    if not raw:
        raise ValueError('site input is required')
    parsed = urlparse(raw if '://' in raw else f'https://{raw}')
    host = (parsed.hostname or parsed.path or '').strip().lower()
    if host.startswith('www.'):
        host = host[4:]
    if not host:
        raise ValueError(f'could not derive site id from: {value!r}')
    return host


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print('usage: site_id.py <url-or-domain>', file=sys.stderr)
        return 1
    try:
        print(normalize_site_id(argv[1]))
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv))
