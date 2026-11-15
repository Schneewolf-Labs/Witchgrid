#!/bin/sh
# Wrapper in the shape of a venv service's run.sh: it starts python
# WITHOUT exec, so the actual server is the agent's grandchild. The
# harness uses that to prove stop/watchdog act on the whole process
# group, not just the pid the agent spawned.
python3 ./fake_local_service.py "$@"
echo "fake_local_run: python exited $?"
