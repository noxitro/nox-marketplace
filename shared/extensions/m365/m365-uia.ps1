# UI Automation driver for the Microsoft 365 Copilot desktop window.
#
# One action per run, described by a UTF-8 JSON request file; the result is written to a
# UTF-8 JSON file. Actions:
#   snapshot  text currently shown in the window, whether a reply is being generated, and
#             the newest reply element (its id, text and how many there are)
#   newchat   press the "new chat" button
#   send      paste the prompt into the input box and submit it
#   inspect   list window titles and the input boxes / buttons UI Automation can see
#   release   undo what send did to keep the window visible while the reply is written
#
# Every result carries the handle of the window that was used (hwnd). A request can pass it
# back as `target`, so that the steps of one command all act on the same window.
#
# Keep this file ASCII-only: Windows PowerShell 5.1 reads a script without a BOM in the
# system code page. All display-language text arrives through the request file.

param(
    [Parameter(Mandatory = $true)][string]$RequestFile,
    [Parameter(Mandatory = $true)][string]$OutFile
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$window = $null

function Write-Result($result) {
    if ($window -and -not $result.ContainsKey('hwnd')) {
        try { $result['hwnd'] = [int64]$window.Current.NativeWindowHandle } catch { }
    }
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
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
[DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint gaFlags);
[DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool SetProp(IntPtr hWnd, string lpString, IntPtr hData);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr GetProp(IntPtr hWnd, string lpString);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr RemoveProp(IntPtr hWnd, string lpString);
[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
'@

    $request = [System.IO.File]::ReadAllText($RequestFile, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
    $patterns = $request.patterns

    function Get-Option([string]$name) {
        $p = $request.PSObject.Properties[$name]
        if ($p) { return $p.Value }
        return $null
    }

    # A pattern the caller may leave out; empty means "not used".
    function Get-Pattern([string]$name) {
        $p = $patterns.PSObject.Properties[$name]
        if ($p -and $p.Value) { return [string]$p.Value }
        return ''
    }

    $AE = [System.Windows.Automation.AutomationElement]
    $CT = [System.Windows.Automation.ControlType]
    $Scope = [System.Windows.Automation.TreeScope]

    function Get-TopWindows {
        return $AE::RootElement.FindAll($Scope::Children, [System.Windows.Automation.Condition]::TrueCondition)
    }

    # Other windows ("GitHub Copilot", the terminal, browser tabs) also carry "Copilot" in
    # their titles, so the default pattern matches whole titles only. The optional process
    # pattern tells apart windows whose titles are the same. Every match is returned: with
    # more than one, nothing is sent, because the prompt must not go to a guess.
    function Get-Candidates {
        $found = New-Object System.Collections.Generic.List[object]
        $wanted = Get-Pattern 'process'
        foreach ($w in (Get-TopWindows)) {
            try {
                $name = $w.Current.Name
                if (-not ($name -and ($name -match $patterns.window))) { continue }
                $process = ''
                try { $process = (Get-Process -Id $w.Current.ProcessId -ErrorAction Stop).ProcessName } catch { }
                if ($wanted -and ($process -notmatch $wanted)) { continue }
                $found.Add(@{ element = $w; label = "$name ($process)" })
            } catch { }
        }
        return ,$found
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

    # Chat messages are unnamed containers, which the control view leaves out, so they are
    # looked for in the raw view. Each reply is the element whose AutomationId matches the
    # reply pattern; the newest one is the last.
    function Find-ById($root, $type, [string]$pattern) {
        $found = New-Object System.Collections.Generic.List[object]
        if (-not $pattern) { return ,$found }
        $cache = New-Object System.Windows.Automation.CacheRequest
        $cache.TreeFilter = [System.Windows.Automation.Automation]::RawViewCondition
        [void]$cache.Add($AE::AutomationIdProperty)
        $activation = $cache.Activate()
        try {
            $all = $root.FindAll($Scope::Descendants, (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $type)))
        }
        finally { $activation.Dispose() }
        foreach ($el in $all) {
            try {
                $id = $el.Cached.AutomationId
                if ($id -and ($id -match $pattern)) { $found.Add($el) }
            } catch { }
        }
        return ,$found
    }

    function Find-Replies($window) { return ,(Find-ById $window $CT::Group (Get-Pattern 'reply')) }

    # Whether this is the Microsoft 365 Copilot page: an element of it (the message box, or a
    # container) carries an id the app pattern matches. Another app can have a window with
    # the same title, and the prompt carries the conversation.
    function Test-AppSignature($window, $box) {
        $wanted = Get-Pattern 'app'
        if (-not $wanted) { return $true }
        if ($box) {
            try {
                $id = $box.Current.AutomationId
                if ($id -and ($id -match $wanted)) { return $true }
            } catch { }
        }
        return ((Find-ById $window $CT::Group $wanted).Count -gt 0)
    }

    # A dialog inside the page (a consent prompt, a sign-in page) hides the message box.
    function Find-Dialog($window) {
        foreach ($el in (Find-ByType $window $CT::Window)) {
            try { if ($el.Current.Name -and $el.Current.Name -ne $window.Current.Name) { return [string]$el.Current.Name } } catch { }
        }
        return ''
    }

    # Whether the page has drawn anything a person could press or type into.
    function Test-PageBuilt($window) {
        [System.Windows.Automation.Condition[]]$either = @(
            (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::Button)),
            (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::Edit)))
        $cond = New-Object System.Windows.Automation.OrCondition -ArgumentList (, $either)
        foreach ($doc in (Find-ByType $window $CT::Document)) {
            try { if ($doc.FindFirst($Scope::Descendants, $cond)) { return $true } } catch { }
        }
        return $false
    }

    # Text of one element in reading order, through the TextPattern of the page it sits in.
    function Get-ElementText($window, $el) {
        $best = ''
        foreach ($doc in (Find-ByType $window $CT::Document)) {
            try {
                $tp = $null
                if ($doc.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$tp)) {
                    $text = $tp.RangeFromChild($el).GetText(-1)
                    if ($text -and ($text.Length -gt $best.Length)) { $best = $text }
                }
            } catch { }
        }
        return $best
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

    function Get-Squashed([string]$text) { return $text -replace '[\s\uFFFC\u200B]', '' }

    # Whether the message box holds the prompt: its start and its end, blanks ignored. A box
    # that cannot be read counts as holding it, so that a version without ValuePattern still
    # sends. A draft the user left in the box does not count: if the paste missed, the draft
    # would be what gets sent.
    function Test-BoxHolds($box, [string]$prompt) {
        $vp = $null
        try {
            if (-not $box.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) { return $true }
            $have = Get-Squashed ([string]$vp.Current.Value)
        } catch { return $true }
        $want = Get-Squashed $prompt
        $n = [Math]::Min(20, $want.Length)
        return ($have.Length -ge $n -and $have.StartsWith($want.Substring(0, $n)) -and $have.EndsWith($want.Substring($want.Length - $n)))
    }

    # A web view builds its accessibility tree on first use, so the first look can be empty.
    # With a dialog open the box will not come, so there is nothing to wait for.
    function Wait-Input($window) {
        for ($i = 0; $i -lt 20; $i++) {
            $el = Find-Input $window
            if ($el) { return $el }
            if (Find-Dialog $window) { return $null }
            Start-Sleep -Milliseconds 500
        }
        return $null
    }

    # For inspect: wait for the page, not for the message box. Inspect is what a person runs
    # when the box is not found, and it must not make them wait for it.
    function Wait-Page($window) {
        for ($i = 0; $i -lt 20; $i++) {
            if ((Find-Input $window) -or (Test-PageBuilt $window)) { return }
            Start-Sleep -Milliseconds 500
        }
    }

    function Send-AltTap {
        [M365Uia.Native]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
        [M365Uia.Native]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
    }

    # Whether a window handle is the target window or sits inside it. Once the message box
    # has the focus, Windows can report the render window inside the target ("Chrome Legacy
    # Window", a child of it) as the one in front; that is still the target. Another
    # top-level window of the same process is not: keys sent there would land elsewhere.
    function Test-SameApp([IntPtr]$other, [IntPtr]$hwnd) {
        if ($other -eq $hwnd) { return $true }
        if ($other -eq [IntPtr]::Zero) { return $false }
        return ([M365Uia.Native]::GetAncestor($other, 2) -eq $hwnd)
    }

    function Test-AppInFront([IntPtr]$hwnd) { return (Test-SameApp ([M365Uia.Native]::GetForegroundWindow()) $hwnd) }

    # Keeping the window on top is marked on the window itself, so that a later run can
    # undo it (the CLI may have quit while waiting) and never undoes an "always on top" the
    # user set.
    $RaisedMark = 'M365UiaRaised'
    function Lift-Window([IntPtr]$hwnd) {
        if (([M365Uia.Native]::GetWindowLong($hwnd, -20) -band 0x8) -ne 0) { return $false }
        [void][M365Uia.Native]::SetWindowPos($hwnd, [IntPtr](-1), 0, 0, 0, 0, 0x13)
        [void][M365Uia.Native]::SetProp($hwnd, $RaisedMark, [IntPtr]1)
        return $true
    }
    function Lower-Window([IntPtr]$hwnd) {
        if ([M365Uia.Native]::GetProp($hwnd, $RaisedMark) -eq [IntPtr]::Zero) { return $false }
        [void][M365Uia.Native]::RemoveProp($hwnd, $RaisedMark)
        [void][M365Uia.Native]::SetWindowPos($hwnd, [IntPtr](-2), 0, 0, 0, 0, 0x13)
        $front = [M365Uia.Native]::GetForegroundWindow()
        $frontTop = $front -ne [IntPtr]::Zero -and (([M365Uia.Native]::GetWindowLong($front, -20) -band 0x8) -ne 0)
        if ($front -ne [IntPtr]::Zero -and -not $frontTop -and -not (Test-SameApp $front $hwnd)) {
            [void][M365Uia.Native]::SetWindowPos($hwnd, $front, 0, 0, 0, 0, 0x13)
        }
        return $true
    }

    function Test-Foreground([IntPtr]$hwnd) {
        for ($i = 0; $i -lt 5; $i++) {
            if (Test-AppInFront $hwnd) { return $true }
            Start-Sleep -Milliseconds 100
        }
        return $false
    }

    # Give the foreground back to the window the user was in, and check that it left the
    # app: what the user types next must not go into the message box.
    function Restore-Foreground([IntPtr]$previous, [IntPtr]$hwnd) {
        if ($previous -eq [IntPtr]::Zero -or (Test-SameApp $previous $hwnd)) { return $true }
        if (-not (Test-AppInFront $hwnd)) { return $true }
        for ($try = 0; $try -lt 2; $try++) {
            # The second time with a tap on Alt, as in Set-Foreground.
            if ($try -gt 0) { Send-AltTap }
            [void][M365Uia.Native]::SetForegroundWindow($previous)
            for ($i = 0; $i -lt 5; $i++) {
                if (-not (Test-AppInFront $hwnd)) { return $true }
                Start-Sleep -Milliseconds 100
            }
        }
        Send-AltTap
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

    $action = [string]$request.action
    $labels = @()
    $target = Get-Option 'target'
    if ($target) {
        # A later step of a command: the window the first step chose, or nothing.
        try {
            $pinned = $AE::FromHandle([IntPtr][int64]$target)
            if ($pinned.Current.Name -match $patterns.window) { $window = $pinned }
        } catch { }
        if (-not $window) { Fail 'window_gone' 'The Microsoft 365 Copilot window this command started with is gone.' }
    } else {
        $candidates = Get-Candidates
        foreach ($c in $candidates) { $labels += $c.label }
        if ($candidates.Count -gt 0) { $window = $candidates[0].element }
        if ($candidates.Count -gt 1 -and $action -ne 'inspect') {
            Fail 'ambiguous_window' "More than one window matches: $($labels -join ', '). Close the other one, or set M365_COPILOT_PROCESS or M365_COPILOT_WINDOW. Nothing was sent."
        }
    }

    # A minimised web view exposes no accessibility tree. Restore it without activating it,
    # unless the caller says not to: a window the user minimised while a reply was awaited
    # stays minimised.
    $minimized = $false
    if ($window -and $action -ne 'release') {
        $handle = [IntPtr]$window.Current.NativeWindowHandle
        if ([M365Uia.Native]::IsIconic($handle)) {
            if ((Get-Option 'restore') -eq $false) { $minimized = $true }
            else {
                [void][M365Uia.Native]::ShowWindow($handle, 4)
                Start-Sleep -Milliseconds 500
            }
        }
    }

    if ($action -eq 'inspect') {
        # Same as below: the first look at a web view can come before its tree is built.
        if ($window) { Wait-Page $window }
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
        $replyCount = 0
        $signature = $false
        $dialog = ''
        if ($window) {
            $title = $window.Current.Name
            $replyCount = (Find-Replies $window).Count
            $signature = Test-AppSignature $window (Find-Input $window)
            $dialog = Find-Dialog $window
        }
        Write-Result @{ ok = $true; window = $title; windows = @($titles); elements = @($elements); replies = $replyCount; candidates = @($labels); signature = $signature; dialog = $dialog }
        exit 0
    }

    if (-not $window) {
        Fail 'window_not_found' "Microsoft 365 Copilot window not found (title pattern: $($patterns.window)). Open the app, or set M365_COPILOT_WINDOW."
    }

    # The first look at a web view can come before its tree is built; the caller asks to
    # wait for the message box when it needs the page to be really there.
    if ((Get-Option 'wait') -and ($action -ne 'send')) { [void](Wait-Input $window) }

    if ($action -eq 'snapshot') {
        if ($minimized) {
            Write-Result @{ ok = $true; window = $window.Current.Name; minimized = $true; text = ''; generating = $false; replies = 0; replyIds = @(); replyId = ''; reply = '' }
            exit 0
        }
        if (Get-Option 'release') { [void](Lower-Window ([IntPtr]$window.Current.NativeWindowHandle)) }
        $stop = Find-Named $window @($CT::Button) $patterns.stop
        $replies = Find-Replies $window
        # A long chat keeps only its last few messages in the tree, so the count can stay the
        # same after a send; the ids tell which replies were already there.
        $replyIds = @()
        foreach ($el in $replies) { try { $replyIds += [string]$el.Cached.AutomationId } catch { } }
        $replyId = ''
        $replyText = ''
        if ($replies.Count -gt 0) {
            $last = $replies[$replies.Count - 1]
            try { $replyId = [string]$last.Cached.AutomationId } catch { }
            $replyText = Get-ElementText $window $last
        }
        Write-Result @{ ok = $true; window = $window.Current.Name; text = (Get-WindowText $window); generating = [bool]$stop; replies = $replies.Count; replyIds = @($replyIds); replyId = $replyId; reply = $replyText; minimized = $false }
        exit 0
    }

    if ($action -eq 'newchat') {
        $button = Find-Named $window @($CT::Button, $CT::Hyperlink, $CT::MenuItem, $CT::ListItem) $patterns.newChat
        $pressed = $false
        # Pressing a link in the app activates its window. The user is working elsewhere (in the
        # terminal, typically), so the window that was in front is put back.
        $previous = [M365Uia.Native]::GetForegroundWindow()
        $hwnd = [IntPtr]$window.Current.NativeWindowHandle
        $wasApp = Test-AppInFront $hwnd
        if ($button) { $pressed = Invoke-Element $button }
        if ($pressed) { Start-Sleep -Milliseconds 1500 }
        $focusBack = $true
        if (-not $wasApp) { $focusBack = Restore-Foreground $previous $hwnd }
        Write-Result @{ ok = $true; newChat = $pressed; focusRestored = $focusBack }
        exit 0
    }

    if ($action -eq 'send') {
        $prompt = [string](Get-Option 'prompt')
        if (-not $prompt) { Fail 'empty_prompt' 'Nothing to send.' }
        $box = Wait-Input $window
        if (-not $box) {
            # Name the dialog that hides the box: the user has to answer it, and changing the
            # pattern would not help.
            $dialog = Find-Dialog $window
            if ($dialog) { Fail 'dialog_open' "A dialog is open in the Microsoft 365 Copilot window ($dialog). Answer it in the app, then try again. Nothing was sent." }
            Fail 'input_not_found' 'Message box not found in the Microsoft 365 Copilot window. Run /m365 --inspect and set M365_COPILOT_INPUT.'
        }

        if (-not (Test-AppSignature $window $box)) {
            Fail 'not_m365' "This window does not look like Microsoft 365 Copilot: nothing in it has an id matching $(Get-Pattern 'app'). Nothing was sent. Check the window with /m365 --inspect; if it is the right one, set M365_COPILOT_APP_ID."
        }

        $previous = [M365Uia.Native]::GetForegroundWindow()
        # Every format on the clipboard is copied out (text, an image, a list of files...), so
        # the paste does not cost the user what they had copied. Metafiles are left out: they
        # do not survive being put back, and make the source application draw for nothing.
        $saved = $null
        try {
            $current = [System.Windows.Forms.Clipboard]::GetDataObject()
            if ($current) {
                $copy = New-Object System.Windows.Forms.DataObject
                $kept = 0
                foreach ($format in $current.GetFormats($false)) {
                    if ($format -match 'Metafile|MetaFilePict') { continue }
                    try {
                        $data = $current.GetData($format, $false)
                        if ($null -ne $data) { $copy.SetData($format, $data); $kept++ }
                    } catch { }
                }
                if ($kept -gt 0) { $saved = $copy }
            }
        } catch { }

        # Keystrokes go to whichever window is in front. If the Microsoft 365 Copilot window
        # cannot be brought there, stop: typing into another window (the terminal, for one)
        # would send the prompt somewhere it must not go.
        if (-not (Set-Foreground $window)) { Fail 'focus_failed' 'Could not bring the Microsoft 365 Copilot window to the front. Nothing was sent.' }
        $hwnd = [IntPtr]$window.Current.NativeWindowHandle
        try {
            $box.SetFocus()
            Start-Sleep -Milliseconds 200
            # The prompt carries the conversation. Mark it so that clipboard history (Win+V),
            # cloud sync and clipboard monitors leave it out.
            $outgoing = New-Object System.Windows.Forms.DataObject
            $outgoing.SetData([System.Windows.Forms.DataFormats]::UnicodeText, $prompt)
            $outgoing.SetData('ExcludeClipboardContentFromMonitorProcessing', (New-Object System.IO.MemoryStream(, [byte[]](0, 0, 0, 0))))
            $outgoing.SetData('CanIncludeInClipboardHistory', (New-Object System.IO.MemoryStream(, [byte[]](0, 0, 0, 0))))
            $outgoing.SetData('CanUploadToCloudClipboard', (New-Object System.IO.MemoryStream(, [byte[]](0, 0, 0, 0))))
            [System.Windows.Forms.Clipboard]::SetDataObject($outgoing, $true)
            # The keys can land beside the message box while the app moves its focus around, so
            # the box is read back after the paste, and the paste tried once more if it is empty.
            # Without text in the box nothing is submitted: Enter would go wherever the focus is.
            $pasted = $false
            for ($try = 0; $try -lt 2 -and -not $pasted; $try++) {
                if ($try -gt 0) {
                    [void](Set-Foreground $window)
                    $box.SetFocus()
                    Start-Sleep -Milliseconds 300
                }
                if (-not (Test-AppInFront $hwnd)) { Fail 'focus_failed' 'The Microsoft 365 Copilot window lost focus. Nothing was sent.' }
                [System.Windows.Forms.SendKeys]::SendWait('^a')
                [System.Windows.Forms.SendKeys]::SendWait('^v')
                Start-Sleep -Milliseconds 500
                $pasted = Test-BoxHolds $box $prompt
            }
            if (-not $pasted) { Fail 'paste_failed' 'The prompt did not reach the message box (or something else is in it). Nothing was sent.' }

            $submit = 'button'
            $button = Find-Named $window @($CT::Button) $patterns.send
            if (-not ($button -and (Invoke-Element $button))) {
                if (-not (Test-AppInFront $hwnd)) { Fail 'focus_failed' 'The Microsoft 365 Copilot window lost focus before sending. Check the message box.' }
                [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
                $submit = 'enter'
            }
            Start-Sleep -Milliseconds 300
        }
        finally {
            # What was there is put back. A format that could not be read (an application that
            # renders on request and has quit, for one) is lost. When nothing can be put back,
            # the clipboard is emptied: the prompt, which carries the conversation, must not
            # stay there.
            $putBack = $false
            try { if ($saved) { [System.Windows.Forms.Clipboard]::SetDataObject($saved, $true); $putBack = $true } } catch { }
            if (-not $putBack) { try { [System.Windows.Forms.Clipboard]::Clear() } catch { } }
            $focusBack = Restore-Foreground $previous $hwnd
        }
        # A window that other windows cover completely stops rendering, and the reply never
        # reaches the accessibility tree. Keep it on top, without the keyboard focus, until the
        # caller sends 'release'. Only after a send that went through.
        $raised = $false
        if (Get-Option 'keepVisible') { $raised = Lift-Window $hwnd }
        Write-Result @{ ok = $true; submit = $submit; raised = $raised; focusRestored = $focusBack }
        exit 0
    }

    if ($action -eq 'release') {
        # Undo 'send': no longer on top, and back behind the window the user is working in.
        # Only what this driver did is undone.
        Write-Result @{ ok = $true; lowered = (Lower-Window ([IntPtr]$window.Current.NativeWindowHandle)) }
        exit 0
    }

    Fail 'unknown_action' "Unknown action: $action"
}
catch {
    $text = $_.Exception.Message
    $code = 'driver_error'
    if ($text -match '^([a-z0-9_]+)\|(.*)$') { $code = $Matches[1]; $text = $Matches[2] }
    Write-Result @{ ok = $false; error = $code; message = $text }
    exit 1
}
