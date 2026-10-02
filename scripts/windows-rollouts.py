"""Find rollout files actually opened by a terminal's Codex descendants.

Read-only Win32 handle inspection, restricted to the supplied process trees.
No guessing from modification times or unrelated desktop conversations.
"""
import ctypes as C
from ctypes import wintypes as W
import json
import sys

k = C.WinDLL('kernel32', use_last_error=True)
n = C.WinDLL('ntdll')
ULONG_PTR = C.c_size_t

class ProcessEntry(C.Structure):
    _fields_ = [('size', W.DWORD), ('usage', W.DWORD), ('pid', W.DWORD),
                ('heap', ULONG_PTR), ('module', W.DWORD), ('threads', W.DWORD),
                ('parent', W.DWORD), ('priority', W.LONG), ('flags', W.DWORD),
                ('exe', W.WCHAR * 260)]

class HandleEntry(C.Structure):
    _fields_ = [('handle', W.HANDLE), ('count', ULONG_PTR), ('pointers', ULONG_PTR),
                ('access', W.DWORD), ('type', W.DWORD), ('attributes', W.DWORD), ('reserved', W.DWORD)]

k.CreateToolhelp32Snapshot.argtypes = [W.DWORD, W.DWORD]
k.CreateToolhelp32Snapshot.restype = W.HANDLE
k.Process32FirstW.argtypes = [W.HANDLE, C.POINTER(ProcessEntry)]
k.Process32NextW.argtypes = [W.HANDLE, C.POINTER(ProcessEntry)]
k.OpenProcess.argtypes = [W.DWORD, W.BOOL, W.DWORD]
k.OpenProcess.restype = W.HANDLE
k.CloseHandle.argtypes = [W.HANDLE]
k.GetCurrentProcess.restype = W.HANDLE
k.DuplicateHandle.argtypes = [W.HANDLE, W.HANDLE, W.HANDLE, C.POINTER(W.HANDLE), W.DWORD, W.BOOL, W.DWORD]
k.GetFileType.argtypes = [W.HANDLE]
k.GetFinalPathNameByHandleW.argtypes = [W.HANDLE, W.LPWSTR, W.DWORD, W.DWORD]
n.NtQueryInformationProcess.argtypes = [W.HANDLE, W.ULONG, C.c_void_p, W.ULONG, C.POINTER(W.ULONG)]
n.NtQueryInformationProcess.restype = W.LONG

def processes():
    snapshot = k.CreateToolhelp32Snapshot(2, 0)
    result = {}
    if snapshot == C.c_void_p(-1).value:
        return result
    try:
        entry = ProcessEntry(); entry.size = C.sizeof(entry)
        ok = k.Process32FirstW(snapshot, C.byref(entry))
        while ok:
            result[entry.pid] = (entry.parent, entry.exe.lower())
            ok = k.Process32NextW(snapshot, C.byref(entry))
    finally:
        k.CloseHandle(snapshot)
    return result

def opened_rollout(pid):
    process = k.OpenProcess(0x440, False, pid)  # QUERY_INFORMATION | DUP_HANDLE
    if not process:
        return None
    try:
        size = 65536
        for _ in range(5):
            buf = C.create_string_buffer(size); needed = W.ULONG()
            status = n.NtQueryInformationProcess(process, 51, buf, size, C.byref(needed))
            if status >= 0:
                break
            size = max(size * 2, needed.value + 4096)
        else:
            return None
        count = ULONG_PTR.from_buffer(buf).value
        if count > (size - 2 * C.sizeof(ULONG_PTR)) // C.sizeof(HandleEntry):
            return None
        for i in range(count):
            entry = HandleEntry.from_buffer(buf, 2 * C.sizeof(ULONG_PTR) + i * C.sizeof(HandleEntry))
            local = W.HANDLE()
            if not k.DuplicateHandle(process, entry.handle, k.GetCurrentProcess(), C.byref(local), 0, False, 2):
                continue
            try:
                if k.GetFileType(local) != 1:  # Disk files only; never inspect pipes.
                    continue
                name = C.create_unicode_buffer(32768)
                length = k.GetFinalPathNameByHandleW(local, name, len(name), 0)
                if length and length < len(name):
                    value = name.value
                    if '\\sessions\\' in value and '\\rollout-' in value and value.endswith('.jsonl'):
                        return value
            finally:
                k.CloseHandle(local)
    finally:
        k.CloseHandle(process)
    return None

def main():
    table = processes(); output = {}
    for root in map(int, sys.argv[1:]):
        descendants = {root}
        for _ in range(12):
            new = {pid for pid, (parent, _) in table.items() if parent in descendants}
            if new <= descendants:
                break
            descendants |= new
        for pid in descendants:
            if 'codex' in table.get(pid, (0, ''))[1]:
                result = opened_rollout(pid)
                if result:
                    output[str(root)] = result; break
    print(json.dumps(output, ensure_ascii=True))

if __name__ == '__main__':
    main()
