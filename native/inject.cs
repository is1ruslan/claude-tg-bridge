// inject.exe: reads {"pid":N,"steps":[...],"gapMs":150} from stdin (UTF-8), injects console input into pid's console.
// stdout: "ok N" (exit 0) or "err <stage> <win32code>" (exit 2).
// inject.exe --ancestor <pid> <name>: walks th32ParentProcessID up from <pid> (<= 12 levels, cycle-safe)
// and prints "ok <pid> <creationUnixMs>" for the first process whose exe name is <name>
// (case-insensitive; creation time 0 if unavailable), else "none". Exit 0 in both cases.
using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

public static class Inject {
  [StructLayout(LayoutKind.Explicit, CharSet=CharSet.Unicode)]
  public struct KEY_EVENT_RECORD {
    [FieldOffset(0)] public int bKeyDown;
    [FieldOffset(4)] public ushort wRepeatCount;
    [FieldOffset(6)] public ushort wVirtualKeyCode;
    [FieldOffset(8)] public ushort wVirtualScanCode;
    [FieldOffset(10)] public char UnicodeChar;
    [FieldOffset(12)] public uint dwControlKeyState;
  }
  [StructLayout(LayoutKind.Explicit)]
  public struct INPUT_RECORD {
    [FieldOffset(0)] public ushort EventType;
    [FieldOffset(4)] public KEY_EVENT_RECORD KeyEvent;
  }
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sa, uint disp, uint flags, IntPtr tmpl);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  static extern bool WriteConsoleInputW(IntPtr h, INPUT_RECORD[] recs, uint n, out uint written);
  [DllImport("user32.dll")] static extern uint MapVirtualKeyW(uint code, uint type);

  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct PROCESSENTRY32W {
    public uint dwSize; public uint cntUsage; public uint th32ProcessID; public IntPtr th32DefaultHeapID;
    public uint th32ModuleID; public uint cntThreads; public uint th32ParentProcessID; public int pcPriClassBase;
    public uint dwFlags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string szExeFile;
  }
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool Process32FirstW(IntPtr h, ref PROCESSENTRY32W e);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool Process32NextW(IntPtr h, ref PROCESSENTRY32W e);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr h, out long creation, out long exit, out long kernel, out long user);

  const uint TH32CS_SNAPPROCESS = 0x2;
  const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
  const long FILETIME_UNIX_EPOCH = 116444736000000000L;

  // Creation time as Unix ms (same representation as procs.mjs listProcs().startedAt); 0 if unavailable.
  static long CreationUnixMs(uint pid) {
    IntPtr h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
    if (h == IntPtr.Zero) return 0;
    try {
      long c, e, k, u;
      if (!GetProcessTimes(h, out c, out e, out k, out u) || c <= FILETIME_UNIX_EPOCH) return 0;
      return (c - FILETIME_UNIX_EPOCH) / 10000;
    } finally { CloseHandle(h); }
  }

  static int Ancestor(string[] args) {
    uint start;
    if (args.Length < 3 || !UInt32.TryParse(args[1], out start)) return Done("none", 0);
    string want = args[2];
    var parent = new Dictionary<uint, uint>();
    var names = new Dictionary<uint, string>();
    IntPtr snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snap == new IntPtr(-1)) return Done("none", 0);
    try {
      var e = new PROCESSENTRY32W(); e.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32W));
      if (Process32FirstW(snap, ref e)) {
        do { parent[e.th32ProcessID] = e.th32ParentProcessID; names[e.th32ProcessID] = e.szExeFile ?? ""; }
        while (Process32NextW(snap, ref e));
      }
    } finally { CloseHandle(snap); }
    var seen = new HashSet<uint>();
    uint cur = start;
    for (int i = 0; i <= 12; i++) {
      if (!seen.Add(cur) || !names.ContainsKey(cur)) break;
      if (String.Equals(names[cur], want, StringComparison.OrdinalIgnoreCase)) return Done("ok " + cur + " " + CreationUnixMs(cur), 0);
      cur = parent[cur];
    }
    return Done("none", 0);
  }

  static Stream stdout;

  static INPUT_RECORD Rec(bool down, ushort vk, char ch) {
    var r = new INPUT_RECORD(); r.EventType = 1;
    r.KeyEvent.bKeyDown = down ? 1 : 0; r.KeyEvent.wRepeatCount = 1;
    r.KeyEvent.wVirtualKeyCode = vk; r.KeyEvent.wVirtualScanCode = (ushort)MapVirtualKeyW(vk, 0);
    r.KeyEvent.UnicodeChar = ch; return r;
  }

  static int Done(string msg, int code) {
    byte[] b = new UTF8Encoding(false).GetBytes(msg + "\n");
    try { stdout.Write(b, 0, b.Length); stdout.Flush(); } catch { }
    return code;
  }
  static int Err(string stage, int win32) { return Done("err " + stage + " " + win32, 2); }

  static bool Write(IntPtr h, List<INPUT_RECORD> l, ref uint total) {
    if (l.Count == 0) return true;
    uint w; bool ok = WriteConsoleInputW(h, l.ToArray(), (uint)l.Count, out w);
    total += w; l.Clear(); return ok;
  }

  public static int Main(string[] args) {
    stdout = Console.OpenStandardOutput();   // pipe handle; survives FreeConsole
    if (args.Length > 0 && args[0] == "--ancestor") return Ancestor(args);
    string json;
    try { json = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false)).ReadToEnd(); }
    catch { return Err("stdin", 0); }

    uint pid; int gap = 150; object[] steps;
    try {
      var d = (Dictionary<string, object>)new JavaScriptSerializer().DeserializeObject(json);
      pid = Convert.ToUInt32(d["pid"]);
      if (d.ContainsKey("gapMs")) gap = Convert.ToInt32(d["gapMs"]);
      var tmp = new List<object>(); foreach (object o in (IEnumerable)d["steps"]) tmp.Add(o); steps = tmp.ToArray();
    } catch { return Err("parse", 0); }

    FreeConsole();
    if (!AttachConsole(pid)) return Err("attach", Marshal.GetLastWin32Error());
    IntPtr h = CreateFileW("CONIN$", 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
    if (h == new IntPtr(-1)) { int e = Marshal.GetLastWin32Error(); FreeConsole(); return Err("open", e); }

    uint total = 0; var list = new List<INPUT_RECORD>();
    for (int i = 0; i < steps.Length; i++) {
      var s = steps[i] as Dictionary<string, object>;
      if (s == null) { FreeConsole(); return Err("step", i); }
      if (i > 0 && gap > 0) Thread.Sleep(gap);
      if (s.ContainsKey("sleep")) { Thread.Sleep(Convert.ToInt32(s["sleep"])); continue; }
      if (s.ContainsKey("text")) {
        foreach (char c in (string)s["text"]) { list.Add(Rec(true, 0, c)); list.Add(Rec(false, 0, c)); }
      } else if (s.ContainsKey("key")) {
        ushort vk = 0; char ch = '\0';
        switch ((string)s["key"]) {
          case "DOWN": vk = 0x28; break;
          case "UP": vk = 0x26; break;
          case "LEFT": vk = 0x25; break;
          case "RIGHT": vk = 0x27; break;
          case "ENTER": vk = 0x0D; ch = '\r'; break;
          case "ESC": vk = 0x1B; ch = (char)27; break;
          case "TAB": vk = 0x09; ch = '\t'; break;
          default: FreeConsole(); return Err("key", i);
        }
        list.Add(Rec(true, vk, ch)); list.Add(Rec(false, vk, ch));
      } else { FreeConsole(); return Err("step", i); }
      if (!Write(h, list, ref total)) { int e = Marshal.GetLastWin32Error(); FreeConsole(); return Err("write", e); }
    }
    FreeConsole();
    return Done("ok " + total, 0);
  }
}
