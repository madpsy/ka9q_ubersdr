#!/usr/bin/env python3
"""Check that a Linux module will resolve in every SDR++ it is meant for.

  elf_imports.py <module.so> <libsdrpp_core.so> [<libsdrpp_core.so> ...]

The module is linked with its SDR++ symbols left undefined, for the process that
loads it to supply. The linker cannot tell whether they will be there, so this
does: every undefined symbol must come from the C/C++ runtime of the build
machine, from each core given, or be one of the three VOLK allocator functions
(which come from the libvolk the core itself links). Also reports the newest
glibc symbol version the module needs, which sets the oldest distribution it
loads on.
"""
import re
import subprocess
import sys

VOLK = {"volk_malloc", "volk_free", "volk_get_alignment"}
RUNTIME = ["libc.so.6", "libstdc++.so.6", "libm.so.6", "libgcc_s.so.1", "libpthread.so.0", "libdl.so.2",
           "ld-linux-x86-64.so.2", "ld-linux-aarch64.so.1"]  # the loader provides TLS and stack-guard symbols


def nm(path, *args):
    out = subprocess.run(["nm", "-D", *args, path], capture_output=True, text=True, check=True).stdout
    syms = {}
    for line in out.splitlines():
        parts = line.split()
        if len(parts) >= 2:
            name = parts[-1].split("@")[0]
            syms[name] = parts[-2]
    return syms


def find_lib(name):
    out = subprocess.run(["/sbin/ldconfig", "-p"], capture_output=True, text=True).stdout
    for line in out.splitlines():
        if line.strip().startswith(name + " "):
            return line.split("=>")[-1].strip()
    return None


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    module, cores = sys.argv[1], sys.argv[2:]
    undefined = {n for n, t in nm(module, "--undefined-only").items() if t not in ("w", "v")}

    runtime = set()
    for lib in RUNTIME:
        p = find_lib(lib)
        if p:
            runtime |= set(nm(p, "--defined-only"))
    needed = undefined - runtime - VOLK

    bad = 0
    for core in cores:
        missing = sorted(needed - set(nm(core, "--defined-only")))
        if missing:
            bad = 1
            print(f"MISSING from {core}:")
            for m in missing:
                print(f"    {m}")
        else:
            print(f"ok: all {len(needed)} core imports present in {core}")

    versions = subprocess.run(["objdump", "-T", module], capture_output=True, text=True, check=True).stdout
    glibc = sorted(set(re.findall(r"GLIBC_(\d+(?:\.\d+)+)", versions)), key=lambda v: [int(x) for x in v.split(".")])
    if glibc:
        print(f"needs glibc {glibc[-1]} or newer")
    return bad


if __name__ == "__main__":
    sys.exit(main())
