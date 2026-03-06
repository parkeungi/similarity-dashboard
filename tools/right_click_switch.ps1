# right_click_switch.ps1
# 전체화면 앱에서 우클릭 시 유사호출부호검출시스템 브라우저를 앞으로 가져옴
# 일반 윈도우에서는 우클릭 정상 동작
# 설치 불필요 - Windows PowerShell 내장 기능만 사용
#
# 실행법: right_click_switch.bat 더블클릭
# 종료: 작업관리자에서 powershell 프로세스 종료

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using System.Diagnostics;
using System.Drawing;
using System.Text;

public class RightClickSwitch {
    private static IntPtr hookId = IntPtr.Zero;
    private delegate IntPtr LowLevelMouseProc(int nCode, IntPtr wParam, IntPtr lParam);
    private static LowLevelMouseProc proc = HookCallback;
    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int id, LowLevelMouseProc cb, IntPtr hMod, uint tid);
    [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hhk);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);
    [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string name);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll")] static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
    [DllImport("user32.dll")] static extern IntPtr GetShellWindow();

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    private const int WH_MOUSE_LL = 14;
    private const int WM_RBUTTONDOWN = 0x0204;
    private const int SW_RESTORE = 9;
    private const int SW_SHOW = 5;

    private static bool IsFullScreen() {
        IntPtr hwnd = GetForegroundWindow();
        if (hwnd == IntPtr.Zero) return false;

        // 바탕화면(Shell) 제외
        if (hwnd == GetShellWindow()) return false;

        // Explorer 클래스 제외 (바탕화면, 작업표시줄)
        StringBuilder className = new StringBuilder(256);
        GetClassName(hwnd, className, 256);
        string cls = className.ToString();
        if (cls == "Progman" || cls == "WorkerW" || cls == "Shell_TrayWnd" ||
            cls == "Shell_SecondaryTrayWnd" || cls == "NotifyIconOverflowWindow") return false;

        // 브라우저 자체도 제외 (브라우저 위에서 우클릭은 정상 동작)
        StringBuilder title = new StringBuilder(512);
        GetWindowText(hwnd, title, 512);
        string t = title.ToString();
        if (t.Contains("\uc720\uc0ac\ud638\ucd9c\ubd80\ud638") || t.Contains(":4000")) return false;

        // 크기 체크: 화면 전체를 차지하는지
        RECT rect;
        GetWindowRect(hwnd, out rect);
        int screenW = Screen.PrimaryScreen.Bounds.Width;
        int screenH = Screen.PrimaryScreen.Bounds.Height;
        return (rect.Left <= 0 && rect.Top <= 0 &&
                rect.Right >= screenW && rect.Bottom >= screenH);
    }

    private static IntPtr FindBrowserWindow() {
        IntPtr found = IntPtr.Zero;
        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
            if (!IsWindowVisible(hWnd)) return true;
            StringBuilder sb = new StringBuilder(512);
            GetWindowText(hWnd, sb, 512);
            string title = sb.ToString();
            if (title.Contains("\uc720\uc0ac\ud638\ucd9c\ubd80\ud638") || title.Contains("localhost:4000") || title.Contains(":4000")) {
                found = hWnd;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    public static void Start() {
        using (var p = Process.GetCurrentProcess())
        using (var m = p.MainModule)
            hookId = SetWindowsHookEx(WH_MOUSE_LL, proc, GetModuleHandle(m.ModuleName), 0);
        Application.Run();
    }

    public static void Stop() {
        UnhookWindowsHookEx(hookId);
        Application.ExitThread();
    }

    private static IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam) {
        if (nCode >= 0 && (int)wParam == WM_RBUTTONDOWN) {
            if (IsFullScreen()) {
                IntPtr browser = FindBrowserWindow();
                if (browser != IntPtr.Zero) {
                    if (IsIconic(browser)) ShowWindow(browser, SW_RESTORE);
                    else ShowWindow(browser, SW_SHOW);

                    // Alt 키를 눌렀다 떼서 SetForegroundWindow 허용
                    keybd_event(0x12, 0, 0, UIntPtr.Zero);
                    keybd_event(0x12, 0, 2, UIntPtr.Zero);
                    SetForegroundWindow(browser);
                    return (IntPtr)1;
                }
            }
        }
        return CallNextHookEx(hookId, nCode, wParam, lParam);
    }
}
"@ -ReferencedAssemblies System.Windows.Forms, System.Drawing

[RightClickSwitch]::Start()
