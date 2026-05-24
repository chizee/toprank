#!/usr/bin/env python3
"""Create the NotFair OpenClaw runtime workspace if it does not exist."""

from __future__ import annotations

from runtime import bootstrap_workspace


if __name__ == "__main__":
    print(bootstrap_workspace())
