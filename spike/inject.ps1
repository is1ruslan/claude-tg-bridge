# SPIKE (throwaway): inject keystrokes into another process's console via WriteConsoleInput.
# Usage: powershell -File inject.ps1 -TargetPid <pid> -Keys "{DOWN},{ENTER}" -Log out.txt
param([int]$TargetPid, [string]$Keys, [string]$Log)

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class Inj {
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
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sa, uint disp, uint flags, IntPtr tmpl);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool WriteConsoleInputW(IntPtr h, INPUT_RECORD[] recs, uint n, out uint written);
  [DllImport("user32.dll")] public static extern uint MapVirtualKeyW(uint code, uint type);

  static INPUT_RECORD Rec(bool down, ushort vk, char ch) {
    var r = new INPUT_RECORD(); r.EventType = 1;
    r.KeyEvent.bKeyDown = down ? 1 : 0; r.KeyEvent.wRepeatCount = 1;
    r.KeyEvent.wVirtualKeyCode = vk; r.KeyEvent.wVirtualScanCode = (ushort)MapVirtualKeyW(vk, 0);
    r.KeyEvent.UnicodeChar = ch; return r;
  }
  public static string Send(uint pid, string[] tokens) {
    FreeConsole();
    if (!AttachConsole(pid)) return "AttachConsole failed: " + Marshal.GetLastWin32Error();
    IntPtr h = CreateFileW("CONIN$", 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
    if (h == new IntPtr(-1)) return "CONIN$ open failed: " + Marshal.GetLastWin32Error();
    var list = new System.Collections.Generic.List<INPUT_RECORD>();
    foreach (var t in tokens) {
      ushort vk = 0; char ch = '\0';
      switch (t) {
        case "{DOWN}": vk = 0x28; break;
        case "{UP}": vk = 0x26; break;
        case "{ENTER}": vk = 0x0D; ch = '\r'; break;
        case "{ESC}": vk = 0x1B; ch = (char)27; break;
        case "{TAB}": vk = 0x09; ch = '\t'; break;
        default:
          foreach (char c in t) { list.Add(Rec(true, 0, c)); list.Add(Rec(false, 0, c)); }
          continue;
      }
      list.Add(Rec(true, vk, ch)); list.Add(Rec(false, vk, ch));
    }
    uint w; bool ok = WriteConsoleInputW(h, list.ToArray(), (uint)list.Count, out w);
    FreeConsole();
    return ok ? ("ok, written " + w + " records") : ("WriteConsoleInput failed: " + Marshal.GetLastWin32Error());
  }
}
"@

if ($Keys.StartsWith('@')) { $Keys = Get-Content -Raw -Encoding utf8 $Keys.Substring(1) }
$res = [Inj]::Send([uint32]$TargetPid, ($Keys -split ','))
Set-Content -Path $Log -Value $res -Encoding utf8
