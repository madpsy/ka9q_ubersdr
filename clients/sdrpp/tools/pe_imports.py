#!/usr/bin/env python3
"""Windows import-library plumbing for the out-of-tree build.

  pe_imports.py def  <dll> <out.def>
      Write a module-definition file listing every export of <dll>, marking
      the ones that live in a non-executable section as DATA. Feed it to
      llvm-dlltool to get an import library for linking against that DLL.

      A DLL's export table does not say which exports are variables, but the
      linker has to know: a variable is imported through its __imp_ pointer
      only, and giving it a code thunk as well would link and then read the
      thunk's bytes as the object. SDR++ exports its globals (sigpath::
      sourceManager, core::args ...) this way, so the section is the tell.

  pe_imports.py check <module.dll> <import dll name> <dll> [<dll> ...]
      Fail unless every symbol <module.dll> imports from <import dll name> is
      exported by each <dll> given: the module must load into every SDR++ it
      claims to support, not just the one whose DLL it was linked against.

The PE reading is done here rather than with pefile, which stops reading an
export table part way through without saying so (sdrpp_core.dll exports over
11000 names; pefile returned about 8000), so a missing symbol would have looked
like a real one being absent.
"""
import struct
import sys

IMAGE_SCN_MEM_EXECUTE = 0x20000000


class PE:
    def __init__(self, path):
        with open(path, "rb") as f:
            self.data = f.read()
        d = self.data
        if d[:2] != b"MZ":
            raise SystemExit(f"{path}: not a PE file")
        pe = struct.unpack_from("<I", d, 0x3C)[0]
        if d[pe:pe + 4] != b"PE\0\0":
            raise SystemExit(f"{path}: not a PE file")
        nsec, = struct.unpack_from("<H", d, pe + 6)
        optsize, = struct.unpack_from("<H", d, pe + 20)
        opt = pe + 24
        magic, = struct.unpack_from("<H", d, opt)
        if magic != 0x20B:
            raise SystemExit(f"{path}: not a 64-bit PE")
        ndirs, = struct.unpack_from("<I", d, opt + 108)
        self.dirs = [struct.unpack_from("<II", d, opt + 112 + 8 * i) for i in range(min(ndirs, 16))]
        self.sections = []
        s = opt + optsize
        for i in range(nsec):
            vsize, va, rawsize, rawptr = struct.unpack_from("<IIII", d, s + 8)
            chars, = struct.unpack_from("<I", d, s + 36)
            self.sections.append((va, max(vsize, rawsize), rawptr, chars))
            s += 40

    def section(self, rva):
        for va, size, raw, chars in self.sections:
            if va <= rva < va + size:
                return va, size, raw, chars
        return None

    def off(self, rva):
        sec = self.section(rva)
        if not sec:
            raise ValueError(f"rva {rva:#x} outside every section")
        return rva - sec[0] + sec[2]

    def cstr(self, rva):
        o = self.off(rva)
        return self.data[o:self.data.index(b"\0", o)].decode()

    def exports(self):
        rva, size = self.dirs[0]
        if not rva:
            return {}
        o = self.off(rva)
        nfuncs, nnames, funcs, names, ords = struct.unpack_from("<IIIII", self.data, o + 20)
        out = {}
        for i in range(nnames):
            name = self.cstr(struct.unpack_from("<I", self.data, self.off(names) + 4 * i)[0])
            ordinal, = struct.unpack_from("<H", self.data, self.off(ords) + 2 * i)
            addr, = struct.unpack_from("<I", self.data, self.off(funcs) + 4 * ordinal)
            if rva <= addr < rva + size:
                out[name] = True  # forwarder: treated as code
                continue
            sec = self.section(addr)
            out[name] = bool(sec and sec[3] & IMAGE_SCN_MEM_EXECUTE)
        if len(out) != nnames:
            raise SystemExit(f"read {len(out)} of {nnames} export names")
        return out

    def imports(self):
        rva, _ = self.dirs[1]
        out = {}
        if not rva:
            return out
        o = self.off(rva)
        while True:
            ilt, _, _, name_rva, iat = struct.unpack_from("<IIIII", self.data, o)
            if not name_rva:
                break
            dll = self.cstr(name_rva).lower()
            names = out.setdefault(dll, set())
            t = self.off(ilt or iat)
            while True:
                entry, = struct.unpack_from("<Q", self.data, t)
                if not entry:
                    break
                if not entry & (1 << 63):
                    names.add(self.cstr((entry & 0x7FFFFFFF) + 2))
                t += 8
            o += 20
        return out


def write_def(dll, out):
    ex = PE(dll).exports()
    name = dll.replace("\\", "/").rsplit("/", 1)[-1]
    with open(out, "w") as f:
        f.write(f"LIBRARY {name}\nEXPORTS\n")
        for sym in sorted(ex):
            f.write(f"    {sym}{'' if ex[sym] else ' DATA'}\n")
    print(f"{out}: {len(ex)} exports ({sum(1 for v in ex.values() if not v)} data)")


def check(module, import_name, dlls):
    wanted = PE(module).imports().get(import_name.lower(), set())
    if not wanted:
        print(f"{module} imports nothing from {import_name}")
        return 1
    bad = 0
    for dll in dlls:
        missing = sorted(wanted - set(PE(dll).exports()))
        if missing:
            bad = 1
            print(f"MISSING from {dll}:")
            for m in missing:
                print(f"    {m}")
        else:
            print(f"ok: all {len(wanted)} imports from {import_name} present in {dll}")
    return bad


if __name__ == "__main__":
    if len(sys.argv) == 4 and sys.argv[1] == "def":
        write_def(sys.argv[2], sys.argv[3])
    elif len(sys.argv) >= 5 and sys.argv[1] == "check":
        sys.exit(check(sys.argv[2], sys.argv[3], sys.argv[4:]))
    else:
        print(__doc__)
        sys.exit(2)
