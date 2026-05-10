"""Entry point. Parses --role and dispatches to CP / worker / both."""

from __future__ import annotations

import argparse
import asyncio
import sys

from .logger import log


def _parse_roles(raw: str) -> set[str]:
    parts = {p.strip() for p in raw.split(",") if p.strip()}
    valid = {"cp", "worker"}
    bad = parts - valid
    if bad:
        raise SystemExit(f"unknown role(s): {', '.join(sorted(bad))}; valid: cp, worker")
    if not parts:
        raise SystemExit("--role must include at least one of: cp, worker")
    return parts


def run() -> None:
    parser = argparse.ArgumentParser(prog="witchgrid")
    sub = parser.add_subparsers(dest="cmd", required=True)

    serve = sub.add_parser("serve", help="Run CP, worker, or both")
    serve.add_argument("--role", default="cp,worker", help="comma-separated: cp, worker (default: both)")

    args = parser.parse_args()
    if args.cmd != "serve":
        parser.print_help()
        sys.exit(1)

    roles = _parse_roles(args.role)
    log.info("witchgrid.starting", roles=sorted(roles))

    asyncio.run(_main(roles))


async def _main(roles: set[str]) -> None:
    tasks: list[asyncio.Task] = []

    if "cp" in roles:
        from .cp.app import serve_cp

        tasks.append(asyncio.create_task(serve_cp(), name="cp"))

    if "worker" in roles:
        from .worker.agent import run_worker

        tasks.append(asyncio.create_task(run_worker(), name="worker"))

    if not tasks:
        return

    try:
        await asyncio.gather(*tasks)
    except (KeyboardInterrupt, asyncio.CancelledError):
        log.info("witchgrid.shutdown")
        for t in tasks:
            t.cancel()


if __name__ == "__main__":
    run()
