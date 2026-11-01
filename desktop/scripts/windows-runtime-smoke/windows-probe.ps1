# Native observations for desktop/scripts/windows-runtime-smoke.ts.
#
# The smoke needs facts that only Windows exposes natively: the OS build, the
# process table, top-level windows, a real screen capture, and the installed
# WebView2 runtime version. PowerShell ships with the runner, so this helper
# adds no dependency. Every action prints one compact JSON value on stdout;
# failures throw and surface as a non-zero exit code.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('system', 'processes', 'windows', 'screenshot', 'webview2')]
  [string]$Action,
  [string]$Path
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Write-Json([object]$Value) {
  $Value | ConvertTo-Json -Depth 6 -Compress
}

switch ($Action) {
  'system' {
    $operatingSystem = Get-CimInstance -ClassName Win32_OperatingSystem
    Write-Json ([pscustomobject]@{
        caption        = [string]$operatingSystem.Caption
        version        = [string]$operatingSystem.Version
        buildNumber    = [string]$operatingSystem.BuildNumber
        architecture   = [string]$operatingSystem.OSArchitecture
        versionString  = [string][System.Environment]::OSVersion.VersionString
      })
  }

  'processes' {
    # CommandLine is deliberately absent: a command line can carry arguments this
    # smoke must never copy into an artifact. Only identity and executable path.
    $items = @(Get-CimInstance -ClassName Win32_Process | ForEach-Object {
        [pscustomobject]@{
          processId        = [int]$_.ProcessId
          parentProcessId  = [int]$_.ParentProcessId
          executablePath   = if ($_.ExecutablePath) { [string]$_.ExecutablePath } else { $null }
        }
      })
    Write-Json ([pscustomobject]@{ items = $items })
  }

  'windows' {
    if (-not ('ObolSmoke.WindowProbe' -as [type])) {
      # The whole enumeration lives in C#: passing a PowerShell script block as
      # the EnumWindows callback and handing it a `[ref]` out parameter throws
      # "Argument types do not match" on a stock runner, so PowerShell only
      # prints the snapshot this type returns.
      Add-Type -TypeDefinition @'
namespace ObolSmoke {
  public sealed class WindowInfo {
    public int processId;
    public string title;
    public bool visible;
  }

  public static class WindowProbe {
    public delegate bool EnumWindowsProc(System.IntPtr handle, System.IntPtr state);

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc callback, System.IntPtr state);

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    public static extern int GetWindowTextLength(System.IntPtr handle);

    [System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
    public static extern int GetWindowText(System.IntPtr handle, System.Text.StringBuilder text, int maximum);

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    public static extern bool IsWindowVisible(System.IntPtr handle);

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(System.IntPtr handle, out uint processId);

    public static WindowInfo[] Snapshot() {
      System.Collections.Generic.List<WindowInfo> windows =
        new System.Collections.Generic.List<WindowInfo>();
      EnumWindows(delegate(System.IntPtr handle, System.IntPtr state) {
        int length = GetWindowTextLength(handle);
        if (length <= 0) {
          return true;
        }
        System.Text.StringBuilder builder = new System.Text.StringBuilder(length + 1);
        GetWindowText(handle, builder, builder.Capacity);
        uint processId;
        GetWindowThreadProcessId(handle, out processId);
        WindowInfo info = new WindowInfo();
        info.processId = unchecked((int)processId);
        info.title = builder.ToString();
        info.visible = IsWindowVisible(handle);
        windows.Add(info);
        return true;
      }, System.IntPtr.Zero);
      return windows.ToArray();
    }
  }
}
'@
    }

    $items = @([ObolSmoke.WindowProbe]::Snapshot() | ForEach-Object {
        [pscustomobject]@{
          processId = $_.processId
          title     = $_.title
          visible   = $_.visible
        }
      })
    Write-Json ([pscustomobject]@{ items = $items })
  }

  'screenshot' {
    if ([string]::IsNullOrWhiteSpace($Path)) {
      throw 'screenshot requires -Path'
    }
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
    try {
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      try {
        $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
      }
      finally {
        $graphics.Dispose()
      }
      $directory = Split-Path -Parent $Path
      if ($directory) {
        [void](New-Item -ItemType Directory -Force -Path $directory)
      }
      $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
      Write-Json ([pscustomobject]@{
          path   = $Path
          width  = [int]$bounds.Width
          height = [int]$bounds.Height
        })
    }
    finally {
      $bitmap.Dispose()
    }
  }

  'webview2' {
    $clientId = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
    $candidates = @(
      "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\$clientId",
      "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\$clientId",
      "HKCU:\Software\Microsoft\EdgeUpdate\Clients\$clientId"
    )
    $version = $null
    $source = $null
    foreach ($candidate in $candidates) {
      $value = (Get-ItemProperty -Path $candidate -Name 'pv' -ErrorAction SilentlyContinue).pv
      if ($value) {
        $version = [string]$value
        $source = $candidate
        break
      }
    }
    Write-Json ([pscustomobject]@{
        version = $version
        source  = $source
      })
  }
}
