// inject.exe: reads {"pid":N,"steps":[...],"gapMs":150} from stdin (UTF-8), injects console input into pid's console.
// stdout: "ok N" (exit 0) or "err <stage> <win32code>" (exit 2).
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

  public static int Main() {
    stdout = Console.OpenStandardOutput();   // pipe handle; survives FreeConsole
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
