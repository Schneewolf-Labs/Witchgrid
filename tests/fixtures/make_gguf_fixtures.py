#!/usr/bin/env python3
"""Generate synthetic GGUF v3 fixtures for the gguf parser tests.

These are header-only GGUFs: valid magic + version + a handful of metadata
KV pairs, tensor_count=0 and NO tensor data. cp/gguf.hml only reads the
header + KV array (it approximates weights from file size and never walks
tensor_info), so that's all the parser needs. Keeps fixtures to a few
hundred bytes instead of shipping real multi-GB models.

Run from anywhere; writes the .gguf/.bin files next to this script:

    python3 tests/fixtures/make_gguf_fixtures.py

Re-run after editing to regenerate. The outputs are committed so CI
doesn't need Python.
"""
import struct
import os

# GGUF metadata value type tags (must match cp/gguf.hml).
T_UINT32 = 4
T_UINT64 = 10
T_STRING = 8

HERE = os.path.dirname(os.path.abspath(__file__))


def _kv(key: str, vtype: int, value) -> bytes:
    out = struct.pack("<Q", len(key)) + key.encode("utf-8")
    out += struct.pack("<I", vtype)
    if vtype == T_STRING:
        out += struct.pack("<Q", len(value)) + value.encode("utf-8")
    elif vtype == T_UINT32:
        out += struct.pack("<I", value)
    elif vtype == T_UINT64:
        out += struct.pack("<Q", value)
    else:
        raise ValueError(f"unsupported test type {vtype}")
    return out


def gguf(kvs, version: int = 3, tensor_count: int = 0) -> bytes:
    body = b"GGUF"
    body += struct.pack("<I", version)
    body += struct.pack("<Q", tensor_count)
    body += struct.pack("<Q", len(kvs))
    for key, vtype, value in kvs:
        body += _kv(key, vtype, value)
    return body


def write(name: str, data: bytes):
    path = os.path.join(HERE, name)
    with open(path, "wb") as f:
        f.write(data)
    print(f"wrote {name} ({len(data)} bytes)")


# A llama-arch model that lies about its context like Mistral-Nemo:
# claimed context_length = 1024000, real trained context = 131072.
# Attention shape mirrors Mistral-Nemo-12B (GQA: 32 heads / 8 kv heads,
# embedding 5120, 40 layers) so the kv-per-token math has real numbers.
nemo = gguf([
    ("general.architecture", T_STRING, "llama"),
    ("general.name", T_STRING, "synthetic-nemo-12b"),
    ("llama.block_count", T_UINT32, 40),
    ("llama.attention.head_count", T_UINT32, 32),
    ("llama.attention.head_count_kv", T_UINT32, 8),
    ("llama.embedding_length", T_UINT32, 5120),
    ("llama.context_length", T_UINT32, 1024000),
])
write("nemo_llama.gguf", nemo)

# A normal llama model with an honest context (131072) — exercises the
# no-override path (arch=llama but claimed != 1024000).
normal = gguf([
    ("general.architecture", T_STRING, "llama"),
    ("general.name", T_STRING, "synthetic-honest-llama"),
    ("llama.block_count", T_UINT32, 32),
    ("llama.attention.head_count", T_UINT32, 32),
    ("llama.attention.head_count_kv", T_UINT32, 8),
    ("llama.embedding_length", T_UINT32, 4096),
    ("llama.context_length", T_UINT32, 131072),
])
write("normal_llama.gguf", normal)

# Unsupported version: valid magic, version=2 (parser handles v3 only).
write("gguf_v2.gguf", gguf([], version=2))

# Not a GGUF at all: wrong magic.
write("bad_magic.bin", b"NOPE" + b"\x00" * 28)

T_ARRAY = 9

# Hardening fixtures: a well-formed header whose KV lies about a length/count,
# the shapes a malicious model from HF/a peer would use. The parser must reject
# each (throw) instead of truncating to a negative size, reading past EOF, or
# looping on an absurd count.

# A metadata STRING that claims a 2 GiB length (0x80000000 — also the exact
# value that i32-truncated to a NEGATIVE size before hardening), with only a
# couple of real bytes after it.
evil_bigstring = b"GGUF" + struct.pack("<I", 3) + struct.pack("<Q", 0)  # version, tensor_count=0
evil_bigstring += struct.pack("<Q", 1)                                   # kv_count = 1
evil_bigstring += struct.pack("<Q", 1) + b"x"                            # key "x"
evil_bigstring += struct.pack("<I", T_STRING)
evil_bigstring += struct.pack("<Q", 0x80000000) + b"ab"                  # lied length + 2 bytes
write("evil_bigstring.gguf", evil_bigstring)

# An ARRAY KV claiming 2^40 elements — would drive an unbounded skip loop.
evil_bigarray = b"GGUF" + struct.pack("<I", 3) + struct.pack("<Q", 0)
evil_bigarray += struct.pack("<Q", 1)                                    # kv_count = 1
evil_bigarray += struct.pack("<Q", 1) + b"y"                             # key "y"
evil_bigarray += struct.pack("<I", T_ARRAY)
evil_bigarray += struct.pack("<I", T_UINT32)                             # element type
evil_bigarray += struct.pack("<Q", 1 << 40)                              # absurd element count
write("evil_bigarray.gguf", evil_bigarray)
