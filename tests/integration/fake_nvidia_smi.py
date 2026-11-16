#!/usr/bin/env python3
"""A stand-in for nvidia-smi, for the Witchgrid layout integration test.

Reports FAKE_GPU_COUNT (default 4) GPUs of FAKE_GPU_TOTAL_MB (default 16380)
and invents GPU memory for the fake llama-servers the agent spawned:
a process whose argv contains FAKE_SMI_MATCH (the test's private
llama-server path) and `--fake-vram N` holds N MB, split evenly over the
GPUs in its CUDA_VISIBLE_DEVICES. FAKE_GPU_OVERHEAD_MB (default 0) is
added to every GPU's used memory and attributed to no process ("other").

Answers the two queries the agent makes:
  --query-gpu=index,name,memory.total,memory.free,uuid,power.draw,power.limit,temperature.gpu
  --query-compute-apps=<fields from pid,process_name,used_memory,gpu_uuid>
both with --format=csv,noheader,nounits.
"""
import os
import sys

COUNT = int(os.environ.get("FAKE_GPU_COUNT", "4"))
TOTAL = int(os.environ.get("FAKE_GPU_TOTAL_MB", "16380"))
OVERHEAD = int(os.environ.get("FAKE_GPU_OVERHEAD_MB", "0"))
MATCH = os.environ.get("FAKE_SMI_MATCH", "")


def uuid(i):
    return "GPU-fake-%d" % i


def apps():
    """[(pid, name, gpu, mb)] for every matching process."""
    out = []
    if not MATCH:
        return out
    for d in os.listdir("/proc"):
        if not d.isdigit():
            continue
        try:
            with open("/proc/%s/cmdline" % d, "rb") as f:
                argv = [a.decode(errors="replace") for a in f.read().split(b"\0") if a]
            with open("/proc/%s/environ" % d, "rb") as f:
                env = dict(
                    kv.decode(errors="replace").split("=", 1)
                    for kv in f.read().split(b"\0") if b"=" in kv)
        except OSError:
            continue
        if not any(MATCH in a for a in argv) or "--fake-vram" not in argv:
            continue
        # the shebang-launched pre-exec process also matches; only count the
        # re-exec'd server (FAKE_LLAMA_REEXEC=1)
        if env.get("FAKE_LLAMA_REEXEC") != "1":
            continue
        cvd = env.get("CUDA_VISIBLE_DEVICES")
        if cvd is None or cvd.strip() == "":
            continue
        gpus = [int(x) for x in cvd.split(",") if x.strip().isdigit()]
        if not gpus:
            continue
        mb = int(argv[argv.index("--fake-vram") + 1])
        each = mb // len(gpus)
        for j, g in enumerate(gpus):
            out.append((int(d), "llama-server", g, each + (mb - each * len(gpus) if j == 0 else 0)))
    return out


def main():
    args = sys.argv[1:]
    q = next((a for a in args if a.startswith("--query-")), None)
    if q is None:
        print("fake nvidia-smi")
        return
    key, fields = q.split("=", 1)
    fields = fields.split(",")
    procs = apps()
    if key == "--query-gpu":
        for i in range(COUNT):
            used = OVERHEAD + sum(mb for (_, _, g, mb) in procs if g == i)
            vals = {"index": str(i), "name": "Fake RTX 4060 Ti", "memory.total": str(TOTAL),
                    "memory.free": str(max(0, TOTAL - used)), "uuid": uuid(i),
                    "power.draw": "[N/A]", "power.limit": "[N/A]", "temperature.gpu": "40"}
            print(", ".join(vals.get(f, "[N/A]") for f in fields))
    elif key == "--query-compute-apps":
        for (pid, name, g, mb) in procs:
            vals = {"pid": str(pid), "process_name": name, "used_memory": str(mb),
                    "gpu_uuid": uuid(g)}
            print(", ".join(vals.get(f, "[N/A]") for f in fields))


if __name__ == "__main__":
    main()
