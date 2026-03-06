# alt_tab.ps1 - 마우스 사이드 버튼(XButton1)으로 Alt+Tab 전환
# 별도 설치 없이 Windows PowerShell로 실행
# 사용법: 더블클릭 또는 powershell -ExecutionPolicy Bypass -File alt_tab.ps1

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using System.Diagnostics;

public class MouseHook {
    private static IntPtr hookId = IntPtr.Zero;
    private delegate IntPtr LowLevelMouseProc(int nCode, IntPtr wParam, IntPtr lParam);
    private static LowLevelMouseProc proc = HookCallback;

    [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int id, LowLevelMouseProc cb, IntPtr hMod, uint tid);
    [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hhk);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);
    [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string name);
    [DllImport("user32.dll")] static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

    private const int WH_MOUSE_LL = 14;
    private const int WM_XBUTTONDOWN = 0x020B;

    public static void Start() {
        using (var proc2 = Process.GetCurrentProcess())
        using (var mod = proc2.MainModule)
            hookId = SetWindowsHookEx(WH_MOUSE_LL, proc, GetModuleHandle(mod.ModuleName), 0);
        Application.Run();
    }

    public static void Stop() {
        UnhookWindowsHookEx(hookId);
        Application.ExitThread();
    }

    private static IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam) {
        if (nCode >= 0 && (int)wParam == WM_XBUTTONDOWN) {
            int data = Marshal.ReadInt32(lParam, 8);
            int button = (data >> 16) & 0xFFFF;
            if (button == 1) { // XButton1 (뒤로 버튼)
                keybd_event(0x12, 0, 0, UIntPtr.Zero); // Alt down
                keybd_event(0x09, 0, 0, UIntPtr.Zero); // Tab down
                keybd_event(0x09, 0, 2, UIntPtr.Zero); // Tab up
                keybd_event(0x12, 0, 2, UIntPtr.Zero); // Alt up
                return (IntPtr)1;
            }
        }
        return CallNextHookEx(hookId, nCode, wParam, lParam);
    }
}
"@ -ReferencedAssemblies System.Windows.Forms

Write-Host "=== Alt+Tab Mouse Switcher ==="
Write-Host "마우스 뒤로(사이드) 버튼 = Alt+Tab"
Write-Host "종료: 이 창을 닫으세요"
Write-Host ""

[MouseHook]::Start()
