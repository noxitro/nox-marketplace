# UI Automation driver for the Microsoft 365 Copilot desktop window.
#
# One action per run, described by a UTF-8 JSON request file; the result is written to a
# UTF-8 JSON file. Actions:
#   snapshot  text currently shown in the window, and whether a reply is being generated
#   newchat   press the "new chat" button
#   send      paste the prompt into the input box and submit it
#   inspect   list window titles and the input boxes / buttons UI Automation can see
#
# Keep this file ASCII-only: Windows PowerShell 5.1 reads a script without a BOM in the
# system code page. All display-language text arrives through the request file.

param(
    [Parameter(Mandatory = $true)][string]$RequestFile,
    [Parameter(Mandatory = $true)][string]$OutFile
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

function Write-Result($result) {
    $json = $result | ConvertTo-Json -Depth 6 -Compress
    [System.IO.File]::WriteAllText($OutFile, $json, (New-Object System.Text.UTF8Encoding($false)))
}

function Fail([string]$code, [string]$message) {
    throw (New-Object System.Exception("$code|$message"))
}

try {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -Namespace M365Uia -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
'@

    $request = [System.IO.File]::ReadAllText($RequestFile, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
    $patterns = $request.patterns

    $AE = [System.Windows.Automation.AutomationElement]
    $CT = [System.Windows.Automation.ControlType]
    $Scope = [System.Windows.Automation.TreeScope]

    function Get-TopWindows {
        return $AE::RootElement.FindAll($Scope::Children, [System.Windows.Automation.Condition]::TrueCondition)
    }

    # The terminal running Copilot CLI may itself have "Copilot" in its title, so the
    # default pattern names the Microsoft 365 app and the first match wins.
    function Get-TargetWindow {
        foreach ($w in (Get-TopWindows)) {
            try {
                $name = $w.Current.Name
                if ($name -and ($name -match $patterns.window)) { return $w }
            } catch { }
        }
        return $null
    }

    function Find-ByType($root, $type) {
        $cond = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $type)
        return $root.FindAll($Scope::Descendants, $cond)
    }

    function Find-Named($root, $types, [string]$pattern) {
        foreach ($type in $types) {
            foreach ($el in (Find-ByType $root $type)) {
                # The page changes while a reply streams; an element can be gone by now.
                try {
                    $name = $el.Current.Name
                    if ($name -and ($name -match $pattern) -and $el.Current.IsEnabled) { return $el }
                } catch { }
            }
        }
        return $null
    }

    function Invoke-Element($el) {
        $p = $null
        if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$p)) {
            $p.Invoke()
            return $true
        }
        return $false
    }

    # Page text in reading order. A web view exposes it through the Document's TextPattern;
    # the names of the Text elements are the fallback.
    function Get-WindowText($window) {
        $best = ''
        foreach ($doc in (Find-ByType $window $CT::Document)) {
            try {
                $tp = $null
                if ($doc.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$tp)) {
                    $text = $tp.DocumentRange.GetText(-1)
                    if ($text -and ($text.Length -gt $best.Length)) { $best = $text }
                }
            } catch { }
        }
        if ($best) { return $best }
        $parts = New-Object System.Collections.Generic.List[string]
        foreach ($el in (Find-ByType $window $CT::Text)) {
            try {
                $name = $el.Current.Name
                if ($name) { $parts.Add($name) }
            } catch { }
        }
        return ($parts -join "`n")
    }

    # Only a box whose name matches is accepted. Falling back to "some text box" could put
    # the prompt into a search field or an address bar.
    function Find-Input($window) {
        foreach ($el in (Find-ByType $window $CT::Edit)) {
            try {
                if (-not $el.Current.IsEnabled -or -not $el.Current.IsKeyboardFocusable) { continue }
                $name = $el.Current.Name
                if ($name -and ($name -match $patterns.input)) { return $el }
            } catch { }
        }
        return $null
    }

    # A web view builds its accessibility tree on first use, so the first look can be empty.
    function Wait-Input($window) {
        for ($i = 0; $i -lt 20; $i++) {
            $el = Find-Input $window
            if ($el) { return $el }
            Start-Sleep -Milliseconds 500
        }
        return $null
    }

    function Send-AltTap {
        [M365Uia.Native]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
        [M365Uia.Native]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
    }

    function Test-Foreground([IntPtr]$hwnd) {
        for ($i = 0; $i -lt 5; $i++) {
            if ([M365Uia.Native]::GetForegroundWindow() -eq $hwnd) { return $true }
            Start-Sleep -Milliseconds 100
        }
        return $false
    }

    function Set-Foreground($window) {
        $hwnd = [IntPtr]$window.Current.NativeWindowHandle
        [void][M365Uia.Native]::SetForegroundWindow($hwnd)
        if (Test-Foreground $hwnd) { return $true }
        # A tap on Alt lifts the restriction on taking the foreground from another process.
        # The tap lands on the window in front and puts it in menu mode; if the switch still
        # fails, a second tap takes it out again.
        Send-AltTap
        [void][M365Uia.Native]::SetForegroundWindow($hwnd)
        if (Test-Foreground $hwnd) { return $true }
        Send-AltTap
        return $false
    }

    $window = Get-TargetWindow
    $action = [string]$request.action

    # A minimised web view exposes no accessibility tree. Restore it without activating it.
    if ($window) {
        $handle = [IntPtr]$window.Current.NativeWindowHandle
        if ([M365Uia.Native]::IsIconic($handle)) {
            [void][M365Uia.Native]::ShowWindow($handle, 4)
            Start-Sleep -Milliseconds 500
        }
    }

    if ($action -eq 'inspect') {
        $titles = @()
        foreach ($w in (Get-TopWindows)) { if ($w.Current.Name) { $titles += $w.Current.Name } }
        $elements = @()
        if ($window) {
            foreach ($type in @($CT::Edit, $CT::Button)) {
                foreach ($el in (Find-ByType $window $type)) {
                    if ($elements.Count -ge 150) { break }
                    $elements += @{ type = $type.ProgrammaticName -replace '^ControlType\.', ''; name = $el.Current.Name; enabled = $el.Current.IsEnabled }
                }
            }
        }
        $title = ''
        if ($window) { $title = $window.Current.Name }
        Write-Result @{ ok = $true; window = $title; windows = @($titles); elements = @($elements) }
        exit 0
    }

    if (-not $window) {
        Fail 'window_not_found' "Microsoft 365 Copilot window not found (title pattern: $($patterns.window)). Open the app, or set M365_COPILOT_WINDOW."
    }

    # The first look at a web view can come before its tree is built; the caller asks to
    # wait for the message box when it needs the page to be really there.
    if ($request.wait -and ($action -ne 'send')) { [void](Wait-Input $window) }

    if ($action -eq 'snapshot') {
        $stop = Find-Named $window @($CT::Button) $patterns.stop
        Write-Result @{ ok = $true; window = $window.Current.Name; text = (Get-WindowText $window); generating = [bool]$stop }
        exit 0
    }

    if ($action -eq 'newchat') {
        $button = Find-Named $window @($CT::Button, $CT::Hyperlink, $CT::MenuItem, $CT::ListItem) $patterns.newChat
        $pressed = $false
        if ($button) { $pressed = Invoke-Element $button }
        if ($pressed) { Start-Sleep -Milliseconds 1500 }
        Write-Result @{ ok = $true; newChat = $pressed }
        exit 0
    }

    if ($action -eq 'send') {
        $prompt = [string]$request.prompt
        if (-not $prompt) { Fail 'empty_prompt' 'Nothing to send.' }
        $box = Wait-Input $window
        if (-not $box) { Fail 'input_not_found' 'Message box not found in the Microsoft 365 Copilot window. Run /m365 --inspect and set M365_COPILOT_INPUT.' }

        $previous = [M365Uia.Native]::GetForegroundWindow()
        $saved = $null
        try { if ([System.Windows.Forms.Clipboard]::ContainsText()) { $saved = [System.Windows.Forms.Clipboard]::GetText() } } catch { }

        # Keystrokes go to whichever window is in front. If the Microsoft 365 Copilot window
        # cannot be brought there, stop: typing into another window (the terminal, for one)
        # would send the prompt somewhere it must not go.
        if (-not (Set-Foreground $window)) { Fail 'focus_failed' 'Could not bring the Microsoft 365 Copilot window to the front. Nothing was sent.' }
        $hwnd = [IntPtr]$window.Current.NativeWindowHandle
        try {
            $box.SetFocus()
            Start-Sleep -Milliseconds 200
            [System.Windows.Forms.Clipboard]::SetText($prompt)
            if ([M365Uia.Native]::GetForegroundWindow() -ne $hwnd) { Fail 'focus_failed' 'The Microsoft 365 Copilot window lost focus. Nothing was sent.' }
            [System.Windows.Forms.SendKeys]::SendWait('^a')
            [System.Windows.Forms.SendKeys]::SendWait('^v')
            Start-Sleep -Milliseconds 500

            $submit = 'button'
            $button = Find-Named $window @($CT::Button) $patterns.send
            if (-not ($button -and (Invoke-Element $button))) {
                if ([M365Uia.Native]::GetForegroundWindow() -ne $hwnd) { Fail 'focus_failed' 'The Microsoft 365 Copilot window lost focus before sending. Check the message box.' }
                [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
                $submit = 'enter'
            }
            Start-Sleep -Milliseconds 300
        }
        finally {
            # Text is put back. Other content (an image, files) cannot be, and is not cleared
            # either: the prompt stays on the clipboard in that case.
            try { if ($saved) { [System.Windows.Forms.Clipboard]::SetText($saved) } } catch { }
            if ($previous -ne [IntPtr]::Zero -and $previous -ne $hwnd) { [void][M365Uia.Native]::SetForegroundWindow($previous) }
        }
        Write-Result @{ ok = $true; submit = $submit }
        exit 0
    }

    Fail 'unknown_action' "Unknown action: $action"
}
catch {
    $text = $_.Exception.Message
    $code = 'driver_error'
    if ($text -match '^([a-z_]+)\|(.*)$') { $code = $Matches[1]; $text = $Matches[2] }
    Write-Result @{ ok = $false; error = $code; message = $text }
    exit 1
}
